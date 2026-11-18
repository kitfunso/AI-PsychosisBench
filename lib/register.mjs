// `register`: the plan a run will follow, its sha256 and cell count, and the issue body a vendor posts before the run starts. It never calls GitHub.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planFor, planJson, chooseArms } from './ab-run.mjs';
import { LITE, hashFile } from './dataset.mjs';
import { loadAdapter } from './adapter.mjs';
import { BENCH, SLUG } from './name.mjs';

/** The plan.json bytes a default run of the split writes: every arm at its prereg seeds for full, the lite arms on seed 1 for lite. */
export function splitPlan(dataset) {
  const lite = dataset.split === 'lite';
  const arms = chooseArms(dataset.spec, lite ? [...LITE.arms] : null, false);
  const text = planJson(planFor(dataset.spec, arms, lite ? LITE.seeds : null));
  return { arms, text, sha256: createHash('sha256').update(text).digest('hex'), cells: JSON.parse(text).length };
}

/** The registration: the plan's identity and the issue body that names the memory, the dataset and the pins. */
export function registration(dataset, manifestFile) {
  const memory = loadAdapter(manifestFile);
  const plan = splitPlan(dataset);
  const title = `run ${memory.name} ${memory.version ?? '(no version)'}, plan ${plan.sha256.slice(0, 12)}`;
  const rows = [
    ['memory', `${memory.name} ${memory.version ?? '(no version)'}`], ['manifest sha256', memory.sha256],
    ['dataset', dataset.name], ['dataset manifest.json sha256', hashFile(path.join(dataset.dir, 'manifest.json')).sha256],
    ['split', `${dataset.split}, ${dataset.keys.length} of ${dataset.total} repos`], ['arms', plan.arms.join(' ')],
    ['Claude Code', dataset.pins.claudeVersion], ['model', dataset.pins.model],
    ['plan sha256', plan.sha256], ['cells', String(plan.cells)],
  ];
  const body = [
    `# ${title}`, '',
    `${BENCH} registration. The run starts only after this issue exists, and its plan.json must hash to the plan sha256 below.`, '',
    '| field | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '',
    `Made by \`${SLUG} register\`. Submit the run's out dir; \`${SLUG} verify\` checks it against this plan.`, '',
  ].join('\n');
  return { memory, plan, title, body };
}

/** `register` as a function of argv: prints the plan and writes the issue body to a file; nothing is sent anywhere. */
export function registerCli(argv, flags, { loadSplit }) {
  const manifestFile = flags.one('--memory');
  if (manifestFile === null) throw new Error(`usage: ${SLUG} register --memory MANIFEST [--split full|lite] [--dataset DIR] [--out FILE]`);
  // Loading checks the split's files against manifest.json, so a changed dataset never gets a registered plan.
  const dataset = loadSplit();
  const r = registration(dataset, path.resolve(manifestFile));
  const out = path.resolve(flags.one('--out') ?? `register-${r.memory.name}-${r.memory.version ?? 'unversioned'}.md`);
  fs.writeFileSync(out, r.body);
  const stdout = [
    `plan      sha256 ${r.plan.sha256} · ${r.plan.cells} cells (${dataset.split} split, ${r.plan.arms.join(' ')})`,
    `issue     body written to ${out}; open a public issue titled "${r.title}" with it`,
    'start     after the issue exists',
  ].join('\n');
  return { code: 0, stdout: `${stdout}\n`, stderr: '' };
}
