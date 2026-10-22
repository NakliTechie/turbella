// Events from the daemon become a waveform (src/signal.js); the waveform
// drives a MilkDrop preset (Butterchurn). Each new turn blends to another
// preset. Nothing is played aloud.
import { createSignal } from './signal.js';
import { gaugeSnapshot } from './gauge.js';
import { publishTools } from './agentface.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const engine = window.butterchurn.default ?? window.butterchurn;
const pack = window.butterchurnPresets.default ?? window.butterchurnPresets;
const presets = pack.getPresets();
const names = Object.keys(presets);

const viz = engine.createVisualizer(null, canvas, { width: 1, height: 1, pixelRatio: devicePixelRatio || 1 });
function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  viz.setRendererSize(canvas.width, canvas.height);
}
addEventListener('resize', resize);
resize();

let order = [];
function nextLook(blendSeconds = 2.7) {
  if (!order.length) order = [...names].sort(() => Math.random() - 0.5);
  const name = order.pop();
  viz.loadPreset(presets[name], blendSeconds);
  $('preset').textContent = name;
  return { preset: name };
}

const TOOLS = { next_look: () => nextLook() };
publishTools('viz', TOOLS);
$('btnNext').addEventListener('click', () => TOOLS.next_look());

// ---- events --------------------------------------------------------------
const signal = createSignal();
const events = [];
const opened = Date.now();
const LABEL = { tool: 'ok', tool_fail: 'failed', permission: 'waiting for permission', think: 'thinking',
  subagent: 'subagent', stop: 'stopped', turn: 'new turn', notification: 'notification' };

const live = new EventSource('/events');
live.onmessage = (m) => {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  events.push(ev);
  if (events.length > 5000) events.splice(0, events.length - 5000);
  // The backlog on connect feeds the gauge only; fresh events also make sound.
  if ((ev.ts ?? 0) < opened - 2000) return;
  signal.hit(ev);
  if (ev.kind === 'turn') nextLook();
  if (ev.status !== 'waiting' || ev.kind === 'permission') {
    $('last').textContent = [ev.tool, LABEL[ev.kind] ?? ev.kind].filter(Boolean).join(' · ');
  }
};
live.onerror = () => { $('last').textContent = 'reconnecting to the daemon…'; };

function updateGauge() {
  const g = gaugeSnapshot(events, { now: Date.now() });
  signal.setTurbulence(g);
  $('gaugeValue').textContent = g.toFixed(2);
  $('gaugeFill').style.width = `${Math.round(g * 100)}%`;
  $('gaugeFill').style.background = g >= 0.5 ? 'var(--bad)' : g >= 0.25 ? 'var(--warn)' : 'var(--accent)';
}
setInterval(updateGauge, 1000);

// The controls fade after a few seconds without the pointer.
let idle;
addEventListener('pointermove', () => {
  $('hud').classList.remove('quiet');
  clearTimeout(idle);
  idle = setTimeout(() => $('hud').classList.add('quiet'), 4000);
});
idle = setTimeout(() => $('hud').classList.add('quiet'), 4000);

nextLook(0);
function frame() {
  viz.render({ audioLevels: signal.frame(performance.now()) });
  requestAnimationFrame(frame);
}
frame();
