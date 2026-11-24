import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAdapter, fillVars } from '../lib/adapter.mjs';
import { armSettings } from '../lib/arms.mjs';

const R3 = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'r3-db3-A2-seed1.json'), 'utf8'));
const R3_OUT = 'C:\\z0-runs\\scored\\r3run\\db3-w1\\run';
const HIPPO = loadAdapter(resolve(__dirname, '..', 'adapters', 'hippo.json'));

const normalise = (v: unknown, outDir: string): unknown => JSON.parse(JSON.stringify(v).split(JSON.stringify(outDir).slice(1, -1)).join('<OUT>'));

describe('the hippo adapter', () => {
  it('reproduces round 3\'s A2 settings once the out dir is filled in', () => {
    const out = 'D:\\runs\\v1';
    const now = fillVars(armSettings('A2', HIPPO), { AIPB_OUT: out });
    expect(normalise(now, out)).toEqual(normalise(R3, R3_OUT));
    expect(JSON.stringify(now)).not.toContain('AIPB_');
  });

  it('gives A5 the same settings as A2; only the namespace differs', () => {
    expect(armSettings('A5', HIPPO)).toEqual(armSettings('A2', HIPPO));
  });
});
