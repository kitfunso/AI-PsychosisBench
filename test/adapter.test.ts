// The memory adapter: manifest checks, namespaces, the empty start, the key pass-through, install, reset and the export leak scan.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  loadAdapter, validateAdapter, namespaceFor, newNonce, setNamespace, fillVars, assertEmpty, memoryStore, storeHolds, resetMemory, runInstall, adapterInit, settleMsOf, SETTLE_CAP_MS,
} from '../lib/adapter.mjs';
import { armEnv, childEnv, ARMS } from '../lib/arms.mjs';
import { runDirs, freshRunDirs } from '../lib/homes.mjs';
import { storedAt, capturedBy } from '../lib/leaks.mjs';
import { RESTORABLE, RESTORE_ONLY } from '../lib/surfaces.mjs';

const FAKE = resolve(__dirname, 'fixtures', 'fake-memory.json');
const FAKE_JS = resolve(__dirname, 'fixtures', 'fake-memory.mjs');
const manifest = () => JSON.parse(readFileSync(FAKE, 'utf8'));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const pathOnly = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|COMSPEC|TEMP|TMP)$/i.test(k)));

/** A run dir with the fake memory installed, as startRun leaves an adapter arm's run. */
function memRun(arm = 'A2', adapter = loadAdapter(FAKE)) {
  const out = tmp('aipb-mem-');
  const d = runDirs(out, 'seqA', arm, 1);
  freshRunDirs(d);
  const ctx = { outDir: out, adapter };
  const env = armEnv(arm, d, { ...pathOnly(), FAKEMEM_API_KEY: 'mem-key-sentinel' }, { adapter });
  const run = { s: { id: 'seqA' }, arm, seed: 1, dirs: d, env, runName: 'seqA', nonce: newNonce() } as Record<string, any>;
  runInstall(ctx, run);
  return { ctx, run, adapter };
}
/** Store `text` the way a hook or the agent would, through the run's own launcher env. */
const remember = (run: Record<string, any>, text: string) => execFileSync(process.execPath, [FAKE_JS, 'remember', text], {
  env: { ...process.env, AIPB_NAMESPACE: run.env.AIPB_NAMESPACE, FAKEMEM_STORE: join(run.dirs.home, 'fakemem') },
});
const NO_SURFACES = Object.fromEntries([...RESTORABLE, ...RESTORE_ONLY, 'instructions'].map((k) => [k, []]));

describe('manifest checks', () => {
  it('loads a manifest with its folder and the sha256 of its bytes', () => {
    const a = loadAdapter(FAKE);
    expect(a).toMatchObject({ name: 'fake-memory', version: '0.0.1', dir: resolve(__dirname, 'fixtures') });
    expect(a.sha256).toBe(createHash('sha256').update(readFileSync(FAKE)).digest('hex'));
    expect(loadAdapter(resolve(__dirname, '..', 'adapters', 'hippo.json'))).toMatchObject({ name: 'hippo', namespaceEnv: ['HIPPO_TENANT'], workDirs: ['.hippo'] });
  });

  it('names the field and the fix for each bad manifest', () => {
    const ok = manifest();
    const cases: Array<[object, RegExp]> = [
      [{ ...ok, name: '' }, /m\.json: name must be a non-empty string/],
      [{ ...ok, export: [] }, /export must be a non-empty array of shell commands that print every text stored in \$AIPB_NAMESPACE/],
      [{ ...ok, hiddenWords: [] }, /hiddenWords must list at least one word/],
      [{ ...ok, mem0: 1 }, /mem0 is not a manifest field; the fields are name, version/],
      [{ ...ok, init: 'fakemem init' }, /init must be an array of shell command strings/],
      [{ ...ok, env: ['PATH'] }, /env cannot hold PATH/],
      [{ ...ok, env: ['claude_code_oauth_token'] }, /env cannot hold claude_code_oauth_token/],
      [{ ...ok, env: ['AIPB_NAMESPACE'] }, /env cannot hold AIPB_NAMESPACE/],
      [{ ...ok, env: ['ANTHROPIC_API_KEY'] }, /env cannot hold ANTHROPIC_API_KEY/],
      [{ ...ok, env: ['MEM_TENANT'], namespaceEnv: ['MEM_TENANT'] }, /namespaceEnv repeats MEM_TENANT from env/],
      [{ ...ok, settleMs: SETTLE_CAP_MS + 1 }, /settleMs must be a whole number of milliseconds from 0 to 30000/],
      [{ ...ok, workDirs: ['../up'] }, /workDirs must list plain folder names/],
      [{ ...ok, workDirs: ['.git'] }, /workDirs must list plain folder names/],
      [[], /the manifest must be a JSON object/],
    ];
    for (const [m, re] of cases) expect(() => validateAdapter(m, 'm.json'), JSON.stringify(m)).toThrow(re);
    expect(() => loadAdapter(join(tmp('aipb-none-'), 'none.json'))).toThrow(/no such file; pass the path of a memory manifest, such as adapters\/hippo.json/);
    const broken = join(tmp('aipb-bad-'), 'bad.json');
    writeFileSync(broken, '{ "name": ');
    expect(() => loadAdapter(broken)).toThrow(/bad\.json: not valid JSON/);
  });

  it('fills $AIPB_X and ${AIPB_X} at any depth and leaves the rest', () => {
    const vars = { AIPB_OUT: 'C:\\out', AIPB_HOME: '/h' };
    expect(fillVars({ a: ['x "${AIPB_OUT}\\logs"', '$AIPB_HOME/y $AIPB_NAMESPACE ${AIPB_OTHER}'], n: 5 }, vars))
      .toEqual({ a: ['x "C:\\out\\logs"', '/h/y $AIPB_NAMESPACE ${AIPB_OTHER}'], n: 5 });
  });

  it('caps settleMs for every manifest', () => {
    expect(settleMsOf(null)).toBe(0);
    expect(settleMsOf({ settleMs: 5000 })).toBe(5000);
    expect(settleMsOf({ settleMs: 10 * SETTLE_CAP_MS })).toBe(SETTLE_CAP_MS);
  });
});

describe('namespaceFor', () => {
  it('is sha256(nonce) for A2 and sha256(nonce/taskId) for A5, 16 hex characters, with a new nonce per run', () => {
    const nonce = 'f00d';
    expect(namespaceFor({ arm: 'A2', nonce }, { id: 't1' })).toBe(sha16('f00d'));
    expect(namespaceFor({ arm: 'A2', nonce }, { id: 't2' })).toBe(sha16('f00d'));
    expect(namespaceFor({ arm: 'A5', nonce }, { id: 't1' })).toBe(sha16('f00d/t1'));
    expect(namespaceFor({ arm: 'A5', nonce }, { id: 't2' })).toBe(sha16('f00d/t2'));
    expect(namespaceFor({ arm: 'A2', nonce }, { id: 't1' })).toMatch(/^[0-9a-f]{16}$/);
    const nonces = new Set(Array.from({ length: 20 }, newNonce));
    expect(nonces.size).toBe(20);
  });

  it('setNamespace sets AIPB_NAMESPACE and every namespaceEnv name, and says when it is new', () => {
    const run = { env: {} as Record<string, string> };
    expect(setNamespace(run, { namespaceEnv: ['HIPPO_TENANT'] }, 'abc')).toBe(true);
    expect(run.env).toEqual({ AIPB_NAMESPACE: 'abc', HIPPO_TENANT: 'abc' });
    expect(setNamespace(run, { namespaceEnv: ['HIPPO_TENANT'] }, 'abc')).toBe(false);
  });
});

describe('the memory keys in the env', () => {
  const adapter = validateAdapter({ ...manifest(), env: ['MEM0_API_KEY'], namespaceEnv: ['MEM0_TENANT'] });
  const base = { ...pathOnly(), MEM0_API_KEY: 'mem0-sentinel', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
  const run = () => runDirs(tmp('aipb-env-'), 'seqA', 'A2', 1);

  it('A2 and A5 get the manifest keys past the secret check; other arms never; childEnv strips them as it strips the token', () => {
    const d = run();
    for (const arm of ARMS) {
      const env = armEnv(arm, d, base, { adapter });
      const memory = arm === 'A2' || arm === 'A5';
      expect(env.MEM0_API_KEY, arm).toBe(memory ? 'mem0-sentinel' : undefined);
      expect(env.AIPB_MEMORY_KEYS, arm).toBe(memory ? 'MEM0_API_KEY,MEM0_TENANT' : undefined);
      // The runner names a namespace only for A2 and A5.
      if (memory) setNamespace({ env }, adapter, 'ns1');
      const child = childEnv(env);
      for (const k of ['MEM0_API_KEY', 'MEM0_TENANT', 'AIPB_NAMESPACE', 'AIPB_MEMORY_KEYS', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(child, `${arm} ${k}`).not.toHaveProperty(k);
      expect(childEnv(env, { keepMemory: true }).MEM0_API_KEY, arm).toBe(memory ? 'mem0-sentinel' : undefined);
    }
  });

  it('the same name without a manifest still stops armEnv, and a missing key names the fix', () => {
    const d = run();
    expect(() => armEnv('A1', d, base, { passEnv: ['MEM0_API_KEY'] })).toThrow(/armEnv: MEM0_API_KEY looks like a secret/);
    expect(() => armEnv('A2', d, base, { passEnv: ['MEM0_API_KEY'] })).toThrow(/armEnv: MEM0_API_KEY looks like a secret/);
    expect(() => armEnv('A2', d, pathOnly(), { adapter })).toThrow(/fake-memory needs MEM0_API_KEY in the environment; export it before the run/);
  });
});

describe('install, assertEmpty and the export leak scan', () => {
  it('install runs once with the run\'s own HOME and the memory key, and puts the launcher in bin/', () => {
    const { run } = memRun('A2', { ...loadAdapter(FAKE), env: ['FAKEMEM_API_KEY'] });
    const calls = readFileSync(join(run.dirs.home, 'fakemem', 'calls.log'), 'utf8');
    expect(calls).toBe(`install key=set home=${run.dirs.home}\n`);
    expect(readFileSync(join(run.dirs.bin, process.platform === 'win32' ? 'fakemem.cmd' : 'fakemem'), 'utf8')).toContain(join(run.dirs.home, 'fakemem'));
  });

  it('assertEmpty passes an empty namespace and throws, with the fix, once it holds text', () => {
    const { ctx, run, adapter } = memRun();
    setNamespace(run, adapter, namespaceFor(run, { id: 't1' }));
    adapterInit(ctx, run);
    expect(() => assertEmpty(ctx, run)).not.toThrow();
    remember(run, 'left from an earlier run');
    expect(() => assertEmpty(ctx, run)).toThrow(/fake-memory: memory is not empty at the start of namespace [0-9a-f]{16} \(seqA A2 seed1\); export printed "left from an earlier run"\. Scope every store/);
  });

  it('memoryStore exports the namespace as one G3 store, where a key phrase is stored and a gold line is a leak', () => {
    const { ctx, run, adapter } = memRun();
    setNamespace(run, adapter, namespaceFor(run, { id: 't1' }));
    expect(memoryStore(ctx, run).entries).toEqual([{ id: 'export', content: '' }]);
    remember(run, 'note zq-f1-l1: Write the lesson file');
    remember(run, '// add must return the sum of both of its arguments');
    const store = memoryStore(ctx, run);
    expect(store).toMatchObject({ surface: 'memoryExport', path: `memory-export/${run.env.AIPB_NAMESPACE}` });
    const lesson = { id: 'f1-l1', keyPhrase: 'zq-f1-l1', rule: 'Write the lesson file' };
    expect(storedAt(lesson, { root: run.dirs.root, surfaces: NO_SURFACES, stores: [store] })).toBe(true);
    expect(storedAt({ ...lesson, id: 'f2-l1', keyPhrase: 'zq-f2-l1' }, { root: run.dirs.root, surfaces: NO_SURFACES, stores: [store] })).toBe(false);
    expect(capturedBy(lesson, [store])).toEqual({ captured: true, capturedAny: true });
    expect(storeHolds([store], ['// add must return the sum of both of its arguments'])).toBe(true);
    expect(storeHolds([store], ['// not stored'])).toBe(false);
    expect(storeHolds([store], [])).toBe(false);
  });

  it('A5 gets a new, empty namespace per task; a memory that ignores the namespace stops the run', () => {
    const { ctx, run, adapter } = memRun('A5');
    setNamespace(run, adapter, namespaceFor(run, { id: 't1' }));
    memoryStore(ctx, run);
    remember(run, 'learned in t1');
    expect(memoryStore(ctx, run).entries[0].content).toContain('learned in t1');
    setNamespace(run, adapter, namespaceFor(run, { id: 't2' }));
    expect(memoryStore(ctx, run).entries[0].content).toBe('');
    const leaky = { ...ctx, adapter: { ...adapter, export: ['node -e "console.log(\'learned in t1\')"'] } };
    setNamespace(run, adapter, namespaceFor(run, { id: 't3' }));
    expect(() => memoryStore(leaky, run)).toThrow(/memory is not empty at the start of namespace/);
  });

  it('resetMemory drops what the namespace stored since the attempt began; with no reset it reports false', () => {
    const { ctx, run, adapter } = memRun();
    setNamespace(run, adapter, namespaceFor(run, { id: 't1' }));
    memoryStore(ctx, run);
    remember(run, 'kept from before');
    const since = new Date(Date.now() + 5).toISOString();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    remember(run, 'cut-off attempt note');
    expect(resetMemory(ctx, run, since)).toBe(true);
    expect(memoryStore(ctx, run).entries[0].content.trim()).toBe('kept from before');
    expect(resetMemory({ ...ctx, adapter: { ...adapter, reset: undefined } }, run, since)).toBe(false);
  });

  it('a failing command names the memory, the step and the run', () => {
    const { ctx, run, adapter } = memRun();
    setNamespace(run, adapter, 'ns');
    const broken = { ...ctx, adapter: { ...adapter, init: ['node -e "process.exit(4)"'] } };
    expect(() => adapterInit(broken, run)).toThrow(/fake-memory init failed for seqA A2 seed1 \(exit 4\)/);
  });
});
