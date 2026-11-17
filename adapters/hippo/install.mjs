// hippo adapter install: the run's own `hippo` launcher in $AIPB_BIN, on the round 3 build only, as round 3's shim was.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// dist/ of hippo at tag z0-r3-freeze (commit cb992a07), as C:/z0-runs/scored/pins-r3.json pins it.
const R3_DIST_HASH = '97ba0e9b48a27a66527c52c59462fd455395512101c98e2b19768afb32d6b1dd';

/** The round 3 runner's tree hash: each file's path, size and bytes, in path order. */
function treeHash(dir) {
  const h = createHash('sha256');
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(dir, f));
    h.update(`${f}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

const cli = process.env.HIPPO_CLI_JS;
const bin = process.env.AIPB_BIN;
const out = process.env.AIPB_OUT;
if (!cli || !fs.existsSync(cli)) {
  console.error(`HIPPO_CLI_JS is ${cli ? `${cli}, which does not exist` : 'not set'}; build hippo at tag z0-r3-freeze and export HIPPO_CLI_JS=<checkout>/dist/cli.js`);
  process.exit(1);
}
const hash = treeHash(path.dirname(path.resolve(cli)));
if (hash !== R3_DIST_HASH) {
  console.error(`${path.dirname(cli)} hashes ${hash}, not round 3's ${R3_DIST_HASH}; rebuild hippo at tag z0-r3-freeze with no local changes`);
  process.exit(1);
}
fs.mkdirSync(bin, { recursive: true });
// Round 3's HOME for every hippo call was the out dir, which keeps hippo off the operator's ~/.claude.
fs.writeFileSync(path.join(bin, 'hippo'), `#!/bin/sh\nexport HOME="${out}" USERPROFILE="${out}"\nexec "${process.execPath}" "${path.resolve(cli)}" "$@"\n`, { mode: 0o755 });
// @setlocal: a caller that runs hippo inside a longer cmd line keeps its own HOME afterwards.
fs.writeFileSync(path.join(bin, 'hippo.cmd'), `@setlocal\r\n@set "HOME=${out}"\r\n@set "USERPROFILE=${out}"\r\n@"${process.execPath}" "${path.resolve(cli)}" %*\r\n`);
