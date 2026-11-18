// `doctor`: the platform, the tools the split needs, Claude Code's version against the pins, and each repo's setup and test at its first fix; no session, no model call.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sh, cloneFresh } from './exec.mjs';
import { armEnv, childEnv, TOKEN_KEY, API_KEY } from './arms.mjs';
import { runDirs, freshRunDirs } from './homes.mjs';
import { checkoutBase } from './workspace.mjs';
import { claudeVersionToken } from './pins.mjs';
import { SLUG } from './name.mjs';
import { venvRepos, withVenv } from './venv.mjs';

// How each toolchain.json name is probed; null means the repo ships it (a wrapper or a dev dependency) and setup brings it.
const PROBES = {
  'mvnw.cmd': 'java -version', maven: 'mvn -v', 'gradlew.bat': 'java -version', dotnet: 'dotnet --version', go: 'go version',
  python: 'python --version', pytest: null, uv: 'uv --version', pnpm: 'pnpm --version', npm: 'npm --version', yarn: 'yarn --version',
  node: 'node --version', vitest: null, jest: null, mix: 'mix --version', cargo: 'cargo --version', git: 'git --version',
};

const firstLine = (r) => `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
const tail = (text, n = 3) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

/** Version 1 runs on Windows, through cmd.exe, with Git Bash for Claude Code. */
export function platformCheck(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { ok: false, line: `${platform}: version 1 runs on Windows only (13 of the 29 repos have cmd-only lines)` };
  const bash = env.CLAUDE_CODE_GIT_BASH_PATH || ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find((p) => fs.existsSync(p));
  const cmd = env.ComSpec ?? env.COMSPEC;
  const ok = Boolean(bash && cmd && fs.existsSync(bash));
  return { ok, line: `Windows ${os.release()} · Git Bash ${bash ?? 'not found'} · cmd.exe ${cmd ?? 'not found'}` };
}

/** Each tool the split's repos need, found or missing, from toolchain.json. */
export function toolChecks(dataset, env) {
  const table = JSON.parse(fs.readFileSync(path.join(dataset.dir, 'toolchain.json'), 'utf8'));
  const names = [...new Set(dataset.keys.flatMap((k) => table[k]?.tools ?? []))].sort();
  return names.map((name) => {
    const probe = PROBES[name];
    if (probe === undefined) return { name, ok: false, line: `${name}: no probe for this tool; add one to PROBES in lib/doctor.mjs` };
    if (probe === null) return { name, ok: true, line: `${name}: comes with the repo's setup` };
    const r = sh(probe, process.cwd(), env, 60_000);
    return { name, ok: r.status === 0, line: `${name}: ${r.status === 0 ? firstLine(r) : `\`${probe}\` failed: ${tail(`${r.stdout}\n${r.stderr}`, 1)}`}` };
  });
}

/** `claude --version` against the pins, with no token or key in its env, so it cannot reach a model. */
export function claudeCheck(dataset, claudeBin, env) {
  const r = sh(`${claudeBin} --version`, process.cwd(), env, 60_000);
  const version = claudeVersionToken(r.stdout);
  const pinned = dataset.pins.claudeVersion;
  return { ok: version === pinned, line: `Claude Code ${version ?? 'not found'}, pinned ${pinned}; model pinned ${dataset.pins.model} (pass --model ${dataset.pins.model} to run)` };
}

/** One repo's first task at its fix: clone the bundle, check out fixRef under the stub, run setup and the test; both must pass. */
export function repoCheck(dataset, key, scratch, baseEnv, passEnv) {
  const s = dataset.spec.sequences.find((x) => x.repoPath === path.join(dataset.dir, 'repos', key, 'repo.bundle'));
  const t = s.tasks[0];
  const root = path.join(scratch, key);
  fs.rmSync(root, { recursive: true, force: true });
  const cache = path.join(root, 'cache');
  cloneFresh(s.repoPath, cache);
  const dirs = runDirs(root, s.id, 'A1', 1);
  freshRunDirs(dirs);
  checkoutBase(cache, dirs.work, s.id, { ...t, baseRef: t.fixRef }, 'A1');
  const python = venvRepos(dataset).has(s.id);
  const env = childEnv(armEnv('A1', dirs, python ? withVenv(baseEnv, path.join(root, 'venv')) : baseEnv, { passEnv }));
  const started = Date.now();
  const step = (name, cmd) => {
    if (!cmd) return { name, ok: true, text: 'none' };
    const r = sh(cmd, dirs.work, env);
    return { name, ok: r.status === 0, text: r.status === 0 ? 'ok' : `${r.timedOut ? 'timed out' : `exit ${r.status}`}: ${tail(`${r.stdout}\n${r.stderr}`)}` };
  };
  const setup = step('setup', t.setup);
  const test = setup.ok ? step('test', t.test) : { name: 'test', ok: false, text: 'skipped after setup failed' };
  fs.rmSync(root, { recursive: true, force: true });
  return { key, ok: setup.ok && test.ok, line: `${key} ${s.id}/${t.id}: setup ${setup.text}; test ${test.text} (${Math.round((Date.now() - started) / 1000)} s)` };
}

/** Every doctor check as one line each, with progress to `log`; `ok` only when all pass. */
export function runDoctor({ dataset, scratch, claudeBin = 'claude', passEnv = [], log = () => {} }) {
  // The probes and repo commands get the run's own env; Claude Code gets the same with no way to sign in.
  const env = childEnv(armEnv('A1', runDirs(path.join(scratch, 'probe'), 'probe', 'A1', 1), process.env, { passEnv }));
  const quiet = Object.fromEntries(Object.entries(env).filter(([k]) => ![TOKEN_KEY, API_KEY].includes(k.toUpperCase())));
  const lines = [];
  const say = (line) => lines.push(line);
  const platform = platformCheck();
  say(`platform  ${platform.line}  ${platform.ok ? 'ok' : 'FAIL'}`);
  const tools = toolChecks(dataset, env);
  for (const t of tools) say(`tool      ${t.line}  ${t.ok ? 'ok' : 'FAIL'}`);
  const claude = claudeCheck(dataset, claudeBin, quiet);
  say(`pins      ${claude.line}  ${claude.ok ? 'ok' : 'FAIL'}`);
  const repos = dataset.keys.map((key, i) => {
    log(`repo ${i + 1} of ${dataset.keys.length}: ${key}, setup and test at its first fix`);
    const r = repoCheck(dataset, key, scratch, process.env, passEnv);
    say(`repo      ${r.line}  ${r.ok ? 'ok' : 'FAIL'}`);
    return r;
  });
  const passed = repos.filter((r) => r.ok).length;
  say(`setup     ${passed} of ${repos.length} repos pass setup and tests  ${passed === repos.length ? 'ok' : 'FAIL'}`);
  say('model     no model call · $0');
  return { ok: platform.ok && tools.every((t) => t.ok) && claude.ok && passed === repos.length, lines };
}

export const DOCTOR_USAGE = `usage: ${SLUG} doctor [--split full|lite] [--dataset DIR] [--scratch DIR] [--pass-env NAME]... [--claude-bin CMD]`;
