// Convert a Claude Code / Codex JSONL transcript into a neutral event JSON array
// for the Turbella replay page (web/turbella.html). The page accepts a .json file
// (an array of neutral events) via its file input.
//
//   node scripts/export-events.mjs <transcript.jsonl> [out.json]
//
// Defaults: reads test/fixtures/claude-retry-loop.jsonl and writes
// test/fixtures/claude-retry-loop.events.json (synthetic, no secrets).

import { readClaudeFile } from '../src/reader.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const defaultIn = join(here, '..', 'test', 'fixtures', 'claude-retry-loop.jsonl');
const defaultOut = join(here, '..', 'test', 'fixtures', 'claude-retry-loop.events.json');

async function main() {
  const inFile = process.argv[2] || defaultIn;
  const outFile = process.argv[3] || defaultOut;
  const events = await readClaudeFile(inFile, 's-retry');
  await writeFile(outFile, JSON.stringify(events, null, 2));
  console.log(`wrote ${events.length} events -> ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
