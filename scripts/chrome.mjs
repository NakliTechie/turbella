// Headless Chrome over the DevTools protocol, for scripts that need a real
// browser (ttfv.mjs, capture.mjs). No dependency: Node 22's WebSocket.
//
// Chrome runs with a throwaway profile in its own temp dir; close() waits for
// Chrome to exit before deleting it, because Chrome writes the profile until then.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ width = 1280, height = 800, scale = 2 } = {}) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);
  const profile = mkdtempSync(join(tmpdir(), 'tb-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [devPort] = readFileSync(portFile, 'utf8').split('\n');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result?.result?.value;
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.result.data, 'base64');
    },
    async close() {
      try { ws.close(); } catch {}
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await Promise.race([exited, sleep(3000)]);
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
