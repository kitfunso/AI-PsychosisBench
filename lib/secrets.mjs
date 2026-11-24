import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { listFiles } from './dataset.mjs';

export const KEY_SHAPES = [
  ['Anthropic key or token', /sk-ant-[A-Za-z0-9_-]{20,}/],
  // sk-ant- is Anthropic's prefix, so an Anthropic key is named once.
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export const shapesIn = (text) => KEY_SHAPES.filter(([, re]) => re.test(text)).map(([name]) => name);

export function packObjects(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a git pack');
  const count = buf.readUInt32BE(8);
  const out = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    let byte = buf[pos++];
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = buf[pos++];
    if (type === 6) {
      do byte = buf[pos++]; while (byte & 0x80);
    } else if (type === 7) pos += 20;
    const { buffer, engine } = inflateSync(buf.subarray(pos), { info: true });
    out.push(buffer);
    pos += engine.bytesWritten;
  }
  return out;
}

export function bundlePack(buf) {
  const end = buf.indexOf('\n\n', 0, 'latin1');
  if (!buf.subarray(0, 12).toString('latin1').startsWith('# v') || end < 0) throw new Error('not a git bundle');
  return buf.subarray(end + 2);
}

export function findKeys(dir) {
  const hits = [];
  for (const rel of listFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    const texts = [buf.toString('latin1')];
    if (buf.subarray(0, 3).toString('latin1') === '# v') texts.push(...packObjects(bundlePack(buf)).map((b) => b.toString('latin1')));
    for (const shape of new Set(texts.flatMap(shapesIn))) hits.push({ file: rel, shape });
  }
  return hits;
}
