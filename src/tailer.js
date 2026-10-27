// Follows the transcripts of live sessions for thinking time, which no hook
// reports. The daemon calls follow() with the transcript path each hook sends;
// reading starts at the file's current end, so history is never replayed.
// Only the duration is read, never the thinking text.

import { open, stat } from 'node:fs/promises';

const MAX_FILES = 32;
const MAX_READ = 4 * 1024 * 1024;

export function createTailer({ onEvent, pollMs = 1000 }) {
  const files = new Map(); // path -> { offset, partial, run }
  let timer = null;

  async function readNew(path, f) {
    let st;
    try { st = await stat(path); } catch { files.delete(path); return; }
    if (st.size < f.offset) { f.offset = 0; f.partial = ''; } // truncated or replaced
    if (st.size === f.offset) return;
    const len = Math.min(st.size - f.offset, MAX_READ);
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, f.offset);
      f.offset += len;
      const lines = (f.partial + buf.toString('utf8')).split('\n');
      f.partial = lines.pop();
      for (const line of lines) {
        if (!line.includes('"thinkingDurationMs"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'assistant' || typeof rec.thinkingDurationMs !== 'number') continue;
        onEvent({
          ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
          agent: rec.isSidechain ? 'subagent' : 'claude',
          session: rec.sessionId ?? null,
          kind: 'think',
          status: 'ok',
          dur_ms: rec.thinkingDurationMs,
          run: f.run,
        });
      }
    } finally {
      await fh.close();
    }
  }

  async function poll() {
    for (const [path, f] of files) {
      try { await readNew(path, f); } catch { /* skip this round */ }
    }
  }

  return {
    // `run` tags the thinking events of an agent under `turbella run`.
    async follow(path, run = null) {
      if (typeof path !== 'string' || !path.endsWith('.jsonl')) return;
      if (files.has(path)) { if (run) files.get(path).run = run; return; }
      let st;
      try { st = await stat(path); } catch { return; }
      if (!st.isFile()) return;
      if (files.size >= MAX_FILES) files.delete(files.keys().next().value);
      files.set(path, { offset: st.size, partial: '', run });
      if (!timer) timer = setInterval(poll, pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      files.clear();
    },
  };
}
