// Transcript tailer: watches Claude Code (`~/.claude/projects/*/*.jsonl`) and
// Codex (`~/.codex/sessions/`) transcript trees for new lines. When it sees an
// assistant turn carrying `thinkingDurationMs`, it emits a `think` event to the
// caller's callback — the transcript lags the live turn, so the tailer
// backfills the thinking heartbeat hooks can't see.
//
// Never blocks or fails loudly: missing/moved files are skipped, callback
// errors are swallowed, and polling stops when stopped.
//
// Usage:
//   import { createTailer } from './tailer.js';
//   const t = createTailer({ onEvent: (ev) => writeEvent(ev), pollMs: 1000 });
//   t.start();  // ... later ... t.stop();

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLAUDE_SRC =
  process.env.TRACELESS_CLAUDE_SRC ||
  (process.env.HOME ? `${process.env.HOME}/.claude/projects` : '');
const CODEX_SRC =
  process.env.TRACELESS_CODEX_SRC ||
  (process.env.HOME ? `${process.env.HOME}/.codex/sessions` : '');

// File cursor: path -> last byte offset read.
const cursors = new Map();
let timer = null;
let running = false;
let onEvent = () => {};

// Read new complete lines from a file since last offset.
async function readNewLines(filePath) {
  let offset = cursors.get(filePath) || 0;
  let st;
  try { st = await stat(filePath); } catch { return []; }
  if (st.size < offset) { offset = 0; cursors.set(filePath, 0); } // rotated
  if (st.size === offset) return [];
  const data = await readFile(filePath, { encoding: 'utf8', start: offset });
  const lines = data.split(/\r?\n/);
  const complete = lines.slice(0, -1); // last element may be a partial line
  const consumed = data.lastIndexOf('\n');
  cursors.set(filePath, offset + (consumed >= 0 ? consumed + 1 : 0));
  return complete.filter(Boolean);
}

// Scan one transcript file for think events.
async function scanFile(filePath, agent) {
  const lines = await readNewLines(filePath);
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'assistant' && msg.message &&
        typeof msg.message.thinkingDurationMs === 'number') {
      try {
        onEvent({
          ts: msg.timestamp ? Date.parse(msg.timestamp) : Date.now(),
          agent,
          session: msg.sessionId ?? null,
          kind: 'think',
          status: 'ok',
          tool: null,
          dur_ms: msg.message.thinkingDurationMs,
          sig: 'sha256:think-' + msg.message.thinkingDurationMs,
        });
      } catch {} // never fail loudly
    }
  }
}

// Discover .jsonl transcript files under a root (one level of subdirs).
async function discover(root) {
  const out = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      const full = join(root, e.name);
      if (e.isDirectory()) {
        try {
          const sub = await readdir(full, { withFileTypes: true });
          for (const s of sub)
            if (s.isFile() && s.name.endsWith('.jsonl')) out.push(join(full, s.name));
        } catch {}
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  } catch {}
  return out;
}

let knownFiles = new Map(); // path -> agent

async function refreshFiles() {
  for (const f of await discover(CLAUDE_SRC)) knownFiles.set(f, 'claude');
  for (const f of await discover(CODEX_SRC)) if (!knownFiles.has(f)) knownFiles.set(f, 'codex');
}

async function poll() {
  await refreshFiles();
  for (const [filePath, agent] of knownFiles) {
    try { await scanFile(filePath, agent); } catch {}
  }
}

export function createTailer(opts = {}) {
  const pollMs = opts.pollMs ?? 2000;
  onEvent = opts.onEvent || (() => {});
  return {
    start() {
      if (running) return;
      running = true;
      refreshFiles();
      poll();
      timer = setInterval(poll, pollMs);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
