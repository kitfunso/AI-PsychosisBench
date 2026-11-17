// One (sequence, arm, seed) run: its dirs, env and settings, plus the shared context and record writer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh, cloneFresh } from './exec.mjs';
import { HIPPO_ARMS, armSettings, armEnv, startupTools } from './arms.mjs';
import { runDirs, freshRunDirs } from './homes.mjs';
import { stubBaseCommit, assertNoInstructionLinks, STUB_CLAUDE_MD } from './workspace.mjs';
import { lessonIndex } from './lessons.mjs';
import { assertNoPhraseInStub } from './leaks.mjs';
import { refuseOffPins, claudePinned } from './pins.mjs';

/** Refuse A2 and A5 until a memory adapter is wired in; round 3 ran them on hippo's own checkout. */
export function assertNoMemoryArms(arms) {
  const memory = arms.filter((a) => HIPPO_ARMS.has(a));
  if (memory.length) throw new Error(`${memory.join(', ')} need a memory adapter, which this runner does not have yet; run A0, A1 and A4 only`);
}

/** Clone each sequence's repo into the cache, then refuse any task to be run (a screen's screen tasks too) whose stub tree checkoutBase would refuse or that holds a key phrase. */
export function cacheTaskRepos(spec, cacheDir, { screen = false } = {}) {
  // Finding a symlinked instruction file here saves abandoning a lockstep run midway.
  for (const s of spec.sequences) {
    const cached = path.join(cacheDir, s.id);
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      cloneFresh(s.repo, cached);
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
  assertNoMemoryArms(opts.arms ?? []);
  const { spec, outDir, claudeBin = 'claude', warmup = true, passEnv = [] } = opts;
  const { claude } = startupTools(claudeBin, process.env);
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = {
    outDir, passEnv, claude, records: [], cacheDir: path.join(outDir, 'repo-cache'),
    model: opts.model ?? null, maxBudgetUsd: opts.maxBudgetUsd ?? null, settleMs: opts.settleMs ?? 5000, permissionMode: opts.permissionMode ?? 'bypassPermissions',
    limitWaitMs: opts.limitWaitMs ?? 15 * 60_000, sessionTimeoutMs: opts.sessionTimeoutMs ?? 60 * 60_000, limitMaxWaits: opts.limitMaxWaits ?? 8 * 96, log: opts.log ?? console.log,
    lessons: lessonIndex(spec.families ?? []), recordsFile: opts.recordsFile ?? 'runs.jsonl', progress: opts.progress ?? {},
    ledgerFile: path.join(outDir, 'ledger.jsonl'), snapDir: path.join(outDir, 'snap'), canaries: opts.canaries ?? [], foreignDirs: [], leakedRuns: new Map(),
    operatorEnv: { ...process.env }, tokenSchedule: opts.tokenSchedule ?? null, tokenVar: opts.tokenVar ?? null, token: null, readToken: opts.readToken ?? null,
  };
  cacheTaskRepos(spec, ctx.cacheDir, { screen: opts.screen === true });
  const warmDir = path.join(outDir, 'warmup');
  const warmEnv = armEnv('A0', { ...runDirs(warmDir, '', '', 0), claudeConfig: path.join(warmDir, 'claude-config') }, process.env, { passEnv });
  ctx.claudeVersion = sh(`${claude} --version`, outDir, warmEnv).stdout.trim() || null;
  refuseOffPins(opts.pins, claudePinned(ctx));
  if (warmup) {
    // One unrecorded call, so the first recorded run does not alone pay the cold prompt-cache write.
    fs.mkdirSync(warmEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    const warmArgs = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', ...(ctx.model ? ['--model', ctx.model] : [])];
    sh(`${claude} ${warmArgs.join(' ')}`, warmDir, warmEnv, 10 * 60_000, 'Reply with the single word OK.');
  }
  return ctx;
}

/** A run's first step: fresh dirs under `name` (the sequence id unless a screen names its own), env and settings; checkoutBase makes the work repo. */
export function startRun(ctx, s, arm, seed, name = s.id) {
  const dirs = runDirs(ctx.outDir, name, arm, seed);
  freshRunDirs(dirs);
  const env = armEnv(arm, dirs, process.env, { passEnv: ctx.passEnv });
  const settingsFile = path.join(ctx.outDir, 'settings', `${name}-${arm}-seed${seed}.json`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(armSettings(arm, null), null, 2));
  return {
    s, arm, seed, dirs, env, settingsFile, cached: path.join(ctx.cacheDir, s.id), seenErrors: new Set(), changes: new Map(), taught: [], teachSeen: new Set(), captured: new Map(),
    rawDir: path.join(ctx.outDir, 'raw', name, arm, `seed${seed}`), runName: name,
  };
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

/** Memory arms only: a SessionEnd hook can write in the background, so let it finish before the next turn reads the store. */
export async function settle(ctx, run, cell, when) {
  if (!HIPPO_ARMS.has(run.arm)) return;
  await sleep(ctx.settleMs);
  fs.appendFileSync(path.join(run.dirs.root, 'settle.log'), `${cell} ${when}\n`);
  afterSettle(run, cell, when);
}
