// Re-hashes a packed dataset against its manifest.json; exits 1 on any change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] ?? path.join(HERE, '..', 'out', 'ai-psychosis-bench-r3-v1'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const bad = [];
const listed = new Set();
for (const e of manifest.files) {
  listed.add(e.path);
  const p = path.join(dir, e.path);
  if (!fs.existsSync(p)) { bad.push(`missing ${e.path}`); continue; }
  const h = crypto.createHash('sha256');
  let size = 0;
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); size += n; }
  fs.closeSync(fd);
  if (size !== e.bytes || h.digest('hex') !== e.sha256) bad.push(`changed ${e.path}`);
}
const walk = (d, b = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => {
  const r = b ? `${b}/${x.name}` : x.name;
  return x.isDirectory() ? walk(path.join(d, x.name), r) : [r];
});
for (const f of walk(dir)) if (f !== 'manifest.json' && !listed.has(f)) bad.push(`extra ${f}`);
if (bad.length) { console.error(bad.join('\n')); console.error(`FAIL: ${bad.length} problem(s)`); process.exit(1); }
console.log(`OK: ${manifest.files.length} files match manifest.json`);
