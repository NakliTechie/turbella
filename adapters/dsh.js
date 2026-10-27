// dsh (DeepSeek Harness) plugin: the session log's events to Turbella events.
// A Cordis plugin; `turbella install dsh` writes a small bundle package that
// re-exports this module and adds it to a dsh profile.
//
//   turn/start                       turn
//   tool/call                        tool, waiting (arguments hashed, never sent)
//   tool/result                      tool, or tool_fail when isError or a shell
//                                    reports "[exit code: N]" with N not 0
//   turn/end                         stop
//
// `session/event` fires after each append to the session log, so observing it
// never delays the agent.

import { createSink } from './sink.js';

export const name = 'turbella';

export function apply(ctx) {
  const sink = createSink('dsh');
  const calls = new Map(); // callId -> { name, time, args }
  const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session?.id ?? '');
    const d = event?.data ?? {};
    switch (event?.type) {
      case 'turn/start':
        sink.send({ kind: 'turn', session: sessionId });
        break;
      case 'tool/call': {
        const args = parse(d.arguments);
        calls.set(d.callId, { name: d.name, time: event.time, args });
        if (calls.size > 2000) calls.delete(calls.keys().next().value);
        sink.send({ kind: 'tool', status: 'waiting', session: sessionId, tool: d.name, args });
        break;
      }
      case 'tool/result': {
        const msg = d.message ?? {};
        const id = msg.toolCallId ?? msg.callId ?? msg.tool_call_id;
        const call = calls.get(id);
        calls.delete(id);
        const base = { session: sessionId, tool: call?.name ?? null, dur_ms: call ? event.time - call.time : null };
        // The result and the error reason are hashed for a failure's signature, never sent.
        // dsh's bash tool marks a non-zero exit only in the result text.
        const text = Array.isArray(msg.content) ? msg.content.map((b) => b?.text ?? '').join('\n') : String(msg.content ?? '');
        const exit = Number(text.match(/\[exit code: (-?\d+)\]/)?.[1] ?? 0);
        if (msg.isError) sink.send({ ...base, kind: 'tool_fail', status: 'error', error: d.error?.reason ?? d.error?.code ?? msg.content });
        else if (exit !== 0) sink.send({ ...base, kind: 'tool_fail', status: 'error', error: text });
        else sink.send({ ...base, kind: 'tool', status: 'ok', args: call?.args });
        break;
      }
      case 'turn/end':
        sink.send({ kind: 'stop', session: sessionId });
        break;
    }
  });
}
