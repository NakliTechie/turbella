// Handlers for the daemon-side tools in manifest.js. The CLI and the MCP server
// both call these, so a command behaves the same through either.
//
// Each handler takes the tool's input object and resolves to a JSON-ready
// result, or throws an Error whose message is fit to show.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState } from './paths.js';
import { deliver } from './socketWrite.js';
import { contentHash } from './crypto.js';
import { readClaudeFile } from './reader.js';
import { gaugeSnapshot } from './gauge.js';
import { toolsFor } from './manifest.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The socket opens before the page server, so the address can lag a moment.
async function waitForState(tries = 10) {
  let st = readState();
  for (let i = 0; !st && i < tries; i++) { await sleep(100); st = readState(); }
  return st;
}

// Make sure a daemon runs and return its address.
async function ensureDaemon() {
  await deliver({ kind: 'ping' });
  const st = await waitForState();
  if (!st) throw new Error('daemon did not start');
  return st;
}

async function status() {
  const st = await ensureDaemon();
  const res = await fetch(`http://127.0.0.1:${st.port}/status`, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

async function emit({ kind = 'tool', status: evStatus = 'ok', tool = null, session = null, payload } = {}) {
  const event = {
    kind, status: evStatus, tool, session,
    dur_ms: null,
    sig: payload === undefined ? null : await contentHash(payload),
    ts: Date.now(),
    agent: 'emit',
  };
  return { delivered: await deliver(event) };
}

async function replay({ path }) {
  if (!path) throw new Error('replay needs a transcript path');
  const events = (await readClaudeFile(path)).filter((e) => e.status !== 'waiting');
  const byKind = {};
  for (const ev of events) byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
  const last = events.length ? events[events.length - 1].ts : Date.now();
  return {
    events: events.length,
    sessions: new Set(events.map((e) => e.session)).size,
    byKind,
    gauge: Math.round(gaugeSnapshot(events, { now: last }) * 1000) / 1000,
  };
}

async function open() {
  const url = `http://127.0.0.1:${(await ensureDaemon()).port}/viz`;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  // Report a missing opener instead of crashing; the URL is still returned.
  const opened = await new Promise((resolve) => {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
  return { url, opened };
}

// The native helper (native/turbella-native.swift): built with the system
// swiftc into ~/.turbella-native on first use, and again when the source is
// newer than the binary.
const NATIVE_SRC = fileURLToPath(new URL('../native/turbella-native.swift', import.meta.url));
const NATIVE_DIR = join(homedir(), '.turbella-native');
const NATIVE_BIN = join(NATIVE_DIR, 'turbella-native');
const OVERLAY_PID = join(NATIVE_DIR, 'overlay.pid');

function nativeHelper() {
  if (process.platform !== 'darwin') throw new Error('the overlay and run need macOS for now');
  if (existsSync(NATIVE_BIN) && statSync(NATIVE_BIN).mtimeMs >= statSync(NATIVE_SRC).mtimeMs) return NATIVE_BIN;
  mkdirSync(NATIVE_DIR, { recursive: true });
  process.stderr.write('turbella: building the native helper with swiftc (once, about 10 s)\n');
  const tmp = `${NATIVE_BIN}.${process.pid}.tmp`;
  const r = spawnSync('swiftc', ['-O', '-swift-version', '5', '-o', tmp, NATIVE_SRC], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) throw new Error('swiftc not found; install the Xcode command line tools (xcode-select --install)');
  if (r.status !== 0) throw new Error(`swiftc failed:\n${String(r.stderr).slice(0, 2000)}`);
  renameSync(tmp, NATIVE_BIN);
  return NATIVE_BIN;
}

function overlayPid() {
  try {
    const pid = Number(readFileSync(OVERLAY_PID, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

async function overlay() {
  const bin = nativeHelper();
  const url = `http://127.0.0.1:${(await ensureDaemon()).port}`;
  const running = overlayPid();
  if (running) return { pid: running, url, already: true };
  const child = spawn(bin, ['overlay', url, OVERLAY_PID], { stdio: 'ignore', detached: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  writeFileSync(OVERLAY_PID, String(child.pid));
  return { pid: child.pid, url };
}

// Runs in the foreground with this terminal; resolves to the agent's exit code.
async function run({ command } = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('run needs a command, e.g. turbella run claude');
  const bin = nativeHelper();
  const { port } = await ensureDaemon();
  const child = spawn(bin, ['run', String(port), ...command], { stdio: 'inherit' });
  // Ctrl-C reaches the agent through its terminal; this process waits it out.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (c, sig) => resolve(c ?? 128));
  });
  process.off('SIGINT', ignore);
  return { exit: code };
}

const HOOK = fileURLToPath(new URL('../bin/turbella-hook', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
// Cursor events Turbella listens to. preToolUse and subagentStart are left out:
// Cursor treats them as permission hooks and blocks on output it cannot parse.
const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure',
  'afterAgentThought', 'subagentStop', 'stop', 'preCompact'];

async function install({ agent }) {
  if (agent === 'cursor') {
    const dir = join(homedir(), '.cursor');
    const file = join(dir, 'hooks.json');
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    config.version ??= 1;
    config.hooks ??= {};
    const command = `"${HOOK}" --agent cursor`;
    let added = 0;
    for (const ev of CURSOR_EVENTS) {
      const list = (config.hooks[ev] ??= []);
      if (list.some((h) => h.command === command)) continue;
      list.push({ command, timeout: 5 });
      added++;
    }
    if (added) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.turbella.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      renameSync(tmp, file);
    }
    return { agent, file, added, note: added ? 'Restart Cursor to load the hooks.' : 'Already installed.' };
  }
  const steps = {
    claude: [`claude plugin marketplace add ${REPO}`, 'claude plugin install turbella@turbella'],
    codex: [`codex plugin marketplace add ${REPO}`, 'codex plugin add turbella@turbella', 'then run /hooks in Codex and trust the Turbella hooks'],
    copilot: ['copilot plugin install NakliTechie/turbella'],
  }[agent];
  if (!steps) throw new Error('agent must be one of claude, codex, copilot, cursor');
  return { agent, run: steps };
}

export const HANDLERS = Object.freeze({ status, emit, replay, open, overlay, run, install });

// Fail at import if the manifest and the handlers drift apart.
for (const t of toolsFor('daemon')) {
  if (!HANDLERS[t.name]) throw new Error(`manifest tool "${t.name}" has no daemon handler`);
}
