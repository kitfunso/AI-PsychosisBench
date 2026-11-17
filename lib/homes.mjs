// Per-run directories for every surface that could hold memory, and the checks that they start empty and stay the run's own.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git, pathKey } from './exec.mjs';
import { ADAPTER_ARMS, armEnv, childEnv, which } from './arms.mjs';

const win = process.platform === 'win32';
const samePath = (a, b) => (win ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

const HOME_DIRS = ['claudeConfig', 'codexHome', 'hippoHome'];

/** `<out>/runs/<seq>/<arm>/seed<n>/` and the dirs inside it. */
export function runDirs(outDir, seq, arm, seed) {
  const root = path.join(outDir, 'runs', seq, arm, `seed${seed}`);
  return {
    root, seed,
    work: path.join(root, 'work'),
    claudeConfig: path.join(root, 'claude-config'),
    codexHome: path.join(root, 'codex-home'),
    hippoHome: path.join(root, 'hippo-home'),
    bin: path.join(root, 'bin'),
    // The run's own HOME, for the memory's install and commands.
    home: path.join(root, 'home'),
  };
}

/** Throws unless the three home dirs exist and are empty. */
export function assertFreshEmpty(dirs) {
  for (const k of HOME_DIRS) {
    const dir = dirs[k];
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is missing; a run's homes must exist before its first session`);
    const left = fs.readdirSync(dir);
    if (left.length > 0) throw new Error(`${dir} is not empty (${left.slice(0, 5).join(', ')}); a run's homes must start empty`);
  }
}

/** Remove and recreate a run's dirs, then check its homes are empty. */
export function freshRunDirs(dirs) {
  fs.rmSync(dirs.root, { recursive: true, force: true });
  for (const k of [...HOME_DIRS, 'work', 'home']) fs.mkdirSync(dirs[k], { recursive: true });
  assertFreshEmpty(dirs);
}

/** Files present in each home, as relative forward-slash paths, for the record. */
export function homeFiles(dirs) {
  const list = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? list(dir, child) : [child];
  });
  return Object.fromEntries(HOME_DIRS.map((k) => [k, fs.existsSync(dirs[k]) ? list(dirs[k]).sort() : []]));
}

const ANCESTOR_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md'), path.join('.claude', 'rules')];

/** Instruction files held by `dir` or any ancestor up to `stopAt` (inclusive; default the filesystem root).
 * @param {string} dir
 * @param {{stopAt?: string | null}} [options] */
export function ancestorInstructionFiles(dir, { stopAt = null } = {}) {
  const hits = [];
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    for (const name of ANCESTOR_FILES) if (fs.existsSync(path.join(cur, name))) hits.push(path.join(cur, name));
    if ((stopAt && samePath(cur, stopAt)) || path.dirname(cur) === cur) return hits;
  }
}

/** Refuse an out dir that Claude Code would load ancestor instructions from. */
export function assertNoAncestorInstructions(outDir, opts) {
  const hits = ancestorInstructionFiles(outDir, opts);
  if (hits.length) throw new Error(`Claude Code would load these instruction files above ${outDir} into every arm: ${hits.join(', ')}. Pick an out dir with none above it, such as C:/z0-runs or /tmp/z0.`);
}

// The env key each home is reached by: a session must find only its own run's dirs there.
const HOME_KEYS = [['CLAUDE_CONFIG_DIR', 'claudeConfig'], ['CODEX_HOME', 'codexHome'], ['HIPPO_HOME', 'hippoHome']];

/** Throws, naming the run, unless every home key in `env` names the run's own dir and that dir lists empty. */
export function checkEnvHomes(env, dirs, name) {
  for (const [key, k] of HOME_KEYS) {
    if (!env[key] || !samePath(env[key], dirs[k])) throw new Error(`${name}: ${key} is ${env[key] ?? 'unset'}, expected the run's own ${dirs[k]}`);
    const left = fs.readdirSync(dirs[k]);
    if (left.length > 0) throw new Error(`${name}: ${dirs[k]} holds ${left.slice(0, 5).join(', ')} before any session; a run's homes must start empty`);
  }
}

/** The agent's login shell: Git Bash on win32 (never System32's bash), sh elsewhere. */
export function gitBash(env, passEnv) {
  if (!win) return 'sh';
  if (passEnv.includes('CLAUDE_CODE_GIT_BASH_PATH') && env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  const gitExe = which('git', env[pathKey(env)], { env });
  const tried = gitExe ? [['..', 'bin'], ['..', '..', 'bin'], ['..', 'usr', 'bin']].map((p) => path.resolve(path.dirname(gitExe), ...p, 'bash.exe')) : [];
  const found = tried.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`Git Bash not found (tried ${tried.join(', ') || 'no git on PATH'}); pass --pass-env CLAUDE_CODE_GIT_BASH_PATH`);
  return found;
}

/** `command -v hippo` in the agent's login shell: A0, A1 and A4 must not find one, A2 and A5 none outside their run's bin/ (the memory's install runs later). */
export function shellHippoCheck(arm, dirs, env, shell, name) {
  // Git Bash prints POSIX paths, some under its own mounts (/tmp), so cygpath turns them back into Windows paths.
  const script = win ? 'if p=$(command -v hippo); then cygpath -m "$p"; else echo Z0_NOT_FOUND; fi' : 'command -v hippo || echo Z0_NOT_FOUND';
  const r = spawnSync(shell, ['-lc', script], { cwd: dirs.work, env: childEnv(env, { keepBin: true }), encoding: 'utf8', timeout: 60_000 });
  const last = (r.stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
  const own = last !== 'Z0_NOT_FOUND' && last !== '' && samePath(path.dirname(last), dirs.bin);
  const ok = last === 'Z0_NOT_FOUND' || (ADAPTER_ARMS.has(arm) && own);
  if (!ok) throw new Error(`${name}: the agent's shell resolves hippo to ${last || `nothing (exit ${r.status}: ${(r.stderr ?? '').trim()})`}, expected ${ADAPTER_ARMS.has(arm) ? `none or ${dirs.bin}` : 'none'}; a login profile may put a hippo dir back on PATH`);
}

/** One run's homes check on fresh dirs: each home the session's env names is the run's own and empty, and what `hippo` the agent's shell finds. */
function checkRunHomes({ outDir, seq, arm, seed }, { baseEnv, passEnv, shell, adapter }) {
  const dirs = runDirs(outDir, seq, arm, seed);
  const name = `${seq}/${arm}/seed${seed}`;
  freshRunDirs(dirs);
  try {
    git(['init', '--quiet'], dirs.work);
    // With the manifest, so a missing memory key stops the run before any session.
    const env = armEnv(arm, dirs, baseEnv, { passEnv, adapter: ADAPTER_ARMS.has(arm) ? adapter : null });
    checkEnvHomes(env, dirs, name);
    shellHippoCheck(arm, dirs, env, shell, name);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

/** The homes check for every planned run (`--check-homes`, and the first step of a real run).
 * @param {{outDir: string, runs: {seq: string, arm: string, seed: number}[], passEnv?: string[], baseEnv?: NodeJS.ProcessEnv, adapter?: any}} options */
export function checkHomes({ outDir, runs, passEnv = [], baseEnv = process.env, adapter = null }) {
  // The check recreates and removes each run dir, so it refuses any that already holds data rather than delete it.
  const occupied = runs.map((r) => runDirs(outDir, r.seq, r.arm, r.seed).root).filter((d) => fs.existsSync(d) && fs.readdirSync(d).length > 0);
  if (occupied.length > 0) throw new Error(`${occupied[0]} already holds run data${occupied.length > 1 ? ` (and ${occupied.length - 1} more run dirs)` : ''}; the homes check never deletes it. Pick a new --out, or move that run away first.`);
  fs.mkdirSync(outDir, { recursive: true });
  const shell = gitBash(baseEnv, passEnv);
  for (const run of runs) checkRunHomes({ outDir, ...run }, { baseEnv, passEnv, shell, adapter });
}
