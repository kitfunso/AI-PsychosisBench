import * as fs from 'node:fs';
import * as path from 'node:path';

export const DATASET_PINS = Object.freeze({ claudeVersion: '2.1.288', model: 'claude-opus-5-5' });

export const claudeVersionToken = (out) => /^\s*(\d+(?:\.\d+)*)(?=\s|$)/.exec(String(out))?.[1] ?? null;

export function pinMismatches(pins, actual) {
  const bad = [];
  for (const [key, value] of Object.entries(actual)) {
    if (pins[key] === undefined) bad.push(`${key} is not pinned`);
    else if (String(pins[key]) !== String(value)) bad.push(`${key} is pinned ${pins[key]}, this run has ${value}`);
  }
  return bad;
}

export const claudePinned = (ctx) => ({ claudeVersion: claudeVersionToken(ctx.claudeVersion), model: ctx.model });

export function datasetPins(tasksFile) {
  let dir = path.dirname(path.resolve(tasksFile));
  for (let up = 0; up < 3; up++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'pins.json');
    if (fs.existsSync(file)) return { file, pins: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return null;
}

export function runPins(tasksFile, pinsFile = null, offPin = false) {
  if (offPin && pinsFile !== null) throw new Error('--allow-off-pin turns the pins check off, so it cannot be combined with --pins');
  if (offPin) return { pins: null, from: null };
  if (pinsFile !== null) return { pins: JSON.parse(fs.readFileSync(pinsFile, 'utf8')), from: '--pins' };
  const found = datasetPins(tasksFile);
  return found ? { pins: found.pins, from: found.file } : { pins: DATASET_PINS, from: 'the version 1 pins' };
}

export function refuseOffPins(pins, actual, from = '--pins') {
  if (!pins) return;
  const bad = pinMismatches(pins, actual);
  if (!bad.length) return;
  const fix = [
    ...(pins.claudeVersion ? [`install Claude Code ${pins.claudeVersion} (npm install -g @anthropic-ai/claude-code@${pins.claudeVersion})`] : []),
    ...(pins.model ? [`pass --model ${pins.model}`] : []),
  ];
  throw new Error(`this run differs from ${from}: ${bad.join('; ')}. To fix it, ${fix.join(' and ')}; or pass --allow-off-pin for a run whose rows are not comparable with the published ones.`);
}
