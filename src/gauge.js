// Turbulence gauge v1 — a 0..1 scalar saying how stuck an agent is.
//
// Built as a NakliOS-style projection (vendored conventions from
// sluice/vendor/naklios/history/{ledger,projection}.mjs): a fold over the
// neutral event record via `runUnit`, with an incremental `createProjector`
// that applies only the tail of new events — so the gauge can be recomputed
// live as the daemon streams events, without refolding the whole log.
//
// Inputs (workplan Batch A / tracelens five rule signals):
//   - repeated identical failures: same `sig` among tool_fail within the window
//   - edit thrash: many writes/edits on a single file
//   - tool-call diversity: repeating the same tool (low diversity = stuck)
//   - time since real progress: ms since the last non-failing event
//
// Output: 0 (smooth) .. 1 (stuck). Weights are a first guess; the workplan
// decides them against 20 hand-labelled stuck / not-stuck stretches.

export const WINDOW_MS = 5 * 60 * 1000;   // 5 min lookback
export const MAX_EVENTS = 200;            // cap the window
export const PROGRESS_CAP_MS = 60 * 1000; // idle > 1 min counts as stalled

// First-guess weights (sum to 1). Calibrate against labelled stretches.
export const WEIGHTS = Object.freeze({
  failRepeat: 0.4,
  editThrash: 0.2,
  lowDiversity: 0.2,
  idleSinceProgress: 0.2,
});

const isToolFail = (e) => e.kind === 'tool_fail';
const isWriteEdit = (e) =>
  e.tool && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(e.tool);
const isProgress = (e) => e.kind !== 'tool_fail' && e.kind !== 'error';

const clamp = (v) => Math.min(1, Math.max(0, v));

// ---- the unit (one fold over the whole event array) ----------------------

function apply(state, event, now) {
  // Out of window: does not concern this unit — same reference (zero work).
  if (event.ts == null || event.ts < now - WINDOW_MS) return state;

  let dirty = false;

  // Repeated identical failures: track sig counts among tool_fail.
  if (isToolFail(event) && event.sig) {
    state.__failSigs = state.__failSigs || {};
    state.__failSigs[event.sig] = (state.__failSigs[event.sig] || 0) + 1;
    state.__nFail = (state.__nFail || 0) + 1;
    dirty = true;
  }

  // Edit thrash: count write/edit calls (file path is privacy-withheld, so use
  // tool frequency as a coarse thrash proxy).
  if (isWriteEdit(event) && event.tool) {
    state.__edits = (state.__edits || 0) + 1;
    state.__nEditTool = (state.__nEditTool || 0) + 1;
    dirty = true;
  }

  // Tool-call diversity.
  if (event.kind === 'tool' && event.tool) {
    state.__tools = state.__tools || {};
    state.__tools[event.tool] = (state.__tools[event.tool] || 0) + 1;
    state.__nTool = (state.__nTool || 0) + 1;
    dirty = true;
  }

  // Time since real progress.
  if (isProgress(event) && event.ts != null) {
    state.__lastProgress = event.ts;
    dirty = true;
  }

  // NakliOS contract: return a NEW state reference when the event concerned the
  // unit (that is what the `changed` signal reports); same reference otherwise.
  // Internal collections (__failSigs, __tools) are mutated in place — shared
  // structure across copies is intentional.
  return dirty ? { ...state } : state;
}

const value = (state) => {
  const now = state.__now ?? Date.now();

  // 1. repeated identical failures
  let failRepeat = 0;
  if (state.__nFail && state.__failSigs) {
    let repeated = 0;
    for (const n of Object.values(state.__failSigs)) if (n >= 2) repeated += n;
    failRepeat = repeated / state.__nFail;
  }

  // 2. edit thrash (coarse: edit-heavy stream)
  const editThrash = state.__nEditTool && state.__nTool
    ? Math.min(1, state.__nEditTool / Math.max(1, state.__nTool))
    : 0;

  // 3. low tool-call diversity
  let lowDiversity = 0;
  if (state.__nTool) {
    const unique = Object.keys(state.__tools).length;
    lowDiversity = 1 - unique / state.__nTool;
  }

  // 4. idle since progress
  let idleSinceProgress = 0;
  if (state.__lastProgress != null) {
    idleSinceProgress = (now - state.__lastProgress) / PROGRESS_CAP_MS;
  }

  const g =
    WEIGHTS.failRepeat * failRepeat +
    WEIGHTS.editThrash * editThrash +
    WEIGHTS.lowDiversity * lowDiversity +
    WEIGHTS.idleSinceProgress * clamp(idleSinceProgress);
  return clamp(g);
};

// ---- public API ----------------------------------------------------------

// One-shot gauge over an event array (a fold = runUnit).
export function gaugeSnapshot(events, opts = {}) {
  const now = opts.now != null ? opts.now : lastEventTs(events);
  const unit = {
    init: () => ({ __now: now }),
    apply: (s, e) => apply(s, e, now),
    value,
  };
  return runUnit(unit, events);
}

// Incremental projector for the live daemon (applies only the tail).
export function createGauge(opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const unit = {
    init: () => ({ __now: now }),
    apply: (s, e) => apply(s, e, now),
    value,
  };
  return createProjector(unit);
}

function lastEventTs(events) {
  let t = null;
  for (const e of events) if (e.ts != null && e.ts > t) t = e.ts;
  return t;
}

// ---- NakliOS projection primitives (mirror sluice/vendor/naklios/history/projection.mjs) ----

const identity = (s) => s;
export function runUnit(unit, events) {
  let state = unit.init();
  for (const e of events) state = unit.apply(state, e);
  return (unit.value || identity)(state);
}

export function createProjector(unit) {
  const value = unit.value || identity;
  let state = unit.init();
  let consumed = 0;
  let last = null;
  const reset = () => { state = unit.init(); consumed = 0; last = null; };
  const extendsConsumed = (events) => {
    if (events.length < consumed) return false;
    if (consumed === 0) return true;
    return Object.is(events[consumed - 1], last);
  };
  return {
    version: unit.version ?? 1,
    get consumed() { return consumed; },
    reset,
    advance(events) {
      let rebuilt = false;
      if (!extendsConsumed(events)) { reset(); rebuilt = true; }
      let changed = rebuilt;
      for (let i = consumed; i < events.length; i++) {
        const next = unit.apply(state, events[i]);
        if (!Object.is(next, state)) { state = next; changed = true; }
        last = events[i];
      }
      consumed = events.length;
      return { value: value(state), changed, consumed, rebuilt };
    },
  };
}

