// The sender every in-process adapter shares (opencode, pi, omp): turns one
// agent happening into one event and writes it to the daemon's socket,
// starting the daemon when none runs. Hashes are made here, in the agent's
// process; only names, ids, durations and hashes leave it (docs/PLUGINS.md).
//
// Never throws and never makes the agent wait: send() returns at once. Events
// go out one after another, so a tool's end never overtakes its start.

import { deliver } from '../src/socketWrite.js';
import { contentHash } from '../src/crypto.js';
import { hashToolInput, errorText } from '../src/event.js';

export function createSink(agent) {
  const run = process.env.TURBELLA_RUN ?? null;
  let queue = Promise.resolve();

  return {
    // kind/status/session/tool/dur_ms as in the event record; `args` is hashed
    // into sig and target, `error` (text) into sig. Neither is sent.
    send({ args, error, ...ev }) {
      const ts = Date.now();
      queue = queue.then(async () => {
        let hashes = {};
        if (error !== undefined) hashes = { sig: await contentHash(errorText(error)), target: null };
        else if (args !== undefined) hashes = await hashToolInput(args);
        await deliver({ agent, run, ts, ...ev, ...hashes });
      }).catch(() => {});
      return queue;
    },
  };
}
