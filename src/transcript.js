// Transcript parsers: Claude Code and Codex JSONL lines -> neutral event record.
// No Node imports, so the page and the CLI share one parser; file reading lives
// in reader.js.
//
// Both readers reuse tracelens's parser field semantics
// (`~/Code/tracelens/src/tracelens/index.py`, CLAUDE_STAGE / CODEX_STAGE):
//
//   - assistant tool_use blocks  -> pending tool call (name, input, ts)
//   - tool_result / `type: 'tool'` with tool_use_id -> resolved call
//       is_error  -> kind 'tool_fail', status 'error', sig = hash(error_text)
//       else      -> kind 'tool',     status 'ok',     sig = hash(tool input)
//       dur_ms    = result_ts - request_ts (tracelens duration_s * 1000)
//   - thinkingDurationMs on an assistant turn -> kind 'think', dur_ms = it
//
// `sig` is a content hash (never raw text) — AGENTS.md privacy rule. Readers run
// a single pass over the transcript so tool_use / tool_result pairs that span
// lines are matched correctly.

import { KIND, STATUS, INPUT_CAP, ERR_CAP } from './event.js';
import { contentHash, stable, truncate } from './crypto.js';

// Objects hash as canonical JSON; String() would turn every one into
// "[object Object]" and give all tool calls the same hash.
async function sigOf(payload, cap) {
  const text = typeof payload === 'string' ? payload : stable(payload ?? null);
  return contentHash(truncate(text, cap));
}

// Resolve a pending tool_use into an event once its tool_result arrives.
async function resolveCall(call, result, session) {
  const isError = result.is_error === true;
  const resultTs = result.timestamp != null ? Date.parse(result.timestamp) : result.ts;
  const endTs = resultTs != null ? resultTs : call.ts;
  const dur_ms = endTs - call.ts;
  const payload = isError ? String(result.content ?? '') : call.input;
  return {
    ts: endTs,
    agent: 'claude',
    session,
    kind: isError ? KIND.TOOL_FAIL : KIND.TOOL,
    status: isError ? STATUS.ERROR : STATUS.OK,
    tool: call.name,
    dur_ms: dur_ms > 0 ? dur_ms : null,
    sig: await sigOf(payload, isError ? ERR_CAP : INPUT_CAP),
  };
}

// Yield events from one Claude Code JSONL transcript (iterable of lines).
export async function* readClaudeEvents(lines, session = null) {
  const pending = new Map(); // tool_use id -> {name, input, ts}
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { type, timestamp, message, sessionId, tool_use_id } = msg;
    const s = session ?? sessionId ?? null;
    const ts = timestamp != null ? Date.parse(timestamp) : null;

    // A think heartbeat on an assistant turn (thinkingDurationMs, ms).
    if (type === 'assistant' && message && typeof message.thinkingDurationMs === 'number') {
      yield {
        ts,
        agent: 'claude',
        session: s,
        kind: KIND.THINK,
        status: STATUS.OK,
        tool: null,
        dur_ms: message.thinkingDurationMs,
        sig: await sigOf(String(message.thinkingDurationMs), ERR_CAP),
      };
    }

    const blocks = message && message.content ? message.content : [];
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        // A thinking block carries the turn's thinking heartbeat (thinkingDurationMs, ms).
        if (b.type === 'thinking' && typeof b.thinkingDurationMs === 'number') {
          yield {
            ts,
            agent: 'claude',
            session: s,
            kind: KIND.THINK,
            status: STATUS.OK,
            tool: null,
            dur_ms: b.thinkingDurationMs,
            sig: await sigOf(String(b.thinkingDurationMs), ERR_CAP),
          };
        }
        if (b.type === 'tool_use') {
          pending.set(b.id, { name: b.name, input: b.input, ts });
        } else if (b.type === 'tool_result') {
          const call = pending.get(b.tool_use_id);
          if (call) { yield await resolveCall(call, b, s); pending.delete(b.tool_use_id); }
        }
      }
    }

    // Separate `type: 'tool'` message carrying a tool_result.
    if (type === 'tool' && tool_use_id) {
      const call = pending.get(tool_use_id);
      if (call) { yield await resolveCall(call, msg, s); pending.delete(tool_use_id); }
    }
  }
}

// ---------------------------------------------------------------- Codex

// Codex transcript reader into the same neutral record, reusing tracelens's
// CODEX_STAGE field semantics (tool calls with name/input, results with
// is_error/error_text, thinkingDurationMs). The neutral record is identical to
// Claude's. Yields no events until the Codex field mapping is verified against a
// real Codex fixture — never invent events.
export async function* readCodexEvents(lines, session = null) {
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Placeholder: no events emitted until the Codex field mapping is verified.
  }
}

export { KIND, STATUS };
