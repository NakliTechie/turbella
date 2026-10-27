# Connecting an agent to Turbella

This is the contract for sending events to Turbella from an agent or app it does not
support yet. It is schema **1**: `turbella status` and `GET /status` report `"schema": 1`,
and a change that would break an adapter raises the number.

There are two ways in:

- **A hook adapter.** Your agent already runs a command on each tool call (Claude Code,
  Codex, Copilot CLI, Cursor and Hermes work this way). Point that command at
  `bin/turbella-hook --agent <name>` and add a profile to `src/agents.js`.
- **Send events yourself.** Anything that can write a line to a Unix socket, or run a
  command, can send events: an agent's plugin, a wrapper script, a CI job.

## The privacy rule

An event carries names, statuses, durations and SHA-256 hashes, never text. Never put
prompts, file contents, tool output, error messages or thinking text in an event. Hash
what names a call (its arguments, or its error text) and send only the hash. The daemon
drops any field that is not listed below, and any `sig` or `target` that is not a hash.

## The event record

One JSON object per event. Fields, as `src/event.js` checks them:

| Field | Type | Meaning |
|---|---|---|
| `kind` | required | `turn`, `tool`, `tool_fail`, `think`, `permission`, `notification`, `subagent`, `stop`, `error`; other kinds are dropped |
| `status` | optional | `ok` (default), `error`, `waiting`, `denied` |
| `agent` | string, 40 chars | your agent's name; it becomes the lane. Defaults to `claude`, so always set it |
| `session` | string, 200 chars | your session id; one session draws as one lane |
| `tool` | string, 120 chars | tool name, e.g. `terminal`, `Edit` |
| `dur_ms` | number | how long the call or the thinking took |
| `ts` | number | epoch milliseconds; defaults to the time the daemon receives it |
| `sig` | `sha256:<64 hex>` | hash of what names the call, so repeats show as a loop |
| `target` | `sha256:<64 hex>` | hash of the file path an edit touched, for edit thrash |
| `run` | string, 64 chars | set from `$TURBELLA_RUN` when the agent runs under `turbella run`, so that terminal's strip shows only this agent; copy it if your adapter sees it |

How the page and the gauge read them:

- A tool call is a `tool` event with `status: "waiting"` when it starts, then `tool` (or
  `tool_fail`) with `status: "ok"` (or `"error"`) when it ends, with the same `tool` and
  `sig`. The start is optional; without it the call shows only when it ends.
- `turn` marks a new prompt from the person, and `stop` the end of the agent's turn.
  Between them the visualiser plays its working tone.
- Three `tool_fail` events with the same `sig` in a row raise the gauge most. Any stable
  hash works for `sig`; Turbella's own is SHA-256 of the canonical JSON of the arguments
  (keys sorted), or of the error text for a failure (`src/crypto.js`).

## Sending events

**From a shell**, with `turbella emit`. It starts the daemon when none runs, hashes the
payload, prints nothing and always exits 0, so it is safe inside a hook:

```
turbella emit --agent myagent --kind tool --status waiting --tool terminal --session s1 --payload '{"command":"make"}'
turbella emit --agent myagent --kind tool_fail --status error --tool terminal --session s1 --payload 'exit 2'
```

**Over the socket**, for speed. Write one JSON object per line to `~/.turbella.sock`
(`$TURBELLA_SOCK` overrides the path). Lines over 1 MB close the connection; lines that
are not valid JSON are dropped. The daemon answers nothing on the socket.

```python
import json, socket, os, hashlib, time
s = socket.socket(socket.AF_UNIX); s.connect(os.path.expanduser("~/.turbella.sock"))
sig = "sha256:" + hashlib.sha256(b'{"command":"make"}').hexdigest()
s.sendall((json.dumps({"agent": "myagent", "session": "s1", "kind": "tool_fail",
                       "status": "error", "tool": "terminal", "sig": sig,
                       "ts": time.time() * 1000}) + "\n").encode())
```

When the socket is missing, no daemon runs. Start one with `turbella status` (it starts
the daemon and returns), or drop the event; never block the agent on Turbella.

**Over MCP**, an agent can call `turbella_emit` on `bin/turbella-mcp` with the same fields.

## Reading what Turbella sees

The daemon serves these only on `127.0.0.1` (port 7377 unless taken; the address is in
`~/.turbella.state`):

- `GET /events` streams every event as server-sent events: `id: <n>` then
  `data: <event JSON>`. On connect it first sends what it holds (up to 10,000 events);
  send `Last-Event-ID` to get only newer ones. `?session=`, `?run=` and `?agent=` limit
  the stream, backlog included. The daemon serves up to 64 streams and answers more with
  503; a reader should retry after a pause.
- `GET /status` returns `{schema, events, byKind, gauge, sockPath, pages, sessions}`.
  `gauge` is the turbulence from 0 (calm) to 1 (stuck) over the last 5 minutes.
  `sessions` lists active sessions, newest first: `{session, agent, run, events, last,
  stopped, open}`. A session is active for 15 minutes after its last event, and for up to
  2 hours while it has not stopped or has tool calls open (`open` counts them).
- `GET /status?session=<id>` (or `?run=`, `?agent=`, combined with `&`) counts and
  measures only the matching events, and leaves out `sessions`.
- `GET /viz?session=<id>` is the visualiser for one session; the floating windows use it.

## Worked example: Hermes Agent

Hermes runs shell hooks with a JSON payload on stdin: `hook_event_name`, `tool_name`,
`tool_input`, `session_id`, and the event's other fields in `extra`. The `hermes` profile
in `src/agents.js` maps its events onto Turbella's:

| Hermes event | Turbella kind |
|---|---|
| `on_session_start` | starts the daemon and opens the page, sends nothing |
| `pre_llm_call` | `turn` (Hermes fires it once per user message) |
| `pre_tool_call` | `tool`, `waiting` |
| `post_tool_call` | `tool`, or `tool_fail` when `extra.status` is `error` or `blocked` |
| `pre_approval_request` | `permission`, `waiting` |
| `subagent_start`, `subagent_stop` | `subagent` |
| `on_session_end` | `stop` (Hermes fires it once per turn) |

Duration comes from `extra.duration_ms`. The error hash comes from `extra.error_message`,
which is hashed in the hook and never sent. `turbella install hermes` prints the
`hooks:` block for `~/.hermes/config.yaml`; Hermes asks you to approve the hooks the
first time it runs them.

## Worked example: opencode, pi and omp (in-process)

These agents load JavaScript plugins, so their adapters run inside the agent and write to
the socket directly, with no process started per call. All three share `adapters/sink.js`,
which hashes in the agent's process and sends events one after another, in order.
`turbella install opencode` (or `pi`, `omp`) writes a one-line file into the agent's plugin
folder that re-exports the adapter; delete that file to remove it.

| Agent | Source events | Turbella kinds |
|---|---|---|
| opencode (`adapters/opencode.js`) | `chat.message`; tool parts `running`, `completed`, `error`; reasoning parts; `permission.updated`/`.replied`; `session.idle` | turn; tool start, end or failure (a shell exit code other than 0 fails); think with duration; permission; stop |
| pi, omp (`adapters/pi.js`, `adapters/omp.js`) | `agent_start`, `tool_execution_start`, `tool_execution_end` (`isError`), `agent_end` | turn; tool start; end or failure with duration; stop |

The pi and omp adapter waits for its queue at `agent_end`, because in print mode the agent
exits right after it.

To add another hook-based agent, copy the Hermes pattern: map its event names in `EVENT`, read
its fields in `normalise()`, add a profile that says which calls failed, teach
`detectAgent()` its payload shape, and add real-shape payloads to `scripts/verify.mjs`.
