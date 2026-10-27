# Turbella: notes for coding agents and contributors

Turbella is a Claude Code plugin, a local Node daemon and a browser page that
shows an agent's tool calls, failures, permission waits and thinking as they
happen, with a gauge for when the agent is stuck. `README.md` covers use.

## Layout

- `hooks/hooks.json`, `.claude-plugin/` — the plugin: which Claude Code hooks run.
- `bin/turbella-hook` — runs per hook; hashes what names the call and sends one event.
- `bin/turbella` — the CLI; `bin/turbella-mcp` — the same tools over MCP (stdio).
- `native/turbella-native.swift` — macOS helper for `overlay` (floating windows) and `run`
  (terminal strip); shipped prebuilt as `native/turbella-native`, else built with swiftc.
- `src/daemon.js` — receives events on a Unix socket; serves the page and its stream on 127.0.0.1.
- `src/event.js` — the event record and the only place events are built from input.
- `docs/PLUGINS.md` — the contract for other apps (schema 1); change it with the record.
- `adapters/` — in-process adapters (opencode, pi, omp) and the sender they share.
- `src/transcript.js`, `src/reader.js` — Claude Code transcripts to events, for replay.
- `src/gauge.js` — the turbulence gauge; `src/tailer.js` — thinking time from live transcripts.
- `src/manifest.js` — every command, declared once; `src/tools.js` — their handlers.
- `web/turbella.html`, `src/render.js`, `src/playback.js` — the page.

## Rules

- **Privacy.** Events carry tool names, statuses, durations and SHA-256 hashes. Never put
  file contents, prompts, tool output, error text or thinking text in an event, and never
  send them out of the hook. `npm run verify` checks this with a stand-in socket.
- **Local only.** The daemon listens on a Unix socket and on 127.0.0.1, and answers only
  requests addressed to this machine. No network calls, no telemetry, no accounts.
- **One manifest.** A new command goes in `src/manifest.js` with a handler in
  `src/tools.js` (CLI and MCP) or in the page's `TOOLS` table, plus a `data-tool`
  attribute on its control. `npm run verify` fails when they drift.
- **No dependencies.** Node 22 built-ins only; the native helper uses only Apple's
  frameworks. One built binary is committed: `native/turbella-native`, the universal
  helper from `npm run build:native`, so a Mac without swiftc works (panel review,
  2026-10-27; this overrides the earlier no-binaries rule). Rebuild it after any change to
  the Swift source; `npm run verify` fails while its recorded source hash is stale.
- **Fixtures are synthetic** and use Claude Code's real record shape. Real transcripts
  hold secrets; never commit one.

## Before you commit

```
npm run verify     # all checks, about 10 s
npm run ttfv       # needs Chrome; first hook to event on the page, gate 5 s
npm run strip      # needs tmux; the terminal strip against unwrapped pastes and screens
```
