// Canvas renderer for the Turbella replay page. Browser-only (DOM + Canvas).
//
// Draws one horizontal lane per agent. X axis is time. As the playhead moves,
// events "arrive" and are painted as marks:
//
//   - tool        : small tick, hue by tool kind (Bash / Write / Read / …)
//   - tool_fail   : red spike  (failure)
//   - permission  : amber tick (permission wait)
//   - think       : soft violet pulse whose radius grows with thinking time
//   - stop / notification / subagent : small distinct marks
//
// A loop glyph (curved arrow) appears above a lane when the same `sig`
// repeats within the recent window — the "stuck on repeat" signal.

import { createPlayer } from './playback.js';

// ---- palette (honest visuals; nothing decorative beyond the signal) ---------

const TOOL_COLOR = {
  Bash: '#2563eb',      // blue
  Write: '#16a34a',     // green
  Read: '#7c3aed',      // violet
  Edit: '#ca8a04',      // yellow
  MultiEdit: '#ca8a04',
  NotebookEdit: '#ca8a04',
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

function hueForTool(tool) {
  // Stable hue per tool name so the same tool looks the same everywhere.
  let h = 0;
  for (let i = 0; i < (tool || '').length; i++) h = (h * 31 + (tool || '').charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
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

function formatMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const lanePad = opts.lanePad ?? 24;
  const topPad = opts.topPad ?? 40;
  const bottomPad = opts.bottomPad ?? 34;
  const sidePad = opts.sidePad ?? 60;

  let agents = [];
  let eventsSoFar = [];
  let playhead = 0;
  let tMin = 0;
  let tMax = 1;
  let width = canvas.width;
  let height = canvas.height;

  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;
  }

  function feed({ eventsSoFar: es, time }, allEvents) {
    eventsSoFar = es;
    playhead = time;
    const seen = [];
    const set = new Set();
    for (const e of allEvents) {
      if (e.agent && !set.has(e.agent)) { set.add(e.agent); seen.push(e.agent); }
    }
    agents = seen;
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
    if (i === -1) return height / 2;
    const n = Math.max(agents.length, 1);
    const laneH = (height - topPad - bottomPad) / n;
    return topPad + i * laneH + laneH / 2;
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
      ctx.fillText(Math.round((tx - sidePad) / (width - 2 * sidePad) * 100) + '%', tx, topPad - 8);
    }

    // agent lane labels (left) + separators
    ctx.textAlign = 'right';
    for (let i = 0; i < agents.length; i++) {
      const n = agents.length;
      const laneH = (height - topPad - bottomPad) / n;
      const cy = topPad + i * laneH + laneH / 2;
      ctx.fillStyle = '#475569';
      ctx.fillText(agents[i], laneLabelX(), cy + 4);
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(sidePad, topPad + i * laneH);
      ctx.lineTo(width - sidePad, topPad + i * laneH);
      ctx.stroke();
    }

    // draw arrived events
    const now = performance.now();
    for (const e of eventsSoFar) {
      const cx = xFor(e.ts);
      const cy = laneY(e.agent);
      const c = colorFor(e);

      if (e.kind === 'tool_fail') {
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
        // soft pulse: radius grows with thinking time, fades with age
        const dur = e.dur_ms ?? 400;
        const age = now - e.ts;
        const phase = (age % 1200) / 1200;
        const r = 6 + (dur / 200) * (1 + Math.sin(phase * Math.PI)) * 1.5;
        const alpha = Math.max(0, 1 - age / 3000);
        ctx.fillStyle = c;
        ctx.globalAlpha = alpha * 0.45;
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
        // tool tick — hue by tool kind
        ctx.fillStyle = hueForTool(e.tool);
        ctx.fillRect(cx - 2, cy - 6, 4, 12);
      }
    }

    // playhead line
    const px = xFor(playhead);
    ctx.strokeStyle = '#111827';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(px, topPad);
    ctx.lineTo(px, height - bottomPad);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#111827';
    ctx.fillRect(px - 2, height - bottomPad + 2, 4, 6);

    // time readout
    ctx.fillStyle = '#111827';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(formatMs(playhead - tMin) + ' / ' + formatMs(tMax - tMin), sidePad, height - 8);
  }

  return { resize, feed, draw };
}

export { colorFor, KIND };

