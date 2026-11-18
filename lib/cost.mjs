// `cost`: sessions and dollars per arm over finished runs; a session is a record Claude Code billed (costUsd above 0).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRunDir } from './run-dir.mjs';
import { LITE } from './dataset.mjs';
import { ARMS } from './arms.mjs';
import { SLUG } from './name.mjs';

/** Per arm: sessions, dollars, and the (runs file, seed) pairs they came from. */
export function costByArm(runsFiles) {
  const by = new Map();
  for (const file of runsFiles) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!(r.costUsd > 0)) continue;
      const a = by.get(r.arm) ?? { sessions: 0, usd: 0, runSeeds: new Set() };
      a.sessions += 1;
      a.usd += r.costUsd;
      a.runSeeds.add(`${file}|${r.seed}`);
      by.set(r.arm, a);
    }
  }
  return new Map(ARMS.filter((a) => by.has(a)).map((a) => [a, by.get(a)]));
}

/** A lite run's size from these rates: `keys` repos, the lite arms on seed 1, at the built-in and memory arms' sessions per run-seed and dollars per session. */
export function liteEstimate(by, keys) {
  const base = ['A1', 'A2'].map((a) => by.get(a));
  if (base.some((a) => !a)) return null;
  const perRunSeed = (base[0].sessions / base[0].runSeeds.size + base[1].sessions / base[1].runSeeds.size) / 2;
  const usdPerSession = (base[0].usd + base[1].usd) / (base[0].sessions + base[1].sessions);
  const sessions = keys * LITE.arms.length * LITE.seeds * perRunSeed;
  return { keys, sessions: Math.round(sessions), usd: sessions * usdPerSession };
}

const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;

/** The cost table as text; `liteKeys` adds the lite estimate. */
export function costText(by, liteKeys = null) {
  const rows = [...by].map(([arm, a]) => `${arm.padEnd(5)} ${String(a.sessions).padStart(5)} sessions  ${usd(a.usd).padStart(7)}`);
  const all = [...by.values()].reduce((t, a) => ({ sessions: t.sessions + a.sessions, usd: t.usd + a.usd }), { sessions: 0, usd: 0 });
  rows.push(`full  ${String(all.sessions).padStart(5)} sessions  ${usd(all.usd).padStart(7)}  (${[...by.keys()].join(' ')})`);
  const lite = liteKeys === null ? null : liteEstimate(by, liteKeys);
  if (lite) rows.push(`lite  approx. ${lite.sessions} sessions, approx. ${usd(lite.usd)}  (${lite.keys} repos, ${LITE.arms.join(' ')}, seed ${LITE.seeds}, at the A1 and A2 rates above)`);
  return rows.join('\n');
}

const USAGE = `usage: ${SLUG} cost --run DIR [--run DIR]... [--dataset DIR]`;

/** `cost` as a function of argv: every --run dir's runs files summed by arm; the dataset's lite split sizes the lite estimate. */
export function costCli(argv, flags, { datasetDir }) {
  const dirs = flags.many('--run');
  if (dirs.length === 0) throw new Error(USAGE);
  const files = dirs.flatMap((d) => readRunDir(d).parts.map((p) => p.runs));
  const dir = flags.one('--dataset') ?? datasetDir;
  const splits = path.join(dir, 'splits.json');
  const liteKeys = fs.existsSync(splits) ? JSON.parse(fs.readFileSync(splits, 'utf8')).lite.length : null;
  return { code: 0, stdout: `runs files ${files.length}\n${costText(costByArm(files), liteKeys)}\n`, stderr: '' };
}
