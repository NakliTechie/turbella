// Turbella daemon: events in on a Unix socket, the page and its event stream
// out on 127.0.0.1, exit when idle.
//
// Input is untrusted: every event is rebuilt from an allowlist (event.js), bad
// lines are dropped, and memory is bounded. HTTP answers only requests
// addressed to this machine, which stops DNS-rebinding pages from reading it.

import { createServer as createNetServer, createConnection } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gaugeSnapshot } from './gauge.js';
import { toEvent } from './event.js';
import { sockPath, stateFile, readState } from './paths.js';
import { createTailer } from './tailer.js';
import { FAILS_BY_MISSING_END } from './agents.js';

export { readState };

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
  UserPromptSubmit: { kind: 'turn', status: 'ok' },
};

const SRC = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(SRC, '..', 'web');
// A fixed default port keeps the page URL stable; when taken, the OS picks one.
const PORT = Number(process.env.TURBELLA_PORT ?? 7377);
const IDLE_DEFAULT_MS = 10 * 60_000;
const MAX_EVENTS = 10_000;     // newest kept; the gauge looks at 5 minutes
const MAX_CLIENTS = 16;
const MAX_LINE = 1024 * 1024;
const MAX_QUEUED = 1024 * 1024; // bytes a slow page may fall behind before it is dropped
const OWNER_CHECK_MS = 5000;

let events = [];   // { id, ev }
let nextId = 1;
let totals = { events: 0, byKind: {} };
const clients = new Set();
const sockConns = new Set();
let sockServer = null;
let httpServer = null;
let idleTimer = null;
let ownerTimer = null;
let port = null;
// Tool starts waiting for their end, for agents that report some failures only
// by never ending the call: "session call-id" -> start event.
const openCalls = new Map();
const MAX_OPEN_CALLS = 1000;
const tailer = createTailer({ onEvent: (raw) => push(toEvent(raw)) });

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  const idleMs = Number(process.env.TURBELLA_IDLE_MS || IDLE_DEFAULT_MS);
  // An open page keeps the daemon alive: the long waits are what it shows.
  idleTimer = setTimeout(() => (clients.size ? resetIdle() : stop()), idleMs);
}

function send(res, id, ev) {
  if (!res.write(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`) && res.writableLength > MAX_QUEUED) {
    clients.delete(res);
    res.destroy();
  }
}

function push(ev) {
  if (!ev) return;
  const id = nextId++;
  events.push({ id, ev });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  totals.events++;
  totals.byKind[ev.kind] = (totals.byKind[ev.kind] || 0) + 1;
  resetIdle();
  for (const c of clients) send(c, id, ev);
}

// One socket line: a hook envelope ({type, ...}), a plain event, or a ping.
function receive(line) {
  let raw;
  try { raw = JSON.parse(line); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  if (typeof raw.transcript === 'string') tailer.follow(raw.transcript);
  if (raw.kind === 'ping') { resetIdle(); return; }
  if (typeof raw.type === 'string') {
    const m = HOOK_MAP[raw.type];
    if (!m) return;
    const ev = toEvent({ ...raw, ...m });
    trackCall(raw, ev);
    push(ev);
    return;
  }
  push(toEvent(raw));
}

function trackCall(raw, ev) {
  if (!ev || !FAILS_BY_MISSING_END.has(ev.agent)) return;
  const key = `${ev.session} ${raw.call}`;
  if (raw.type === 'PreToolUse' && typeof raw.call === 'string') {
    openCalls.set(key, ev);
    if (openCalls.size > MAX_OPEN_CALLS) openCalls.delete(openCalls.keys().next().value);
  } else if (raw.type === 'PostToolUse' || raw.type === 'PostToolUseFailure') {
    openCalls.delete(key);
  } else if (ev.kind === 'stop' || ev.kind === 'turn') {
    // The turn moved on: calls of this session that never ended failed.
    for (const [k, start] of openCalls) {
      if (start.session !== ev.session) continue;
      openCalls.delete(k);
      push({ ...start, ts: ev.ts, kind: 'tool_fail', status: 'error' });
    }
  }
}

function handleSocket(socket) {
  sockConns.add(socket);
  socket.setEncoding('utf8');
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      try { receive(line); } catch { /* drop the line */ }
    }
    if (buf.length > MAX_LINE) socket.destroy();
  });
  socket.on('close', () => sockConns.delete(socket));
  socket.on('error', () => socket.destroy());
}

function status() {
  const recent = events.map((e) => e.ev);
  return {
    events: totals.events,
    byKind: totals.byKind,
    gauge: Math.round(gaugeSnapshot(recent, { now: Date.now() }) * 1000) / 1000,
    sockPath: sockPath(),
    pages: clients.size,
  };
}

async function handleHttp(req, res) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  const path = (req.url || '/').split('?')[0];
  if (path === '/events') {
    if (clients.size >= MAX_CLIENTS) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    // A reconnecting page sends the last id it saw and gets only what is newer.
    // An id from an earlier daemon (larger than any here) gets everything.
    const last = Number(req.headers['last-event-id']) || 0;
    const from = last < nextId ? last : 0;
    for (const { id, ev } of events) if (id > from) send(res, id, ev);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    resetIdle();
    return;
  }
  if (path === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status()));
    return;
  }
  const page = { '/': 'turbella.html', '/index.html': 'turbella.html', '/viz': 'viz.html' }[path];
  if (page) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(await readFile(join(WEB, page), 'utf8'));
    return;
  }
  // The visualiser's bundled library: these two files only.
  const vendor = path.match(/^\/vendor\/(butterchurn\.min\.js|butterchurnPresets\.min\.js)$/);
  if (vendor) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=86400' });
    res.end(await readFile(join(WEB, 'vendor', vendor[1]), 'utf8'));
    return;
  }
  // The page's modules: bare lowercase names under src/ only.
  const mod = path.match(/^\/src\/([a-z]+\.js)$/);
  if (mod) {
    try {
      const js = await readFile(join(SRC, mod[1]), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(js);
      return;
    } catch { /* 404 below */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

// Thrown when another daemon already owns the socket; carries its address.
export class AlreadyRunning extends Error {
  constructor(state) { super('turbella daemon already running'); this.state = state; }
}

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...args, () => { server.off('error', reject); resolve(); });
});

// A connect that succeeds means a live daemon; a refusal means a stale file.
const socketIsLive = (path) => new Promise((resolve) => {
  const c = createConnection({ path });
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

function writeState(state) {
  // Written to a temp file and renamed, so a reader never sees half a file and
  // a planted symlink at the final path is replaced, not followed.
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, stateFile());
}

const ownsFiles = () => readState()?.pid === process.pid;

export async function start() {
  const path = sockPath();
  sockServer = createNetServer(handleSocket);
  try {
    await listen(sockServer, path);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (await socketIsLive(path)) throw new AlreadyRunning(readState());
    try { unlinkSync(path); } catch { /* another starter removed it first */ }
    await listen(sockServer, path);
  }
  chmodSync(path, 0o600);
  httpServer = createHttpServer((req, res) => {
    handleHttp(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  try {
    await listen(httpServer, PORT, '127.0.0.1');
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || PORT === 0) throw e;
    await listen(httpServer, 0, '127.0.0.1');
  }
  port = httpServer.address().port;
  writeState({ sockPath: path, port, pid: process.pid });
  // Two daemons can race over a stale socket; the one whose pid is not in the
  // state file has lost and leaves quietly.
  ownerTimer = setInterval(() => { if (!ownsFiles()) stop(); }, OWNER_CHECK_MS);
  resetIdle();
  return { sockPath: path, port };
}

// Remove the address files only if they are this daemon's, then cut every
// connection instead of waiting on it.
export function stop() {
  clearTimeout(idleTimer);
  clearInterval(ownerTimer);
  tailer.stop();
  if (ownsFiles()) {
    try { unlinkSync(sockPath()); } catch {}
    try { unlinkSync(stateFile()); } catch {}
  }
  for (const c of clients) c.destroy();
  clients.clear();
  for (const s of sockConns) s.destroy();
  sockConns.clear();
  events = [];
  totals = { events: 0, byKind: {} };
  openCalls.clear();
  const http = httpServer;
  const net = sockServer;
  httpServer = null;
  sockServer = null;
  return Promise.all([
    new Promise((r) => (http ? (http.close(() => r()), http.closeAllConnections()) : r())),
    new Promise((r) => (net ? net.close(() => r()) : r())),
  ]).then(() => {});
}

// For tests.
export function __state() {
  return { events: events.length, clients: clients.size, byKind: totals.byKind };
}
export function __clear() {
  events = [];
  totals = { events: 0, byKind: {} };
}
