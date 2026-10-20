// Turbella daemon: Unix socket in, HTTP page out, idle exit.
//
//   socket in : hook binaries write one JSON line per event to the Unix socket
//   http out  : serves the replay canvas page on localhost + SSE /events stream
//   idle exit : shuts down after TURBELLA_IDLE_MS with no activity
//
// Localhost / Unix socket only — no network (AGENTS.md privacy rule). Events
// carry hashes, never raw content.

import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, truncate } from './crypto.js';
import { gaugeSnapshot } from './gauge.js';

// Hook event type -> neutral kind/status.
const HOOK_MAP = {
  PreToolUse: { kind: 'tool', status: 'waiting' },
  PostToolUse: { kind: 'tool', status: 'ok' },
  PostToolUseFailure: { kind: 'tool_fail', status: 'error' },
  PermissionRequest: { kind: 'permission', status: 'waiting' },
  PermissionDenied: { kind: 'permission', status: 'denied' },
  Notification: { kind: 'notification', status: 'ok' },
  SubagentStart: { kind: 'subagent', status: 'ok' },
  SubagentStop: { kind: 'subagent', status: 'ok' },
  Stop: { kind: 'stop', status: 'ok' },
  StopFailure: { kind: 'stop', status: 'error' },
  PreCompact: { kind: 'stop', status: 'ok' },
};

// Normalize a Claude Code hook envelope into a neutral event. Hooks forward
// raw payloads; the daemon computes `sig` (a content hash, never raw text)
// and the neutral shape so the canvas and gauge consume one format.
async function normalizeHook(env) {
  const m = HOOK_MAP[env.type] || { kind: 'tool', status: 'ok' };
  const p = env.payload || {};
  const tool = p.tool_name ?? p.tool ?? null;
  let sig = null;
  let payload = null;
  if (env.type === 'PostToolUseFailure') {
    payload = String(p.error_message ?? p.error ?? '');
    sig = await contentHash(truncate(payload, 1000));
  } else if (tool && (p.input || p.arguments)) {
    payload = p.input ?? p.arguments;
    sig = await contentHash(truncate(payload, 4000));
  }
  return {
    ts: env.ts ?? Date.now(),
    agent: env.agent ?? 'claude',
    session: env.session ?? null,
    kind: m.kind,
    status: m.status,
    tool,
    dur_ms: null,
    sig,
  };
}

const __dirname = join(fileURLToPath(import.meta.url), '..');
const WEB = join(__dirname, '..', 'web');

const STATE_FILE = join(homedir(), '.turbella.state');
const PORT = Number(process.env.TURBELLA_PORT || 0); // 0 = OS picks a free port
const IDLE_DEFAULT_MS = 30_000;

function sockPath() {
  return process.env.TURBELLA_SOCK || join(homedir(), '.turbella.sock');
}

let events = [];       // in-memory buffer of neutral events
let lastActivity = Date.now();
let clients = new Set(); // SSE response writers
let sockServer = null;
let httpServer = null;
let idleTimer = null;

function touch() {
  lastActivity = Date.now();
  resetIdle();
}
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  const idleMs = Number(process.env.TURBELLA_IDLE_MS || IDLE_DEFAULT_MS);
  idleTimer = setTimeout(stop, idleMs);
}
function broadcast(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const c of clients) {
    try { c.write(line); } catch { clients.delete(c); }
  }
}

// ---- Unix socket input ------------------------------------------------------

async function pushEvent(raw) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; } // swallow malformed lines
  if (ev && ev.type) {
    // Hook envelope -> neutral event (async content hash).
    try { ev = await normalizeHook(ev); } catch { /* fall back to raw envelope */ }
  }
  ev.ts = ev.ts ?? Date.now();
  ev.agent = ev.agent ?? 'claude';
  events.push(ev);
  touch();
  broadcast(ev);
}

function handleSocket(socket) {
  let buf = '';
  let processing = Promise.resolve();
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      processing = processing.then(() => pushEvent(line));
    }
  });
  socket.on('end', () => { try { socket.destroy(); } catch {} });
  socket.on('error', () => { try { socket.destroy(); } catch {} });
}

// ---- HTTP output ------------------------------------------------------------

async function handleHttp(req, res) {
  const u = new URL(req.url || '/', `http://localhost`);
  if (u.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); try { res.end(); } catch {} });
    // backlog: everything buffered so far
    for (const ev of events) {
      try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {}
    }
    touch();
    return;
  }
  if (u.pathname === '/status') {
    const byKind = {};
    for (const ev of events) byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
    const gauge = gaugeSnapshot(events, { now: Date.now() });
    const body = JSON.stringify({
      events: events.length,
      byKind,
      gauge: Math.round(gauge * 1000) / 1000,
      sockPath: sockPath(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const html = await readFile(join(WEB, 'turbella.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

export function start() {
  return new Promise((resolve, reject) => {
    try {
      // Remove a stale socket file before listening.
      try { unlinkSync(sockPath()); } catch {}

      sockServer = createNetServer(handleSocket);
      sockServer.listen(sockPath(), () => {
        httpServer = createHttpServer(handleHttp);
        httpServer.on('error', reject);
        httpServer.listen(PORT, '127.0.0.1', () => {
          const actualPort = httpServer.address().port;
          writeFileSync(STATE_FILE, JSON.stringify({ sockPath: sockPath(), port: actualPort }));
          resetIdle();
          resolve({ sockPath: sockPath(), port: actualPort });
        });
      });
      sockServer.on('error', reject);
    } catch (e) { reject(e); }
  });
}

export function stop() {
  if (idleTimer) clearTimeout(idleTimer);
  for (const c of clients) { try { c.end(); } catch {} }
  clients.clear();
  events = [];
  return new Promise((resolve) => {
    httpServer.close(() => {
      sockServer.close(() => {
        try { unlinkSync(sockPath()); } catch {}
        try { unlinkSync(STATE_FILE); } catch {}
        resolve();
      });
    });
  });
}

// Exposed for tests only.
export function __state() {
  const byKind = {};
  for (const ev of events) byKind[ev.kind] = (byKind[ev.kind] || 0) + 1;
  return { events: events.length, clients: clients.size, byKind };
}

export function __clear() {
  events = [];
}

// Read the address the daemon published (port + sock path) for the CLI.
export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}
