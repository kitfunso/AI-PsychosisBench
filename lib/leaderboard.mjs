import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCORE_SCHEMA, estimateText } from './score.mjs';
import { BENCH, SLUG } from './name.mjs';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
export const LEADERBOARD_SCHEMA = `${SLUG}-leaderboard/1`;

const interval = (e) => ({ estimate: e.estimate, low: e.low, high: e.high, units: e.units, text: estimateText(e) });

export function rankedRow(row, text) {
  const s = JSON.parse(text);
  if (s.schema !== SCORE_SCHEMA) throw new Error(`${row.score}: schema ${s.schema}, expected ${SCORE_SCHEMA}`);
  if (!s.gates || Object.values(s.gates).some((pass) => !pass)) throw new Error(`${row.score}: a gate failed, so the run is not ranked`);
  if (!s.H1 || !s.learn || !s.memory) throw new Error(`${row.score}: needs H1, learn and the memory manifest's name`);
  return {
    label: row.label, memory: s.memory.name, version: s.memory.version, learns: interval(s.learn), vsBuiltIn: interval(s.H1), status: row.status,
    score: row.score,
  };
}

export function buildLeaderboard(rows, readScore) {
  return {
    schema: LEADERBOARD_SCHEMA, bench: BENCH,
    rows: rows.map((row) => (row.score ? rankedRow(row, readScore(row.score)) : { label: row.label, memory: row.label, version: null, learns: null, vsBuiltIn: null, status: row.status })),
  };
}

export function leaderboardJson(docs = DOCS) {
  const rows = JSON.parse(fs.readFileSync(path.join(docs, 'scores', 'rows.json'), 'utf8'));
  const board = buildLeaderboard(rows, (rel) => fs.readFileSync(path.join(docs, 'scores', rel), 'utf8'));
  return `${JSON.stringify(board, null, 2)}\n`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(DOCS, 'leaderboard.json');
  fs.writeFileSync(out, leaderboardJson());
  console.log(`wrote ${out}`);
}
