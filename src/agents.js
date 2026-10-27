// The agents the hook serves, and how their hook payloads differ.
//
//   claude   Claude Code: PascalCase events, snake_case fields, a failure event
//   codex    Codex: Claude-shaped; no failure event, no shell exit codes
//   copilot  Copilot CLI: Claude-shaped through the plugin, except permission
//            requests (camelCase); shell results end with "exit code N"
//   cursor   Cursor: camelCase events, snake_case fields, a failure event and a
//            thinking-time event; installed into ~/.cursor/hooks.json
//   hermes   Hermes Agent shell hooks: snake_case events, per-event fields in
//            `extra`; a tool's end carries status ok, error or blocked
//
// normalise() turns any of them into one shape; each profile then says which
// calls failed and what error text to hash. Only names, ids, durations and
// hashes leave the hook; the text fields read here are hashed or dropped.

// Agent event names -> the canonical (Claude Code) names the daemon knows.
const EVENT = {
  sessionStart: 'SessionStart', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure', permissionRequest: 'PermissionRequest',
  subagentStart: 'SubagentStart', subagentStop: 'SubagentStop', notification: 'Notification',
  preCompact: 'PreCompact', stop: 'Stop', agentStop: 'Stop', errorOccurred: 'StopFailure',
  userPromptSubmitted: 'UserPromptSubmit', beforeSubmitPrompt: 'UserPromptSubmit',
  afterAgentThought: 'AgentThought',
  // Hermes; pre_llm_call fires once per user message, on_session_end once per turn
  on_session_start: 'SessionStart', pre_llm_call: 'UserPromptSubmit', pre_tool_call: 'PreToolUse',
  post_tool_call: 'PostToolUse', pre_approval_request: 'PermissionRequest',
  subagent_start: 'SubagentStart', subagent_stop: 'SubagentStop', on_session_end: 'Stop',
};

const EXIT_CODE = /exit code:? (-?\d+)/i;
const exitCode = (text) => {
  const m = typeof text === 'string' ? text.match(EXIT_CODE) : null;
  return m ? Number(m[1]) : null;
};

export function normalise(p) {
  const raw = p.hook_event_name ?? p.hookName ?? null;
  const x = p.extra && typeof p.extra === 'object' ? p.extra : {};
  return {
    event: EVENT[raw] ?? raw,
    session: p.session_id ?? p.sessionId ?? p.conversation_id ?? null,
    tool: p.tool_name ?? p.toolName ?? null,
    input: p.tool_input ?? p.toolInput ?? p.toolArgs ?? p.args,
    result: p.tool_response ?? p.tool_result ?? p.toolResult ?? p.tool_output,
    error: p.error_message ?? p.error ?? x.error_message,
    status: x.status ?? null,
    transcript: p.transcript_path ?? p.transcriptPath ?? null,
    call: p.tool_use_id ?? p.toolUseId ?? x.tool_call_id ?? null,
    durMs: [p.duration_ms, p.duration, x.duration_ms].find(Number.isFinite) ?? null,
  };
}

const errorOf = (n) => (typeof n.error === 'string' ? n.error : n.error?.message);

export const PROFILES = {
  claude: {
    failed: (n) => n.event === 'PostToolUseFailure',
    errorText: errorOf,
    // SessionStart output Claude Code shows the person.
    greeting: (url) => JSON.stringify({ systemMessage: `Turbella: ${url}` }),
  },
  codex: {
    // A patch reports "Exit code: N"; a patch that fails outright sends no
    // PostToolUse at all (FAILS_BY_MISSING_END). A shell call reports only its
    // output, so its failures cannot be seen.
    failed: (n) => n.event === 'PostToolUse' && /^Exit code:/m.test(n.result ?? '') && exitCode(n.result) !== 0,
    errorText: (n) => n.result,
    greeting: () => '',
  },
  copilot: {
    failed: (n) => n.event === 'PostToolUseFailure' || (n.event === 'PostToolUse' && (
      ['failure', 'error', 'denied', 'rejected'].includes(n.result?.result_type ?? n.result?.resultType)
      || (exitCode(n.result?.text_result_for_llm ?? n.result?.textResultForLlm) ?? 0) !== 0)),
    errorText: (n) => errorOf(n) ?? n.result?.text_result_for_llm ?? n.result?.textResultForLlm,
    greeting: () => '',
  },
  cursor: {
    failed: (n) => n.event === 'PostToolUseFailure',
    errorText: errorOf,
    greeting: () => '',
  },
  hermes: {
    // A blocked call never ran, so it counts as failed like an error.
    failed: (n) => n.event === 'PostToolUse' && (n.status === 'error' || n.status === 'blocked'),
    errorText: (n) => n.error ?? n.status,
    // Hermes reads stdout as a hook decision; print nothing.
    greeting: () => '',
  },
};

// Agents with no failure event for some calls: a tool start that never gets
// its end before the turn stops is counted as a failure (the daemon does this).
export const FAILS_BY_MISSING_END = new Set(['codex']);

// Which agent sent this payload: an explicit choice first, then what the
// payload itself shows.
export function detectAgent(p, { env = process.env, argv = process.argv } = {}) {
  const flag = argv.indexOf('--agent');
  const chosen = env.TURBELLA_AGENT ?? (flag >= 0 ? argv[flag + 1] : null);
  if (chosen && PROFILES[chosen]) return chosen;
  const transcript = p?.transcript_path ?? p?.transcriptPath ?? '';
  if (/[/\\]\.codex[/\\]/.test(transcript)) return 'codex';
  if (/[/\\]\.copilot[/\\]/.test(transcript) || p?.hookName) return 'copilot';
  if (p?.cursor_version || p?.conversation_id) return 'cursor';
  if (p?.extra && typeof p.hook_event_name === 'string' && /^[a-z]+(_[a-z]+)+$/.test(p.hook_event_name)) return 'hermes';
  // Copilot stamps every payload and omits the transcript on tool events;
  // Claude Code always sends a transcript path.
  if (!transcript && p?.timestamp != null) return 'copilot';
  return 'claude';
}
