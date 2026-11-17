// hippo adapter init, after `hippo init`: LLM extraction off and prompt recall on, as round 3 pinned them.
import * as fs from 'node:fs';
import * as path from 'node:path';

const cfgPath = path.join(process.cwd(), '.hippo', 'config.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (err) {
  // init may write no config; an existence check first would race the read.
  if (err.code !== 'ENOENT') throw err;
}
// Pinned, so a change to hippo's promptRecall default cannot move what the arms receive.
fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, extraction: { enabled: false }, pinnedInject: { ...cfg.pinnedInject, promptRecall: true } }, null, 2));
