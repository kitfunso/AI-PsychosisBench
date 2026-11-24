import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeZ0, loadInputs, ITERATIONS, SEED } from './z0-analyze.mjs';
import { inputHashes } from './z0-blind.mjs';
import { loadAdapter, adapterKeys } from './adapter.mjs';
import { readRunDir, BENCH_PRICES } from './run-dir.mjs';
import { BENCH, SLUG } from './name.mjs';

export const SCORE_SCHEMA = `${SLUG}-score/1`;
const GATES = ['G1', 'G2', 'G3', 'G4', 'G5'];

const f3 = (x) => x.toFixed(3);
const signed = (x) => `${x > 0 ? '+' : ''}${f3(x)}`;
const pick = (e) => ({ estimate: e.violation.estimate, low: e.violation.low, high: e.violation.high, units: e.violation.units });
export const estimateText = (e) => `${signed(e.estimate)} [${f3(e.low)}, ${f3(e.high)}]`;

export function scoreRun(runDir, { memory = null, iterations = ITERATIONS, seed = SEED } = {}) {
  const run = readRunDir(runDir);
  const args = { runs: run.parts.map((p) => p.runs), plan: run.parts.map((p) => p.plan), prices: run.prices ?? BENCH_PRICES, grading: run.grading, dropList: run.dropList, out: null };
  const inputs = loadInputs(args, process.cwd());
  const manifest = memory === null ? null : loadAdapter(path.resolve(memory));
  const analysis = analyzeZ0(inputs.records, { ...inputs, adapterKeys: manifest ? adapterKeys(manifest) : [], iterations, seed, unblind: true, refuse: () => null });
  const h = analysis.hypotheses;
  const has = (x) => x && typeof x === 'object' && x.violation;
  const counts = Object.values(analysis.filtered.counts);
  return {
    schema: SCORE_SCHEMA, bench: BENCH, run: run.dir, from: run.from, parts: run.parts.length,
    memory: manifest ? { name: manifest.name, version: manifest.version ?? null } : null,
    claudeVersions: [...new Set(inputs.records.map((r) => r.claudeVersion).filter(Boolean))].sort(),
    models: [...new Set(inputs.records.map((r) => r.model).filter(Boolean))].sort(),
    arms: analysis.filtered.arms, records: counts.reduce((n, c) => n + c.records, 0), planned: counts.reduce((n, c) => n + c.planned, 0),
    status: analysis.status, gates: analysis.gates ? Object.fromEntries(GATES.map((g) => [g, analysis.gates[g].pass])) : null,
    G5: analysis.gates?.G5.status ?? null, iterations, seed,
    H1: has(h?.H1) ? { ...pick(h.H1), verdict: h.verdicts.H1.final.verdict } : null,
    learn: has(h?.attribution) ? pick(h.attribution) : null,
    inputs: inputHashes(args, process.cwd()),
  };
}

const LITE_NOTE = 'no score: the run plans no A0 or A4, so gate G2 cannot run (a lite run); run --split full for a leaderboard row';

export function scoreText(s) {
  const lines = [`run      ${s.run} (${s.parts} runs file${s.parts === 1 ? '' : 's'}, from ${path.basename(s.from)})`, `records  ${s.records} of ${s.planned} planned; arms ${s.arms.join(' ')}`];
  if (s.gates === null) return [...lines, `no score: the run is ${s.status}`].join('\n');
  const failed = GATES.filter((g) => !s.gates[g]);
  lines.push(failed.length === 0 ? `gates    ${GATES.join(' ')} pass` : `gates    ${GATES.map((g) => `${g} ${s.gates[g] ? 'pass' : 'fail'}`).join(', ')}${s.gates.G5 ? '' : ` (G5: ${s.G5})`}`);
  if (!['A0', 'A4'].every((a) => s.arms.includes(a))) lines.push(LITE_NOTE);
  else if (failed.length) lines.push(`no score: ${failed.join(', ')} failed`);
  if (s.H1) lines.push(`H1       A2 - A1  ${estimateText(s.H1)}  (${s.H1.units} units, ${s.H1.verdict})`);
  if (s.learn) lines.push(`learn    A2 - A5  ${estimateText(s.learn)}  (${s.learn.units} units)`);
  return lines.join('\n');
}

const USAGE = `usage: ${SLUG} score --run DIR [--memory MANIFEST] [--json FILE]`;

export function scoreCli(argv, flags) {
  const runDir = flags.one('--run');
  if (runDir === null) throw new Error(USAGE);
  const s = scoreRun(runDir, { memory: flags.one('--memory') });
  const json = flags.one('--json');
  if (json !== null) fs.writeFileSync(path.resolve(json), `${JSON.stringify(s, null, 2)}\n`);
  return { code: s.H1 && s.learn ? 0 : 1, stdout: `${scoreText(s)}\n`, stderr: '' };
}
