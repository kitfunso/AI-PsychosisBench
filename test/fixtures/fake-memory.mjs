#!/usr/bin/env node
// A stand-in memory for the adapter tests: entries in one JSON-lines file, scoped by $AIPB_NAMESPACE.
// Commands: install, init, remember TEXT, export, reset (drops entries since $AIPB_SINCE), inject (a UserPromptSubmit hook), --version.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const [cmd, ...rest] = process.argv.slice(2);
// The launcher names the store, so a hook or the agent's shell finds it with no AIPB_HOME of their own.
const store = process.env.FAKEMEM_STORE ?? path.join(process.env.AIPB_HOME ?? '.', 'fakemem');
const entriesFile = path.join(store, 'entries.jsonl');
const ns = process.env.AIPB_NAMESPACE;
const read = () => (fs.existsSync(entriesFile) ? fs.readFileSync(entriesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const mine = () => read().filter((e) => e.ns === ns);
const needNs = () => {
  if (!ns) {
    console.error('fakemem: AIPB_NAMESPACE is not set');
    process.exit(2);
  }
};
const callLog = (line) => {
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(path.join(store, 'calls.log'), `${line}\n`);
};

if (cmd === '--version') {
  console.log('fakemem 0.0.1');
} else if (cmd === 'install') {
  const bin = process.env.AIPB_BIN;
  const own = path.join(process.env.AIPB_HOME, 'fakemem');
  const script = fileURLToPath(import.meta.url);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fakemem'), `#!/bin/sh\nFAKEMEM_STORE="${own}" exec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fakemem.cmd'), `@setlocal\r\n@set "FAKEMEM_STORE=${own}"\r\n@"${process.execPath}" "${script}" %*\r\n`);
  callLog(`install key=${process.env.FAKEMEM_API_KEY ? 'set' : 'unset'} home=${process.env.HOME}`);
} else if (cmd === 'init') {
  callLog(`init ${ns}`);
} else if (cmd === 'remember') {
  needNs();
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(entriesFile, `${JSON.stringify({ ns, at: new Date().toISOString(), text: rest.join(' ') })}\n`);
} else if (cmd === 'export') {
  needNs();
  for (const e of mine()) console.log(e.text);
} else if (cmd === 'reset') {
  needNs();
  const since = process.env.AIPB_SINCE ?? '';
  const kept = read().filter((e) => e.ns !== ns || e.at < since);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(entriesFile, kept.map((e) => `${JSON.stringify(e)}\n`).join(''));
  callLog(`reset ${ns} since ${since}`);
} else if (cmd === 'inject') {
  needNs();
  const texts = mine().map((e) => e.text);
  if (texts.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `## Fake memory\n${texts.map((t) => `- ${t}`).join('\n')}\n` } }));
} else {
  console.error(`fakemem: unknown command ${cmd}`);
  process.exit(2);
}
