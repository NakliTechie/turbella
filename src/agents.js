// What differs between the agents the hook serves. Each profile answers:
// did this tool call fail, and what is the error text to hash. Event names and
// payload fields are otherwise shared (Claude Code's hook shape, which Codex
// follows).

const EXIT_CODE = /^Exit code: (-?\d+)/m;

export const PROFILES = {
  claude: {
    // Claude Code sends failures as their own event.
    failed: (p) => p.hook_event_name === 'PostToolUseFailure',
    errorText: (p) => p.error ?? p.error_message,
    // SessionStart output Claude Code shows the person.
    greeting: (url) => JSON.stringify({ systemMessage: `Turbella: ${url}` }),
  },
  codex: {
    // Codex has no failure event. A patch reports "Exit code: N", and a patch
    // that fails outright sends no PostToolUse at all (FAILS_BY_MISSING_END).
    // A shell call reports only its output, so its failures cannot be seen.
    failed: (p) => {
      if (p.hook_event_name !== 'PostToolUse' || typeof p.tool_response !== 'string') return false;
      const m = p.tool_response.match(EXIT_CODE);
      return m != null && Number(m[1]) !== 0;
    },
    errorText: (p) => p.tool_response,
    greeting: () => '',
  },
};

// Agents with no failure event for some calls: a tool start that never gets
// its end before the turn stops is counted as a failure (the daemon does this).
export const FAILS_BY_MISSING_END = new Set(['codex']);

// Which agent sent this payload: an explicit choice first, then the
// transcript's location (Codex keeps sessions under ~/.codex/).
export function detectAgent(payload, { env = process.env, argv = process.argv } = {}) {
  const flag = argv.indexOf('--agent');
  const chosen = env.TURBELLA_AGENT ?? (flag >= 0 ? argv[flag + 1] : null);
  if (chosen && PROFILES[chosen]) return chosen;
  return /[/\\]\.codex[/\\]/.test(payload?.transcript_path ?? '') ? 'codex' : 'claude';
}
