// The tool versions every Z0 record names, and the pins check that keeps every run on the dataset's Claude Code and model.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Version 1's pins, for a tasks file with no dataset pins.json above it; a new pin is a new dataset version. */
export const DATASET_PINS = Object.freeze({ claudeVersion: '2.1.288', model: 'claude-opus-5-5' });

/** The leading version number of `claude --version` output, or null. */
export const claudeVersionToken = (out) => /^\s*(\d+(?:\.\d+)*)(?=\s|$)/.exec(String(out))?.[1] ?? null;

/** The pins a run's start differs from, one line each; a key in `actual` that the pins file lacks counts as a difference. */
export function pinMismatches(pins, actual) {
  const bad = [];
  for (const [key, value] of Object.entries(actual)) {
    if (pins[key] === undefined) bad.push(`${key} is not pinned`);
    else if (String(pins[key]) !== String(value)) bad.push(`${key} is pinned ${pins[key]}, this run has ${value}`);
  }
  return bad;
}

/** What --pins compares before any session spends usage; Claude Code's version is its leading token, so "2.1.288 (Claude Code)" pins as 2.1.288. */
export const claudePinned = (ctx) => ({ claudeVersion: claudeVersionToken(ctx.claudeVersion), model: ctx.model });

/** The pins.json of the dataset that holds `tasksFile` (<dataset>/repos/<key>/tasks.json), as `{file, pins}`, or null. */
export function datasetPins(tasksFile) {
  let dir = path.dirname(path.resolve(tasksFile));
  for (let up = 0; up < 3; up++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'pins.json');
    if (fs.existsSync(file)) return { file, pins: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return null;
}

/** The pins a run checks, as `{pins, from}`: --pins, else the dataset's pins.json, else DATASET_PINS; --allow-off-pin checks none. */
export function runPins(tasksFile, pinsFile = null, offPin = false) {
  if (offPin && pinsFile !== null) throw new Error('--allow-off-pin turns the pins check off, so it cannot be combined with --pins');
  if (offPin) return { pins: null, from: null };
  if (pinsFile !== null) return { pins: JSON.parse(fs.readFileSync(pinsFile, 'utf8')), from: '--pins' };
  // Round 3 checked pins only with --pins; version 1 checks every run, so a vendor's rows stay comparable.
  const found = datasetPins(tasksFile);
  return found ? { pins: found.pins, from: found.file } : { pins: DATASET_PINS, from: 'the version 1 pins' };
}

/** Throws when pins are given and the run differs from them, naming how to get back on pin; `from` names where the pins came from. */
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
