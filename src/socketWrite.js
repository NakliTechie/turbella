import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

function sockPath() {
  return process.env.TURBELLA_SOCK ||
    (process.env.HOME ? `${process.env.HOME}/.turbella.sock` : '/tmp/turbella.sock');
}

// Write one JSON line to the Turbella daemon's Unix socket. Returns a promise
// that resolves once the line is written (or rejects/times out on error).
// Hook callers intentionally do not await it — a hook that can't reach the
// daemon must never slow or break the agent (AGENTS.md + pending.md).
export function writeEvent(obj, opts = {}) {
  const line = JSON.stringify(obj ?? {}) + '\n';
  const socket = createConnection({ path: sockPath() });
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    socket.destroy();
  };
  const done = new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write(line, (err) => {
        if (err) { finish(false); reject(err); }
        else { finish(true); resolve(); }
      });
    });
    socket.once('error', (err) => { finish(false); reject(err); });
    socket.setTimeout(opts.timeout ?? 150, () => { finish(false); reject(new Error('timeout')); });
  });
  return done;
}

export { sockPath };

const DAEMON_BIN = new URL('../bin/turbella', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the daemon detached so it outlives the hook process that launched it.
// Two hooks racing here is harmless: the second daemon finds a live socket
// and exits.
export function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_BIN, 'start'], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
}

// Write one event, starting the daemon when nothing listens. Resolves true on
// delivery, false otherwise; never rejects, so hooks cannot fail loudly. The
// total wait is capped at `budgetMs`.
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
