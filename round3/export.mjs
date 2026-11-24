// Writes round3/outcomes.jsonl, the public per-session verdict table of round 3, from the private run records.
// Read-only on the inputs. Run: AIPB_COUNTS=<counts.json> AIPB_GRADING=<grading.json> AIPB_SENSITIVITY=<drop-list-sensitivity.json> node round3/export.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZ0Records, parsePlan, positionKey, runKey, isInvalid, isLeak, untaughtApplies } from '../lib/z0-records.mjs';
import { filterRecords, applyDrops, retryVoids } from '../lib/z0-filters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AIPB_R3_ROOT ?? 'C:/z0-runs/scored';
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}; see round3/README.md for the file it names.`);
  return JSON.parse(fs.readFileSync(v, 'utf8'));
};
const counts = need('AIPB_COUNTS');
const grading = need('AIPB_GRADING');
const promptHookList = need('AIPB_SENSITIVITY');

// The input rule of the frozen final read (C:/z0-runs/scored/r3-final-read.sh): every wave 1 run except gr3-w1, gr3-w1b,
// and the Amendment E reruns; a run in r3-merged is read from there, and runs.regraded.jsonl wins over runs.jsonl.
const runDirs = fs.readdirSync(path.join(ROOT, 'r3run'))
  .filter((n) => (/-w1$/.test(n) && n !== 'gr3-w1') || n === 'gr3-w1b' || /-e\d$/.test(n))
  .filter((n) => fs.statSync(path.join(ROOT, 'r3run', n)).isDirectory()).sort();
const inputs = runDirs.map((n) => {
  const merged = path.join(ROOT, 'r3-merged', n);
  const src = fs.existsSync(merged) ? merged : path.join(ROOT, 'r3run', n, 'run');
  const regraded = path.join(src, 'runs.regraded.jsonl');
  return { name: n, runs: fs.existsSync(regraded) ? regraded : path.join(src, 'runs.jsonl'), plan: path.join(src, 'plan.json') };
});
if (inputs.length !== 35) throw new Error(`expected the 35 runs files of the final read, found ${inputs.length}`);

const records = inputs.flatMap((i) => parseZ0Records(fs.readFileSync(i.runs, 'utf8'), i.runs).records.map((r) => ({ ...r, _run: i.name })));
const planCells = inputs.flatMap((i) => parsePlan(fs.readFileSync(i.plan, 'utf8'), i.plan));
const filtered = filterRecords(records, planCells, { grading, dropList: null });

// Why each record is out, replaying filterRecords' own predicates; the check below proves the replay matches it.
const leakedRuns = new Set(records.filter(isLeak).map((r) => runKey(r.sequence, r.seed)));
const voided = new Set(records.filter((r) => r.void !== null).map(positionKey));
const untaught = new Set(untaughtApplies(records, planCells).map(positionKey));
const retryFrom = retryVoids(records);
const reasonOf = (r) => {
  if (leakedRuns.has(runKey(r.sequence, r.seed))) return 'leak-run';
  if (isInvalid(r)) return 'invalid';
  if (voided.has(positionKey(r))) return 'void-position';
  if (r.position >= (retryFrom.get(runKey(r.sequence, r.seed)) ?? Infinity)) return 'retry-void';
  if (untaught.has(positionKey(r))) return 'untaught-apply';
  return null;
};
const cellOf = (r) => `${positionKey(r)}/${r.arm}/${r._run}`;
const scoredCells = new Set(filtered.scored.map(cellOf));
for (const r of records) {
  if ((reasonOf(r) === null) !== scoredCells.has(cellOf(r))) throw new Error(`exclusion replay disagrees with filterRecords at ${cellOf(r)}`);
}

// Hook-cancel records in the transcripts (Amendment B): a prompt-hook position is in the committed sensitivity list.
const promptHook = new Set(promptHookList.hookVoids.map(positionKey));
const anyHook = new Set();
const runRoot = path.join(ROOT, 'r3run');
const ls = (d) => (fs.existsSync(d) && fs.statSync(d).isDirectory() ? fs.readdirSync(d) : []);
const transcriptOf = new Map();
for (const run of ls(runRoot)) {
  const runsDir = path.join(runRoot, run, 'run', 'runs');
  for (const seq of ls(runsDir)) for (const arm of ls(path.join(runsDir, seq))) for (const seed of ls(path.join(runsDir, seq, arm))) {
    const pj = path.join(runsDir, seq, arm, seed, 'claude-config', 'projects');
    for (const p of ls(pj)) for (const f of ls(path.join(pj, p))) if (f.endsWith('.jsonl')) transcriptOf.set(f.slice(0, -6), path.join(pj, p, f));
  }
}
for (const r of records) {
  if (!['A2', 'A5'].includes(r.arm) || !r.sessionId || !transcriptOf.has(r.sessionId)) continue;
  const cancelled = fs.readFileSync(transcriptOf.get(r.sessionId), 'utf8').split('\n')
    .some((l) => l && JSON.parse(l).attachment?.type === 'hook_cancelled');
  if (cancelled) anyHook.add(positionKey(r));
}
for (const k of promptHook) if (!anyHook.has(k)) throw new Error(`prompt-hook position ${k} has no cancel record in the transcripts`);

// The prompt-hook drop must remove exactly the flagged positions, so tables.mjs can read it from the flag.
const withDrop = filterRecords(records, planCells, { grading, dropList: promptHookList }).scored.map(cellOf).sort();
const fromFlag = filtered.scored.filter((r) => !promptHook.has(positionKey(r))).map(cellOf).sort();
if (JSON.stringify(withDrop) !== JSON.stringify(fromFlag)) throw new Error('prompt-hook drop and the flag disagree');
const anyDrop = { droppedLessons: [], droppedFamilies: [], hookVoids: [...anyHook].map((k) => { const [s, p] = k.split('@'); const [sequence, seed] = s.split('#'); return { sequence, seed: Number(seed), position: Number(p) }; }) };
const withAny = filterRecords(records, planCells, { grading, dropList: anyDrop }).scored.map(cellOf).sort();
const fromAny = filtered.scored.filter((r) => !anyHook.has(positionKey(r))).map(cellOf).sort();
if (JSON.stringify(withAny) !== JSON.stringify(fromAny)) throw new Error('any-hook drop and the flag disagree');

const upstream = new Map(counts.perRepo.map((p) => [p.key.replace(/-r$/, ''), p.upstream?.[0]]));
const RERUN = new Set(['hu3#1', 'hu3#2', 'q133#1', 'q133#3', 'q14#1', 'q256#2']);
const RETURNING = new Set(['debezium/debezium', 'heroui-inc/heroui', 'getzep/graphiti']);
const python = new Set(ls(runRoot).filter((d) => ls(path.join(runRoot, d)).some((f) => f.startsWith('venv'))).map((d) => d.replace(/-(w1b?|e\d)(\..*)?$/, '')));
const repoOf = (r) => {
  const name = upstream.get(r.sequence);
  if (!name) throw new Error(`no upstream name for sequence ${r.sequence}`);
  return name;
};

const scoredOnly = applyDrops(records, grading, null);
const rows = scoredOnly.map((r) => ({
  repo: repoOf(r), sequence: r.sequence, seed: r.seed, position: r.position, arm: r.arm, set: r.set, kind: r.kind, tool: r.tool,
  taskId: r.taskId, familyId: r.familyId, lessonSource: r.lessonSource, applyIndex: r.applyIndex,
  tasksSinceTeach: r.tasksSinceTeach, afterReversal: r.afterReversal, resolved: r.resolved,
  lessons: r.lessons.map((l) => ({ lessonId: l.lessonId, first: l.first })),
  run: /-e\d$/.test(r._run) ? 'amendment-e-rerun' : 'wave-1',
  excluded: reasonOf(r),
  promptHookCancel: promptHook.has(positionKey(r)), anyHookCancel: anyHook.has(positionKey(r)),
  rerunSeed: RERUN.has(runKey(r.sequence, r.seed)), python: python.has(r.sequence), returningRepo: RETURNING.has(repoOf(r)),
}));
rows.sort((a, b) => a.sequence.localeCompare(b.sequence) || a.seed - b.seed || a.position - b.position || a.arm.localeCompare(b.arm) || a.run.localeCompare(b.run));
fs.writeFileSync(path.join(HERE, 'outcomes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ inputs: inputs.length, records: records.length, scored: filtered.scored.length, rows: rows.length,
  excluded: Object.fromEntries([...new Set(rows.map((r) => r.excluded))].map((k) => [String(k), rows.filter((r) => r.excluded === k).length])),
  promptHookPositions: promptHook.size, anyHookPositions: anyHook.size, python: [...python].sort() }));
