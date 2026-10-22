// Tool manifest: every command Turbella offers, declared once.
//
// Two places run commands, and each reads this list:
//   daemon  the CLI (`turbella <name>`) and the MCP server (`turbella_<name>`)
//   page    the controls on the timeline page, published to agents as
//           navigator.modelContext tools where the browser has it, and as
//           window.turbella.tools[name] otherwise
//   viz     the controls on the visualiser page, published the same way
//
// `effect` says what a call changes: `read` changes nothing; `view` changes
// only what this page shows; `append` adds one event to the in-memory buffer
// (no undo needed, it ages out of the gauge window); `open` opens a browser tab.
// No Turbella command needs a person's own judgment or consent, so none is
// person-only: every entry sets `personOnly: false` on purpose.
//
// scripts/verify.mjs checks parity: the CLI, the MCP tool list and the page's
// controls each match this list.

const none = { type: 'object', properties: {}, additionalProperties: false };

export const MANIFEST = Object.freeze([
  // ---- daemon ---------------------------------------------------------------
  {
    name: 'status', place: 'daemon', effect: 'read', personOnly: false,
    description: 'Daemon status: event count, counts by kind, turbulence gauge (0..1), socket path.',
    inputSchema: none,
  },
  {
    name: 'emit', place: 'daemon', effect: 'append', personOnly: false,
    description: 'Send one event to the daemon, e.g. to report "switching approach" or "stuck", which hooks cannot see. The payload is hashed, never stored.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Event kind: tool, tool_fail, think, permission, notification, subagent, stop, error.' },
        status: { type: 'string', description: 'ok, error, waiting or denied.' },
        tool: { type: 'string' },
        session: { type: 'string' },
        payload: { description: 'Hashed into the event signature; the text itself is dropped.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'replay', place: 'daemon', effect: 'read', personOnly: false,
    description: 'Read a Claude Code JSONL transcript and return its event counts and turbulence gauge. Returns counts only, never transcript text.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to a .jsonl transcript.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'open', place: 'daemon', effect: 'open', personOnly: false,
    description: 'Start the daemon if needed and open the visualiser in the default browser (it falls back to the timeline without WebGL 2). Returns the URL.',
    inputSchema: none,
  },

  // ---- page -----------------------------------------------------------------
  {
    name: 'play', place: 'page', effect: 'view', personOnly: false,
    description: 'Start playback of the loaded events.', inputSchema: none,
  },
  {
    name: 'pause', place: 'page', effect: 'view', personOnly: false,
    description: 'Pause playback; in live mode, also stop following the newest event.', inputSchema: none,
  },
  {
    name: 'set_speed', place: 'page', effect: 'view', personOnly: false,
    description: 'Set playback speed as transcript time per real time.',
    inputSchema: {
      type: 'object', properties: { speed: { type: 'number', enum: [0.25, 1, 2, 5, 10] } },
      required: ['speed'], additionalProperties: false,
    },
  },
  {
    name: 'seek', place: 'page', effect: 'view', personOnly: false,
    description: 'Move the playhead to a fraction of the session (0 = start, 1 = end).',
    inputSchema: {
      type: 'object', properties: { fraction: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['fraction'], additionalProperties: false,
    },
  },
  {
    name: 'load_events', place: 'page', effect: 'view', personOnly: false,
    description: 'Replace the shown events with a transcript: a neutral event array, or Claude Code JSONL text.',
    inputSchema: {
      type: 'object', properties: { events: { description: 'Event array or JSONL text.' } },
      required: ['events'], additionalProperties: false,
    },
  },
  {
    name: 'go_live', place: 'page', effect: 'view', personOnly: false,
    description: 'Follow the daemon live: show its events and keep the playhead on the newest. Pause, play or seek to stop following.',
    inputSchema: none,
  },

  // ---- visualiser ---------------------------------------------------------
  {
    name: 'next_look', place: 'viz', effect: 'view', personOnly: false,
    description: 'Blend the visualiser to another preset now, instead of waiting for the next turn.',
    inputSchema: none,
  },
]);

export const toolsFor = (place) => MANIFEST.filter((t) => t.place === place);
