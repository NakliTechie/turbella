// Regenerate the README images (the desk plate, the strip and the timeline)
// and the 1280×640 social card from the real pages.
//
// Run:  node marketing/capture.mjs
//
// Starts a daemon on a temporary socket, sends a scripted session through the
// real hook binary (reads, an edit, the same test failing three times, a
// permission wait, the fix) and screenshots the timeline; desk.mjs renders the
// floating windows and the strip; social.html is rendered around the desk.
// Writes hero.png, windows.jpg, strip.png and social.png here.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../scripts/chrome.mjs';
import { buildDesk } from './desk.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const HOOK = join(here, '..', 'bin', 'turbella-hook');
const SOCK = `/tmp/tb-capture-${process.pid}.sock`;
const env = { ...process.env, TURBELLA_SOCK: SOCK, TURBELLA_PORT: '0', TURBELLA_OPEN: '0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hook = (payload) => execFileSync(process.execPath, [HOOK], {
  env, input: JSON.stringify({ session_id: 'demo', ...payload }),
});
const FAIL = 'FAIL src/db.test.ts: expected 3 rows, got 0';

// [tool, input, outcome, ms the call takes]; outcome: ok | fail | ask
const SESSION = [
  ['Read', { file_path: 'src/app.ts' }, 'ok', 300],
  ['Grep', { pattern: 'openDb' }, 'ok', 300],
  ['Read', { file_path: 'src/db.ts' }, 'ok', 300],
  ['Edit', { file_path: 'src/db.ts', old_string: 'a', new_string: 'b' }, 'ok', 400],
  ['Bash', { command: 'npm test' }, 'fail', 900],
  ['Bash', { command: 'npm test' }, 'fail', 900],
  ['Bash', { command: 'npm test' }, 'fail', 900],
  ['Bash', { command: 'git stash' }, 'ask', 1200],
  ['Read', { file_path: 'src/db.test.ts' }, 'ok', 300],
  ['Edit', { file_path: 'src/db.ts', old_string: 'b', new_string: 'c' }, 'ok', 400],
];

async function main() {
  hook({ hook_event_name: 'SessionStart' });
  const { port } = JSON.parse(readFileSync(`${SOCK}.state`, 'utf8'));

  const page = await launchChrome({ width: 1440, height: 540, scale: 2 });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(800);

  for (const [tool, tool_input, outcome, ms] of SESSION) {
    hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input });
    if (outcome === 'ask') hook({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input });
    await sleep(ms);
    if (outcome === 'fail') hook({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input, error: FAIL });
    else hook({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input });
    await sleep(250);
  }
  await sleep(1200); // one gauge tick after the last event
  writeFileSync(join(here, 'hero.png'), await page.screenshot());
  const gauge = await page.evaluate("document.getElementById('gaugeValue').textContent");
  const status = await page.evaluate("document.getElementById('status').textContent");
  await page.close();

  // The desk plate (windows.jpg) and the strip (strip.png); the social card uses the plate.
  await buildDesk();

  const card = await launchChrome({ width: 1280, height: 640, scale: 1 });
  await card.send('Page.navigate', { url: `file://${join(here, 'social.html')}` });
  await sleep(800);
  writeFileSync(join(here, 'social.png'), await card.screenshot());
  await card.close();

  const kb = (f) => Math.round(statSync(join(here, f)).size / 1024);
  console.log(JSON.stringify({ status, gauge, hero_kb: kb('hero.png'), windows_kb: kb('windows.jpg'), strip_kb: kb('strip.png'), social_kb: kb('social.png') }));
}

main()
  .catch((e) => { console.error(`capture: ${e.message}`); process.exitCode = 1; })
  .finally(() => {
    try { process.kill(JSON.parse(readFileSync(`${SOCK}.state`, 'utf8')).pid); } catch {}
  });
