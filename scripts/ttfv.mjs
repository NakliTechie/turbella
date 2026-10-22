// Time to first value, cold: from the first hook event with no daemon running
// to that event drawn on the live page. Gate: 5 s (DOCTRINES rule 2).
//
// Run:  node scripts/ttfv.mjs        exit 0 within the gate, 1 over it or on error
//
// Steps timed from one clock:
//   hook      bin/turbella-hook runs with no daemon, starts one and delivers
//   drawn     headless Chrome loads the page and its status line reads "1 events · live"
// Chrome is launched before the clock starts: the measured path is Turbella's.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './chrome.mjs';

const GATE_MS = 5000;
const here = new URL('.', import.meta.url).pathname;
const HOOK = join(here, '..', 'bin', 'turbella-hook');
const SOCK = `/tmp/tb-ttfv-${process.pid}.sock`; // macOS caps socket paths at 104 chars
const env = { ...process.env, TURBELLA_SOCK: SOCK, TURBELLA_PORT: '0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null;
async function cleanup() {
  try { process.kill(JSON.parse(readFileSync(`${SOCK}.state`, 'utf8')).pid); } catch {}
  await chrome?.close();
}

async function main() {
  chrome = await launchChrome();

  const t0 = performance.now();
  execFileSync(process.execPath, [HOOK], {
    env,
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'ttfv', tool_name: 'Bash', tool_input: { command: 'ls' } }),
  });
  const tHook = performance.now() - t0;
  const { port } = JSON.parse(readFileSync(`${SOCK}.state`, 'utf8'));

  await chrome.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let text = '';
  while (performance.now() - t0 < GATE_MS * 2) {
    text = (await chrome.evaluate("document.getElementById('status')?.textContent ?? ''")) ?? '';
    if (text.startsWith('1 events')) break;
    await sleep(20);
  }
  const tDrawn = performance.now() - t0;

  const ok = text.startsWith('1 events') && tDrawn <= GATE_MS;
  console.log(JSON.stringify({ hook_ms: Math.round(tHook), drawn_ms: Math.round(tDrawn), gate_ms: GATE_MS, status: text, pass: ok }));
  return ok;
}

main()
  .then(async (ok) => { await cleanup(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error(`ttfv: ${e.message}`); await cleanup(); process.exit(1); });
