import * as fs from 'node:fs';
import * as path from 'node:path';
import { openContext } from './runs.mjs';
import { runSteps } from './task.mjs';

const SCREEN_SEEDS = [1, 2];
export const SCREEN_ARMS = ['A0', 'A4'];
const A0_OF = 4;
const A4_OF = 2;

function screenFamilies(spec) {
  return (spec.families ?? []).filter((f) => f.screen).map((family) => {
    const root = family.lessons.find((l) => !l.supersedes);
    const sequence = spec.sequences.find((s) => s.id === family.sequence);
    const teach = sequence.tasks.find((t) => t.kind === 'teach' && t.lessonId === root.id);
    if (!teach) throw new Error(`family ${family.id}: no teach task for its root lesson ${root.id} in sequence ${sequence.id}`);
    return { family, root, sequence, teach };
  });
}

export function planScreen(spec) {
  const steps = [];
  for (const { family, root, sequence, teach } of screenFamilies(spec)) {
    const role = {
      kind: 'screen', familyId: family.id, lessonId: root.id, lessonSource: family.lessonSource,
      applyIndex: null, afterReversal: null, tasksSinceTeach: null, set: null,
    };
    const screenTask = { ...family.screen, kind: 'screen', familyId: family.id, lessonId: root.id };
    const cell = { sequence, role, runName: `screen-${family.id}` };
    for (const seed of SCREEN_SEEDS) {
      steps.push({ ...cell, seed, arm: 'A0', position: 0, taskId: teach.id, t: teach });
      steps.push({ ...cell, seed, arm: 'A0', position: 1, taskId: screenTask.id, t: screenTask });
      steps.push({ ...cell, seed, arm: 'A4', position: 0, taskId: screenTask.id, t: screenTask, taught: [root] });
    }
  }
  return steps;
}

export function screenVerdicts(records, spec) {
  const rows = screenFamilies(spec).map(({ family }) => {
    const mine = records.filter((r) => r.familyId === family.id);
    const count = (arm, verdict) => mine.filter((r) => r.arm === arm && r.lessons[0]?.first === verdict).length;
    const row = { familyId: family.id, a0Breaks: count('A0', 'fail'), a0Of: A0_OF, a4Follows: count('A4', 'pass'), a4Of: A4_OF };
    const bad = mine.find((r) => r.invalid || r.void);
    if (bad) return { ...row, verdict: 'undecided', reason: `${bad.taskId} ${bad.arm} seed${bad.seed}: ${bad.invalid ? `invalid ${bad.invalid}` : `void ${bad.void}`}` };
    if (mine.length !== A0_OF + A4_OF) return { ...row, verdict: 'undecided', reason: `${mine.length} of ${A0_OF + A4_OF} screen sessions recorded` };
    return { ...row, verdict: row.a0Breaks >= 2 && row.a4Follows === A4_OF ? 'kept' : 'dropped' };
  });
  const by = (v) => rows.filter((r) => r.verdict === v);
  return { families: rows, kept: by('kept').map((r) => r.familyId), dropped: by('dropped'), undecided: by('undecided') };
}

export function screenLines(spec, steps) {
  const lines = steps.map((st, i) => `  ${i} ${st.runName} seed${st.seed} ${st.arm} ${st.sequence.id}/${st.taskId}`);
  for (const f of spec.families ?? []) if (!f.screen) lines.push(`  skipped ${f.id}: ${f.screenNote}`);
  return lines;
}

export async function runScreen(opts) {
  const ctx = await openContext({ ...opts, arms: SCREEN_ARMS, recordsFile: 'screen.jsonl', screen: true });
  const records = await runSteps(ctx, planScreen(opts.spec));
  const verdicts = screenVerdicts(records, opts.spec);
  fs.writeFileSync(path.join(opts.outDir, 'screen.json'), `${JSON.stringify(verdicts, null, 2)}\n`);
  return verdicts;
}
