import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './z0-blind.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_PRICES = path.join(HERE, '..', 'prices.json');
const REPORTS = ['blind.json', 'unblind.json'];

const exists = (...p) => fs.existsSync(path.join(...p));
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());

export const runsFileOf = (dir) => (exists(dir, 'runs.regraded.jsonl') ? path.join(dir, 'runs.regraded.jsonl') : path.join(dir, 'runs.jsonl'));

function checked(entry, reportDir) {
  const candidates = [entry.file, path.join(reportDir, path.basename(entry.file))];
  const hit = candidates.find((f) => fs.existsSync(f) && sha256(f) === entry.sha256);
  if (hit) return hit;
  const why = fs.existsSync(entry.file) ? 'has changed since the report hashed it' : 'is gone';
  throw new Error(`${entry.file} (${entry.role}) ${why}; the report in ${reportDir} cannot be read again`);
}

function fromReport(dir) {
  const file = path.join(dir, REPORTS.find((f) => exists(dir, f)));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (report.schema !== 'z0-report/1' || !Array.isArray(report.hashes)) throw new Error(`${file} is not an analyzer report (schema z0-report/1 with hashes)`);
  const role = (r) => report.hashes.filter((h) => h.role === r);
  const runs = role('runs');
  const plans = role('plan');
  if (runs.length === 0 || runs.length !== plans.length) throw new Error(`${file} names ${runs.length} runs files and ${plans.length} plans; it needs one plan per runs file`);
  const one = (r) => (role(r)[0] ? checked(role(r)[0], dir) : null);
  return {
    dir, from: file, parts: runs.map((r, i) => ({ runs: checked(r, dir), plan: checked(plans[i], dir) })),
    grading: one('grading'), dropList: one('drop-list'), prices: one('prices'),
  };
}

export function readRunDir(runDir) {
  const dir = path.resolve(runDir);
  if (!fs.existsSync(dir)) throw new Error(`--run ${runDir}: no such folder`);
  if (exists(dir, 'runs.jsonl')) {
    if (!exists(dir, 'plan.json')) throw new Error(`${dir} has runs.jsonl but no plan.json; pass the out dir the runner wrote`);
    const grading = exists(dir, 'grading.json') ? path.join(dir, 'grading.json') : null;
    return { dir, from: dir, parts: [{ runs: runsFileOf(dir), plan: path.join(dir, 'plan.json'), out: dir }], grading, dropList: null, prices: null };
  }
  if (REPORTS.some((f) => exists(dir, f))) return fromReport(dir);
  throw new Error(`${dir} holds neither runs.jsonl (a runner out dir) nor ${REPORTS.join(' or ')} (an analyzer report)`);
}

export function gradingDirOf(part) {
  if (part.out && exists(part.out, 'grading')) return part.out;
  const own = path.dirname(part.runs);
  if (exists(own, 'grading')) return own;
  const name = path.basename(own);
  const root = path.dirname(path.dirname(own));
  const copy = lines(part.runs);
  const holds = (d) => {
    const source = new Set(lines(runsFileOf(d)));
    return copy.every((l) => source.has(l));
  };
  const candidates = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => [path.join(root, e.name, name, 'run'), path.join(root, e.name, name)])
    .filter((d) => exists(d, 'grading') && fs.existsSync(runsFileOf(d)) && holds(d));
  if (candidates.length !== 1) throw new Error(`${part.runs} has no grading/ beside it, and ${candidates.length} run dirs under ${root} hold all its records (${candidates.join(', ') || 'none'}); a regrade needs exactly one`);
  return candidates[0];
}
