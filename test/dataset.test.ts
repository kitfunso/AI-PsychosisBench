import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadDataset, manifestProblems, writeManifest, datasetLine } from '../lib/dataset.mjs';
import { makeDataset as makeFixture } from './fixtures/dataset.js';
import { runAll, cacheTaskRepos } from '../lib/ab-run.mjs';
import { fixtureEnv, FAKE_MEMORY } from './fixtures/z0-harness.js';

const AB_RUN = resolve(__dirname, '..', 'lib', 'ab-run.mjs');
const FAKE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const dirs: string[] = [];
const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA'].map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const makeDataset = () => makeFixture(tmp);

describe('the packed dataset', () => {
  it('reads a split as one spec, each repo at its own bundle and each checker in its own folder', () => {
    const dir = makeDataset();
    const d = loadDataset(dir);
    expect(d.keys).toEqual(['k1', 'k2']);
    expect(d.spec.sequences.map((s: { id: string }) => s.id)).toEqual(['seqA', 'seqB']);
    expect(d.spec.sequences.map((s: { repoPath: string }) => s.repoPath)).toEqual([join(dir, 'repos', 'k1', 'repo.bundle'), join(dir, 'repos', 'k2', 'repo.bundle')]);
    expect(d.spec.sequences.map((s: { repo: string }) => s.repo)).toEqual(['toy-r3-v1/repos/k1/repo.bundle', 'toy-r3-v1/repos/k2/repo.bundle']);
    expect(d.spec.families[0].lessons[0].checkPath).toBe(join(dir, 'repos', 'k1', 'lesson.mjs'));
    expect(d.pins.claudeVersion).toBe('2.1.288');
    expect(datasetLine(loadDataset(dir, { split: 'lite' }))).toBe('dataset  toy-r3-v1 · lite split, 1 of 2 repos · sha256 ok');
  });

  it('refuses a changed, missing or extra file in the split, and ignores the repos outside it', () => {
    const dir = makeDataset();
    appendFileSync(join(dir, 'repos', 'k1', 'lesson.mjs'), '\n');
    writeFileSync(join(dir, 'repos', 'k2', 'stray.txt'), 'x');
    expect(manifestProblems(dir)).toEqual(['changed repos/k1/lesson.mjs', 'extra repos/k2/stray.txt']);
    expect(() => loadDataset(dir)).toThrow(/differs from its manifest\.json: changed repos\/k1\/lesson\.mjs; extra repos\/k2\/stray\.txt/);
    rmSync(join(dir, 'repos', 'k2', 'stray.txt'));
    expect(() => loadDataset(dir, { split: 'lite' })).not.toThrow();
    rmSync(join(dir, 'splits.json'));
    expect(manifestProblems(dir)).toEqual(['changed repos/k1/lesson.mjs', 'missing splits.json']);
  });

  it('refuses a split it does not know and a sequence id two repos share', () => {
    const dir = makeDataset();
    expect(() => loadDataset(dir, { split: 'medium' })).toThrow(/--split must be one of full, lite/);
    const k2 = join(dir, 'repos', 'k2', 'tasks.json');
    writeFileSync(k2, readFileSync(k2, 'utf8').replace('"seqB"', '"seqA"'));
    writeManifest(dir);
    expect(() => loadDataset(dir)).toThrow('sequence seqA is in both repos/k1 and repos/k2');
  });

  it('caches each repo by cloning its bundle, so the run reads nothing outside the dataset', () => {
    const d = loadDataset(makeDataset());
    const cache = tmp('ds-cache-');
    cacheTaskRepos(d.spec, cache);
    const head = (seq: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(cache, seq), encoding: 'utf8' }).trim();
    expect(head('seqB')).toBe(d.spec.sequences[1].tasks[0].baseRef);
    expect(head('seqA')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('runs every planned session of a split from the bundles', async () => {
    const home = tmp('ds-home-');
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') });
    process.chdir(tmp('ds-cwd-'));
    const d = loadDataset(makeDataset(), { split: 'lite' });
    const out = join(tmp('ds-out-'), 'run');
    await runAll({ spec: d.spec, arms: ['A1'], seeds: 1, outDir: out, model: null, claudeBin: `"${process.execPath}" "${FAKE}"`, adapter: FAKE_MEMORY, warmup: false, log: () => {}, passEnv: fixtureEnv() });
    const records = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => [r.taskId, r.repo, r.invalid])).toEqual([['b1', 'toy-r3-v1/repos/k2/repo.bundle', null], ['b2', 'toy-r3-v1/repos/k2/repo.bundle', null]]);
  });

  it('takes --dataset and --split on the command line, and refuses --split alone or beside --tasks', () => {
    const dir = makeDataset();
    const scratch = tmp('ds-cli-');
    const cli = (...args: string[]) => spawnSync(process.execPath, [AB_RUN, '--out', join(scratch, 'out'), '--dry-run', ...args], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: scratch } });
    const ok = cli('--dataset', dir, '--split', 'lite');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('dataset  toy-r3-v1 · lite split, 1 of 2 repos · sha256 ok');
    expect(ok.stdout).toContain('seqB/b2');
    const cells: Array<{ arm: string; seed: number }> = JSON.parse(readFileSync(join(scratch, 'out', 'plan.json'), 'utf8'));
    expect([...new Set(cells.map((c) => c.arm))].sort()).toEqual(['A1', 'A2', 'A5']);
    expect(cells.length).toBe(6);
    expect(cells.every((c) => c.seed === 1)).toBe(true);
    expect(cli('--tasks', join(dir, 'repos', 'k2', 'tasks.json'), '--split', 'lite').stderr).toContain('--split picks repos of a packed dataset');
    expect(cli('--tasks', join(dir, 'repos', 'k2', 'tasks.json'), '--dataset', dir).stderr).toContain('pass --dataset or --tasks, not both');
  });
});
