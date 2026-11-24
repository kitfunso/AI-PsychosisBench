import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validateTasks } from './ab-run.mjs';

export const SPLITS = ['full', 'lite'];
export const LITE = Object.freeze({ arms: Object.freeze(['A1', 'A2', 'A5']), seeds: 1 });
const MANIFEST = 'manifest.json';

export function hashFile(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let size = 0;
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      h.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), bytes: size };
}

export function listFiles(dir, base = '') {
  const files = fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel];
  });
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function writeManifest(dir) {
  const files = listFiles(dir).filter((f) => f !== MANIFEST).map((f) => ({ path: f, ...hashFile(path.join(dir, f)) }));
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify({ files }, null, 2)}\n`);
  return files;
}

const inScope = (keys) => (rel) => keys === null || !rel.startsWith('repos/') || keys.includes(rel.split('/')[1]);

export function manifestProblems(dir, keys = null) {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) return [`no ${MANIFEST} in ${dir}`];
  const scope = inScope(keys);
  const listed = new Set();
  const bad = [];
  for (const e of JSON.parse(fs.readFileSync(file, 'utf8')).files) {
    listed.add(e.path);
    if (!scope(e.path)) continue;
    const p = path.join(dir, e.path);
    if (!fs.existsSync(p)) bad.push(`missing ${e.path}`);
    else {
      const got = hashFile(p);
      if (got.bytes !== e.bytes || got.sha256 !== e.sha256) bad.push(`changed ${e.path}`);
    }
  }
  for (const f of listFiles(dir)) if (f !== MANIFEST && scope(f) && !listed.has(f)) bad.push(`extra ${f}`);
  return bad;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function splitKeys(dir, split) {
  if (!SPLITS.includes(split)) throw new Error(`--split must be one of ${SPLITS.join(', ')}, got ${split}`);
  const keys = readJson(path.join(dir, 'splits.json'))[split];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`${path.join(dir, 'splits.json')} lists no ${split} keys`);
  return keys;
}

function repoSpec(dir, name, key) {
  const repoDir = path.join(dir, 'repos', key);
  const spec = readJson(path.join(repoDir, 'tasks.json'));
  for (const s of spec.sequences ?? []) {
    if (typeof s.repo !== 'string') continue;
    s.repoPath = path.resolve(repoDir, s.repo);
    s.repo = `${name}/repos/${key}/${s.repo}`;
  }
  return validateTasks(spec, repoDir);
}

function assertUnique(specs) {
  const seen = new Map();
  for (const [key, spec] of specs) {
    const ids = [...spec.sequences.map((s) => `sequence ${s.id}`), ...(spec.families ?? []).flatMap((f) => [`family ${f.id}`, ...(f.lessons ?? []).map((l) => `lesson ${l.id}`)])];
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`${id} is in both repos/${seen.get(id)} and repos/${key}`);
      seen.set(id, key);
    }
  }
}

export function loadDataset(datasetDir, { split = 'full', checkManifest = true } = {}) {
  const dir = path.resolve(datasetDir);
  if (!fs.existsSync(path.join(dir, 'pins.json'))) throw new Error(`${dir} is not a packed dataset: it has no pins.json`);
  const keys = splitKeys(dir, split);
  const total = readJson(path.join(dir, 'splits.json')).full?.length ?? keys.length;
  if (checkManifest) {
    const bad = manifestProblems(dir, keys);
    if (bad.length) throw new Error(`the dataset at ${dir} differs from its manifest.json: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? `; and ${bad.length - 5} more` : ''}`);
  }
  const pinsFile = path.join(dir, 'pins.json');
  const pins = readJson(pinsFile);
  const name = pins.dataset ?? path.basename(dir);
  const specs = keys.map((key) => [key, repoSpec(dir, name, key)]);
  assertUnique(specs);
  const spec = { families: specs.flatMap(([, s]) => s.families ?? []), sequences: specs.flatMap(([, s]) => s.sequences) };
  return { dir, name, pins, pinsFile, split, keys, total, spec };
}

export const datasetLine = (d) => `dataset  ${d.name} · ${d.split} split, ${d.keys.length} of ${d.total} repos · sha256 ok`;
