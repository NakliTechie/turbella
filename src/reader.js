// Read a Claude Code transcript file into events (Node only). Refuses anything
// but a regular file under MAX_BYTES, so a pipe cannot hang the caller and a
// huge file cannot exhaust memory.

import { readFile, stat } from 'node:fs/promises';
import { readClaudeEvents } from './transcript.js';

export const MAX_BYTES = 256 * 1024 * 1024;

export async function readClaudeFile(filePath) {
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error(`not a regular file: ${filePath}`);
  if (st.size > MAX_BYTES) throw new Error(`transcript over ${MAX_BYTES / 1024 / 1024} MB: ${filePath}`);
  const events = [];
  for await (const ev of readClaudeEvents((await readFile(filePath, 'utf8')).split('\n'))) events.push(ev);
  return events;
}
