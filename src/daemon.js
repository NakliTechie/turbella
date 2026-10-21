// Turbella daemon: Unix socket in, HTTP page out, idle exit.
//
//   socket in : hook binaries write one JSON line per event to the Unix socket
//   http out  : serves the replay canvas page on localhost + SSE /events stream
//   idle exit : shuts down after TURBELLA_IDLE_MS with no activity
//
// Localhost / Unix socket only — no network (AGENTS.md privacy rule). Events
// carry hashes, never raw content.

import { createServer as createNetServer, createConnection } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, stable, truncate } from './crypto.js';
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
  } else if (tool && (p.tool_input || p.input || p.arguments)) {
    payload = p.tool_input ?? p.input ?? p.arguments;
    // The model rewrites `description` on every call; drop it so repeats match.
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const { description, ...rest } = payload;
      payload = rest;
    }
    // Hash canonical JSON: truncate() on an object yields "[object Object]".
    sig = await contentHash(truncate(stable(payload), 4000));
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

// The state file sits beside the socket, so a test daemon never overwrites
// the real daemon's address.
function stateFile() {
  return process.env.TURBELLA_SOCK ? `${process.env.TURBELLA_SOCK}.state` : join(homedir(), '.turbella.state');
}
// A fixed default port keeps the page URL stable across daemon restarts; when
// it is taken the OS picks a free one and the state file records it.
const PORT = Number(process.env.TURBELLA_PORT || 7377);
const IDLE_DEFAULT_MS = 10 * 60_000;

function sockPath() {
  return process.env.TURBELLA_SOCK || join(homedir(), '.turbella.sock');
}

let events = [];       // in-memory buffer of neutral events
let lastActivity = Date.now();
let clients = new Set(); // SSE response writers
let sockServer = null;
let httpServer = null;
let idleTimer = null;
const sockConns = new Set(); // open Unix-socket connections, cut on stop

function touch() {
  lastActivity = Date.now();
  resetIdle();
}
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  const idleMs = Number(process.env.TURBELLA_IDLE_MS || IDLE_DEFAULT_MS);
  // An open page keeps the daemon alive: the long waits are what it shows.
  idleTimer = setTimeout(() => (clients.size ? resetIdle() : stop()), idleMs);
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
  if (ev?.kind === 'ping') { touch(); return; } // wake-up only, not an event
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
  sockConns.add(socket);
  socket.on('close', () => sockConns.delete(socket));
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
  // The page's ES modules. Only bare lowercase names under src/, so a request
  // cannot climb out of the folder.
  const mod = u.pathname.match(/^\/src\/([a-z]+\.js)$/);
  if (mod) {
    try {
      const js = await readFile(join(__dirname, mod[1]), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(js);
      return;
    } catch { /* fall through to 404 */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

// Thrown when another daemon already owns the socket; carries its address.
export class AlreadyRunning extends Error {
  constructor(state) { super('turbella daemon already running'); this.state = state; }
}

function listenSocket(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}

// A connect that succeeds means a live daemon; ECONNREFUSED means a stale file.
function socketIsLive(path) {
  return new Promise((resolve) => {
    const c = createConnection({ path });
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

function listenHttp(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

export async function start() {
  const path = sockPath();
  sockServer = createNetServer(handleSocket);
  try {
    await listenSocket(sockServer, path);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (await socketIsLive(path)) throw new AlreadyRunning(readState());
    try { unlinkSync(path); } catch {}
    await listenSocket(sockServer, path);
  }
  httpServer = createHttpServer(handleHttp);
  try {
    await listenHttp(httpServer, PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || PORT === 0) throw e;
    await listenHttp(httpServer, 0);
  }
  const port = httpServer.address().port;
  writeFileSync(stateFile(), JSON.stringify({ sockPath: path, port, pid: process.pid }));
  resetIdle();
  return { sockPath: path, port };
}

// Shutdown is deterministic: the address files go first, so no client reads a
// dead daemon's address, and open connections are cut instead of awaited, so a
// lingering keep-alive connection cannot hold the daemon up.
export function stop() {
  if (idleTimer) clearTimeout(idleTimer);
  try { unlinkSync(sockPath()); } catch {}
  try { unlinkSync(stateFile()); } catch {}
  for (const c of clients) { try { c.end(); } catch {} }
  clients.clear();
  events = [];
  for (const sock of sockConns) sock.destroy();
  sockConns.clear();
  const http = httpServer;
  const net = sockServer;
  httpServer = null;
  sockServer = null;
  return Promise.all([
    new Promise((r) => (http ? (http.close(() => r()), http.closeAllConnections()) : r())),
    new Promise((r) => (net ? net.close(() => r()) : r())),
  ]).then(() => {});
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
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch { return null; }
}
