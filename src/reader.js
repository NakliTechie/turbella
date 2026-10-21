// Transcript file readers (Node only): read a JSONL file and run it through
// the shared parser in transcript.js.

import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { readClaudeEvents, readCodexEvents, KIND, STATUS } from './transcript.js';

async function readLines(filePath) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) lines.push(line);
  return lines;
}

export async function readClaudeFile(filePath, session = null) {
  const events = [];
  for await (const ev of readClaudeEvents(await readLines(filePath), session)) events.push(ev);
  return events;
}

export async function readCodexFile(filePath, session = null) {
  const events = [];
  for await (const ev of readCodexEvents(await readLines(filePath), session)) events.push(ev);
  return events;
}

export { readClaudeEvents, readCodexEvents, KIND, STATUS };
