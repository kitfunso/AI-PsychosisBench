// The CLI commands with no model call: flags, cost, score, register, regrade and verify, the key scan and doctor.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseFlags, runCli } from '../lib/cli.mjs';
import { costByArm, costText } from '../lib/cost.mjs';
import { scoreRun, scoreText } from '../lib/score.mjs';
import { readRunDir, gradingDirOf, BENCH_PRICES } from '../lib/run-dir.mjs';
import { compareRow } from '../lib/dataset-regrade.mjs';
import { findKeys, shapesIn } from '../lib/secrets.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { loadDataset, LITE } from '../lib/dataset.mjs';
import { runAll } from '../lib/ab-run.mjs';
import { analyzeZ0, loadInputs } from '../lib/z0-analyze.mjs';
import { GRADING, PRICES, generate, jsonl } from './fixtures/z0-gen.js';
import { makeDataset, bundleRepo } from './fixtures/dataset.js';
import { fixtureEnv, FAKE_MEMORY } from './fixtures/z0-harness.js';

const AB_RUN = resolve(__dirname, '..', 'lib', 'ab-run.mjs');
const FAKE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const dirs: string[] = [];
const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'CLAUDE_CODE_OAUTH_TOKEN'].map((k) => [k, process.env[k]]));
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
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
// Built at run time, so no key-shaped literal sits in the source.
const FAKE_KEY = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');

/** A runner-shaped out dir holding generated records, their plan and a passing grading file. */
function generatedRun(arms?: string[]) {
  const dir = tmp('cli-run-');
  const g = generate(arms ? { arms } : {});
  writeFileSync(join(dir, 'runs.jsonl'), jsonl(g.records));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(g.plan));
  writeFileSync(join(dir, 'grading.json'), JSON.stringify(GRADING));
  return dir;
}

describe('the CLI', () => {
  it('refuses an unknown command, an unknown or repeated flag and a flag with no value', () => {
    expect(runCli(['bogus'])).toMatchObject({ code: 1, stderr: expect.stringContaining('unknown command bogus') });
    expect(runCli([])).toMatchObject({ code: 0, stdout: expect.stringContaining('ai-psychosisbench score --run DIR') });
    expect(() => parseFlags(['--x'], { values: ['--run'] })).toThrow('unknown flag --x');
    expect(() => parseFlags(['--run', 'a', '--run', 'b'], { values: ['--run'] })).toThrow('--run given twice');
    expect(() => parseFlags(['--run'], { values: ['--run'] })).toThrow('--run needs a value');
    expect(parseFlags(['--run', 'a', '--run', 'b'], { multi: ['--run'] }).many('--run')).toEqual(['a', 'b']);
    expect(runCli(['score', '--run', join(tmpdir(), 'no-such-run-dir')])).toMatchObject({ code: 1, stderr: expect.stringContaining('no such folder') });
  });

  it('cost counts billed sessions and dollars per arm across run dirs, with a lite estimate', () => {
    const a = tmp('cost-a-');
    const b = tmp('cost-b-');
    const rec = (arm: string, seed: number, costUsd: number | null) => JSON.stringify({ arm, seed, costUsd });
    writeFileSync(join(a, 'runs.jsonl'), [rec('A1', 1, 0.5), rec('A1', 1, 0.25), rec('A2', 1, 1.25), rec('A2', 1, null)].join('\n'));
    writeFileSync(join(b, 'runs.jsonl'), [rec('A1', 2, 1000), rec('A0', 1, 0)].join('\n'));
    for (const d of [a, b]) writeFileSync(join(d, 'plan.json'), '[]');
    const by = costByArm([join(a, 'runs.jsonl'), join(b, 'runs.jsonl')]);
    expect([...by].map(([arm, x]) => [arm, x.sessions, x.usd, x.runSeeds.size])).toEqual([['A1', 3, 1000.75, 2], ['A2', 1, 1.25, 1]]);
    expect(costText(by)).toContain('full      4 sessions   $1,002  (A1 A2)');
    const ds = makeDataset(tmp, { lite: ['k1'] });
    const out = runCli(['cost', '--run', a, '--run', b, '--dataset', ds]);
    expect(out.code).toBe(0);
    // A1 runs 1.5 sessions per run-seed and A2 1: lite is 1 repo x 3 arms x 1 seed x 1.25.
    expect(out.stdout).toContain(`lite  approx. 4 sessions, approx. $939  (1 repos, ${LITE.arms.join(' ')}, seed 1`);
  });

  it('score prints the gates, then H1 and learn as the analyzer computes them, and writes them as JSON', () => {
    const dir = generatedRun();
    const s = scoreRun(dir, { iterations: 200 });
    expect(s.gates).toEqual({ G1: true, G2: true, G3: true, G4: true, G5: true });
    const inputs = loadInputs({ runs: [join(dir, 'runs.jsonl')], plan: [join(dir, 'plan.json')], prices: BENCH_PRICES, grading: join(dir, 'grading.json'), dropList: null, out: null }, dir);
    const ref = analyzeZ0(inputs.records, { ...inputs, adapterKeys: [], iterations: 200, seed: 1, unblind: true, refuse: () => null });
    expect(s.H1).toMatchObject({ estimate: ref.hypotheses.H1.violation.estimate, low: ref.hypotheses.H1.violation.low, high: ref.hypotheses.H1.violation.high });
    expect(s.learn).toMatchObject({ estimate: ref.hypotheses.attribution.violation.estimate, low: ref.hypotheses.attribution.violation.low });
    const text = scoreText(s);
    expect(text).toContain('gates    G1 G2 G3 G4 G5 pass');
    expect(text).toMatch(/^H1 {7}A2 - A1 {2}[+-]?\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\]/m);
    expect(text).toMatch(/^learn {4}A2 - A5 {2}[+-]?\d\.\d{3} \[/m);
    const json = join(dir, 'score.json');
    const cli = runCli(['score', '--run', dir, '--json', json]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(JSON.parse(readFileSync(json, 'utf8'))).toMatchObject({ schema: 'ai-psychosisbench-score/1', bench: 'AI-PsychosisBench', iterations: 10000, gates: s.gates });
  });

  it('score gives no numbers for a lite run, which plans no A0 or A4', () => {
    const s = scoreRun(generatedRun(['A1', 'A2', 'A5']), { iterations: 50 });
    expect(s.H1).toBeNull();
    expect(scoreText(s)).toContain('no score: the run plans no A0 or A4, so gate G2 cannot run (a lite run)');
  });

  it('reads a run from an analyzer report by its input hashes, finds a moved grading file by hash, and refuses a changed input', () => {
    const run = generatedRun();
    const report = tmp('cli-report-');
    const moved = join(tmp('cli-gone-'), 'grading.json');
    const hash = (role: string, file: string) => ({ role, file, sha256: sha(file) });
    writeFileSync(join(run, 'prices.json'), JSON.stringify(PRICES));
    const hashes = [hash('runs', join(run, 'runs.jsonl')), hash('plan', join(run, 'plan.json')), hash('prices', join(run, 'prices.json')), { ...hash('grading', join(run, 'grading.json')), file: moved }];
    copyFileSync(join(run, 'grading.json'), join(report, 'grading.json'));
    writeFileSync(join(report, 'blind.json'), JSON.stringify({ schema: 'z0-report/1', hashes }));
    const r = readRunDir(report);
    expect(r.parts).toEqual([{ runs: join(run, 'runs.jsonl'), plan: join(run, 'plan.json') }]);
    expect([r.grading, r.prices]).toEqual([join(report, 'grading.json'), join(run, 'prices.json')]);
    expect(scoreRun(report, { iterations: 200 }).H1.estimate).toBeCloseTo(scoreRun(run, { iterations: 200 }).H1.estimate, 12);
    appendFileSync(join(run, 'plan.json'), '\n');
    expect(() => readRunDir(report)).toThrow(/plan\.json \(plan\) has changed since the report hashed it/);
  });

  it('finds the grading of a runs file copied out of its run by the records it holds, CRLF endings or not', () => {
    const root = tmp('cli-root-');
    const src = join(root, 'r3run', 'x-w1', 'run');
    const copy = join(root, 'r3-merged', 'x-w1');
    mkdirSync(join(src, 'grading'), { recursive: true });
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(src, 'runs.jsonl'), '{"a":1}\n{"a":2}\n');
    writeFileSync(join(copy, 'runs.jsonl'), '{"a":2}\r\n');
    expect(gradingDirOf({ runs: join(copy, 'runs.jsonl') })).toBe(src);
    writeFileSync(join(copy, 'runs.jsonl'), '{"a":3}\n');
    expect(() => gradingDirOf({ runs: join(copy, 'runs.jsonl') })).toThrow(/0 run dirs under .* hold all its records/);
  });

  it('compares each regraded check with the verdict the record holds', () => {
    const record = { lessons: [{ lessonId: 'l1', first: 'fail', final: 'pass', staleFollow: true }] };
    const row = { checks: [{ lessonId: 'l1', which: 'first', regraded: 'fail' }, { lessonId: 'l1', which: 'final', regraded: 'fail' }, { lessonId: 'l0', which: 'stale', regraded: 'error' }] };
    expect(compareRow(record, row)).toEqual({ changes: [{ lessonId: 'l1', which: 'final', run: 'pass', packed: 'fail' }], crashed: ['l0 stale'] });
  });

  it('register prints the sha256 of the plan.json a run of the split writes, and writes the issue body', () => {
    const ds = makeDataset(tmp);
    const scratch = tmp('cli-reg-');
    const body = join(scratch, 'issue.md');
    const r = runCli(['register', '--memory', FAKE_MEMORY.file, '--dataset', ds, '--out', body]);
    expect(r.code, r.stderr).toBe(0);
    const dry = spawnSync(process.execPath, [AB_RUN, '--dataset', ds, '--out', join(scratch, 'out'), '--dry-run'], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: scratch } });
    expect(dry.status, dry.stderr).toBe(0);
    const plan = join(scratch, 'out', 'plan.json');
    const cells = JSON.parse(readFileSync(plan, 'utf8')).length;
    const arms = [...new Set(JSON.parse(readFileSync(plan, 'utf8')).map((c: { arm: string }) => c.arm))].sort().join(' ');
    expect(r.stdout).toContain(`plan      sha256 ${sha(plan)} · ${cells} cells (full split, ${arms})`);
    const text = readFileSync(body, 'utf8');
    expect(text).toContain(`# run ${FAKE_MEMORY.name}`);
    expect(text).toContain(`| plan sha256 | ${sha(plan)} |`);
    expect(text).toContain(`| manifest sha256 | ${FAKE_MEMORY.sha256} |`);
  });

  it('verify passes a lite run of the toy dataset, then fails it for a key-shaped value and for a missing record', async () => {
    const home = tmp('cli-home-');
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') });
    process.chdir(tmp('cli-cwd-'));
    // One family's tasks and the two spacers its order needs keep the run to 15 sessions.
    const ds = makeDataset(tmp, { lite: ['k1'], tasks: ['t3', 'n1', 'n2', 'a4', 'a5'] });
    const d = loadDataset(ds, { split: 'lite' });
    const out = join(tmp('cli-out-'), 'run');
    await runAll({ spec: d.spec, arms: [...LITE.arms], seeds: LITE.seeds, outDir: out, model: null, claudeBin: `"${process.execPath}" "${FAKE}"`, adapter: FAKE_MEMORY, warmup: false, log: () => {}, passEnv: fixtureEnv() });
    const scratch = tmp('cli-scratch-');
    expect(runCli(['regrade', '--run', out, '--dataset', ds, '--scratch', scratch])).toMatchObject({ code: 0, stdout: expect.stringContaining('changed  0 verdicts') });
    // Each verify resumes the regrade's rows in the same scratch, so only the first regrade runs the checkers.
    const verify = () => runCli(['verify', out, '--dataset', ds, '--scratch', scratch]);
    const ok = verify();
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/plan {5}sha256 [0-9a-f]{64} is the lite split's plan {2}ok/);
    expect(ok.stdout).toContain('cells    every planned cell has one record  ok');
    expect(ok.stdout).toMatch(/regrade  packed checkers on the bundles: [1-9]\d* cells, 0 changed verdicts, 0 errors {2}ok/);
    writeFileSync(join(out, 'notes.txt'), `token ${FAKE_KEY}\n`);
    const leaked = verify();
    expect(leaked.code).toBe(1);
    expect(leaked.stdout).toContain('secrets  Anthropic key or token in notes.txt  FAIL');
    expect(leaked.stdout).not.toContain(FAKE_KEY);
    rmSync(join(out, 'notes.txt'));
    const lines = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n');
    writeFileSync(join(out, 'runs.jsonl'), `${lines.slice(1).join('\n')}\n`);
    expect(verify().stdout).toMatch(/cells {4}1 problems: .* has 0 records {2}FAIL/);
  }, 300_000);

  it('finds a key-shaped value in a plain file and inside a git bundle, and names only its shape', () => {
    const clean = tmp('keys-');
    bundleRepo(clean, tmp);
    expect(findKeys(clean)).toEqual([]);
    const repo = tmp('keys-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, '.env'), `KEY=${FAKE_KEY}\n`);
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x');
    const sub = tmp('keys-sub-');
    git('bundle', 'create', join(sub, 'cell.bundle').replace(/\\/g, '/'), '--all');
    expect(findKeys(sub)).toEqual([{ file: 'cell.bundle', shape: 'Anthropic key or token' }]);
    expect(shapesIn(['sk', 'proj', 'y'.repeat(40)].join('-'))).toEqual(['OpenAI key']);
  });

  it('doctor checks tools, the pinned Claude Code version with no token in its env, and each repo at its fix', () => {
    const ds = makeDataset(tmp);
    const seen = join(tmp('doc-seen-'), 'env.json');
    const fake = join(tmp('doc-bin-'), 'claude.cjs');
    writeFileSync(fake, `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));\nconsole.log('2.1.288 (Claude Code)');\n`);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'not-a-real-token';
    const ok = runDoctor({ dataset: loadDataset(ds), scratch: tmp('doc-'), claudeBin: `"${process.execPath}" "${fake}"` });
    expect(ok.ok, ok.lines.join('\n')).toBe(true);
    expect(ok.lines).toContain('setup     2 of 2 repos pass setup and tests  ok');
    expect(ok.lines.find((l: string) => l.startsWith('pins'))).toContain('Claude Code 2.1.288, pinned 2.1.288');
    expect(JSON.parse(readFileSync(seen, 'utf8')).map((k: string) => k.toUpperCase())).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(ok.lines.at(-1)).toBe('model     no model call · $0');
  });
});
