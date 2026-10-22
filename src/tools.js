// Handlers for the daemon-side tools in manifest.js. The CLI and the MCP server
// both call these, so a command behaves the same through either.
//
// Each handler takes the tool's input object and resolves to a JSON-ready
// result, or throws an Error whose message is fit to show.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
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

export const HANDLERS = Object.freeze({ status, emit, replay, open, install });

// Fail at import if the manifest and the handlers drift apart.
for (const t of toolsFor('daemon')) {
  if (!HANDLERS[t.name]) throw new Error(`manifest tool "${t.name}" has no daemon handler`);
}
