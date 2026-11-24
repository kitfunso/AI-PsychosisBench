// The public round 3 verdict table rebuilds the paper's main numbers and the leaderboard row with no private file.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const out = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'round3', 'tables.mjs'), '--json'], { encoding: 'utf8' }));
const score = JSON.parse(readFileSync(join(ROOT, 'docs', 'scores', 'hippo-r3.json'), 'utf8'));

describe('round3/outcomes.jsonl', () => {
  it('holds every round 3 record, scored or with its exclusion reason', () => {
    expect(out).toMatchObject({ rows: 4862, scored: 4345 });
  });

  it('rebuilds the first-apply rates of Figure 1', () => {
    expect(Object.fromEntries(Object.entries(out.figure).map(([a, v]: [string, any]) => [a, v.rate])))
      .toEqual({ A0: '0.839', A1: '0.265', A2: '0.116', A5: '0.107', A4: '0.068' });
  });

  it('rebuilds H1 and the attribution contrast of the score file', () => {
    expect(out.table4['H1: A2 - A1'][0]).toBe('-0.149 [-0.243, -0.055]');
    expect(out.table4['Attribution: A2 - A5'][0]).toBe('+0.009 [-0.052, 0.070]');
    expect(score.H1.estimate.toFixed(3)).toBe('-0.149');
    expect(score.learn.estimate.toFixed(3)).toBe('0.009');
  });

  it('rebuilds the post-hoc rows with their unit and repository counts', () => {
    expect(out.table5['Python repositories dropped']).toEqual(['-0.106 [-0.207, -0.005]', '+0.030 [-0.013, 0.073]', '116 / 22']);
    expect(out.table5['Any cancelled hook dropped (51 positions)'][2]).toBe('142 / 28');
  });

  it('rebuilds the void and perfect-memory rows added after review', () => {
    expect(out.sequenceSeedsWithVoid).toBe(39);
    expect(out.table5['Positions after a void dropped']).toEqual(['-0.154 [-0.260, -0.049]', '+0.019 [-0.059, 0.096]', '116 / 27']);
    expect(out.table5['Sequence-seeds with a void dropped'][2]).toBe('84 / 21');
    expect(out.table4['A2 - A4 (seeds 1-2)'][0]).toBe('+0.057 [-0.023, 0.136]');
    expect(out.signTest.H1ReposDiffered).toEqual({ tWorse: 2, tBetter: 11 });
    expect(out.table3MaxCodingGap).toBe('0.010');
  });
});
