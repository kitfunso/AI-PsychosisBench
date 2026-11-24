import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!fs.existsSync('.hippo')) process.exit(0);
const r = spawnSync('hippo export', { shell: true, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`hippo export failed (exit ${r.status}): ${r.stderr}`);
  process.exit(1);
}
const at = r.stdout.indexOf('[');
const entries = at < 0 ? [] : JSON.parse(r.stdout.slice(at));
for (const e of entries) console.log(e.content);
