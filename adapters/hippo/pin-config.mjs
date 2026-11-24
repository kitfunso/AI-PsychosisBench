import * as fs from 'node:fs';
import * as path from 'node:path';

const cfgPath = path.join(process.cwd(), '.hippo', 'config.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, extraction: { enabled: false }, pinnedInject: { ...cfg.pinnedInject, promptRecall: true } }, null, 2));
