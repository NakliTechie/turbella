import { createConnection } from 'node:net';
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
