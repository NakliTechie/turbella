// Canvas renderer for the Turbella replay page. Browser-only (DOM + Canvas).
//
// Draws one horizontal lane per agent and session. X axis is time. As the playhead moves,
// events "arrive" and are painted as marks:
//
//   - tool        : small tick, hue by tool kind (Bash / Write / Read / …)
//   - tool_fail   : red spike  (failure)
//   - permission  : amber tick (permission wait)
//   - think       : violet dot whose size grows with thinking time
//   - stop / notification / subagent : small distinct marks
//
// A loop glyph marks a failure whose `sig` already failed in the last minute.

// ---- palette (honest visuals; nothing decorative beyond the signal) ---------

const TOOL_COLOR = {
  Bash: '#2563eb',      // blue
  Write: '#16a34a',     // green
  Read: '#7c3aed',      // violet
  Edit: '#ca8a04',      // yellow
  MultiEdit: '#ca8a04',
  NotebookEdit: '#ca8a04',
  apply_patch: '#ca8a04',
  Glob: '#0891b2',      // cyan
  Grep: '#0891b2',
  Task: '#be185d',      // pink
  mcp__: '#6366f1',     // indigo (any MCP tool)
};

const KIND = {
  TOOL: '#64748b',       // slate
  TOOL_FAIL: '#ef4444',  // red spike
  PERMISSION: '#f59e0b', // amber
  THINK: '#8b5cf6',      // violet pulse
  STOP: '#475569',
  NOTIFICATION: '#06b6d4',
  SUBAGENT: '#84cc16',
};

function colorFor(event) {
  if (event.kind === 'tool_fail') return KIND.TOOL_FAIL;
  if (event.kind === 'tool') {
    const t = event.tool || '';
    if (t.startsWith('mcp__')) return TOOL_COLOR.mcp__;
    return TOOL_COLOR[t] ?? KIND.TOOL;
  }
  if (event.kind === 'permission') return KIND.PERMISSION;
  if (event.kind === 'think') return KIND.THINK;
  if (event.kind === 'stop') return KIND.STOP;
  if (event.kind === 'notification') return KIND.NOTIFICATION;
  if (event.kind === 'subagent') return KIND.SUBAGENT;
  return '#94a3b8';
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

function formatSpan(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const lanePad = opts.lanePad ?? 24;
  const topPad = opts.topPad ?? 40;
  const bottomPad = opts.bottomPad ?? 34;
  const sidePad = opts.sidePad ?? 110;

  let agents = [];
  let eventsSoFar = [];
  let playhead = 0;
  let tMin = 0;
  let tMax = 1;
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

  // Lanes are at most MAX_LANE tall and the block sits centred, so one agent
  // reads as one band instead of a page of empty space.
  const MAX_LANE = opts.maxLane ?? 120;
  function lanes() {
    const avail = height - topPad - bottomPad;
    const n = Math.max(agents.length, 1);
    const laneH = Math.min(avail / n, MAX_LANE);
    return { laneH, y0: topPad + (avail - laneH * n) / 2, n };
  }

  function feed({ eventsSoFar: es, time }, allEvents) {
    eventsSoFar = es;
    playhead = time;
    agents = [...new Set(allEvents.map(laneOf))];
    const ts = allEvents.map((e) => e.ts).filter((t) => t != null);
    tMin = ts.length ? Math.min(...ts) : 0;
    tMax = ts.length ? Math.max(...ts) : tMin + 1;
    if (tMax === tMin) tMax = tMin + 1;
  }

  function xFor(ts) {
    return sidePad + ((ts - tMin) / (tMax - tMin)) * (width - 2 * sidePad);
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
    if (agents.length === 0) return;

    // time axis ticks (top)
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const tickCount = 5;
    for (let i = 0; i <= tickCount; i++) {
      const tx = xFor(tMin + (i / tickCount) * (tMax - tMin));
      ctx.fillText(formatSpan((i / tickCount) * (tMax - tMin)), tx, topPad - 8);
    }

    // agent lane labels (left) + separators
    ctx.textAlign = 'right';
    const { laneH, y0, n } = lanes();
    for (let i = 0; i <= n; i++) {
      ctx.strokeStyle = '#e5e5e2';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sidePad, y0 + i * laneH);
      ctx.lineTo(width - sidePad, y0 + i * laneH);
      ctx.stroke();
      if (i < agents.length) {
        ctx.fillStyle = '#6b6b66';
        ctx.fillText(agents[i], laneLabelX(), y0 + i * laneH + laneH / 2 + 4);
      }
    }

    // draw arrived events
    for (const e of eventsSoFar) {
      const cx = xFor(e.ts);
      const cy = laneY(laneOf(e));
      const c = colorFor(e);

      if (e.kind === 'turn') {
        // a new prompt: a thin divider across the lane
        ctx.strokeStyle = '#c7c7c2';
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
    ctx.strokeStyle = '#1c1c1a';
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


