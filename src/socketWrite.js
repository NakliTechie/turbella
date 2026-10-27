// Send events to the daemon's Unix socket, starting the daemon when none runs.

import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sockPath } from './paths.js';

const DAEMON_BIN = fileURLToPath(new URL('../bin/turbella', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Write one JSON line. Resolves once written; rejects on error or after `timeout` ms.
export function writeEvent(obj, { timeout = 150 } = {}) {
  const line = JSON.stringify(obj ?? {}) + '\n';
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: sockPath() });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.once('error', fail);
    socket.setTimeout(timeout, () => fail(new Error('timeout')));
    socket.once('connect', () => {
      socket.write(line, (err) => (err ? fail(err) : (socket.destroy(), resolve())));
    });
  });
}

// Start the daemon detached, so it outlives the process that launched it. If
// two start at once, the loser finds a live socket and exits.
// Inside another runtime (an agent's plugin under Bun) process.execPath is that
// agent's binary, so fall back to `node` on the PATH.
export function spawnDaemon() {
  const node = /[/\\]node(\.exe)?$/.test(process.execPath) ? process.execPath : 'node';
  const child = spawn(node, [DAEMON_BIN, 'start'], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
}

// Write one event, starting the daemon when nothing listens. Resolves true on
// delivery, false otherwise; never rejects. Waits at most `budgetMs`.
export async function deliver(obj, { budgetMs = 1500 } = {}) {
  try { await writeEvent(obj); return true; } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') return false;
  }
  spawnDaemon();
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(100);
    try { await writeEvent(obj); return true; } catch {}
  }
  return false;
}
