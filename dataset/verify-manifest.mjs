// Re-hashes a packed dataset against its manifest.json; exits 1 on any change.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { SLUG } from '../lib/name.mjs';
import { manifestProblems } from '../lib/dataset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] ?? path.join(HERE, '..', 'out', `${SLUG}-r3-v1`));
const bad = manifestProblems(dir);
if (bad.length) { console.error(bad.join('\n')); console.error(`FAIL: ${bad.length} problem(s)`); process.exit(1); }
console.log(`OK: ${JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files.length} files match manifest.json`);
