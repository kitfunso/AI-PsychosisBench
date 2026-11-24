import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneFresh } from './exec.mjs';
import { checkerIdentity } from './checker-identity.mjs';
import { lessonIndex } from './lessons.mjs';
import { listGrades, readRows, regradeCell, taskOf, isGraded } from './regrade.mjs';
import { cellKey, parseZ0Records } from './z0-records.mjs';
import { gradingDirOf } from './run-dir.mjs';

const RECORD_FIELD = { first: 'first', final: 'final', stale: 'staleFollow' };

export function compareRow(record, row) {
  const lesson = record.lessons[0];
  const changes = [];
  const crashed = [];
  for (const c of row.checks) {
    if (c.regraded === 'error') crashed.push(`${c.lessonId} ${c.which}`);
    else if (c.regraded !== lesson[RECORD_FIELD[c.which]]) changes.push({ lessonId: c.lessonId, which: c.which, run: lesson[RECORD_FIELD[c.which]], packed: c.regraded });
  }
  return { changes, crashed };
}

function partCells(part, faults) {
  const { records } = parseZ0Records(fs.readFileSync(part.runs, 'utf8'), part.runs);
  const graded = records.filter((r) => isGraded(r) && r.lessons.length > 0);
  const out = gradingDirOf(part);
  const grades = new Map(listGrades(out).map((e) => [e.key, e]));
  const cells = [];
  for (const r of graded) {
    const entry = grades.get(cellKey(r));
    if (!entry) faults.push({ key: cellKey(r), stage: 'grade', message: `no grade.json under ${path.join(out, 'grading')}` });
    else if (entry.grade.lessonId !== r.lessons[0].lessonId) faults.push({ key: cellKey(r), stage: 'grade', message: `grade.json is for lesson ${entry.grade.lessonId}, the record for ${r.lessons[0].lessonId}` });
    else cells.push({ record: r, entry });
  }
  const runOf = (c) => `${c.entry.grade.runName}/${c.entry.grade.arm}/seed${c.entry.grade.seed}`;
  return cells.sort((a, b) => runOf(a).localeCompare(runOf(b)) || a.entry.key.localeCompare(b.entry.key)).map((c) => ({ ...c, run: runOf(c) }));
}

function datasetContext(dataset, scratch) {
  const lessons = lessonIndex(dataset.spec.families ?? []);
  const lesson = (id) => {
    const hit = lessons.get(id);
    if (!hit) throw new Error(`lesson ${id} is not in the dataset at ${dataset.dir}; pass the dataset the run used`);
    return hit.lesson;
  };
  const cachedFor = (seq) => {
    const dir = path.join(scratch, 'repo-cache', seq);
    if (!fs.existsSync(dir)) {
      const s = dataset.spec.sequences.find((x) => x.id === seq);
      if (!s) throw new Error(`sequence ${seq} is not in the dataset at ${dataset.dir}`);
      cloneFresh(s.repoPath, dir);
    }
    return dir;
  };
  return { pass: 'dataset', lessonsOnly: true, baseEnv: process.env, passEnv: [], extraEnvKeys: [], lesson, checkerId: (id) => checkerIdentity(lesson(id)), cachedFor };
}

export function regradeRun({ dataset, parts, scratch, log = () => {} }) {
  fs.mkdirSync(scratch, { recursive: true });
  const rowsFile = path.join(scratch, 'regrade.jsonl');
  const { rows: done, torn, whole } = readRows(rowsFile);
  if (torn) fs.truncateSync(rowsFile, whole);
  const base = datasetContext(dataset, scratch);
  const packedSha = new Map();
  const shaOf = (id) => packedSha.get(id) ?? packedSha.set(id, base.checkerId(id)).get(id);
  const current = (row) => row?.status === 'done' && row.checks.every((ch) => ch.checkerSha === shaOf(ch.lessonId));
  const tally = { parts: parts.length, cells: 0, checks: 0, checkerChanged: new Set(), changes: [], faults: [] };
  parts.forEach((part, i) => {
    const cells = partCells(part, tally.faults);
    log(`part ${i + 1} of ${parts.length}: ${cells.length} cells, ${part.runs}`);
    const ctx = { ...base, out: path.join(scratch, 'work') };
    let open = null;
    for (const c of cells) {
      if (open !== null && open !== c.run) fs.rmSync(path.join(ctx.out, 'rg', open), { recursive: true, force: true });
      open = c.run;
      const id = `${part.runs}|${c.entry.key}`;
      let row = done.get(id);
      if (!current(row)) {
        row = { ...regradeCell(ctx, { ...c.entry, t: taskOf(dataset.spec, c.entry.grade) }, null), key: id, cell: c.entry.key, runsFile: part.runs };
        fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      }
      tally.cells += 1;
      tally.checks += row.checks.length;
      for (const ch of row.checks) if (ch.checkerSha !== c.entry.grade.checkers[ch.lessonId]) tally.checkerChanged.add(ch.lessonId);
      const { changes, crashed } = compareRow(c.record, row);
      tally.changes.push(...changes.map((x) => ({ ...x, key: c.entry.key, runs: part.runs })));
      if (row.status === 'error') tally.faults.push({ key: c.entry.key, stage: row.error.stage, message: row.error.message });
      else if (crashed.length) tally.faults.push({ key: c.entry.key, stage: 'checker', message: `crashed: ${crashed.join(', ')}` });
      else if (row.checks.length === 0) tally.faults.push({ key: c.entry.key, stage: 'checker', message: 'the run saved no lesson verdict to regrade' });
    }
    fs.rmSync(path.join(scratch, 'work'), { recursive: true, force: true });
  });
  fs.rmSync(path.join(scratch, 'repo-cache'), { recursive: true, force: true });
  return tally;
}

export function regradeText(t) {
  const lines = [`grading  every lesson of ${t.parts} runs file${t.parts === 1 ? '' : 's'} with the packed checkers: ${t.cells} cells, ${t.checks} checks`];
  if (t.checkerChanged.size) lines.push(`checkers ${t.checkerChanged.size} lessons' packed checker differs from the one the run saved: ${[...t.checkerChanged].sort().join(', ')}`);
  lines.push(`changed  ${t.changes.length} verdicts`);
  for (const c of t.changes) lines.push(`  ${c.key} ${c.lessonId} ${c.which}: run ${c.run}, packed ${c.packed} (${c.runs})`);
  if (t.faults.length) lines.push(`errors   ${t.faults.length} cells could not be regraded`);
  for (const f of t.faults) lines.push(`  ${f.key} ${f.stage}: ${f.message}`);
  return lines.join('\n');
}
