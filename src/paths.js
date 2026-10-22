// Where the daemon's socket and address file live. One resolver, so the hook,
// the CLI and the daemon always agree.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function sockPath() {
  return process.env.TURBELLA_SOCK || join(homedir(), '.turbella.sock');
}

// Beside the socket, so a test daemon never overwrites the real one's address.
export function stateFile() {
  return process.env.TURBELLA_SOCK ? `${process.env.TURBELLA_SOCK}.state` : join(homedir(), '.turbella.state');
}

// The running daemon's address, or null when there is none. A state file left
// by a crashed daemon is ignored: its pid must still be alive.
export function readState() {
  let st;
  try { st = JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return null; }
  try { process.kill(st.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  return st;
}
