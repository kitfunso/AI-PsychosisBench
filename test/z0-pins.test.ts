// Pins: Claude Code's version token and the --pins refusal.
import { describe, it, expect } from 'vitest';
import { pinMismatches, claudePinned, claudeVersionToken, refuseOffPins } from '../lib/pins.mjs';

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

  it('refuses an off-pin run and checks nothing without a pins file', () => {
    const off = { ...ctx, model: 'claude-opus-5-5' };
    expect(() => refuseOffPins(pins, claudePinned(off))).toThrow(/differs from --pins: model is pinned claude-sonnet-5-5/);
    expect(() => refuseOffPins(null, claudePinned(off))).not.toThrow();
  });
});
