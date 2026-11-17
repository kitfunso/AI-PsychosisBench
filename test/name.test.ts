// The public name: one display name and one lowercase slug, which package.json, the command and the cards all follow.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCH, SLUG } from '../lib/name.mjs';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const SCOPE = 'AI-PsychosisBench measures repeat mistakes by coding agents with memory. It is not a mental-health benchmark and is not related to psychosis-bench (arXiv 2509.10970).';

describe('the benchmark name', () => {
  it('has a display name and its lowercase slug', () => {
    expect(BENCH).toBe('AI-PsychosisBench');
    expect(SLUG).toBe(BENCH.toLowerCase());
  });

  it('names the package and its one command by the slug', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe(SLUG);
    expect(Object.keys(pkg.bin)).toEqual([SLUG]);
  });

  it('says what it measures near the top of the README and the dataset card', () => {
    for (const rel of ['README.md', 'dataset/README.md']) {
      const top = read(rel).split('\n').slice(0, 14);
      expect(top).toContain(SCOPE);
    }
  });

  it('keeps the old name out of the card, the pack script and the upload script', () => {
    for (const rel of ['dataset/README.md', 'dataset/pack-dataset.mjs', 'dataset/upload-hf.sh', 'dataset/verify-manifest.mjs']) {
      expect(read(rel)).not.toMatch(/ai-psychosis-bench/);
    }
  });
});
