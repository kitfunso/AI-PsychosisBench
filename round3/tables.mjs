// Rebuilds the paper's Figure 1 and Tables 3-5 from round3/outcomes.jsonl alone, with the frozen analyser's functions.
// Run: node round3/tables.mjs            (add --json for machine-readable output)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from '../lib/z0-hypotheses.mjs';
import * as RT from '../lib/stats/repository-t.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(HERE, 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const scored = rows.filter((r) => r.excluded === null);
const ARMS = ['A0', 'A1', 'A2', 'A5', 'A4'];
const fa = H.firstApplyR;
const opts = {};
const f3 = (x) => x.toFixed(3);
const sg = (x) => (x > 0 ? '+' : '') + f3(x);
const ci = (e) => `${sg(e.estimate)} [${f3(e.low)}, ${f3(e.high)}]`;
const between = (lo, hi) => (r) => r.tasksSinceTeach >= lo && r.tasksSinceTeach <= hi;

function rate(s, arm, keep, coding = 'violation') {
  const e = H.armRate(s, arm, coding, keep, opts);
  return { estimate: e.estimate, low: e.low, high: e.high, units: e.units };
}

function contrast(s, t, c, keep, coding = 'violation') {
  const { units } = H.repeatMistakeUnits(s, t, c, coding, keep);
  const e = H.repeatMistake(s, t, c, coding, opts, keep);
  const repos = [...new Set(units.map((u) => u.repo))];
  const repoMeans = repos.map((r) => H.mean(units.filter((u) => u.repo === r).map((u) => u.value)));
  const loo = repos.map((r) => RT.fixedRepositoryT(units.filter((u) => u.repo !== r), 0).estimate);
  return { estimate: e.estimate, low: e.low, high: e.high, p: e.p, df: e.df, units: units.length, repos: repos.length,
    differed: { tWorse: units.filter((u) => u.value > 0).length, tBetter: units.filter((u) => u.value < 0).length },
    reposDiffered: { tWorse: repoMeans.filter((m) => m > 0).length, tBetter: repoMeans.filter((m) => m < 0).length },
    repositoryT: RT.repositoryT(repoMeans), leaveOneOut: [Math.min(...loo), Math.max(...loo)] };
}

const figure = Object.fromEntries(ARMS.map((a) => {
  const e = rate(scored, a, fa);
  return [a, { rate: f3(e.estimate), halfWidth: f3((e.high - e.low) / 2), units: e.units }];
}));

const resolveRate = (arm) => H.mean(scored.filter((r) => r.arm === arm).map((r) => (r.resolved ? 1 : 0)));
const later = (r) => r.set === 'R' && r.applyIndex >= 2;
const since = (lo, hi) => (r) => r.set === 'R' && between(lo, hi)(r);
const failureRows = { fa, later, since24: since(2, 4), since59: since(5, 9) };
const table3 = {
  'First apply (H1 unit)': ARMS.map((a) => f3(rate(scored, a, fa).estimate)),
  '95% interval': ARMS.map((a) => { const e = rate(scored, a, fa); return `[${f3(e.low)}, ${f3(e.high)}]`; }),
  'Later applies': ARMS.map((a) => f3(rate(scored, a, later).estimate)),
  'All applies, 2-4 tasks after teach': ARMS.map((a) => f3(rate(scored, a, failureRows.since24).estimate)),
  'All applies, 5-9 tasks after teach': ARMS.map((a) => f3(rate(scored, a, failureRows.since59).estimate)),
  'Resolve rate, all tasks': ARMS.map((a) => f3(resolveRate(a))),
};
const codingGap = Math.max(...Object.values(failureRows).flatMap((k) => ARMS.map((a) =>
  Math.abs(rate(scored, a, k, 'violation').estimate - rate(scored, a, k, 'excluded').estimate))));

const both = (s, t, c, keep) => {
  const v = contrast(s, t, c, keep, 'violation');
  const x = contrast(s, t, c, keep, 'excluded');
  return [ci(v), ci(x), String(v.units)];
};
const noPromptHook = scored.filter((r) => !r.promptHookCancel);
const table4 = {
  'H1: A2 - A1': both(scored, 'A2', 'A1', fa),
  'Attribution: A2 - A5': both(scored, 'A2', 'A5', fa),
  'A5 - A1 (exploratory)': both(scored, 'A5', 'A1', fa),
  'A1 - A0 (seeds 1-2)': both(scored, 'A1', 'A0', fa),
  'A4 - A1 (seeds 1-2)': both(scored, 'A4', 'A1', fa),
  'A2 - A4 (seeds 1-2)': both(scored, 'A2', 'A4', fa),
  'A5 - A4 (seeds 1-2)': both(scored, 'A5', 'A4', fa),
  'H1, maintainer rules only': both(scored, 'A2', 'A1', (r) => fa(r) && H.maintainer(r)),
  'H1, all applies': both(scored, 'A2', 'A1', H.inSets('R')),
  'H1, all applies, 2-4 tasks after teach': both(scored, 'A2', 'A1', failureRows.since24),
  'H1, all applies, 5-9 tasks after teach': both(scored, 'A2', 'A1', failureRows.since59),
  'Prompt-hook positions dropped, H1: A2 - A1': both(noPromptHook, 'A2', 'A1', fa),
  'Prompt-hook positions dropped, Attribution: A2 - A5': both(noPromptHook, 'A2', 'A5', fa),
};

const post = (s, keep) => {
  const h1 = contrast(s, 'A2', 'A1', keep);
  const at = contrast(s, 'A2', 'A5', keep);
  return [ci(h1), ci(at), `${h1.units} / ${h1.repos}`];
};
const h1 = contrast(scored, 'A2', 'A1', fa);
const at = contrast(scored, 'A2', 'A5', fa);
const rt = (c) => ci(c.repositoryT);
// A voided session's memory carries on in its sequence, so these rows drop what came after it.
const firstVoid = new Map();
for (const r of rows.filter((x) => x.excluded === 'void-position')) {
  const k = `${r.sequence}#${r.seed}`;
  firstVoid.set(k, Math.min(firstVoid.get(k) ?? Infinity, r.position));
}
const beforeVoid = (r) => r.position < (firstVoid.get(`${r.sequence}#${r.seed}`) ?? Infinity);
const noVoidSeq = (r) => !firstVoid.has(`${r.sequence}#${r.seed}`);
const choose = (n, k) => { let c = 1; for (let i = 0; i < k; i += 1) c = (c * (n - i)) / (i + 1); return c; };
const signP = ({ tBetter, tWorse }) => {
  const n = tBetter + tWorse, k = Math.min(tBetter, tWorse);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
};
const table5 = {
  [`Repository-level t (${h1.repositoryT.df} df)`]: [rt(h1), rt(at), `${h1.units} / ${h1.repos}`],
  'Leave one repository out': [`${sg(h1.leaveOneOut[0])} to ${sg(h1.leaveOneOut[1])}`, `${sg(at.leaveOneOut[0])} to ${sg(at.leaveOneOut[1])}`, '--'],
  [`Any cancelled hook dropped (${new Set(rows.filter((r) => r.anyHookCancel).map((r) => `${r.sequence}#${r.seed}@${r.position}`)).size} positions)`]:
    post(scored.filter((r) => !r.anyHookCancel), fa),
  'Amendment E sequence-seeds dropped': post(scored, (r) => fa(r) && !r.rerunSeed),
  'Python repositories dropped': post(scored, (r) => fa(r) && !r.python),
  'New repositories only': post(scored, (r) => fa(r) && !r.returningRepo),
  '2-4 tasks after teach only': post(scored, (r) => fa(r) && between(2, 4)(r)),
  'Positions after a void dropped': post(scored, (r) => fa(r) && beforeVoid(r)),
  'Sequence-seeds with a void dropped': post(scored, (r) => fa(r) && noVoidSeq(r)),
};
const returning = post(scored, (r) => fa(r) && r.returningRepo);
// With few units that differ, one unit can swing the Satterthwaite df, so the Power paragraph reports this range.
const atUnits = H.repeatMistakeUnits(scored, 'A2', 'A5', 'violation', fa).units;
const dropOneDf = atUnits.map((_, i) => RT.fixedRepositoryT(atUnits.filter((__, j) => j !== i), 0).df);
const promptHookRepoT = contrast(noPromptHook, 'A2', 'A5', fa).repositoryT;

const out = { rows: rows.length, scored: scored.length, figure, table3, table3MaxCodingGap: f3(codingGap), table4, table5,
  H1p: { violation: h1.p, excluded: contrast(scored, 'A2', 'A1', fa, 'excluded').p },
  unitsThatDiffered: { H1: h1.differed, attribution: at.differed },
  signTest: { H1Units: signP(h1.differed), H1Repositories: signP(h1.reposDiffered), H1ReposDiffered: h1.reposDiffered },
  returningRepositoriesOnly: returning, sequenceSeedsWithVoid: firstVoid.size,
  promptHookPositionsBySet: Object.fromEntries(['R', 'N'].map((set) => [set,
    new Set(rows.filter((r) => r.set === set && r.promptHookCancel).map((r) => `${r.sequence}#${r.seed}@${r.position}`)).size])),
  attributionDf: { all: at.df, dropOneUnit: [Math.min(...dropOneDf), Math.max(...dropOneDf)], promptHookRepositoryT: ci(promptHookRepoT) } };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 1));
} else {
  const print = (title, t, head) => {
    console.log(`\n${title}\n${head}`);
    for (const [k, v] of Object.entries(t)) console.log(`${k} | ${v.join(' | ')}`);
  };
  console.log(`${rows.length} rows, ${scored.length} scored`);
  console.log('\nFigure 1 (first-apply rate +- half-width, units):');
  for (const [a, v] of Object.entries(figure)) console.log(`${a} ${v.rate} +- ${v.halfWidth} (${v.units} units)`);
  print('Table 3 (violation coding)', table3, ARMS.join(' | '));
  console.log(`Largest violation-excluded gap over the four failure-rate rows: ${f3(codingGap)}`);
  print('Table 4', table4, 'violation | excluded | units');
  print('Table 5 (violation coding)', table5, 'H1: A2 - A1 | Attribution: A2 - A5 | units / repos');
  console.log(`
Units where the arms differed: H1 ${h1.differed.tBetter} favour A2, ${h1.differed.tWorse} favour A1; attribution ${at.differed.tWorse} favour A5, ${at.differed.tBetter} favour A2`);
  console.log(`H1 raw p: violation ${out.H1p.violation.toFixed(4)}, excluded ${out.H1p.excluded.toFixed(4)}`);
  const rd = h1.reposDiffered;
  console.log(`H1 sign test: units p ${out.signTest.H1Units.toFixed(4)}; repositories ${rd.tBetter} favour A2, ${rd.tWorse} favour A1, p ${out.signTest.H1Repositories.toFixed(4)}`);
  console.log(`Returning repositories only (registered secondary line): H1 ${returning.join(' | ')}`);
  const d = out.attributionDf;
  console.log(`Attribution df ${d.all.toFixed(1)}; dropping one unit gives ${d.dropOneUnit[0].toFixed(1)} to ${d.dropOneUnit[1].toFixed(1)}; repository-level t with prompt-hook positions dropped ${d.promptHookRepositoryT}`);
}
