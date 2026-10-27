// Extension for pi and omp (oh-my-pi), which share one extension API. Installed
// by `turbella install pi` or `turbella install omp` as a one-line file in the
// agent's extensions folder that re-exports this module.
//
//   agent_start              turn (once per prompt; `input` does not fire in print mode)
//   tool_execution_start     tool, waiting
//   tool_execution_end       tool, or tool_fail when isError (duration measured here)
//   agent_end                stop

import { createSink } from './sink.js';

export function turbellaExtension(agent) {
  return function (pi) {
    const sink = createSink(agent);
    const starts = new Map(); // toolCallId -> { t0, args }; the end event has no args
    const sessionOf = (ctx) => { try { return ctx?.sessionManager?.getSessionId?.() ?? null; } catch { return null; } };

    pi.on('agent_start', async (_event, ctx) => { sink.send({ kind: 'turn', session: sessionOf(ctx) }); });
    pi.on('tool_execution_start', async (event, ctx) => {
      starts.set(event.toolCallId, { t0: Date.now(), args: event.args });
      if (starts.size > 2000) starts.delete(starts.keys().next().value);
      sink.send({ kind: 'tool', status: 'waiting', session: sessionOf(ctx), tool: event.toolName, args: event.args });
    });
    pi.on('tool_execution_end', async (event, ctx) => {
      const start = starts.get(event.toolCallId);
      starts.delete(event.toolCallId);
      const base = { session: sessionOf(ctx), tool: event.toolName, dur_ms: start ? Date.now() - start.t0 : null };
      // The result is hashed for a failure's signature, never sent.
      if (event.isError) sink.send({ ...base, kind: 'tool_fail', status: 'error', error: event.result?.content ?? event.result });
      else sink.send({ ...base, kind: 'tool', status: 'ok', args: start?.args });
    });
    // Wait for the queue here: in print mode the agent exits right after this.
    pi.on('agent_end', async (_event, ctx) => { await sink.send({ kind: 'stop', session: sessionOf(ctx) }); });
    pi.on('session_shutdown', async () => { await sink.send({ kind: 'notification' }).catch(() => {}); });
  };
}

export default turbellaExtension('pi');
