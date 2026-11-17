// Z0 arms (docs/evals/2026-09-29-z0-built-in-memory-prereg.md, "Arms"): settings, environment and PATH.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathKey } from './exec.mjs';

export const ARMS = ['A0', 'A1', 'A2', 'A4', 'A5'];
// Prereg "Seeds": A0's and A4's gates need a large effect, so they run two.
export const ARM_SEEDS = { A0: 2, A1: 3, A2: 3, A4: 2, A5: 3 };
const NO_AUTO_MEMORY = new Set(['A0', 'A4']);
// The arms that run the memory under test; A5 gets it with a new namespace per task.
export const ADAPTER_ARMS = new Set(['A2', 'A5']);
export const CARRY_ARMS = new Set(['A1', 'A2', 'A5']);
export const TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
export const API_KEY = 'ANTHROPIC_API_KEY';

const LAUNCHERS = ['hippo', 'hippo.cmd', 'hippo.ps1', 'hippo.exe', 'hippo.bat'];
const REQUIRED_TOOLS = ['node', 'npm', 'npx', 'git'];
// The keys armEnv sets itself: a --pass-env copy would silently override the arm (and a second PATH key on Windows).
const RUNNER_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HIPPO_AGENT_MEMORY_TOOLS', 'DISABLE_AUTOUPDATER', 'EVAL_SEED', TOKEN_KEY, API_KEY, 'PATH',
  'AIPB_NAMESPACE', 'AIPB_MEMORY_KEYS'];
export const isRunnerKey = (name) => RUNNER_KEYS.includes(name.toUpperCase());
// Round 3 prereg item 5a: system names the agent and shells need, as round 2's records carried them. Left out on purpose: provider, CLAUDE_*, AWS_*, CODEX_*, HIPPO_*, OPENAI_*
// and ANTHROPIC_* names, parent session ids (a child would log under the parent's id), and NoDefaultCurrentDirectoryInExePath (cmd.exe then misses a checkout's gradlew.bat).
const SYSTEM_ENV = [
  'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'DriverData',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE',
  'COMPUTERNAME', 'LOGONSERVER', 'SESSIONNAME', 'PSModulePath', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TZ',
  // Keep git from opening an editor or a prompt that no one answers.
  'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE',
  // A path, not a secret; listed so the README's --pass-env route does not fail G1.
  'CLAUDE_CODE_GIT_BASH_PATH',
];
// The union over every toolchain in C:/eval-authors/s3x-env.ps1, which now covers the Android builds of round 3's batch 5, plus COREPACK_ENABLE_AUTO_PIN, which stops corepack editing package.json.
const TOOLCHAIN_ENV = [
  'CI', 'COREPACK_ENABLE_STRICT', 'COREPACK_ENABLE_AUTO_PIN', 'npm_config_manage_package_manager_versions', 'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_ARGS', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JULIA_DEPOT_PATH', 'JULIA_PKG_PRECOMPILE_AUTO',
  'GEM_HOME', 'GEM_PATH', 'BUNDLE_PATH', 'RI_DEVKIT', 'MAKE', 'RUSTUP_HOME', 'CARGO_HOME', 'CARGO_BUILD_JOBS', 'CARGO_TARGET_DIR', 'MIX_HOME', 'HEX_HOME', 'MIX_ENV',
  'GOROOT', 'GOPATH', 'GOCACHE', 'GOTOOLCHAIN', 'DOTNET_ROOT', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'DOTNET_ROLL_FORWARD', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO',
  'VIRTUAL_ENV', 'PYTHONUTF8', 'PYTHONIOENCODING',
];
/** The only names a session's env may start from; matching is case-insensitive, as on Windows. */
export const ENV_ALLOWLIST = Object.freeze([...RUNNER_KEYS, ...SYSTEM_ENV, ...TOOLCHAIN_ENV]);
// Any allowlisted name that looks like this stops armEnv, so a secret cannot ride in on a list edit.
export const SECRET_SHAPED = /TOKEN|SECRET|PASSW|API_KEY|_KEY$|DSN|CREDENTIAL|ACCOUNT_ID/i;
export const envAllowSet = (list = ENV_ALLOWLIST) => new Set(list.map((name) => name.toUpperCase()));

/** The `--settings` file for an arm; A2 and A5 get the manifest's settings unchanged, so only the namespace tells them apart. */
export function armSettings(arm, adapter) {
  if (NO_AUTO_MEMORY.has(arm)) return { autoMemoryEnabled: false };
  if (arm === 'A1') return {};
  if (ADAPTER_ARMS.has(arm)) {
    if (!adapter) throw new Error(`${arm} runs the memory under test; pass --memory <manifest>, such as adapters/hippo.json`);
    return adapter.settings ?? {};
  }
  throw new Error(`unknown arm ${arm}; known: ${ARMS.join(', ')}`);
}

function getKey(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The run's one auth mode: 'oauth' for a subscription token, 'apikey' for an Anthropic API key, null for neither; both at once stops the run. */
export function authMode(env) {
  const oauth = Boolean(getKey(env, TOKEN_KEY));
  const apikey = Boolean(getKey(env, API_KEY));
  if (oauth && apikey) throw new Error(`both ${TOKEN_KEY} and ${API_KEY} are set; a run uses one auth mode, so unset one of them`);
  return oauth ? 'oauth' : (apikey ? 'apikey' : null);
}

/** A session's environment: only the parent's allowlisted names, plus the run's own homes and PATH and any --pass-env name.
 * @param {string} arm
 * @param {any} dirs
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{passEnv?: string[], allowlist?: readonly string[], adapter?: any}} [options] `allowlist` is for tests; `adapter` passes its `env` names to A2 and A5
 * @returns {Record<string, string | undefined>} */
export function armEnv(arm, dirs, baseEnv, { passEnv = [], allowlist = ENV_ALLOWLIST, adapter = null } = {}) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}; known: ${ARMS.join(', ')}`);
  const reserved = passEnv.find((name) => RUNNER_KEYS.includes(name.toUpperCase()));
  if (reserved !== undefined) throw new Error(`--pass-env ${reserved}: the runner sets ${reserved.toUpperCase()} itself per arm, so it cannot be passed through`);
  const allowed = envAllowSet(allowlist);
  // The runner's own keys are set below, so a base copy under another case would leave two keys.
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => allowed.has(k.toUpperCase()) && !RUNNER_KEYS.includes(k.toUpperCase())));
  // Version 1 takes either auth; an empty one counts as unset, as in authMode, so envKeys name only the mode in use.
  for (const name of [TOKEN_KEY, API_KEY]) {
    const value = getKey(baseEnv, name);
    if (value) env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = dirs.claudeConfig;
  env.CODEX_HOME = dirs.codexHome;
  env.HIPPO_HOME = dirs.hippoHome;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = NO_AUTO_MEMORY.has(arm) ? '1' : '0';
  env.HIPPO_AGENT_MEMORY_TOOLS = 'claude-code,codex';
  env.DISABLE_AUTOUPDATER = '1';
  env.EVAL_SEED = String(dirs.seed);
  for (const name of passEnv) {
    const value = getKey(baseEnv, name);
    if (value !== undefined) env[name] = value;
  }
  const key = pathKey(baseEnv);
  const cleaned = cleanPath(baseEnv[key] ?? '', { env: baseEnv }).value;
  env[key] = ADAPTER_ARMS.has(arm) ? `${dirs.bin}${path.delimiter}${cleaned}` : cleaned;
  const memoryKeys = ADAPTER_ARMS.has(arm) && adapter ? memoryEnv(env, adapter, baseEnv) : [];
  // Only the manifest's own names may look like secrets, and only in A2 and A5.
  const exempt = new Set([TOKEN_KEY, API_KEY, ...memoryKeys.map((k) => k.toUpperCase())]);
  const secret = Object.keys(env).find((k) => !exempt.has(k.toUpperCase()) && SECRET_SHAPED.test(k));
  if (secret !== undefined) throw new Error(`armEnv: ${secret} looks like a secret and would reach the session; remove it from ENV_ALLOWLIST in lib/arms.mjs (or from --pass-env)`);
  return env;
}

/** Copy the manifest's `env` names from the operator's env into `env`, and name every memory key in AIPB_MEMORY_KEYS, so childEnv can strip them. */
function memoryEnv(env, adapter, baseEnv) {
  for (const name of adapter.env ?? []) {
    const value = getKey(baseEnv, name);
    if (value === undefined) throw new Error(`${adapter.name} needs ${name} in the environment; export it before the run`);
    env[name] = value;
  }
  const keys = [...(adapter.env ?? []), ...(adapter.namespaceEnv ?? [])];
  env.AIPB_MEMORY_KEYS = keys.join(',');
  return keys;
}

/** The env for setup, tests, checkers and the homes check: no auth token or API key, no memory keys or runner vars (unless keepMemory), and (unless keepBin) no run `bin/` on PATH. */
export function childEnv(env, { keepBin = false, keepMemory = false } = {}) {
  const memory = new Set((env.AIPB_MEMORY_KEYS ?? '').split(',').filter(Boolean).map((k) => k.toUpperCase()));
  const drop = (k) => [TOKEN_KEY, API_KEY].includes(k.toUpperCase()) || (!keepMemory && (memory.has(k.toUpperCase()) || k.toUpperCase().startsWith('AIPB_')));
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !drop(k)));
  if (!keepBin && out.CLAUDE_CONFIG_DIR) {
    // The run's bin/ is its config dir's sibling, so it is found without a second argument.
    const bin = path.join(path.dirname(out.CLAUDE_CONFIG_DIR), 'bin');
    const key = pathKey(out);
    out[key] = (out[key] ?? '').split(path.delimiter).filter((e) => e !== bin).join(path.delimiter);
  }
  return out;
}

function normaliseEntry(entry, env, cwd, platform) {
  let e = entry.trim();
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1).trim();
  if (e === '') return null;
  if (platform === 'win32') e = e.replace(/%([^%]+)%/g, (m, name) => getKey(env, name) ?? m);
  return path.resolve(cwd, e);
}

const holdsLauncher = (dir) => LAUNCHERS.some((name) => fs.existsSync(path.join(dir, name)));

/** PATH without any dir holding a hippo launcher, so A0 and A1 get the shell's own "not found" and A2/A5 only their shim. */
export function cleanPath(pathValue, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const kept = [];
  const removed = [];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, cwd, platform);
    if (dir === null) continue;
    if (holdsLauncher(dir)) {
      if (!removed.includes(dir)) removed.push(dir);
      continue;
    }
    kept.push(path.isAbsolute(entry.trim().replace(/^"|"$/g, '')) ? entry : dir);
  }
  return { value: kept.join(path.delimiter), removed };
}

/** The first file `name` resolves to on a PATH value (PATHEXT-aware on win32), or null. */
export function which(name, pathValue, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? ['', ...(getKey(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, process.cwd(), platform);
    if (dir === null) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${name}${ext}`);
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return null;
}

const firstToken = (cmd) => (cmd.trim().startsWith('"') ? cmd.trim().slice(1).split('"')[0] : cmd.trim().split(/\s+/)[0]);
const isBareName = (cmd) => /^[\w.-]+$/.test(cmd);
const sameDir = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** A bare `claude` name resolved once to an absolute, quoted path on the uncleaned PATH; a command string is left as is. */
export function resolveClaude(claudeBin, pathValue, opts = {}) {
  if (!isBareName(claudeBin)) return claudeBin;
  const found = which(claudeBin, pathValue, opts);
  if (!found) throw new Error(`${claudeBin} is not on PATH; install Claude Code or pass --claude-bin`);
  return `"${found}"`;
}

/** Refuse to run when hiding the hippo launcher dirs also hid a tool the runner or the agent needs. */
export function assertToolsResolve(cleanedPath, claudeCmd, removed = [], opts = {}) {
  const missing = REQUIRED_TOOLS.filter((t) => !which(t, cleanedPath, opts));
  const claude = firstToken(claudeCmd);
  if (path.isAbsolute(claude)) {
    if (!fs.existsSync(claude) || removed.some((d) => sameDir(path.dirname(claude), d))) missing.push(`claude (${claude})`);
  } else if (!which(claude, cleanedPath, opts)) missing.push(claude);
  if (missing.length === 0) return;
  const dirs = removed.length > 0 ? removed.join(', ') : 'none';
  throw new Error(`with the hippo launcher dirs (${dirs}) off PATH, these no longer resolve: ${missing.join(', ')}. Install hippo in its own prefix, or uninstall the global copy, so those dirs hold no hippo.`);
}

/** Resolve claude and check the cleaned PATH once, before any run: returns the claude command every session spawns. */
export function startupTools(claudeBin, baseEnv) {
  const pathValue = baseEnv[pathKey(baseEnv)] ?? '';
  const { value, removed } = cleanPath(pathValue, { env: baseEnv });
  const claude = resolveClaude(claudeBin, pathValue, { env: baseEnv });
  assertToolsResolve(value, claude, removed, { env: baseEnv });
  return { claude, removed };
}
