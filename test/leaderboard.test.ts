// The leaderboard is built from committed score files, and round 3's score file is what `score` gives on round 3's run.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLeaderboard, leaderboardJson, rankedRow } from '../lib/leaderboard.mjs';
import { scoreRun } from '../lib/score.mjs';

const DOCS = join(__dirname, '..', 'docs');
const R3 = 'C:/z0-runs/scored/r3-final';
const read = (rel: string) => JSON.parse(readFileSync(join(DOCS, rel), 'utf8'));

describe('the leaderboard', () => {
  it('is the JSON that lib/leaderboard.mjs builds from docs/scores, with no number typed by hand', () => {
    expect(read('leaderboard.json')).toEqual(JSON.parse(leaderboardJson(DOCS)));
  });

  it('ranks round 3 as hippo 3.3.1 (round 3 build) with the numbers its score file holds', () => {
    const score = read('scores/hippo-r3.json');
    const [hippo, open] = read('leaderboard.json').rows;
    expect(hippo).toMatchObject({ label: 'hippo, round 3 run', memory: 'hippo', version: '3.3.1 (round 3 build)', status: 'round 3 run' });
    expect(hippo.vsBuiltIn).toMatchObject({ estimate: score.H1.estimate, low: score.H1.low, high: score.H1.high, text: '-0.149 [-0.243, -0.055]' });
    expect(hippo.learns).toMatchObject({ estimate: score.learn.estimate, low: score.learn.low, high: score.learn.high, text: '+0.009 [-0.052, 0.070]' });
    expect(score).toMatchObject({ records: 4862, planned: 4862, gates: { G1: true, G2: true, G3: true, G4: true, G5: true }, iterations: 10000, seed: 1 });
    expect(readFileSync(join(DOCS, '..', 'README.md'), 'utf8')).toContain(`learns ${hippo.learns.text}, vs built-in ${hippo.vsBuiltIn.text}`);
    expect(open).toEqual({ label: 'your memory', memory: 'your memory', version: null, learns: null, vsBuiltIn: null, status: 'register, run, submit' });
  });

  it('refuses a score file with a failed gate or no numbers', () => {
    const score = read('scores/hippo-r3.json');
    const row = { label: 'x', score: 'x.json', status: 's' };
    expect(() => rankedRow(row, JSON.stringify({ ...score, gates: { ...score.gates, G3: false } }))).toThrow('x.json: a gate failed, so the run is not ranked');
    expect(() => rankedRow(row, JSON.stringify({ ...score, learn: null }))).toThrow('x.json: needs H1, learn');
    expect(() => buildLeaderboard([row], () => '{"schema":"other"}')).toThrow('x.json: schema other');
  });

  // Round 3's runs live on the machine that ran them; elsewhere this check is skipped.
  it.skipIf(!existsSync(join(R3, 'blind.json')))('matches `score` run again on round 3', () => {
    const fresh = scoreRun(R3, { memory: join(__dirname, '..', 'adapters', 'hippo.json') });
    const { inputs, ...rest } = read('scores/hippo-r3.json');
    expect(JSON.parse(JSON.stringify(fresh))).toMatchObject(rest);
    expect(fresh.inputs.map((i: { sha256: string }) => i.sha256)).toEqual(inputs.map((i: { sha256: string }) => i.sha256));
  }, 120_000);
});
