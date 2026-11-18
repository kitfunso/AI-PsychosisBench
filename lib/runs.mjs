// One (sequence, arm, seed) run: its dirs, env and settings, plus the shared context and record writer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh, cloneFresh } from './exec.mjs';
import { ADAPTER_ARMS, armSettings, armEnv, startupTools, authMode } from './arms.mjs';
import { newNonce, runVars, fillVars, runInstall, settleMsOf } from './adapter.mjs';
import { runDirs, freshRunDirs } from './homes.mjs';
import { stubBaseCommit, assertNoInstructionLinks, STUB_CLAUDE_MD } from './workspace.mjs';
import { lessonIndex } from './lessons.mjs';
import { assertNoPhraseInStub } from './leaks.mjs';
import { refuseOffPins, claudePinned } from './pins.mjs';
import { withVenv } from './venv.mjs';

/** Refuse A2 and A5 without a memory manifest, before any clone or session. */
export function requireAdapter(arms, adapter) {
  const memory = arms.filter((a) => ADAPTER_ARMS.has(a));
  if (memory.length && !adapter) throw new Error(`${memory.join(', ')} run the memory under test; pass --memory <manifest>, such as adapters/hippo.json, or run A0, A1 and A4 only`);
}

/** Clone each sequence's repo (a packed dataset's bundle, `repoPath`) into the cache, then refuse any task to be run (a screen's screen tasks too) whose stub tree checkoutBase would refuse or that holds a key phrase. */
export function cacheTaskRepos(spec, cacheDir, { screen = false } = {}) {
  // Finding a symlinked instruction file here saves abandoning a lockstep run midway.
  for (const s of spec.sequences) {
    const cached = path.join(cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      cloneFresh(s.repoPath ?? s.repo, cached);
    }
    const screens = screen ? (spec.families ?? []).filter((f) => f.sequence === s.id && f.screen).map((f) => f.screen) : [];
    for (const t of [...s.tasks, ...screens]) {
      const stub = stubBaseCommit(cached, t.baseRef, STUB_CLAUDE_MD);
      assertNoInstructionLinks(cached, s.id, t, stub);
      assertNoPhraseInStub(spec, cached, s.id, t, stub);
    }
  }
}

/** The shared context of a run or a screen: tools, limits, the lesson index, the cached repos, the Claude version, one warm-up call. */
export async function openContext(opts) {
  requireAdapter(opts.arms ?? [], opts.adapter);
  const { spec, outDir, claudeBin = 'claude', warmup = true, passEnv = [] } = opts;
  const { claude } = startupTools(claudeBin, process.env);
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = {
    outDir, passEnv, claude, records: [], cacheDir: path.join(outDir, 'repo-cache'), venvRepos: opts.venvRepos ?? new Map(),
    model: opts.model ?? null, maxBudgetUsd: opts.maxBudgetUsd ?? null, adapter: opts.adapter ?? null, settleMs: settleMsOf(opts.adapter), permissionMode: opts.permissionMode ?? 'bypassPermissions',
    limitWaitMs: opts.limitWaitMs ?? 15 * 60_000, sessionTimeoutMs: opts.sessionTimeoutMs ?? 60 * 60_000, limitMaxWaits: opts.limitMaxWaits ?? 8 * 96, log: opts.log ?? console.log,
    lessons: lessonIndex(spec.families ?? []), recordsFile: opts.recordsFile ?? 'runs.jsonl', progress: opts.progress ?? {},
    ledgerFile: path.join(outDir, 'ledger.jsonl'), snapDir: path.join(outDir, 'snap'), canaries: opts.canaries ?? [], foreignDirs: [], leakedRuns: new Map(),
    operatorEnv: { ...process.env }, auth: authMode(process.env), tokenSchedule: opts.tokenSchedule ?? null, tokenVar: opts.tokenVar ?? null, token: null, readToken: opts.readToken ?? null,
  };
  cacheTaskRepos(spec, ctx.cacheDir, { screen: opts.screen === true });
  const warmDir = path.join(outDir, 'warmup');
  const warmEnv = armEnv('A0', { ...runDirs(warmDir, '', '', 0), claudeConfig: path.join(warmDir, 'claude-config') }, process.env, { passEnv });
  ctx.claudeVersion = sh(`${claude} --version`, outDir, warmEnv).stdout.trim() || null;
  refuseOffPins(opts.pins, claudePinned(ctx), opts.pinsFrom);
  if (warmup) {
    // One unrecorded call, so the first recorded run does not alone pay the cold prompt-cache write.
    fs.mkdirSync(warmEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const warmArgs = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', ...(ctx.model ? ['--model', ctx.model] : [])];
    sh(`${claude} ${warmArgs.join(' ')}`, warmDir, warmEnv, 10 * 60_000, 'Reply with the single word OK.');
  }
  return ctx;
}

/** A run's first step: fresh dirs under `name` (the sequence id unless a screen names its own), env and settings, and for A2 and A5 the memory's install; checkoutBase makes the work repo. */
export function startRun(ctx, s, arm, seed, name = s.id) {
  const dirs = runDirs(ctx.outDir, name, arm, seed);
  freshRunDirs(dirs);
  const memory = ADAPTER_ARMS.has(arm) ? ctx.adapter : null;
  // One venv per Python repo, shared by its arms and seeds, as round 3's one run per repo had.
  const repo = ctx.venvRepos?.get(s.id);
  const base = repo ? withVenv(process.env, path.join(ctx.outDir, 'venv', repo)) : process.env;
  const env = armEnv(arm, dirs, base, { passEnv: ctx.passEnv, adapter: memory });
  const settingsFile = path.join(ctx.outDir, 'settings', `${name}-${arm}-seed${seed}.json`);
  const run = {
    s, arm, seed, dirs, env, settingsFile, cached: path.join(ctx.cacheDir, s.id), seenErrors: new Set(), changes: new Map(), taught: [], teachSeen: new Set(), captured: new Map(),
    rawDir: path.join(ctx.outDir, 'raw', name, arm, `seed${seed}`), runName: name, nonce: memory ? newNonce() : null, mcpFile: null,
  };
  const vars = memory ? runVars(ctx, run) : {};
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(fillVars(armSettings(arm, memory), vars), null, 2));
  if (memory?.mcpServers) {
    run.mcpFile = path.join(ctx.outDir, 'mcp', `${name}-${arm}-seed${seed}.json`);
    fs.mkdirSync(path.dirname(run.mcpFile), { recursive: true });
    fs.writeFileSync(run.mcpFile, JSON.stringify({ mcpServers: fillVars(memory.mcpServers, vars) }, null, 2));
  }
  if (memory) runInstall(ctx, run);
  return run;
}

const SKIPPED = { setup: 'setup failed, skipped', leak: 'a leak voids this sequence and seed, skipped', 'ancestor-instructions': 'an instruction file sits above work/, skipped' };

export function writeRecord(ctx, record) {
  ctx.records.push(record);
  fs.appendFileSync(path.join(ctx.outDir, ctx.recordsFile),`${JSON.stringify(record)}\n`);
  const outcome = SKIPPED[record.invalid] ?? (record.resolved ? 'resolved' : 'not resolved');
  ctx.log(`${record.sequence} ${record.taskId} ${record.arm} seed${record.seed}: ${outcome}${record.costUsd ? `, $${record.costUsd.toFixed(4)}` : ''}${record.invalid ? ` (invalid: ${record.invalid})` : ''}`);
}

// Async, so a run inside a test worker never blocks the worker's RPC with its parent.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

let afterSettle = () => {};

/** Test seam standing in for a background hook that writes during the wait (the lint bans module mocks); null removes it. */
export function __setSettleHook(fn) {
  afterSettle = fn ?? (() => {});
}

/** A2 and A5 only: a SessionEnd hook can write in the background, so let it finish before the next turn reads the store. */
export async function settle(ctx, run, cell, when) {
  if (!ADAPTER_ARMS.has(run.arm)) return;
  await sleep(ctx.settleMs);
  fs.appendFileSync(path.join(run.dirs.root, 'settle.log'), `${cell} ${when}\n`);
  afterSettle(run, cell, when);
}
