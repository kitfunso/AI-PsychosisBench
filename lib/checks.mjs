import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './exec.mjs';

export const PRE_REF = 'refs/z0/pre';
const VERDICTS = new Map([[0, 'pass'], [1, 'fail'], [3, 'na']]);
const SNAPSHOT_IDENT = {
  GIT_AUTHOR_NAME: 'z0-eval', GIT_AUTHOR_EMAIL: 'z0-eval@localhost',
  GIT_COMMITTER_NAME: 'z0-eval', GIT_COMMITTER_EMAIL: 'z0-eval@localhost',
};

export class WorkspaceGitError extends Error {
  constructor(cause) {
    super(`runner git on the agent's workspace failed: ${cause.message.split('\n')[0]}`, { cause });
    this.name = 'WorkspaceGitError';
    this.stderr = String(cause.stderr ?? '');
  }
}

// GIT_CONFIG_PARAMETERS quoting: key and value each single-quoted, so a driver name may hold '=', '.' or a quote.
const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function filtersOff(listed) {
  const names = new Set();
  for (const key of listed.split('\0')) {
    const last = key.lastIndexOf('.');
    if (key.startsWith('filter.') && last > 'filter'.length) names.add(key.slice('filter.'.length, last));
  }
  // Empty commands make git skip the driver; required=false stops it then failing the file.
  const off = (n) => [...['clean', 'smudge', 'process'].map((k) => `${sq(`filter.${n}.${k}`)}=''`), `${sq(`filter.${n}.required`)}='false'`];
  return [...names].flatMap(off).join(' ');
}

export function agentGit(work, fn) {
  // A deleted work dir fails git's spawn (ENOENT) before git runs, yet it is still the agent breaking its repo.
  if (!fs.existsSync(work)) throw new WorkspaceGitError(new Error(`the work dir ${work} is gone`));
  // GIT_DIR pinned: with .git deleted, git would otherwise walk up to whatever repo holds the workspace.
  const gitDir = { GIT_DIR: path.join(work, '.git'), GIT_WORK_TREE: work };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-git-'));
  // A sparse checkout the agent turned on would make `add -A` skip tracked edits outside the cone.
  const sparseOff = (args, cwd, extra) => git(['-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false', ...args], cwd, { ...gitDir, ...extra });
  try {
    // An agent's filter driver would run as the runner on add and checkout-index; listed per call, so after any .git restore.
    const filterParams = filtersOff(sparseOff(['config', '--list', '--name-only', '-z'], work, {}));
    const rgit = (args, cwd, extra = {}) => sparseOff(args, cwd, { ...extra, GIT_CONFIG_PARAMETERS: filterParams });
    return fn(rgit, scratch, filterParams);
  } catch (err) {
    if (Number.isInteger(err.status) && !err.code) throw new WorkspaceGitError(err);
    throw err;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export class CheckerError extends Error {
  constructor(message, stderr = '', started = true) {
    super(message);
    this.name = 'CheckerError';
    this.stderr = stderr;
    this.started = started;
  }
}

export function runCheck(lesson, { work, env, preCommit, postCommit, commands, resumeCommands = null, scratch, timeoutMs = 120_000 }) {
  fs.mkdirSync(scratch, { recursive: true });
  const commandsFile = path.join(scratch, 'z0-commands.json');
  fs.writeFileSync(commandsFile, JSON.stringify(commands));
  const resumeFile = path.join(scratch, 'z0-resume-commands.json');
  fs.rmSync(resumeFile, { force: true });
  if (resumeCommands) fs.writeFileSync(resumeFile, JSON.stringify(resumeCommands));
  const resumeEnv = resumeCommands ? { CHECK_RESUME_COMMANDS: resumeFile } : {};
  // Appended last so they win: core.fsmonitor and filter drivers in the agent's .git/config name programs a checker's `git status` would run.
  const filterParams = agentGit(work, (_rgit, _scratch, params) => params);
  const configParams = [env.GIT_CONFIG_PARAMETERS, filterParams, "'core.fsmonitor=false'"].filter(Boolean).join(' ');
  const r = spawnSync(process.execPath, [lesson.checkPath, ...(lesson.check.args ?? [])], {
    cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_PARAMETERS: configParams, CHECK_PRE_COMMIT: preCommit, CHECK_POST_COMMIT: postCommit, CHECK_COMMANDS: commandsFile, ...resumeEnv, CHECK_LESSON_ID: lesson.id },
  });
  const stderr = r.stderr ?? '';
  if (r.error?.code === 'ETIMEDOUT') throw new CheckerError(`checker for lesson ${lesson.id} timed out after ${timeoutMs} ms`, stderr);
  if (r.error) throw new CheckerError(`checker for lesson ${lesson.id} did not start: ${r.error.message}`, stderr, false);
  const verdict = VERDICTS.get(r.status);
  if (!verdict) throw new CheckerError(`checker for lesson ${lesson.id} exited ${r.status ?? r.signal}`, stderr);
  return verdict;
}

export function stateCommit(work, parent) {
  return agentGit(work, (rgit, scratch) => {
    const env = { ...SNAPSHOT_IDENT, GIT_INDEX_FILE: path.join(scratch, 'index') };
    rgit(['read-tree', 'HEAD'], work, env);
    rgit(['add', '-A'], work, env);
    const tree = rgit(['write-tree'], work, env).trim();
    return rgit(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'snapshot'], work, env).trim();
  });
}

export const FIRST_REF = 'refs/z0/hold/first';
export const STALE_REF = 'refs/z0/hold/stale';
export const FINAL_CHECK_REF = 'refs/z0/hold/finalCheck';

export function holdPre(work, sha, ref = PRE_REF) {
  agentGit(work, (rgit) => rgit(['update-ref', '--no-deref', ref, sha], work));
}

export function dropPre(work) {
  agentGit(work, (rgit) => {
    for (const ref of [PRE_REF, FIRST_REF, STALE_REF, FINAL_CHECK_REF]) rgit(['update-ref', '-d', ref], work);
  });
}
