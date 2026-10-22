// Turbulence gauge: one number from 0 (smooth) to 1 (stuck), from the events
// of the last few minutes.
//
// Signals:
//   failRepeat   share of recent failures that repeat an earlier failure's hash
//   editThrash   the most edits to one file (by path hash) beyond the second
//   lowDiversity the same tool called over and over in the recent calls
//   idle         time since the last successful tool call, over one minute;
//                measured against all events, so a long silence never resets it
//
// A tool-start event (status `waiting`) is not a call yet and counts nowhere.
// Weights are a first guess, to be calibrated against labelled sessions.

export const WINDOW_MS = 5 * 60 * 1000;
export const PROGRESS_CAP_MS = 60 * 1000;
const DIVERSITY_CALLS = 10;

export const WEIGHTS = Object.freeze({
  failRepeat: 0.4,
  editThrash: 0.2,
  lowDiversity: 0.2,
  idle: 0.2,
});

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const clamp = (v) => Math.min(1, Math.max(0, v));

export function gaugeSnapshot(events, opts = {}) {
  let now = opts.now;
  if (now == null) for (const e of events) if (e.ts != null && (now == null || e.ts > now)) now = e.ts;
  if (now == null) return 0;

  const failCounts = new Map();
  const editCounts = new Map();
  let nFail = 0;
  let lastProgress = null;
  const recentTools = [];

  for (const e of events) {
    if (e.ts == null || e.status === 'waiting') continue;
    if (e.kind === 'tool' && e.status === 'ok' && (lastProgress == null || e.ts > lastProgress)) lastProgress = e.ts;
    if (e.ts < now - WINDOW_MS || e.ts > now) continue;
    if (e.kind === 'tool_fail') {
      nFail++;
      if (e.sig) failCounts.set(e.sig, (failCounts.get(e.sig) || 0) + 1);
    }
    if (e.kind === 'tool' && e.tool) {
      recentTools.push(e.tool);
      if (EDIT_TOOLS.test(e.tool) && e.target) editCounts.set(e.target, (editCounts.get(e.target) || 0) + 1);
    }
  }

  let repeated = 0;
  for (const n of failCounts.values()) if (n >= 2) repeated += n;
  const failRepeat = nFail ? repeated / nFail : 0;

  const maxEdits = Math.max(0, ...editCounts.values());
  const editThrash = clamp((maxEdits - 2) / 4);

  const last = recentTools.slice(-DIVERSITY_CALLS);
  const lowDiversity = last.length >= 3 ? 1 - new Set(last).size / last.length : 0;

  const idle = lastProgress == null ? 0 : clamp((now - lastProgress) / PROGRESS_CAP_MS);

  return clamp(
    WEIGHTS.failRepeat * failRepeat +
    WEIGHTS.editThrash * editThrash +
    WEIGHTS.lowDiversity * lowDiversity +
    WEIGHTS.idle * idle,
  );
}
