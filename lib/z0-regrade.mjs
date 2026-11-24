#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTasks } from './ab-run.mjs';
import { parseZ0Records } from './z0-records.mjs';
import { listGrades, runRegrade } from './regrade.mjs';
import { flipsOf } from './g5-flips.mjs';
import { assertCheckersJudged, drawReader, readerSummary, scoreReader } from './reader-sample.mjs';
import { drawStored, scoreStored, storedSummary } from './stored-sample.mjs';
import { loadAdapter } from './adapter.mjs';

const USAGE = [
  'usage: z0-regrade.mjs regrade --out DIR --tasks FILE [--runs FILE] [--post-fix] [--cell KEY]...',
  '       z0-regrade.mjs reader --out DIR (--tasks FILE --seed N [--n N] [--round K] [--flip-errors] [--memory MANIFEST] | [--round K] --labels FILE)',
  '       z0-regrade.mjs stored --out DIR (--tasks FILE --seed N [--n N] [--runs FILE] [--memory MANIFEST] | --labels FILE)',
  '       z0-regrade.mjs grading --out DIR [--flip-errors]',
].join('\n');
const MODES = {
  regrade: { values: ['--out', '--tasks', '--runs'], multi: ['--cell'], flags: ['--post-fix'], required: ['--out', '--tasks'] },
  reader: { values: ['--out', '--tasks', '--seed', '--n', '--round', '--labels', '--memory'], multi: [], flags: ['--flip-errors'], required: ['--out'] },
  stored: { values: ['--out', '--tasks', '--runs', '--seed', '--n', '--labels', '--memory'], multi: [], flags: [], required: ['--out'] },
  grading: { values: ['--out'], multi: [], flags: ['--flip-errors'], required: ['--out'] },
};
const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const spec = MODES[mode];
  if (!spec) throw new Error(USAGE);
  const args = { mode };
  for (const f of spec.multi) args[camel(f)] = [];
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (spec.flags.includes(f)) {
      args[camel(f)] = true;
      continue;
    }
    if (!spec.values.includes(f) && !spec.multi.includes(f)) throw new Error(`${mode}: unknown flag ${f}\n${USAGE}`);
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${mode}: ${f} needs a value`);
    if (spec.multi.includes(f)) args[camel(f)].push(v);
    else if (camel(f) in args) throw new Error(`${mode}: ${f} given twice`);
    else args[camel(f)] = v;
  }
  for (const f of spec.required) if (args[camel(f)] === undefined) throw new Error(`${mode} needs ${f}\n${USAGE}`);
  return args;
}

export function withLock(out, fn) {
  const lock = path.join(out, 'g5', 'regrade.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    throw new Error(`${lock} exists: another regrade is running, or one was killed; remove the file by hand once none runs`);
  }
  fs.writeSync(fd, `${process.pid}\n`);
  fs.closeSync(fd);
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || v === undefined || v.constructor !== Object) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
};

function regradeMode(args, out, cwd, log) {
  const tasksFile = path.resolve(cwd, args.tasks);
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), path.dirname(tasksFile));
  const runsFile = args.runs ? path.resolve(cwd, args.runs) : path.join(out, 'runs.jsonl');
  const { records } = parseZ0Records(fs.readFileSync(runsFile, 'utf8'), runsFile);
  const pass = args.postFix ? 'postfix' : 'repro';
  const assertCheckers = (pairs) => assertCheckersJudged(out, pairs);
  const tally = runRegrade({ out, spec, records, runsFile, pass, cells: args.cell, baseEnv: process.env, log, assertCheckers });
  const wrote = tally.regraded ? `; wrote ${tally.regraded}` : '';
  return `${pass}: regraded ${tally.ran} cells (${tally.errors} with errors), skipped ${tally.skipped} done ones${wrote}\n`;
}

export function buildGrading(out, { flipErrors = false } = {}) {
  const entries = listGrades(out);
  if (entries.length === 0) throw new Error(`no grade.json under ${path.join(out, 'grading')}`);
  const f = flipsOf(out, entries, flipErrors);
  const reader = readerSummary(out);
  const g5 = {
    pass: f.pass, cells: entries.length, unreproducible: { cells: f.unrepro.cells.size, lessons: [...f.unrepro.lessons].sort() }, ...reader.g5, extraEnvKeys: [...f.extra].sort(),
  };
  const grading = { flippedLessons: [...f.flipped].sort(), acceptanceFlips: f.accepted.size, readerSample: reader.readerSample, g5 };
  const storedSample = storedSummary(out);
  if (storedSample) grading.storedSample = storedSample;
  return sortKeys(grading);
}

const count = (v, flag, min) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${flag} must be a whole number of at least ${min}, got ${v}`);
  return Number(v);
};

function sampleArgs(args, cwd, drawFlags) {
  if (args.labels !== undefined) {
    const extra = drawFlags.filter((f) => args[camel(f)] !== undefined);
    if (extra.length) throw new Error(`${args.mode} --labels scores a drawn sample and takes no ${extra.join(', ')}`);
    return { labels: path.resolve(cwd, args.labels) };
  }
  for (const f of ['--tasks', '--seed']) if (args[camel(f)] === undefined) throw new Error(`${args.mode} needs ${f} to draw, or --labels to score\n${USAGE}`);
  const memoryWords = args.memory === undefined ? [] : loadAdapter(path.resolve(cwd, args.memory)).hiddenWords;
  return { tasksFile: path.resolve(cwd, args.tasks), seed: count(args.seed, '--seed', 0), n: count(args.n, '--n', 1) ?? 30, memoryWords };
}

function readerMode(args, out, cwd) {
  const round = count(args.round, '--round', 1) ?? 1;
  const a = sampleArgs(args, cwd, ['--tasks', '--seed', '--n', '--memory']);
  return a.labels ? scoreReader(out, round, a.labels) : drawReader(out, { ...a, round, flipErrors: args.flipErrors === true, aliases: [args.given] });
}

function storedMode(args, out, cwd) {
  const a = sampleArgs(args, cwd, ['--tasks', '--seed', '--n', '--runs', '--memory']);
  if (a.labels) return scoreStored(out, a.labels);
  return drawStored(out, { ...a, aliases: [args.given], runsFile: args.runs ? path.resolve(cwd, args.runs) : path.join(out, 'runs.jsonl') });
}

function gradingMode(args, out) {
  const file = path.join(out, 'grading.json');
  fs.rmSync(file, { force: true });
  const grading = buildGrading(out, { flipErrors: args.flipErrors === true });
  fs.writeFileSync(file, `${JSON.stringify(grading, null, 2)}\n`);
  return `wrote ${file}: ${grading.flippedLessons.length} flipped lessons, ${grading.acceptanceFlips} acceptance flips\n`;
}

const RUN = { regrade: regradeMode, reader: readerMode, stored: storedMode, grading: gradingMode };

export function runCli(argv, cwd = process.cwd()) {
  const notes = [];
  try {
    const args = parseArgs(argv);
    const given = path.resolve(cwd, args.out);
    if (!fs.existsSync(given)) throw new Error(`--out ${args.out}: no such folder`);
    const out = fs.realpathSync.native(given);
    const stdout = withLock(out, () => RUN[args.mode]({ ...args, given }, out, cwd, (m) => notes.push(m)));
    return { code: 0, stdout, stderr: notes.map((n) => `${n}\n`).join('') };
  } catch (err) {
    return { code: 1, stdout: '', stderr: [...notes, err.message].map((n) => `${n}\n`).join('') };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
