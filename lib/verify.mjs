import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRunDir } from './run-dir.mjs';
import { splitPlan } from './register.mjs';
import { regradeRun } from './dataset-regrade.mjs';
import { findKeys } from './secrets.mjs';
import { SPLITS } from './dataset.mjs';
import { cellKey, parsePlan, parseZ0Records } from './z0-records.mjs';

export function cellProblems(planCells, records) {
  const counts = new Map(planCells.map((c) => [cellKey(c), 0]));
  const extra = [];
  for (const r of records) {
    const k = cellKey(r);
    if (counts.has(k)) counts.set(k, counts.get(k) + 1);
    else extra.push(k);
  }
  const bad = [...counts].filter(([, n]) => n !== 1).map(([k, n]) => `${k} has ${n} records`);
  return [...bad, ...extra.map((k) => `${k} is not in the plan`)];
}

export function registeredSplit(planText, loadSplit) {
  const sha = createHash('sha256').update(planText).digest('hex');
  for (const split of SPLITS) {
    const plan = splitPlan(loadSplit(split));
    if (plan.sha256 === sha) return { split, sha256: sha };
  }
  return { split: null, sha256: sha };
}

export function verifySubmission({ dir, loadSplit, scratch, log = () => {} }) {
  const run = readRunDir(dir);
  if (run.parts.length !== 1 || run.parts[0].out !== run.dir) throw new Error(`${dir} is not a runner out dir; submit the folder the run wrote, with runs.jsonl, plan.json and grading/`);
  const part = run.parts[0];
  const planText = fs.readFileSync(part.plan, 'utf8');
  const lines = [];
  const say = (ok, line) => {
    lines.push(`${line}  ${ok ? 'ok' : 'FAIL'}`);
    return ok;
  };
  const reg = registeredSplit(planText, loadSplit);
  const planOk = say(reg.split !== null, `plan     sha256 ${reg.sha256}${reg.split ? ` is the ${reg.split} split's plan` : ' matches no split of this dataset'}`);
  const { records } = parseZ0Records(fs.readFileSync(part.runs, 'utf8'), part.runs);
  const bad = cellProblems(parsePlan(planText, part.plan), records);
  const cellsOk = say(bad.length === 0, `cells    ${bad.length === 0 ? 'every planned cell has one record' : `${bad.length} problems: ${bad.slice(0, 5).join('; ')}`}`);
  const t = regradeRun({ dataset: loadSplit(reg.split ?? 'full'), parts: run.parts, scratch, log });
  const regradeOk = say(t.changes.length === 0 && t.faults.length === 0, `regrade  packed checkers on the bundles: ${t.cells} cells, ${t.changes.length} changed verdicts, ${t.faults.length} errors`);
  const keys = findKeys(dir);
  const keysOk = say(keys.length === 0, `secrets  ${keys.length === 0 ? 'no key-shaped value in any file' : keys.map((k) => `${k.shape} in ${k.file}`).join('; ')}`);
  return { ok: planOk && cellsOk && regradeOk && keysOk, lines, regrade: t };
}

export const scratchFor = (base, name, dir) => path.join(base, `${name}-${createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)}`);
