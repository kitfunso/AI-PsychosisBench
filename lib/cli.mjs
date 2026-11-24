#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as runMain } from './ab-run.mjs';
import { loadDataset } from './dataset.mjs';
import { readRunDir } from './run-dir.mjs';
import { regradeRun, regradeText } from './dataset-regrade.mjs';
import { scoreCli } from './score.mjs';
import { costCli } from './cost.mjs';
import { registerCli } from './register.mjs';
import { verifySubmission, scratchFor } from './verify.mjs';
import { runDoctor, DOCTOR_USAGE } from './doctor.mjs';
import { REPO } from './exec.mjs';
import { BENCH, SLUG } from './name.mjs';

export const DATASET_DIR = path.join(REPO, 'out', `${SLUG}-r3-v1`);

export function parseFlags(argv, { values = [], multi = [], bools = [], positional = 0 } = {}) {
  const one = new Map();
  const many = new Map(multi.map((f) => [f, []]));
  const has = new Set();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bools.includes(a)) {
      has.add(a);
      continue;
    }
    if (!values.includes(a) && !multi.includes(a)) {
      if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
      rest.push(a);
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    if (multi.includes(a)) many.get(a).push(v);
    else if (one.has(a)) throw new Error(`${a} given twice`);
    else one.set(a, v);
  }
  if (rest.length > positional) throw new Error(`unexpected argument ${rest[positional]}`);
  return { one: (f) => one.get(f) ?? null, many: (f) => many.get(f) ?? [], has: (f) => has.has(f), rest };
}

const datasetOf = (flags) => flags.one('--dataset') ?? DATASET_DIR;
const splitOf = (flags) => flags.one('--split') ?? 'full';

function doctor(argv, flags, { log }) {
  const dataset = loadDataset(datasetOf(flags), { split: splitOf(flags) });
  const scratch = flags.one('--scratch') ?? fs.mkdtempSync(path.join(os.tmpdir(), `${SLUG}-doctor-`));
  try {
    const r = runDoctor({ dataset, scratch, claudeBin: flags.one('--claude-bin') ?? 'claude', passEnv: flags.many('--pass-env'), log });
    return { code: r.ok ? 0 : 1, stdout: `${r.lines.join('\n')}\n`, stderr: '' };
  } finally {
    if (!flags.one('--scratch')) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function regrade(argv, flags, { log, scratchBase }) {
  const runDir = flags.one('--run');
  if (runDir === null) throw new Error(`usage: ${SLUG} regrade --run DIR [--dataset DIR] [--scratch DIR]`);
  const dataset = loadDataset(datasetOf(flags));
  const run = readRunDir(runDir);
  const t = regradeRun({ dataset, parts: run.parts, scratch: flags.one('--scratch') ?? scratchFor(scratchBase, 'regrade', runDir), log });
  return { code: t.changes.length === 0 && t.faults.length === 0 ? 0 : 1, stdout: `${regradeText(t)}\n`, stderr: '' };
}

function verify(argv, flags, { log, scratchBase }) {
  const [dir] = flags.rest;
  if (!dir) throw new Error(`usage: ${SLUG} verify SUBMISSION_DIR [--dataset DIR] [--scratch DIR]`);
  const loadSplit = (split) => loadDataset(datasetOf(flags), { split });
  const r = verifySubmission({ dir, loadSplit, scratch: flags.one('--scratch') ?? scratchFor(scratchBase, 'verify', dir), log });
  return { code: r.ok ? 0 : 1, stdout: `${r.lines.join('\n')}\n`, stderr: '' };
}

const COMMANDS = {
  doctor: { flags: { values: ['--split', '--dataset', '--scratch', '--claude-bin'], multi: ['--pass-env'] }, run: doctor, usage: DOCTOR_USAGE },
  regrade: { flags: { values: ['--run', '--dataset', '--scratch'] }, run: regrade },
  score: { flags: { values: ['--run', '--memory', '--json'] }, run: scoreCli },
  cost: { flags: { values: ['--dataset'], multi: ['--run'] }, run: (argv, flags) => costCli(argv, flags, { datasetDir: datasetOf(flags) }) },
  register: { flags: { values: ['--memory', '--split', '--dataset', '--out'] }, run: (argv, flags) => registerCli(argv, flags, { loadSplit: () => loadDataset(datasetOf(flags), { split: splitOf(flags) }) }) },
  verify: { flags: { values: ['--dataset', '--scratch'], positional: 1 }, run: verify },
};

export const USAGE = [
  `${BENCH}: a repeat-mistake benchmark for coding-agent memory.`,
  `usage: ${SLUG} run --dataset DIR --memory MANIFEST --model MODEL --out DIR [--split full|lite]   (starts Claude Code sessions)`,
  `       ${SLUG} doctor [--split full|lite]          setup and tests of every repo once, tools against the pins; no model call`,
  `       ${SLUG} regrade --run DIR [--dataset DIR]    every lesson of a finished run with the packed checkers`,
  `       ${SLUG} score --run DIR [--memory MANIFEST] [--json FILE]   gates G1 to G5, then H1 and learn`,
  `       ${SLUG} cost --run DIR [--run DIR]...        sessions and dollars per arm`,
  `       ${SLUG} register --memory MANIFEST [--split full|lite]   the plan sha256 and the issue body; never calls GitHub`,
  `       ${SLUG} verify SUBMISSION_DIR                one record per planned cell, regrade, no key-shaped value`,
].join('\n');

export function runCli(argv, { log = () => {}, scratchBase = path.join(os.tmpdir(), SLUG) } = {}) {
  const [name, ...rest] = argv;
  const cmd = COMMANDS[name];
  if (!cmd) return { code: name === undefined || name === '--help' ? 0 : 1, stdout: name === undefined || name === '--help' ? `${USAGE}\n` : '', stderr: name === undefined || name === '--help' ? '' : `unknown command ${name}\n${USAGE}\n` };
  try {
    return cmd.run(rest, parseFlags(rest, cmd.flags), { log, scratchBase });
  } catch (err) {
    return { code: 1, stdout: '', stderr: `${err.message}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    runMain(argv).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  } else {
    const { code, stdout, stderr } = runCli(argv, { log: (line) => process.stderr.write(`${line}\n`) });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
  }
}
