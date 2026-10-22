// Claude Code transcript (JSONL lines) -> events. No Node imports, so the page
// and the CLI share one parser; reading a file lives in reader.js.
//
// The format, as Claude Code writes it:
//   assistant record  message.content holds tool_use blocks; thinkingDurationMs
//                     sits at the top level of the record
//   user record       message.content holds tool_result blocks (is_error, content)
//   other records     (summaries, api-request-blob, ...) repeat content and are skipped
// isSidechain marks a subagent's records; they get their own lane.
//
// Tool calls hash the same way as on the live hook path (event.js), so replay
// and live agree.

import { KIND, STATUS, hashToolInput, errorText } from './event.js';
import { contentHash } from './crypto.js';

export async function* readClaudeEvents(lines) {
  const pending = new Map(); // tool_use id -> { name, input, ts }
  const resolved = new Set();
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== 'assistant' && rec?.type !== 'user') continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
    const base = { agent: rec.isSidechain ? 'subagent' : 'claude', session: rec.sessionId ?? null };

    if (rec.type === 'assistant' && typeof rec.thinkingDurationMs === 'number') {
      yield { ...base, ts, kind: KIND.THINK, status: STATUS.OK, tool: null, dur_ms: rec.thinkingDurationMs, sig: null, target: null };
    }

    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.id && !resolved.has(b.id)) {
        pending.set(b.id, { name: b.name ?? null, input: b.input, ts });
      } else if (b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const call = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        resolved.add(b.tool_use_id);
        const failed = b.is_error === true;
        const { sig, target } = failed
          ? { sig: await contentHash(errorText(b.content)), target: null }
          : await hashToolInput(call.input);
        const dur = ts != null && call.ts != null ? ts - call.ts : null;
        yield {
          ...base,
          ts: ts ?? call.ts,
          kind: failed ? KIND.TOOL_FAIL : KIND.TOOL,
          status: failed ? STATUS.ERROR : STATUS.OK,
          tool: call.name,
          dur_ms: dur > 0 ? dur : null,
          sig,
          target,
        };
      }
    }
  }
}
