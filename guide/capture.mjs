// Guide capture: walks the route-plan against a daemon on a temporary socket,
// fed a synthetic demo session through the real hook binary, and screenshots
// each route to guide/screenshots/. Part of the guide generator; regenerate with
// guide/regenerate.sh, never by editing index.html.
//
// Surface: browser (the timeline and the visualiser). One role, the person
// watching agents, so routes carry no role prefix.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../scripts/chrome.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const HOOK = join(here, '..', 'bin', 'turbella-hook');
const OUT = join(here, 'screenshots');
const SOCK = `/tmp/tb-guide-${process.pid}.sock`;
const env = { ...process.env, TURBELLA_SOCK: SOCK, TURBELLA_PORT: '0', TURBELLA_OPEN: '0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The entry, the key action and the result; /package-nt films these.
export const HERO_FLOW = ['01-timeline-empty', '02-timeline-live', '04-visualiser-all'];

// (NN-slug, backend, target, viewport, wait_ms, ready check, format)
const ROUTES = [
  ['01-timeline-empty', 'browser', '/', [1400, 900], 800, 'status'],
  ['02-timeline-live', 'browser', '/', [1400, 900], 1500, 'status', 'after-session'],
  ['03-visualiser-session', 'browser', '/viz?session=demo&cycle=0', [1400, 900], 2500, 'readout'],
  ['04-visualiser-all', 'browser', '/viz?cycle=0', [1400, 900], 2500, 'readout'],
  ['05-window-session', 'browser', '/viz?overlay=1&session=demo&cycle=0', [320, 200], 2500, 'readout'],
  ['06-window-all', 'browser', '/viz?overlay=1&cycle=0', [320, 200], 2500, 'readout'],
  ['07-timeline-offline', 'browser', '/', [1400, 900], 1500, 'status', 'daemon-gone'],
];

// The demo seed: one Claude Code session that reads, edits, fails the same
// test three times, waits on a permission prompt and fixes it; plus a Codex
// session thinking and an opencode session running a command.
const FAIL = 'FAIL src/db.test.ts: expected 3 rows, got 0';
const SESSION = [
  ['Read', { file_path: 'src/app.ts' }, 'ok'], ['Grep', { pattern: 'openDb' }, 'ok'],
  ['Read', { file_path: 'src/db.ts' }, 'ok'], ['Edit', { file_path: 'src/db.ts', old_string: 'a', new_string: 'b' }, 'ok'],
  ['Bash', { command: 'npm test' }, 'fail'], ['Bash', { command: 'npm test' }, 'fail'], ['Bash', { command: 'npm test' }, 'fail'],
  ['Bash', { command: 'git stash' }, 'ask'], ['Read', { file_path: 'src/db.test.ts' }, 'ok'],
  ['Edit', { file_path: 'src/db.ts', old_string: 'b', new_string: 'c' }, 'ok'],
];
const hook = (payload) => execFileSync(process.execPath, [HOOK], { env, input: JSON.stringify({ session_id: 'demo', ...payload }) });
const raw = (ev) => new Promise((res) => { const s = createConnection(SOCK, () => s.end(JSON.stringify(ev) + '\n', res)); s.on('error', res); });
async function playSeed() {
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing db test' });
  for (const [tool, tool_input, outcome] of SESSION) {
    hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input });
    if (outcome === 'ask') hook({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input });
    await sleep(350);
    hook({ hook_event_name: outcome === 'fail' ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_input, error: FAIL });
  }
  await raw({ agent: 'codex', session: 'cx-guide', kind: 'turn' });
  await raw({ agent: 'codex', session: 'cx-guide', kind: 'think', dur_ms: 6000 });
  await raw({ agent: 'opencode', session: 'oc-guide', kind: 'tool', status: 'waiting', tool: 'bash' });
}

// Ready: fonts and images loaded, no finite animation running.
const SETTLED = `(async () => { await document.fonts.ready;
  return [...document.images].every((i) => i.complete)
    && document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity); })()`;
// Blank-capture guard per page.
const READY = {
  status: "document.getElementById('status')?.textContent.trim().length > 3",
  readout: "document.getElementById('readout')?.innerText.trim().length > 10",
};

// A short burst of demo events while a visualiser page is open, so the picture
// moves and the readout shows fresh activity.
async function burst() {
  for (const [tool, tool_input, outcome] of SESSION.slice(3, 8)) {
    hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input });
    await sleep(250);
    if (outcome !== 'ask') hook({ hook_event_name: outcome === 'fail' ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_input, error: FAIL });
  }
}

async function shoot(base, [id, , target, [w, h], waitMs, ready], log) {
  const page = await launchChrome({ width: w, height: h, scale: 2 });
  await page.send('Page.navigate', { url: base + target });
  await sleep(1000);
  if (target.startsWith('/viz')) await burst();
  await sleep(waitMs);
  let settled = false;
  for (let i = 0; i < 25 && !settled; i++) { settled = await page.evaluate(SETTLED); if (!settled) await sleep(200); }
  const ok = await page.evaluate(READY[ready]);
  const jpeg = target.startsWith('/viz');
  const file = `${id}.${jpeg ? 'jpg' : 'png'}`;
  writeFileSync(join(OUT, file), await page.screenshot(jpeg ? 'jpeg' : 'png'));
  await page.close();
  log.push({ id, file, state: !ok ? 'empty' : settled ? 'ok' : 'unsettled', errors: [...page.errors] });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  hook({ hook_event_name: 'SessionStart' });
  const { port, pid } = JSON.parse(readFileSync(`${SOCK}.state`, 'utf8'));
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  for (const route of ROUTES) {
    const stage = route[6];
    if (stage === 'after-session' && !log.some((l) => l.seeded)) { await playSeed(); log.push({ seeded: true }); }
    if (stage === 'daemon-gone') {
      // Open the page, then stop the daemon under it.
      const [id, , target, [w, h], waitMs] = route;
      const page = await launchChrome({ width: w, height: h, scale: 2 });
      await page.send('Page.navigate', { url: base + target });
      await sleep(waitMs);
      process.kill(pid);
      await sleep(3000);
      writeFileSync(join(OUT, `${id}.png`), await page.screenshot('png'));
      const ok = await page.evaluate("document.body.classList.contains('offline')");
      const errors = [...page.errors];
      await page.close();
      log.push({ id, file: `${id}.png`, state: ok ? 'ok' : 'fail', errors });
      continue;
    }
    await shoot(base, route, log);
  }
  const shots = log.filter((l) => l.id);
  writeFileSync(join(OUT, 'capture-log.json'), JSON.stringify(shots, null, 2) + '\n');
  console.log(`${shots.filter((l) => l.state === 'ok').length}/${shots.length} routes captured ok`
    + shots.filter((l) => l.state !== 'ok').map((l) => ` · ${l.id}: ${l.state}`).join(''));
}

main()
  .catch((e) => { console.error(`guide capture: ${e.message}`); process.exitCode = 1; })
  .finally(() => { try { process.kill(JSON.parse(readFileSync(`${SOCK}.state`, 'utf8')).pid); } catch {} });
