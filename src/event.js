// Neutral event record — the single shape every Turbella reader produces and
// every consumer (canvas, gauge, daemon, emit) reads.
//
//   { ts, agent, session, kind, status, tool, dur_ms, sig }
//
//   ts      epoch ms of the event
//   agent   'claude' | 'codex' | ... (source client)
//   session source session id (one stream of turns)
//   kind    'tool' | 'tool_fail' | 'think' | 'permission' | 'notification'
//          | 'subagent' | 'stop' | 'error'
//   status  'ok' | 'error' | 'waiting' | 'denied'
//   tool    tool name (e.g. 'Bash', 'Write', 'task'); null for non-tool kinds
//   dur_ms  duration in ms (tool call, think, wait); null when unknown
//   sig     sha256 content hash of what names the event: tool input args for
//           `tool`, error text for `tool_fail`. A hash, never raw content — the
//           privacy rule (AGENTS.md): never file contents, prompts, tool output
//           or thinking text.
//
// Sig mirrors the NakliOS ledger convention (input_hash / output_hash committed
// by hash): the payload is canonical (sorted-key) JSON, hashed with SHA-256.

import { contentHash, truncate } from './crypto.js';

// Tracesens-parity caps, reused verbatim so Turbella's sig matches what tracelens
// would extract from the same transcript.
export const INPUT_CAP = 4000;
export const ERR_CAP = 1000;

export const KIND = Object.freeze({
  TOOL: 'tool',
  TOOL_FAIL: 'tool_fail',
  THINK: 'think',
  PERMISSION: 'permission',
  NOTIFICATION: 'notification',
  SUBAGENT: 'subagent',
  STOP: 'stop',
  ERROR: 'error',
});

export const STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  WAITING: 'waiting',
  DENIED: 'denied',
});

// Build one event. `sig` may be precomputed or left null; `payload` (tool input
// args or error text) is hashed into `sig` asynchronously when provided. The
// payload is truncated before hashing and never stored in the record.
export async function makeEvent({
  ts,
  agent,
  session,
  kind,
  status = STATUS.OK,
  tool = null,
  dur_ms = null,
  sig = null,
  payload = null,
} = {}) {
  if (sig === null && payload !== null) sig = await contentHash(payload);
  return Object.freeze({
    ts: ts ?? null,
    agent: agent ?? null,
    session: session ?? null,
    kind,
    status,
    tool,
    dur_ms: dur_ms ?? null,
    sig,
  });
}
