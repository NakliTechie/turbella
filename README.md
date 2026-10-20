# Turbella

A Winamp-style visualiser for the long waits in an agent turn. Every tool call, failed tool call, retry, permission wait and stretch of thinking becomes a stimulus, and a "turbulence" gauge says when an agent is stuck. A standalone plugin: Claude Code, Codex, opencode and ACP clients feed it, and other agents can send it events or read the gauge.

Tier: Tool. macOS first. Localhost only. No account, no telemetry.

## Install

TODO. Planned: one local daemon (starts on the first event, exits when idle), a Claude Code plugin that registers async hooks, and a `turbella emit` command for any other agent. Nothing is built yet.

## Why

You wait on an agent for minutes and learn nothing from the wait. Was it thinking, retrying the same failing command, blocked on a permission prompt, or finished? A transcript tells you afterwards. Turbella shows it while it happens, as something you can leave in a corner of the screen.

The idea comes from "Fractal basins trap latent reasoning" (Gilpin's group, arXiv:2609.04963): reasoning that gets stuck near almost-correct answers keeps switching candidates, and that switching rate measures how stuck it is. Turbella uses the observable agent analogue: repeated identical failures, edit thrash on one file, tool-call diversity and time since real progress.

## Context

Handoff, from a 2026-10-20 session in the knowledge vault (Chirag: "an actual stand alone plugin that can be called in Claude code. Twists and turns, failed tool calls are all inputs/stimuli for the visualiser. Can be called by other agents as well").

What is observable today (checked 2026-10-20):

- **Claude Code hooks:** a dedicated `PostToolUseFailure`, plus `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PermissionDenied`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`. Command hooks can run async (`"async": true`). Plugins package hooks in `hooks/hooks.json`, a `bin/` directory on the Bash tool's PATH, skills and an MCP server.
- **Transcript** (`~/.claude/projects/<cwd>/<session>.jsonl`): `thinkingDurationMs` per assistant turn, `is_error` on tool results and timestamps. Thinking text is not stored and `thinking_tokens` read 0, so the thinking heartbeat is timing, not content.
- **Status line:** refreshes at most once a second, so it can show a one-line spark and a link, not an animation.
- **Other agents:** Codex hooks (no failure event; read `tool_response`), opencode plugin events (`tool.execute.after`, `session.error`, `permission.asked`), ACP `session/update` (`agent_thought_chunk`, `tool_call_update` with status `failed`).

Prior art, all dashboards and none ambient: agents-observe, Claude-Code-Agent-Monitor, ccdeck, claude-flightdeck, mohano. In the vault: agentplay (session replay map and Errors tab), hapsland (hooks into Claude Code, Codex and Pi), tracelens (`~/Code/tracelens`, five rule signals and parsers for Claude and Codex transcripts).

Full plan: `plan/pending.md` and `plan/workplan.md`.

## Verify it yourself

TODO: the first gate is replaying a recorded session and matching its failure count to tracelens's.

## License

TODO (decide before the first public push).
