import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_KEY, TOKEN_KEY, authMode } from '../lib/arms.mjs';
import { validateRecord } from '../lib/z0-records.mjs';
import { g1 } from '../lib/z0-gates.mjs';
import { validateCorpus } from './fixtures/z0-contract.js';
import { FAKE_MEMORY, cleanup, find, fixtureEnv, isolate, logLines, makeRepo, oneLesson, rawResult, readPlan, readRecords, run, tmp } from './fixtures/z0-harness.js';

vi.setConfig({ testTimeout: 30_000 });

const FAKE_KEY = 'zq-fake-api-key-0000';
const FAKE_TOKEN = 'fake-tok-auth';
const saved = { [TOKEN_KEY]: process.env[TOKEN_KEY], [API_KEY]: process.env[API_KEY] };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanup();
});
const runNames = <T extends { envKeys?: string[] }>(recs: T[]): T[] => recs.map((r) => ({ ...r, envKeys: (r.envKeys ?? []).filter((k) => !fixtureEnv().includes(k)) }));
function auth(token: string | undefined, key: string | undefined) {
  for (const [k, v] of [[TOKEN_KEY, token], [API_KEY, key]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('authMode', () => {
  it('names the one mode set, in any case, and null for none', () => {
    expect(authMode({ [TOKEN_KEY]: 't' })).toBe('oauth');
    expect(authMode({ anthropic_api_key: 'k' })).toBe('apikey');
    expect(authMode({ [TOKEN_KEY]: '' })).toBeNull();
    expect(authMode({})).toBeNull();
  });

  it('refuses both at once, naming the two vars and never their values', () => {
    let message = '';
    try {
      authMode({ [TOKEN_KEY]: FAKE_TOKEN, [API_KEY]: FAKE_KEY });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set.*unset one of them/);
    for (const v of [FAKE_TOKEN, FAKE_KEY]) expect(message).not.toContain(v);
  });
});

describe('a run in one auth mode', () => {
  it('an API-key run gives the key to each session and to no checker, and each record says auth apikey', async () => {
    const { out } = isolate('auth-apikey');
    auth(undefined, FAKE_KEY);
    const dumps = tmp('z0-auth-dumps-');
    process.env.Z0_ENV_DUMP_DIR = dumps;
    await run(oneLesson(makeRepo(), {}, { check: { script: 'env-dump.mjs', args: [] } }), ['A0'], out);
    const recs = readRecords(out);
    expect(recs).toHaveLength(5);
    for (const r of recs) {
      expect(r, r.taskId).toMatchObject({ auth: 'apikey', invalid: null });
      expect(r.envKeys, r.taskId).toContain(API_KEY);
      expect(r.envKeys, r.taskId).not.toContain(TOKEN_KEY);
    }
    expect(rawResult(out, 'A0', 't1.json').envKeys).toContain(API_KEY);
    const files = readdirSync(dumps);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const env = JSON.parse(readFileSync(join(dumps, f), 'utf8')) as Record<string, string>;
      expect(Object.keys(env).filter((k) => [API_KEY, TOKEN_KEY].includes(k.toUpperCase())), f).toEqual([]);
      expect(Object.values(env), f).not.toContain(FAKE_KEY);
    }
    expect(() => validateCorpus(recs, readPlan(out))).not.toThrow();
    expect(g1(runNames(recs), {})).toMatchObject({ pass: true, envKeysOutside: {}, authModes: { oauth: 0, apikey: 5 }, mixedAuth: false });
    expect(g1(runNames([...recs, { ...recs[0], auth: 'oauth' }]), {})).toMatchObject({ pass: false, authModes: { oauth: 1, apikey: 5 }, mixedAuth: true });
  }, 300_000);

  it('a token run says auth oauth', async () => {
    const { out } = isolate('auth-oauth');
    auth(FAKE_TOKEN, undefined);
    await run(oneLesson(makeRepo()), ['A0'], out);
    const recs = readRecords(out);
    for (const r of recs) expect(r, r.taskId).toMatchObject({ auth: 'oauth' });
    expect(g1(runNames(recs), {})).toMatchObject({ pass: true, envKeysOutside: {}, authModes: { oauth: 5, apikey: 0 } });
  }, 300_000);

  it('refuses a run with both a token and an API key before any session, so it writes no record', async () => {
    const { out, log } = isolate('auth-both');
    auth(FAKE_TOKEN, FAKE_KEY);
    await expect(run(oneLesson(makeRepo()), ['A0'], out)).rejects.toThrow(/both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set/);
    expect(existsSync(join(out, 'runs.jsonl'))).toBe(false);
    expect(logLines(log)).toEqual([]);
  }, 120_000);
});

describe('the record names its memory', () => {
  it('A2 and A5 records carry the manifest name, version and sha256; A0 records carry none', async () => {
    const { out } = isolate('auth-memory');
    await run(oneLesson(makeRepo()), ['A0', 'A2', 'A5'], out);
    const recs = readRecords(out);
    const memory = { name: 'fake-memory', version: '0.0.1', manifestSha256: FAKE_MEMORY.sha256 };
    expect(FAKE_MEMORY.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const r of recs) {
      if (r.arm === 'A0') expect(r, r.taskId).not.toHaveProperty('memory');
      else expect(r.memory, `${r.arm} ${r.taskId}`).toEqual(memory);
    }
    expect(find(recs, 'A5', 'a2').memory).toEqual(memory);
    expect(() => validateCorpus(recs, readPlan(out))).not.toThrow();
    for (const r of recs) expect(() => validateRecord(r), `${r.arm} ${r.taskId}`).not.toThrow();
  }, 600_000);

  it('the record check reads auth and memory as optional, and refuses a bad value of either', () => {
    const base = { schema: 'z0-record/1', tool: 'claude-code' };
    const check = (extra: Record<string, unknown>) => () => validateRecord({ ...base, ...extra });
    expect(check({ auth: 'cookie' })).toThrow(/auth must be 'oauth' or 'apikey'/);
    expect(check({ memory: { name: 'm', version: '1', manifestSha256: 'abc' } })).toThrow(/memory must be \{name, version, manifestSha256\}/);
    expect(check({ memory: { name: '', version: '1', manifestSha256: 'a'.repeat(64) } })).toThrow(/memory must be/);
  });
});
