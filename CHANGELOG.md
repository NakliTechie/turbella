# Changelog

All notable changes to Turbella. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-10-27

The first release. macOS only.

### Added
- Claude Code plugin: hooks send one event per tool call, failure, permission wait,
  subagent, turn and stop to a local daemon. Events carry names, statuses, durations and
  SHA-256 hashes only, never prompts, file contents or output.
- Daemon on a Unix socket and 127.0.0.1: a live event stream with session, run and agent
  filters, and a JSON status with the turbulence gauge and the active sessions.
- Turbulence gauge (0 calm to 1 stuck) from repeated failures, edit thrash, low tool
  diversity and time without a successful call.
- Timeline page: one lane per agent session, round-step time axis, silence shaded while
  live, an offline state when the daemon stops, and replay of recorded transcripts.
- Music visualiser: MilkDrop presets (Butterchurn) driven by the events, with next look,
  cycle looks every 30 s, a held tone while a tool runs, a calmer idle mode, and a readout
  listing each agent's current action.
- `turbella overlay` (macOS): always-on-top windows, one per agent session or one combined
  window, with a fading toolbar that hides on demand; opacity and click-through from the
  menu bar. Ships a prebuilt universal helper; swiftc is needed only to rebuild it.
- `turbella run <agent>` (macOS): runs any terminal agent under a one-line strip with its
  own gauge and current tool.
- Agents: Claude Code, Codex, Copilot CLI and Cursor through the hook; Hermes through its
  shell hooks; opencode, pi, omp and dsh (DeepSeek Harness) through in-process adapters.
  `turbella install <agent>` writes or prints the setup.
- `docs/PLUGINS.md`: the contract (schema 1) for other apps to send and read events.
- MCP server with the same tools as the CLI; page controls published to agents.
- A guide at `/guide/`, linked from a `?` on both pages, regenerated from `guide/`.
- Checks: `npm run verify`, `npm run ttfv` (cold start, gate 5 s) and `npm run strip`
  (terminal strip against unwrapped pastes and screens).

### Known limits
- macOS only; Linux and Windows are not supported yet.
- Codex reports no exit code for shell commands, so a failed Codex shell command shows as
  a normal call.
- Cursor has not been run live with Turbella; pi and omp were run live for turns only.
- The gauge's weights are a first guess, not yet calibrated against labelled sessions.

[0.1.0]: https://github.com/NakliTechie/turbella/releases/tag/v0.1.0
