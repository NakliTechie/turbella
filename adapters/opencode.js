// opencode plugin: opencode's event bus to Turbella events. Installed by
// `turbella install opencode` as a one-line file in ~/.config/opencode/plugin/
// that re-exports this module.
//
//   chat.message                      turn
//   tool part running                 tool, waiting (once per call)
//   tool part completed               tool, or tool_fail when a shell exits non-zero
//   tool part error                   tool_fail (its error text is hashed)
//   reasoning part ended              think, with its duration
//   permission.updated / .replied     permission waiting / denied
//   session.idle                      stop

import { createSink } from './sink.js';

export const TurbellaPlugin = async () => {
  const sink = createSink('opencode');
  const started = new Set(); // call ids already reported as running
  const ended = new Set();   // call and part ids already reported as ended
  const remember = (set, id) => { set.add(id); if (set.size > 2000) set.delete(set.values().next().value); };

  function onPart(part) {
    const session = part.sessionID;
    if (part.type === 'reasoning' && part.time?.end && !ended.has(part.id)) {
      remember(ended, part.id);
      sink.send({ kind: 'think', session, dur_ms: part.time.end - part.time.start });
      return;
    }
    if (part.type !== 'tool') return;
    const st = part.state ?? {};
    const base = { session, tool: part.tool };
    if (st.status === 'running' && !started.has(part.callID)) {
      remember(started, part.callID);
      sink.send({ ...base, kind: 'tool', status: 'waiting', args: st.input });
    } else if ((st.status === 'completed' || st.status === 'error') && !ended.has(part.callID)) {
      remember(ended, part.callID);
      const dur_ms = st.time?.end && st.time?.start ? st.time.end - st.time.start : null;
      const exit = st.metadata?.exit;
      if (st.status === 'error') sink.send({ ...base, kind: 'tool_fail', status: 'error', dur_ms, error: st.error });
      else if (typeof exit === 'number' && exit !== 0) sink.send({ ...base, kind: 'tool_fail', status: 'error', dur_ms, error: `exit ${exit}` });
      else sink.send({ ...base, kind: 'tool', status: 'ok', dur_ms, args: st.input });
    }
  }

  return {
    'chat.message': async (input) => { sink.send({ kind: 'turn', session: input.sessionID }); },
    event: async ({ event }) => {
      const p = event?.properties ?? {};
      switch (event?.type) {
        case 'message.part.updated': if (p.part) onPart(p.part); break;
        case 'permission.updated': sink.send({ kind: 'permission', status: 'waiting', session: p.sessionID, tool: p.type ?? null }); break;
        case 'permission.replied':
          if (p.response === 'reject') sink.send({ kind: 'permission', status: 'denied', session: p.sessionID });
          break;
        case 'session.idle': sink.send({ kind: 'stop', session: p.sessionID }); break;
        case 'session.error': sink.send({ kind: 'error', status: 'error', session: p.sessionID ?? null }); break;
      }
    },
  };
};
