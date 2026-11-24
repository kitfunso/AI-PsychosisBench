import * as fs from 'node:fs';
import * as path from 'node:path';
import { sh, pathKey } from './exec.mjs';

export function venvRepos(dataset) {
  const table = JSON.parse(fs.readFileSync(path.join(dataset.dir, 'toolchain.json'), 'utf8'));
  const byBundle = new Map(dataset.keys.filter((k) => table[k]?.tools?.includes('python')).map((k) => [path.join(dataset.dir, 'repos', k, 'repo.bundle'), k]));
  return new Map(dataset.spec.sequences.filter((s) => byBundle.has(s.repoPath)).map((s) => [s.id, byBundle.get(s.repoPath)]));
}

export function withVenv(env, dir) {
  if (!fs.existsSync(path.join(dir, 'pyvenv.cfg'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = sh(`python -m venv "${dir}"`, path.dirname(dir), env, 10 * 60_000);
    if (r.status !== 0) throw new Error(`python -m venv ${dir} failed (exit ${r.status}): ${`${r.stdout}\n${r.stderr}`.trim().slice(-300)}; put Python 3 on PATH and run again`);
  }
  const key = pathKey(env);
  const scripts = path.join(dir, process.platform === 'win32' ? 'Scripts' : 'bin');
  const rest = Object.fromEntries(Object.entries(env).filter(([k]) => !['VIRTUAL_ENV', 'PYTHONUTF8', 'PYTHONIOENCODING'].includes(k.toUpperCase())));
  return { ...rest, VIRTUAL_ENV: dir, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', [key]: `${scripts}${path.delimiter}${env[key] ?? ''}` };
}
