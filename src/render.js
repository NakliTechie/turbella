// Canvas renderer for the Turbella replay page. Browser-only (DOM + Canvas).
//
// Draws one horizontal lane per agent and session. X axis is time. As the playhead moves,
// events "arrive" and are painted as marks:
//
//   - tool        : small tick, dark for edits and writes, grey for other tools
//   - tool_fail   : red spike  (failure)
//   - permission  : amber tick (permission wait)
//   - think       : violet dot whose size grows with thinking time
//   - stop / notification / subagent : small distinct marks
//
// A loop glyph marks a failure whose `sig` already failed in the last minute.

// ---- palette (honest visuals; nothing decorative beyond the signal) ---------
// Colour is kept for states only (failure, permission wait, thinking); tools
// are told apart by ink weight. Values come from the page's tokens.

const WRITE_TOOLS = /^(write|edit|multiedit|notebookedit|apply_patch|patch)$/i;

function colorFor(event, p) {
  switch (event.kind) {
    case 'tool_fail': return p.bad;
    case 'tool': return WRITE_TOOLS.test(event.tool || '') ? p.ink : p.muted;
    case 'permission': return p.warn;
    case 'think': return p.think;
    case 'stop': return p.ink;
    default: return p.muted;
  }
}

// Returns true if this event's `sig` has appeared at least twice among the
// arrived events within `windowMs` — a stuck-on-repeat signal.
function loopSig(eventsSoFar, event, windowMs = 60 * 1000) {
  if (!event.sig || event.kind !== 'tool_fail') return false;
  let n = 0;
  const cut = event.ts - windowMs;
  for (const e of eventsSoFar) {
    if (e.sig === event.sig && e.kind === 'tool_fail' && e.ts >= cut) n++;
  }
  return n >= 2;
}

// Lane key: the agent, plus the session when there is one, so two concurrent
// sessions of one agent draw on two lanes.
function laneOf(e) {
  return e.session ? `${e.agent} ${String(e.session).slice(0, 6)}` : (e.agent ?? '?');
}

function formatSpan(ms, step = 1000) {
  if (step < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Axis ticks at a round step (0.5, 1, 2, 5, 10, 15, 30 s, then minutes), about
// five across the span, so each label sits where its time is.
const STEPS = [500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
export function axisStep(spanMs) {
  return STEPS.find((s) => spanMs / s <= 6) ?? STEPS[STEPS.length - 1];
}

export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const lanePad = opts.lanePad ?? 24;
  const topPad = opts.topPad ?? 40;
  const bottomPad = opts.bottomPad ?? 34;
  const sidePad = opts.sidePad ?? 110;
  const emptyText = opts.emptyText ?? 'No agent events yet.';
  // Colours come from the page's tokens, so the canvas and the CSS stay one system.
  const token = (name, fallback) => getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;

  let agents = [];
  let eventsSoFar = [];
  let playhead = 0;
  let tMin = 0;
  let tMax = 1;
  let lastTs = null; // the newest event; past it, while live, is silence
  let width = canvas.width;
  let height = canvas.height;

  // Draw in CSS pixels on a backing store scaled to the screen, so text and
  // marks stay sharp on high-density displays.
  function resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Lanes are at most MAX_LANE tall and start under the axis, so one agent
  // reads as one band next to its time scale.
  const MAX_LANE = opts.maxLane ?? 120;
  function lanes() {
    const avail = height - topPad - bottomPad;
    const n = Math.max(agents.length, 1);
    const laneH = Math.min(avail / n, MAX_LANE);
    return { laneH, y0: topPad, n };
  }

  // `now`, while following live, extends the axis to the present, so a silent
  // wait shows as growing empty time instead of a frozen picture.
  function feed({ eventsSoFar: es, time }, allEvents, { now } = {}) {
    eventsSoFar = es;
    playhead = now ?? time;
    agents = [...new Set(allEvents.map(laneOf))];
    const ts = allEvents.map((e) => e.ts).filter((t) => t != null);
    tMin = ts.length ? Math.min(...ts) : 0;
    lastTs = ts.length ? Math.max(...ts) : null;
    tMax = Math.max(lastTs ?? tMin + 1, now ?? 0);
    if (tMax === tMin) tMax = tMin + 1;
  }

  // On a phone the right margin shrinks; the left keeps room for lane labels.
  const rightPad = () => (width < 600 ? 16 : sidePad);
  function xFor(ts) {
    return sidePad + ((ts - tMin) / (tMax - tMin)) * (width - sidePad - rightPad());
  }

  function laneY(agent) {
    const i = agents.indexOf(agent);
    const { laneH, y0 } = lanes();
    if (i === -1) return height / 2;
    return y0 + i * laneH + laneH / 2;
  }

  function laneLabelX() { return sidePad - 10; }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    const muted = token('--muted', '#6b6b66');
    const line = token('--line', '#e5e5e2');
    const ink = token('--ink', '#1c1c1a');
    const palette = { ink, muted, bad: token('--bad', '#dc2626'), warn: token('--warn', '#d97706'), think: token('--think', '#8b5cf6') };
    ctx.font = '11px system-ui, sans-serif';
    if (agents.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emptyText, width / 2, height / 2);
      return;
    }

    // time axis ticks (top), at a round step
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    const step = axisStep(tMax - tMin);
    for (let t = 0; t <= tMax - tMin + 1; t += step) {
      ctx.fillText(formatSpan(t, step), xFor(tMin + t), topPad - 8);
    }

    // agent lane labels (left) + separators
    ctx.textAlign = 'right';
    const { laneH, y0, n } = lanes();
    // silence since the newest event, while following live
    if (lastTs != null && playhead > lastTs) {
      ctx.fillStyle = line;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(xFor(lastTs), y0, xFor(playhead) - xFor(lastTs), n * laneH);
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i <= n; i++) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sidePad, y0 + i * laneH);
      ctx.lineTo(width - rightPad(), y0 + i * laneH);
      ctx.stroke();
      if (i < agents.length) {
        ctx.fillStyle = muted;
        ctx.fillText(agents[i], laneLabelX(), y0 + i * laneH + laneH / 2 + 4);
      }
    }

    // draw arrived events
    for (const e of eventsSoFar) {
      const cx = xFor(e.ts);
      const cy = laneY(laneOf(e));
      const c = colorFor(e, palette);

      if (e.kind === 'turn') {
        // a new prompt: a thin divider across the lane
        ctx.strokeStyle = muted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 30);
        ctx.lineTo(cx, cy + 30);
        ctx.stroke();
      } else if (e.kind === 'tool_fail') {
        // red spike
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 14);
        ctx.lineTo(cx + 3, cy - 14);
        ctx.lineTo(cx, cy + 14);
        ctx.closePath();
        ctx.fill();
        // loop glyph above if stuck on repeat
        if (loopSig(eventsSoFar, e)) {
          ctx.strokeStyle = c;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy - 26, 8, 0, Math.PI);
          ctx.moveTo(cx - 4, cy - 30);
          ctx.lineTo(cx + 4, cy - 30);
          ctx.stroke();
        }
      } else if (e.kind === 'think') {
        // radius grows with thinking time, capped at 20 s
        const r = 4 + Math.min(e.dur_ms ?? 0, 20_000) / 20_000 * 14;
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'permission') {
        ctx.fillStyle = c;
        ctx.fillRect(cx - 4, cy - 5, 8, 10);
      } else if (e.kind === 'stop') {
        ctx.fillStyle = c;
        ctx.fillRect(cx - 3, cy - 3, 6, 6);
      } else if (e.kind === 'notification') {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
        ctx.fill();
      } else if (e.kind === 'subagent') {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx - 4, cy + 4);
        ctx.lineTo(cx + 4, cy + 4);
        ctx.closePath();
        ctx.fill();
      } else {
        // tool tick, coloured by tool; a call still running is drawn faint
        ctx.fillStyle = c;
        ctx.globalAlpha = e.status === 'waiting' ? 0.3 : 1;
        ctx.fillRect(cx - 2, cy - 8, 4, 16);
        ctx.globalAlpha = 1;
      }
    }

    // playhead line, across the lanes only
    const px = xFor(playhead);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, y0 - 8);
    ctx.lineTo(px, y0 + n * laneH + 8);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  return { resize, feed, draw };
}


