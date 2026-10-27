// The desk plate (windows.jpg) and the terminal strip (strip.png), from real
// renders. A daemon on a temporary socket gets synthetic events for eight
// agent sessions; each session's floating-window page (/viz?overlay=1&session=)
// is rendered at the window's size, then placed in an HTML desk: a terminal on
// the left and the windows stacked down the right edge, as `turbella overlay`
// places them. The window frames are drawn here, not by macOS. The strip is a
// real `turbella run` capture from tmux, colours kept.
//
// Run through marketing/capture.mjs, or alone: node marketing/desk.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../scripts/chrome.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(here, '..', 'bin', 'turbella');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

// [agent, session, what it is doing]: the events each window plays.
const DESK = [
  ['claude', '3f2a9c1b', 'loop'], ['codex', '01a17c2c', 'think'], ['opencode', 'ses_7f2e', 'run'],
  ['claude', '8e01d4aa', 'edit'], ['pi', '4c91e0d7', 'run'], ['hermes', '20261027', 'ask'],
  ['dsh', '9a3e11f0', 'fail'], ['omp', 'b7d20352', 'edit'],
];

function plan(kind) {
  const tool = (t, args, ms) => [{ kind: 'tool', status: 'waiting', tool: t, sig: sha(args) }, ms, { kind: 'tool', status: 'ok', tool: t, sig: sha(args) }];
  const fail = (t, err) => [{ kind: 'tool', status: 'waiting', tool: t, sig: sha(err) }, 300, { kind: 'tool_fail', status: 'error', tool: t, sig: sha(err) }];
  return {
    loop: [tool('Read', 'a', 120), fail('Bash', 'npm test'), fail('Bash', 'npm test'), fail('Bash', 'npm test')],
    think: [tool('read', 'b', 150), [{ kind: 'think', dur_ms: 9000 }]],
    run: [tool('grep', 'c', 100), [{ kind: 'tool', status: 'waiting', tool: 'bash', sig: sha('build') }]],
    edit: [tool('Read', 'd', 100), tool('Edit', 'e', 150), tool('Edit', 'f', 150)],
    ask: [tool('terminal', 'g', 100), [{ kind: 'permission', status: 'waiting', tool: 'terminal' }]],
    fail: [tool('read', 'h', 100), fail('bash', 'make'), fail('bash', 'make lint')],
  }[kind];
}

function send(sock, ev) {
  return new Promise((res) => { const s = createConnection(sock, () => s.end(JSON.stringify(ev) + '\n', res)); s.on('error', res); });
}

async function play(sock, agent, session, kind) {
  await send(sock, { agent, session, kind: 'turn', ts: Date.now() });
  for (const step of plan(kind)) {
    for (const part of step) {
      if (typeof part === 'number') await sleep(part);
      else await send(sock, { agent, session, ts: Date.now(), ...part });
    }
    await sleep(120);
  }
}

// A minimal SGR (colour) to HTML converter for tmux's capture-pane -e.
function xterm256(n) {
  const base = ['#000', '#c00', '#0a0', '#ca0', '#00c', '#c0c', '#0aa', '#ccc', '#555', '#f55', '#5f5', '#ff5', '#55f', '#f5f', '#5ff', '#fff'];
  if (n < 16) return base[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = n - 16, l = [0, 95, 135, 175, 215, 255];
  return `rgb(${l[Math.floor(c / 36)]},${l[Math.floor(c / 6) % 6]},${l[c % 6]})`;
}
function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let st = {}, out = '';
  const open = () => { const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.bold && 'font-weight:700'].filter(Boolean).join(';'); return css ? `<span style="${css}">` : '<span>'; };
  out += open();
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { out += esc(part); continue; }
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {}; else if (c === 1) st.bold = true; else if (c === 22) st.bold = false;
      else if (c === 38 && codes[i + 1] === 5) { st.fg = xterm256(codes[i + 2]); i += 2; }
      else if (c === 48 && codes[i + 1] === 5) { st.bg = xterm256(codes[i + 2]); i += 2; }
      else if (c === 39) delete st.fg; else if (c === 49) delete st.bg;
      else if (c >= 30 && c <= 37) st.fg = xterm256(c - 30); else if (c >= 90 && c <= 97) st.fg = xterm256(c - 82);
    }
    out += '</span>' + open();
  }
  return out + '</span>';
}

// The strip: a demo shell session under `turbella run`, its events sent with
// `turbella emit` (which carries the run tag).
async function captureStrip(sock, dir) {
  const emit = (a) => `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} emit --agent claude --session demo-run ${a}`;
  const script = [
    "printf '\\033[2J\\033[H'",
    `${emit('--kind turn')}`,
    "echo '$ npm test'", 'sleep 0.3',
    `${emit("--kind tool --status waiting --tool Bash --payload '\"npm test\"'")}`,
    "echo ''; echo '> turbella-demo@1.0.0 test'; echo '> node --test'", 'sleep 0.4',
    "echo ''; echo '✔ parses events (2.1ms)'; echo '✔ hashes arguments (0.8ms)'; echo '✖ expected 3 rows, got 0'",
    `${emit("--kind tool_fail --status error --tool Bash --payload '\"exit 1\"'")}`,
    "echo ''; echo '$ npm test'",
    `${emit("--kind tool --status waiting --tool Bash --payload '\"npm test\"'")}`,
    "echo '✖ expected 3 rows, got 0'",
    `${emit("--kind tool_fail --status error --tool Bash --payload '\"exit 1\"'")}`,
    "echo ''; echo '$ npm test'",
    `${emit("--kind tool --status waiting --tool Bash --payload '\"npm test\"'")}`,
    'sleep 30',
  ].join('; ');
  const env = `TURBELLA_SOCK=${sock}`;
  execFileSync('tmux', ['new-session', '-d', '-s', 'tbdesk', '-x', '96', '-y', '14', '-e', env, '-e', 'TURBELLA_OPEN=0',
    `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} run -- sh -c ${JSON.stringify(script)}`]);
  await sleep(9000);
  const pane = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', 'tbdesk'], { encoding: 'utf8' });
  execFileSync('tmux', ['kill-session', '-t', 'tbdesk']);
  return ansiToHtml(pane.replace(/\s+$/, ''));
}

const terminal = (title, body, cls = '') => `<div class="term ${cls}"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div><pre>${body}</pre></div>`;

export async function buildDesk() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-desk-'));
  const sock = join(dir, 'd.sock');
  const env = { ...process.env, TURBELLA_SOCK: sock, TURBELLA_PORT: '0', TURBELLA_OPEN: '0' };
  execFileSync(process.execPath, [BIN, 'status'], { env });
  const { port, pid } = JSON.parse(readFileSync(`${sock}.state`, 'utf8'));
  try {
    // One render per session, with its events playing while the page is open.
    for (const [agent, session, kind] of DESK) {
      const page = await launchChrome({ width: 320, height: 200, scale: 2 });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/viz?overlay=1&cycle=0&session=${session}` });
      // Play only once the page is up and its stream is open.
      for (let i = 0; i < 50 && !(await page.evaluate("!!window.turbella?.tools && document.getElementById('preset').textContent !== 'loading…'")); i++) await sleep(200);
      await sleep(800);
      await play(sock, agent, session, kind);
      await sleep(2500);
      writeFileSync(join(dir, `${session}.jpg`), await page.screenshot('jpeg'));
      await page.close();
    }
    const strip = await captureStrip(sock, dir);

    const windows = DESK.map(([agent, session], i) =>
      `<div class="win" style="right:${24 + Math.floor(i / 4) * 344}px;top:${44 + (i % 4) * 236}px">`
      + `<div class="bar"><i></i><i></i><i></i><span>${agent} · ${session}</span></div><img src="${session}.jpg"></div>`).join('');
    const css = `
      html, body { margin: 0; width: 1600px; height: 1000px; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
      .desk { position: relative; width: 100%; height: 100%; background: linear-gradient(160deg, #1e2633, #10141b 60%, #0b0e13); }
      .menubar { height: 28px; background: rgba(242, 244, 247, 0.08); color: rgba(242, 244, 247, 0.7); font-size: 13px; display: flex; align-items: center; gap: 18px; padding: 0 16px; }
      .term { position: absolute; left: 36px; top: 64px; width: 860px; border-radius: 10px; overflow: hidden; background: #0d1015; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }
      .term pre { margin: 0; padding: 10px 14px 18px; font: 14px/1.45 ui-monospace, Menlo, monospace; color: #d6dae0; }
      .bar { height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 10px; background: #1b2028; color: rgba(242, 244, 247, 0.6); font-size: 12px; }
      .bar i { width: 11px; height: 11px; border-radius: 6px; background: #3a414c; } .bar span { margin: 0 auto; padding-right: 50px; }
      .win { position: absolute; width: 320px; border-radius: 9px; overflow: hidden; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55); background: #000; }
      .win img { display: block; width: 320px; height: 200px; }
      .note { position: absolute; left: 36px; bottom: 30px; color: rgba(242, 244, 247, 0.55); font-size: 15px; max-width: 840px; line-height: 1.5; }`;
    writeFileSync(join(dir, 'desk.html'), `<!doctype html><meta charset="utf-8"><style>${css}</style>
      <style>.desk .term pre { height: 800px; }</style>
      <div class="desk"><div class="menubar"><b>Terminal</b><span>Shell</span><span>Edit</span><span>View</span></div>
      ${terminal('~/project — turbella run claude', strip)}
      ${windows}</div>`);
    writeFileSync(join(dir, 'strip.html'), `<!doctype html><meta charset="utf-8"><style>${css}
      html, body { width: 900px; height: 300px; } .term { left: 20px; top: 20px; } body { background: #f5f6f8; }</style>
      ${terminal('~/project — turbella run claude', strip)}`);

    const desk = await launchChrome({ width: 1600, height: 1000, scale: 1 });
    await desk.send('Page.navigate', { url: `file://${join(dir, 'desk.html')}` });
    await sleep(800);
    writeFileSync(join(here, 'windows.jpg'), await desk.screenshot('jpeg'));
    await desk.close();
    const stripPage = await launchChrome({ width: 900, height: 300, scale: 2 });
    await stripPage.send('Page.navigate', { url: `file://${join(dir, 'strip.html')}` });
    await sleep(600);
    writeFileSync(join(here, 'strip.png'), await stripPage.screenshot('png'));
    await stripPage.close();
  } finally {
    try { process.kill(pid); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildDesk().then(() => console.log('wrote marketing/windows.jpg and marketing/strip.png'))
    .catch((e) => { console.error(`desk: ${e.message}`); process.exitCode = 1; });
}
