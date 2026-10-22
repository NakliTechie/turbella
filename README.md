<h1 align="center">Turbella</h1>

<p align="center">
  <strong>See what your coding agent is doing while you wait:<br>
  every tool call, failure, retry and permission wait, live, with a gauge for when it is stuck.</strong>
</p>

<p align="center">
  A Claude Code plugin and a local page. macOS (Linux untested), Node 22. No account, no server, no telemetry.
</p>

<p align="center">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-2563eb?style=flat-square">
  <img alt="localhost only" src="https://img.shields.io/badge/network-localhost%20only-2563eb?style=flat-square">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square"></a>
  <img alt="no dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-2563eb?style=flat-square">
</p>

![A live Turbella page: one Claude Code lane with tool ticks, three identical test failures marked as a repeat, a permission wait in amber, and the turbulence gauge at 0.49](marketing/hero.png)

## Install

| | |
|---|---|
| **Claude Code** | `claude plugin marketplace add NakliTechie/turbella`, then `claude plugin install turbella@turbella` |
| **From a clone** | `git clone https://github.com/NakliTechie/turbella`, then `claude --plugin-dir turbella` |
| **The `turbella` command** | in the clone, `npm link` puts it on your PATH; or run `node bin/turbella` |

Start a Claude Code session. The first hook starts the Turbella daemon and opens the page
in your browser (only when no Turbella page is open; `TURBELLA_OPEN=0` turns this off).
The session also prints the address, `http://127.0.0.1:7377`. Leave the page in a corner
of the screen. Events appear as the agent
works; the page shows the first one within 5 seconds of the first hook.

No config file, no account, nothing to start by hand. No session to watch? Run
`turbella open` and load any Claude Code transcript from `~/.claude/projects/` with the
page's **load** button to replay it. Press **Live** to go back to following the agent.

## Why

You wait on an agent for minutes and learn nothing from the wait. Was it thinking,
retrying the same failing command, blocked on a permission prompt, or finished? The
transcript tells you afterwards. Turbella shows it while it happens.

Each session gets a lane, and each tool call is a tick coloured by tool. A failure is a
red spike, and the same failure twice gets a repeat mark. A permission wait is amber; a
violet dot is thinking, larger for longer. The **turbulence gauge** (0 to 1) adds four
signals from the last five minutes: failures that repeat an earlier failure, repeated
edits to one file, the same tool called over and over, and time since the last
successful tool call. That last one rises through a silent wait and reaches its full
share after a minute, because silence is part of being stuck.

The idea comes from "Fractal basins trap latent reasoning" (Gilpin's group,
arXiv:2609.04963): reasoning stuck near almost-correct answers keeps switching
candidates, and that switching rate measures how stuck it is. Turbella measures the
agent's observable version of that.

## What leaves your machine

Nothing. The hook hashes the tool's arguments, the edited file's path and any error text
with SHA-256, and sends the daemon only the hashes, the tool name and the status. File
contents, prompts, tool output and error text never leave the hook; thinking is read as
a duration only. A hash lets Turbella see that the same command failed the same way
three times without storing the command. The daemon listens on a Unix socket readable
only by you and on `127.0.0.1`, and answers only requests addressed to this machine.

## Other agents

Claude Code is the only agent Turbella hooks into today. Any other agent or script can
send an event with `turbella emit` (for example "switching approach") or read the gauge
with `turbella status`. Both start the daemon if it is not running, and `emit` never fails
loudly, so an agent can call it mid-task.

## Commands

```
turbella open                     # start the daemon if needed, open the page
turbella status                   # events, counts by kind, the gauge, as JSON
turbella emit --kind tool_fail --tool Bash --payload '"exit 1"'   # send one event
turbella replay <file.jsonl>      # counts and gauge for a recorded transcript
turbella start                    # run the daemon in the foreground
```

Every command is declared once in `src/manifest.js`. The same tools are served over MCP
(`bin/turbella-mcp`, as `turbella_status`, `turbella_emit`, `turbella_replay`,
`turbella_open`). The page publishes its own controls (play, pause, speed, seek, load,
live) to agents as `navigator.modelContext` tools, or as `window.turbella.tools` where the
browser has no WebMCP.

## Verify it yourself

```
npm run verify     # readers, gauge, playback, daemon, hook binary, CLI, MCP, manifest parity
npm run ttfv       # cold start: first hook to event on the page, gate 5 s (needs Chrome)
node marketing/capture.mjs   # regenerate the hero and social card from a scripted session
```

`npm run verify` runs the real hook binary against a daemon, checks that no file body,
prompt, output or error text leaves the hook, and fails if the CLI, the MCP tool list or
the page controls stop matching the manifest. `npm run ttfv` drives headless Chrome (set
`CHROME_BIN` if Chrome is not in `/Applications`) and measured under 200 ms on an Apple
Silicon Mac. Delivery from a real Claude Code session (`claude -p --plugin-dir .`) was
checked by hand on 2026-10-21; no script repeats that check.

## License

MIT — see [LICENSE](LICENSE).

For a coding agent or contributor: [AGENTS.md](AGENTS.md)
