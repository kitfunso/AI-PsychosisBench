// The memory under test (plan claims 1.1-1.3, 3.1): its manifest, its namespace, and the commands the runner runs for it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sh } from './exec.mjs';
import { childEnv, isRunnerKey } from './arms.mjs';

/** One cap on every manifest's settleMs, so no memory buys more background time than another. */
export const SETTLE_CAP_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const FIELDS = ['name', 'version', 'install', 'init', 'settings', 'mcpServers', 'env', 'namespaceEnv', 'workDirs', 'settleMs', 'export', 'reset', 'hiddenWords'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Throws, naming the field and the fix, unless `m` is a usable manifest. */
export function validateAdapter(m, file = 'memory manifest') {
  const bad = (field, fix) => {
    throw new Error(`${file}: ${field} ${fix}`);
  };
  if (!isObject(m)) bad('the manifest', 'must be a JSON object with at least name, version, export and hiddenWords');
  const unknown = Object.keys(m).find((k) => !FIELDS.includes(k));
  if (unknown !== undefined) bad(unknown, `is not a manifest field; the fields are ${FIELDS.join(', ')}`);
  for (const k of ['name', 'version']) if (typeof m[k] !== 'string' || !m[k].trim()) bad(k, 'must be a non-empty string, such as "my-memory" and "0.4.1"');
  if (!isStrings(m.export) || m.export.length === 0) bad('export', 'must be a non-empty array of shell commands that print every text stored in $AIPB_NAMESPACE, and nothing when it is empty');
  for (const k of ['install', 'init', 'reset']) if (m[k] !== undefined && !isStrings(m[k])) bad(k, 'must be an array of shell command strings, run in order');
  for (const k of ['settings', 'mcpServers']) if (m[k] !== undefined && !isObject(m[k])) bad(k, k === 'settings' ? 'must be a Claude Code settings object, such as {"hooks": {...}}' : 'must map each server name to its {command, args, env} entry');
  for (const k of ['env', 'namespaceEnv']) {
    if (m[k] === undefined) continue;
    if (!isStrings(m[k])) bad(k, 'must be an array of environment variable names');
    const wrong = m[k].find((n) => !ENV_NAME.test(n) || isRunnerKey(n) || /^(HOME|USERPROFILE|ANTHROPIC_API_KEY)$/i.test(n));
    if (wrong !== undefined) bad(k, `cannot hold ${wrong}: it is not a variable name, or the runner sets it itself`);
  }
  const both = (m.env ?? []).find((n) => (m.namespaceEnv ?? []).some((x) => x.toUpperCase() === n.toUpperCase()));
  if (both !== undefined) bad('namespaceEnv', `repeats ${both} from env; the runner sets a namespaceEnv name to the namespace, so it cannot also pass its own value`);
  if (m.workDirs !== undefined && (!isStrings(m.workDirs) || m.workDirs.some((d) => /[\\/:]/.test(d) || d === '.' || d === '..' || d.toLowerCase() === '.git'))) bad('workDirs', 'must list plain folder names at the workspace root, such as [".mymem"]');
  if (m.settleMs !== undefined && !(Number.isInteger(m.settleMs) && m.settleMs >= 0 && m.settleMs <= SETTLE_CAP_MS)) bad('settleMs', `must be a whole number of milliseconds from 0 to ${SETTLE_CAP_MS}`);
  if (!isStrings(m.hiddenWords) || m.hiddenWords.length === 0) bad('hiddenWords', 'must list at least one word the blind G5 reader must not see, such as your memory\'s name');
  return m;
}

/** The manifest at `file`, checked, with its folder (for ${AIPB_ADAPTER_DIR}) and the sha256 of its bytes. */
export function loadAdapter(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`--memory ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}; pass the path of a memory manifest, such as adapters/hippo.json`);
  }
  let m;
  try {
    m = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
  validateAdapter(m, file);
  const abs = path.resolve(file);
  return Object.freeze({ ...m, file: abs, dir: path.dirname(abs), sha256: createHash('sha256').update(bytes).digest('hex') });
}

/** A fresh random nonce per run, so no two runs, even of the same plan, share a namespace. */
export const newNonce = () => randomBytes(16).toString('hex');

/** One opaque namespace per run for A2, and one per task for the sham (A5), so the sham's memory never outlives its task. */
export function namespaceFor(run, task) {
  const key = run.arm === 'A5' ? `${run.nonce}/${task.id}` : run.nonce;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Put the task's namespace into the session env, under AIPB_NAMESPACE and every namespaceEnv name; true when it is new. */
export function setNamespace(run, adapter, namespace) {
  const fresh = run.env.AIPB_NAMESPACE !== namespace;
  run.env.AIPB_NAMESPACE = namespace;
  for (const name of adapter.namespaceEnv ?? []) run.env[name] = namespace;
  return fresh;
}

/** The per-run values a manifest may name as ${AIPB_X}; the namespace is not among them, as A5's changes per task. */
export const runVars = (ctx, run) => ({
  AIPB_OUT: ctx.outDir, AIPB_RUN: run.dirs.root, AIPB_HOME: run.dirs.home, AIPB_BIN: run.dirs.bin, AIPB_WORK: run.dirs.work, AIPB_ADAPTER_DIR: ctx.adapter.dir,
});

/** `value` with each $AIPB_X or ${AIPB_X} that `vars` names filled in, at any depth; other text stays as it is. */
export function fillVars(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{(AIPB_[A-Z_]+)\}|\$(AIPB_[A-Z_]+)/g, (m, a, b) => vars[a ?? b] ?? m);
  if (Array.isArray(value)) return value.map((v) => fillVars(v, vars));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillVars(v, vars)]));
  return value;
}

/** Each command of one manifest field, in order, with the run's own HOME and the memory's keys; the stdout of all, or a throw naming the step. */
function runCommands(ctx, run, field, extra = {}) {
  const vars = { ...runVars(ctx, run), AIPB_NAMESPACE: run.env.AIPB_NAMESPACE ?? '', ...extra };
  // Never the operator's HOME, so a memory installs and stores nothing where the operator's own memory lives.
  const env = { ...childEnv(run.env, { keepBin: true, keepMemory: true }), HOME: run.dirs.home, USERPROFILE: run.dirs.home, ...vars };
  const cwd = field === 'install' ? run.dirs.home : run.dirs.work;
  let out = '';
  for (const raw of ctx.adapter[field] ?? []) {
    const cmd = fillVars(raw, vars);
    const r = sh(cmd, cwd, env, COMMAND_TIMEOUT_MS);
    if (r.status !== 0) throw new Error(`${ctx.adapter.name} ${field} failed for ${run.runName} ${run.arm} seed${run.seed} (exit ${r.status}${r.timedOut ? ', timed out' : ''}): ${cmd}\n${r.stderr.slice(-1000)}`);
    out += r.stdout;
  }
  return out;
}

/** The manifest's install, once per run dir, before any session. */
export const runInstall = (ctx, run) => runCommands(ctx, run, 'install');

/** The manifest's init, before the first session of the run. */
export const adapterInit = (ctx, run) => runCommands(ctx, run, 'init');

/** Every text the memory holds in the current namespace, as its export prints it. */
export const runExport = (ctx, run) => runCommands(ctx, run, 'export');

/** Throws unless the memory's export prints nothing, so no run starts on a memory that already holds text. */
export function assertEmpty(ctx, run, text = runExport(ctx, run)) {
  if (text.trim()) throw new Error(`${ctx.adapter.name}: memory is not empty at the start of namespace ${run.env.AIPB_NAMESPACE} (${run.runName} ${run.arm} seed${run.seed}); export printed ${JSON.stringify(text.trim().slice(0, 200))}. Scope every store, recall and export to $AIPB_NAMESPACE, and print nothing for an empty one.`);
}

/** The export as one G3 store, for the leak scan and the chain; a new namespace must export nothing. */
export function memoryStore(ctx, run) {
  const text = runExport(ctx, run);
  if (run.checkedNamespace !== run.env.AIPB_NAMESPACE) assertEmpty(ctx, run, text);
  run.checkedNamespace = run.env.AIPB_NAMESPACE;
  return { surface: 'memoryExport', path: `memory-export/${run.env.AIPB_NAMESPACE}`, entries: [{ id: 'export', content: text }] };
}

/** True when any gold line of the task's fix sits in the exported memory. */
export const storeHolds = (stores, lines) => lines.length > 0 && stores.some((s) => s.entries.some((e) => lines.some((l) => e.content.includes(l))));

/** Undo what a cut-off attempt stored since `since` (ISO time); false when the manifest has no reset, which voids the cell. */
export function resetMemory(ctx, run, since) {
  if (!ctx.adapter.reset?.length) return false;
  runCommands(ctx, run, 'reset', { AIPB_SINCE: since });
  return true;
}

/** The wait after each session: the manifest's settleMs, never past the cap. */
export const settleMsOf = (adapter) => Math.min(adapter?.settleMs ?? 0, SETTLE_CAP_MS);

/** Names G1 accepts on top of the allowlist: the manifest's keys and namespace variables. */
export const adapterKeys = (adapter) => [...(adapter?.env ?? []), ...(adapter?.namespaceEnv ?? [])];
