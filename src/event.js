// The event record: the one shape the readers, the hook, the daemon, the gauge
// and the page share.
//
//   ts      epoch ms
//   agent   source client, e.g. 'claude'
//   session source session id
//   kind    see KIND
//   status  see STATUS
//   tool    tool name, or null
//   dur_ms  duration in ms, or null
//   sig     sha256 of the tool arguments (tool) or the error text (tool_fail)
//   target  sha256 of the file path an edit touched, or null
//
// Only hashes, never text: no file contents, prompts, tool output or thinking.

import { contentHash } from './crypto.js';

export const KIND = Object.freeze({
  TOOL: 'tool',
  TOOL_FAIL: 'tool_fail',
  THINK: 'think',
  PERMISSION: 'permission',
  NOTIFICATION: 'notification',
  SUBAGENT: 'subagent',
  STOP: 'stop',
  ERROR: 'error',
  TURN: 'turn', // the person sent a prompt; never carries the prompt
});

export const STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  WAITING: 'waiting',
  DENIED: 'denied',
});

const KINDS = new Set(Object.values(KIND));
const STATUSES = new Set(Object.values(STATUS));
const HASH = /^sha256:[0-9a-f]{64}$/;
const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

// Build an event from untrusted input, keeping only known fields with valid
// values. Returns null when the kind is unknown.
export function toEvent(raw) {
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.kind)) return null;
  return {
    ts: num(raw.ts) ?? Date.now(),
    agent: str(raw.agent, 40) ?? 'claude',
    session: str(raw.session),
    kind: raw.kind,
    status: STATUSES.has(raw.status) ? raw.status : STATUS.OK,
    tool: str(raw.tool, 120),
    dur_ms: num(raw.dur_ms),
    sig: HASH.test(raw.sig ?? '') ? raw.sig : null,
    target: HASH.test(raw.target ?? '') ? raw.target : null,
  };
}

// Hashes for one tool call, shared by the hook and the transcript reader so a
// call hashes the same live and in replay. Bash's `description` is free text
// the model rewrites on every call, so it is left out.
export async function hashToolInput(input) {
  let args = input;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const { description, ...rest } = args;
    args = rest;
  }
  const path = args?.file_path ?? args?.notebook_path;
  return {
    sig: args === undefined ? null : await contentHash(args),
    target: typeof path === 'string' ? await contentHash(path) : null,
  };
}

// Error text from a tool result: a string, or the text blocks of an array.
export function errorText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return content == null ? '' : JSON.stringify(content);
}
