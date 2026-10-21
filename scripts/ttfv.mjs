// Time to first value, cold: from the first hook event with no daemon running
// to that event drawn on the live page. Gate: 5 s (DOCTRINES rule 2).
//
// Run:  node scripts/ttfv.mjs        exit 0 within the gate, 1 over it or on error
//
// Steps timed from one clock:
//   hook      bin/turbella-hook runs with no daemon, starts one and delivers
//   page      headless Chrome loads http://127.0.0.1:<port>/
//   drawn     the page's status line reads "1 events · live"
//
// Chrome runs headless with a throwaway profile in one temp dir, deleted on exit.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE_MS = 5000;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const here = new URL('.', import.meta.url).pathname;
const HOOK = join(here, '..', 'bin', 'turbella-hook');
const tmp = mkdtempSync(join(tmpdir(), 'tb-ttfv-'));
const SOCK = join('/tmp', `tb-ttfv-${process.pid}.sock`); // macOS caps socket paths at 104 chars
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, TURBELLA_SOCK: SOCK, TURBELLA_PORT: '0' };

let chrome = null;
// Chrome keeps writing its profile until it exits, so wait for the exit first.
async function cleanup() {
  try { process.kill(JSON.parse(readFileSync(`${SOCK}.state`, 'utf8')).pid); } catch {}
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  return {
    send: (method, params = {}) => new Promise((res) => {
      pending.set(++id, res);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);

  // Chrome starts before the clock: the measured path is Turbella's, not the browser's launch.
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${tmp}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(tmp, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [devPort] = readFileSync(portFile, 'utf8').split('\n');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json`)).json();
  const page = await cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);

  const t0 = performance.now();
  execFileSync(process.execPath, [HOOK], {
    env,
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'ttfv', tool_name: 'Bash', tool_input: { command: 'ls' } }),
  });
  const tHook = performance.now() - t0;
  const { port } = JSON.parse(readFileSync(`${SOCK}.state`, 'utf8'));

  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let text = '';
  while (performance.now() - t0 < GATE_MS * 2) {
    const r = await page.send('Runtime.evaluate', { expression: "document.getElementById('status')?.textContent ?? ''", returnByValue: true });
    text = r.result?.result?.value ?? '';
    if (text.startsWith('1 events')) break;
    await sleep(20);
  }
  const tDrawn = performance.now() - t0;
  page.close();

  const ok = text.startsWith('1 events') && tDrawn <= GATE_MS;
  console.log(JSON.stringify({ hook_ms: Math.round(tHook), drawn_ms: Math.round(tDrawn), gate_ms: GATE_MS, status: text, pass: ok }));
  return ok;
}

main()
  .then(async (ok) => { await cleanup(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error(`ttfv: ${e.message}`); await cleanup(); process.exit(1); });
