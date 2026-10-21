// Handlers for the daemon-side tools in manifest.js. The CLI and the MCP server
// both call these, so a command behaves the same through either.
//
// Each handler takes the tool's input object and resolves to a JSON-ready
// result, or throws an Error whose message is fit to show.

import { spawn } from 'node:child_process';
import { readState } from './daemon.js';
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

async function status() {
  const st = readState();
  if (!st) throw new Error('daemon not running (no state file)');
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
  const events = await readClaudeFile(path);
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
  await deliver({ kind: 'ping' });
  const st = await waitForState();
  if (!st) throw new Error('daemon did not start');
  const url = `http://127.0.0.1:${st.port}`;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  return { url };
}

export const HANDLERS = Object.freeze({ status, emit, replay, open });

// Fail at import if the manifest and the handlers drift apart.
for (const t of toolsFor('daemon')) {
  if (!HANDLERS[t.name]) throw new Error(`manifest tool "${t.name}" has no daemon handler`);
}
