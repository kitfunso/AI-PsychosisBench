// A Python repo runs in a venv of its own, in the runner and in doctor, as round 3 ran each one (s3x-run.ps1).
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadDataset } from '../lib/dataset.mjs';
import { runAll } from '../lib/ab-run.mjs';
import { repoCheck } from '../lib/doctor.mjs';
import { venvRepos } from '../lib/venv.mjs';
import { sh } from '../lib/exec.mjs';
import { makeDataset, VENV_CHECK } from './fixtures/dataset.js';
import { cleanup, isolate, tmp, fixtureEnv } from './fixtures/z0-harness.js';

const FAKE = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
afterEach(cleanup);

describe('a Python repo', () => {
  it('runs every arm and seed in one venv under the out dir, where its setup and test pass', async () => {
    const { out } = isolate('venv');
    const d = loadDataset(makeDataset(tmp, { python: true }), { split: 'lite' });
    const venvs = venvRepos(d);
    expect([...venvs]).toEqual([['seqB', 'k2']]);
    const noVenv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'VIRTUAL_ENV'));
    expect(sh(VENV_CHECK, out, noVenv).status).not.toBe(0);
    await runAll({ spec: d.spec, arms: ['A0', 'A1'], seeds: 1, outDir: out, model: null, claudeBin: `"${process.execPath}" "${FAKE}"`, adapter: null, warmup: false, log: () => {}, passEnv: fixtureEnv(), venvRepos: venvs });
    const records = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(records).toHaveLength(4);
    expect(records.filter((r) => r.invalid)).toEqual([]);
    expect(records.every((r) => r.envKeys.includes('VIRTUAL_ENV'))).toBe(true);
    expect(readdirSync(join(out, 'venv'))).toEqual(['k2']);
    expect(existsSync(join(out, 'venv', 'k2', 'pyvenv.cfg'))).toBe(true);
  }, 300_000);

  it('gets a venv in doctor too, so its setup and test pass', () => {
    const d = loadDataset(makeDataset(tmp, { python: true }), { split: 'lite' });
    const r = repoCheck(d, 'k2', tmp('doc-venv-'), process.env, []);
    expect(r.ok, r.line).toBe(true);
  }, 120_000);
});
