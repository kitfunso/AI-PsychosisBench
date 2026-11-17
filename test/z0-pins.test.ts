// Pins: Claude Code's version token, the dataset pins every run checks by default, and the off-pin refusal.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATASET_PINS, datasetPins, pinMismatches, claudePinned, claudeVersionToken, refuseOffPins, runPins } from '../lib/pins.mjs';

describe('the --pins check', () => {
  const ctx = { claudeVersion: '2.1.288 (Claude Code)', model: 'claude-sonnet-5-5' };
  const pins = { claudeVersion: '2.1.288', model: 'claude-sonnet-5-5' };

  it('reads the leading version number and nothing else', () => {
    expect(claudeVersionToken('2.1.288 (Claude Code)')).toBe('2.1.288');
    expect(claudeVersionToken('  2.1.288\n')).toBe('2.1.288');
    expect(claudeVersionToken('Claude Code 2.1.288')).toBeNull();
  });

  it('pins Claude Code by its version token and passes a run that matches', () => {
    expect(claudePinned(ctx)).toEqual(pins);
    expect(() => refuseOffPins(pins, claudePinned(ctx))).not.toThrow();
  });

  it('names each difference and each key the pins file lacks', () => {
    expect(pinMismatches({ model: 'claude-opus-5-5' }, claudePinned(ctx))).toEqual([
      'claudeVersion is not pinned', 'model is pinned claude-opus-5-5, this run has claude-sonnet-5-5',
    ]);
  });

  it('refuses an off-pin run and checks nothing without pins', () => {
    const off = { ...ctx, model: 'claude-opus-5-5' };
    expect(() => refuseOffPins(pins, claudePinned(off))).toThrow(/differs from --pins: model is pinned claude-sonnet-5-5/);
    expect(() => refuseOffPins(null, claudePinned(off))).not.toThrow();
  });

  it('says where the pins came from and how to get back on pin', () => {
    const off = { claudeVersion: '2.1.300', model: 'claude-sonnet-5-5' };
    expect(() => refuseOffPins(DATASET_PINS, off, 'dataset/pins.json')).toThrow(new RegExp([
      'this run differs from dataset/pins\\.json: claudeVersion is pinned 2\\.1\\.288, this run has 2\\.1\\.300; model is pinned claude-opus-5-5, this run has claude-sonnet-5-5\\. ',
      'To fix it, install Claude Code 2\\.1\\.288 \\(npm install -g @anthropic-ai/claude-code@2\\.1\\.288\\) and pass --model claude-opus-5-5; ',
      'or pass --allow-off-pin for a run whose rows are not comparable with the published ones\\.',
    ].join('')));
  });
});

describe('the pins a run checks by default', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  /** A dataset root with repos/r1/tasks.json, and pins.json at the root when `pins` is given. */
  function dataset(pins?: object) {
    const root = mkdtempSync(join(tmpdir(), 'aipb-pins-'));
    dirs.push(root);
    mkdirSync(join(root, 'repos', 'r1'), { recursive: true });
    const tasks = join(root, 'repos', 'r1', 'tasks.json');
    writeFileSync(tasks, '{}');
    if (pins) writeFileSync(join(root, 'pins.json'), JSON.stringify(pins));
    return { root, tasks };
  }

  it('pins version 1 to Claude Code 2.1.288 and claude-opus-5-5', () => {
    expect(DATASET_PINS).toEqual({ claudeVersion: '2.1.288', model: 'claude-opus-5-5' });
    expect(Object.isFrozen(DATASET_PINS)).toBe(true);
  });

  it('finds the dataset pins.json two folders above a tasks file, and none outside a dataset', () => {
    const own = { dataset: 'x', round: 3, claudeVersion: '2.1.288', model: 'claude-opus-5-5' };
    const d = dataset(own);
    expect(datasetPins(d.tasks)).toEqual({ file: join(d.root, 'pins.json'), pins: own });
    expect(datasetPins(dataset().tasks)).toBeNull();
  });

  it('uses --pins, else the dataset pins.json, else the version 1 pins; --allow-off-pin checks none', () => {
    const own = { claudeVersion: '2.1.299', model: 'claude-opus-5-5' };
    const d = dataset(own);
    const file = join(d.root, 'other-pins.json');
    writeFileSync(file, JSON.stringify({ model: 'm' }));
    expect(runPins(d.tasks, file)).toEqual({ pins: { model: 'm' }, from: '--pins' });
    expect(runPins(d.tasks)).toEqual({ pins: own, from: join(d.root, 'pins.json') });
    expect(runPins(dataset().tasks)).toEqual({ pins: DATASET_PINS, from: 'the version 1 pins' });
    expect(runPins(d.tasks, null, true)).toEqual({ pins: null, from: null });
    expect(() => runPins(d.tasks, file, true)).toThrow(/--allow-off-pin .* cannot be combined with --pins/);
  });

  it('refuses a run off the dataset pins by default', () => {
    const d = dataset({ claudeVersion: '2.1.288', model: 'claude-opus-5-5' });
    const { pins, from } = runPins(d.tasks);
    expect(() => refuseOffPins(pins, { claudeVersion: '2.1.288', model: 'claude-sonnet-5-5' }, from ?? undefined)).toThrow(/differs from .*pins\.json: model is pinned claude-opus-5-5/);
    expect(() => refuseOffPins(pins, { claudeVersion: '2.1.288', model: 'claude-opus-5-5' }, from ?? undefined)).not.toThrow();
  });
});
