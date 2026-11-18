// A toy packed dataset: k1 holds the toy lesson families and their checker, k2 one no-lesson sequence, each with its own repo bundle.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeManifest } from '../../lib/dataset.mjs';

const TOY = resolve(__dirname, 'z0-checks');

/** A repo whose HEAD passes `node test.js`, bundled the way pack-dataset bundles one; returns HEAD. */
export function bundleRepo(dest: string, tmp: (prefix: string) => string): string {
  const repo = tmp('ds-repo-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'test.js'), 'process.exit(0);\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('bundle', 'create', join(dest, 'repo.bundle').replace(/\\/g, '/'), '--all');
  return git('rev-parse', 'HEAD');
}

const noLesson = (id: string, base: string) => ({ id, kind: 'no-lesson', baseRef: base, fixRef: base, prompt: `Task ${id}.`, test: 'node test.js', testFiles: [] });
/** Passes only under a Python whose prefix is the active VIRTUAL_ENV. */
export const VENV_CHECK = `python -c "import os, sys; sys.exit(0 if os.path.samefile(sys.prefix, os.environ['VIRTUAL_ENV']) else 1)"`;

/** The dataset folder; `lite` names the lite split's keys (k2 by default), `tasks` keeps only those toy tasks in k1, with their families, and `python` makes k2 a Python repo whose setup and test pass only in a venv. */
export function makeDataset(tmp: (prefix: string) => string, { lite = ['k2'], tasks = null, python = false }: { lite?: string[]; tasks?: string[] | null; python?: boolean } = {}): string {
  const dir = tmp('ds-');
  const k1 = join(dir, 'repos', 'k1');
  const k2 = join(dir, 'repos', 'k2');
  mkdirSync(k1, { recursive: true });
  mkdirSync(k2, { recursive: true });
  bundleRepo(k1, tmp);
  const toy = JSON.parse(readFileSync(join(TOY, 'toy-tasks.json'), 'utf8'));
  toy.sequences[0].repo = 'repo.bundle';
  if (tasks) {
    toy.sequences[0].tasks = toy.sequences[0].tasks.filter((t: { id: string }) => tasks.includes(t.id));
    const used = new Set(toy.sequences[0].tasks.map((t: { familyId?: string }) => t.familyId));
    toy.families = toy.families.filter((f: { id: string }) => used.has(f.id));
  }
  writeFileSync(join(k1, 'tasks.json'), JSON.stringify(toy));
  copyFileSync(join(TOY, 'lesson.mjs'), join(k1, 'lesson.mjs'));
  const base = bundleRepo(k2, tmp);
  const k2Tasks = [noLesson('b1', base), noLesson('b2', base)].map((t) => (python ? { ...t, setup: VENV_CHECK, test: VENV_CHECK } : t));
  writeFileSync(join(k2, 'tasks.json'), JSON.stringify({ sequences: [{ id: 'seqB', cluster: 'b', repo: 'repo.bundle', fixedOrder: true, tasks: k2Tasks }] }));
  writeFileSync(join(dir, 'pins.json'), JSON.stringify({ dataset: 'toy-r3-v1', claudeVersion: '2.1.288', model: 'claude-opus-5-5' }));
  writeFileSync(join(dir, 'splits.json'), JSON.stringify({ full: ['k1', 'k2'], lite }));
  writeFileSync(join(dir, 'toolchain.json'), JSON.stringify({ k1: { tools: ['node', 'git'] }, k2: { tools: python ? ['python'] : ['node'] } }));
  writeManifest(dir);
  return dir;
}
