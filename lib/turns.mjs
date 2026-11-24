import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnTree } from './exec.mjs';
import { startLogProxy } from './proxy.mjs';
import { isUsageLimit, sessionFiles, findTranscript, listTranscripts } from './records.mjs';
import { sleep } from './runs.mjs';
import { agentGit } from './checks.mjs';
import { instructionSnapshot, restoreInstructions } from './workspace.mjs';
import { TOKEN_KEY } from './arms.mjs';
import { execFileSync } from 'node:child_process';

export function userEnvVar(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch (err) {
    // reg exits 1 when the value does not exist; the caller logs the var name as unset. Any other failure stands.
    if (err.status === 1) return null;
    throw err;
  }
}

export function moveToken(ctx, now = Date.now() / 1000, read = ctx.readToken ?? userEnvVar) {
  if (!ctx.tokenSchedule) return;
  const due = fs.readFileSync(ctx.tokenSchedule, 'utf8').split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length === 2 && /^\d+$/.test(f[0]) && Number(f[0]) <= now);
  const name = due.at(-1)?.[1];
  if (!name || name === ctx.tokenVar) return;
  const value = read(name);
  if (!value) {
    ctx.log(`token schedule names ${name}, which is not set; keeping ${ctx.tokenVar ?? 'the start token'}`);
    return;
  }
  ctx.token = value;
  ctx.log(`token moved from ${ctx.tokenVar ?? 'the start token'} to ${name} after a plan limit`);
  ctx.tokenVar = name;
}

function claudeArgs(ctx, run) {
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', JSON.stringify(run.settingsFile), '--strict-mcp-config', '--permission-mode', ctx.permissionMode];
  // --strict-mcp-config still loads servers named here, so only A2 and A5 get the memory's servers.
  if (run.mcpFile) args.push('--mcp-config', JSON.stringify(run.mcpFile));
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.maxBudgetUsd) args.push('--max-budget-usd', String(ctx.maxBudgetUsd));
  return args;
}

function lastJson(stdout) {
  try {
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    return null;
  }
}

const claudeLimit = (cc, result) => isUsageLimit(result, `${cc.stdout}\n${cc.stderr}`);

export const requestLogFile = (run, taskId, kind, attempt) => path.join(run.rawDir, `${taskId}.${kind}${attempt}.requests.jsonl`);

export function requestLogs(run, taskId, kind) {
  const own = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${kind}\\d+\\.requests\\.jsonl$`);
  return fs.existsSync(run.rawDir) ? fs.readdirSync(run.rawDir).filter((f) => own.test(f)).sort().map((f) => path.join(run.rawDir, f)) : [];
}

async function withRequestLog(logFile, env, fn) {
  if (!logFile) return fn(env);
  const proxy = await startLogProxy(logFile, env.ANTHROPIC_BASE_URL ? { upstream: env.ANTHROPIC_BASE_URL } : {});
  try {
    return await fn({ ...env, ANTHROPIC_BASE_URL: proxy.url });
  } finally {
    await proxy.close();
  }
}

export async function untilNotLimited(ctx, run, t, { args, input, rawName, reset, command = () => `${ctx.claude} ${args().join(' ')}`, env = run.env, isLimit = claudeLimit, redact = (text) => text, logKind = null }) {
  let cutOffMs = 0;
  // SHORTCUT: 15-minute polls up to 8 days, so a weekly limit's reset is waited out; parse the reset time if polling costs too much.
  for (let attempt = 1; ; attempt++) {
    const start = performance.now();
    const logFile = logKind ? requestLogFile(run, t.id, logKind, attempt) : null;
    const tokenEnv = ctx.token && env[TOKEN_KEY] ? { ...env, [TOKEN_KEY]: ctx.token } : env;
    const cc = await withRequestLog(logFile, tokenEnv, (e) => spawnTree(command(), run.dirs.work, e, ctx.sessionTimeoutMs, input));
    const result = lastJson(cc.stdout);
    if (cc.timedOut || !isLimit(cc, result)) return { cc, result, limitRetries: attempt - 1, cutOffMs };
    fs.writeFileSync(path.join(run.rawDir, `${t.id}.${rawName}${attempt}.txt`), redact(`${cc.stdout}\n${cc.stderr}`).slice(-20000));
    if (attempt > ctx.limitMaxWaits) throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: still at the plan limit after ${ctx.limitMaxWaits} waits`);
    ctx.log(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: plan limit hit, waiting ${Math.round(ctx.limitWaitMs / 60_000)} min (attempt ${attempt})`);
    await sleep(ctx.limitWaitMs);
    moveToken(ctx);
    const stop = reset();
    cutOffMs += performance.now() - start;
    if (stop) return { cc, result: null, limitRetries: attempt, cutOffMs, stopped: true };
  }
}

export async function runSession(ctx, run, t, reset) {
  let sessionId = null;
  const args = () => {
    sessionId = randomUUID();
    return [...claudeArgs(ctx, run), '--session-id', sessionId];
  };
  const session = await untilNotLimited(ctx, run, t, { args, input: t.prompt, rawName: 'limit', reset, logKind: 'session' });
  return { ...session, sessionId };
}

export async function resumeSession(ctx, run, t, sessionId, message, afterReset = () => {}) {
  const args = [...claudeArgs(ctx, run), '--resume', sessionId];
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-resume-'));
    const snap = workSnapshot(run, sessionId, dir);
    const reset = () => {
      restoreWork(run, snap, sessionId);
      return afterReset();
    };
    const projects = path.join(run.dirs.claudeConfig, 'projects');
    const main = findTranscript(projects, sessionId);
    const sizesBefore = new Map([...snap.transcripts].map(([f, bytes]) => [f, bytes.length]));
    const before = { bytesBefore: (main && sizesBefore.get(main)) || 0, sizesBefore, filesBefore: new Set(listTranscripts(projects)) };
    return { ...(await untilNotLimited(ctx, run, t, { args: () => args, input: message, rawName: 'resume-limit', reset, logKind: 'resume' })), ...before };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const withTempIndex = (work, fn) => agentGit(work, (rgit, scratch) => fn(rgit, { GIT_INDEX_FILE: path.join(scratch, 'index') }));

const transcriptsOf = (run, sessionId) => sessionFiles(path.join(run.dirs.claudeConfig, 'projects'), sessionId);

function workSnapshot(run, sessionId, dir) {
  const work = run.dirs.work;
  const tree = withTempIndex(work, (rgit, env) => {
    rgit(['read-tree', 'HEAD'], work, env);
    rgit(['add', '-A'], work, env);
    return rgit(['write-tree'], work, env).trim();
  });
  fs.cpSync(path.join(work, '.git'), path.join(dir, 'git'), { recursive: true });
  const transcripts = new Map(transcriptsOf(run, sessionId).map((f) => [f, fs.readFileSync(f)]));
  return { dir, tree, instructions: instructionSnapshot(work), transcripts };
}

function restoreWork(run, snap, sessionId) {
  const work = run.dirs.work;
  fs.rmSync(path.join(work, '.git'), { recursive: true, force: true, maxRetries: 3 });
  fs.cpSync(path.join(snap.dir, 'git'), path.join(work, '.git'), { recursive: true });
  // SHORTCUT: git-ignored files the cut-off attempt wrote stay; snapshot them too if an agent ever leans on one.
  withTempIndex(work, (rgit, env) => {
    rgit(['read-tree', snap.tree], work, env);
    rgit(['checkout-index', '-a', '-f'], work, env);
    rgit(['clean', '-ffdq'], work, env);
  });
  restoreInstructions(work, snap.instructions);
  for (const f of transcriptsOf(run, sessionId)) if (!snap.transcripts.has(f)) fs.rmSync(f);
  for (const [f, bytes] of snap.transcripts) fs.writeFileSync(f, bytes);
}
