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

// Cycle mode blends to another look every 30 s. ?cycle=1 starts it on; the
// choice is remembered per browser.
const CYCLE_MS = 30_000;
let cycleTimer = null;
function cycleLooks({ on } = {}) {
  const want = typeof on === 'boolean' ? on : !cycleTimer;
  clearInterval(cycleTimer);
  cycleTimer = want ? setInterval(() => nextLook(), CYCLE_MS) : null;
  $('btnCycle').setAttribute('aria-pressed', String(want));
  try { localStorage.setItem('turbella.cycle', want ? '1' : '0'); } catch {}
  return { cycling: want };
}

// Hide bar: the controls stay hidden until the pointer comes back over the
// page. Hiding with the pointer inside holds the bar hidden until the pointer
// leaves, so the click takes effect at once. The choice is remembered per
// browser, so every floating window shares it.
function setToolbar({ hidden } = {}) {
  const want = typeof hidden === 'boolean' ? hidden : !document.body.classList.contains('bar-hidden');
  document.body.classList.toggle('bar-hidden', want);
  const inside = document.body.classList.contains('pointer') || $('hud').matches(':hover');
  document.body.classList.toggle('bar-held', want && inside);
  $('btnBar').setAttribute('aria-pressed', String(want));
  $('btnBar').setAttribute('aria-label', want ? 'Show bar' : 'Hide bar');
  $('btnBar').title = want ? 'Keep this bar showing' : 'Hide this bar until the pointer comes back';
  try { localStorage.setItem('turbella.barHidden', want ? '1' : '0'); } catch {}
  return { hidden: want };
}

// The floating window calls this when the pointer enters or leaves it (a
// window without focus may not tell the page); the page's own events do the
// same in a browser.
window.turbellaPointer = (inside) => {
  if (!inside) document.body.classList.remove('bar-held');
  document.body.classList.toggle('pointer', inside);
};
document.addEventListener('mouseleave', () => window.turbellaPointer(false));

const TOOLS = { next_look: () => nextLook(), cycle_looks: cycleLooks, set_toolbar: setToolbar };
publishTools('viz', TOOLS);
$('btnNext').addEventListener('click', () => TOOLS.next_look());
$('btnCycle').addEventListener('click', () => TOOLS.cycle_looks());
$('btnBar').addEventListener('click', () => TOOLS.set_toolbar());

const params = new URLSearchParams(location.search);
if (params.has('overlay')) document.body.classList.add('overlay');
let savedCycle = null;
try { savedCycle = localStorage.getItem('turbella.cycle'); } catch {}
if (params.get('cycle') === '1' || (params.get('cycle') !== '0' && savedCycle === '1')) cycleLooks({ on: true });
let savedBar = null;
try { savedBar = localStorage.getItem('turbella.barHidden'); } catch {}
if (savedBar === '1') setToolbar({ hidden: true });

// ---- events --------------------------------------------------------------
const signal = createSignal();
const events = [];
const opened = Date.now();
const LABEL = { tool: 'ok', tool_fail: 'failed', permission: 'waiting for permission', think: 'thinking',
  subagent: 'subagent', stop: 'stopped', turn: 'new turn', notification: 'notification' };

// ?session=<id> shows one session only: its sound, its gauge, its status line.
const only = new URLSearchParams(location.search).get('session');

const live = new EventSource('/events');
live.onmessage = (m) => {
  let ev;
  try { ev = JSON.parse(m.data); } catch { return; }
  if (only && ev.session !== only) return;
  events.push(ev);
  if (events.length > 5000) events.splice(0, events.length - 5000);
  // The backlog on connect feeds the gauge only; fresh events also make sound.
  if ((ev.ts ?? 0) < opened - 2000) return;
  signal.hit(ev);
  if (ev.kind === 'turn') nextLook();
  const running = ev.kind === 'tool' && ev.status === 'waiting';
  status = { text: [ev.tool, running ? 'running' : LABEL[ev.kind] ?? ev.kind].filter(Boolean).join(' · '),
    since: Date.now() };
  showStatus();
};
live.onerror = () => { status = null; $('last').textContent = 'reconnecting to the daemon…'; };

// The bottom line says what the agent is on and for how long, so a quiet
// stretch (a long search, the model writing) still reads as work.
let status = null;
function showStatus() {
  if (!status) return;
  const s = Math.floor((Date.now() - status.since) / 1000);
  const busy = signal.running > 0 || signal.working;
  const tail = !busy || s < 2 ? '' : signal.running > 0 ? ` · ${s} s` : ` · working, ${s} s since`;
  $('last').textContent = status.text + tail;
}
setInterval(showStatus, 1000);

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

// While the agent is idle the preset runs at a third of real time, so the
// resting picture drifts; work brings it back to full speed within a second.
const IDLE_PACE = 0.3;
let pace = IDLE_PACE;
let lastFrame = performance.now();

nextLook(0);
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const target = signal.working || signal.running > 0 ? 1 : IDLE_PACE;
  pace += (target - pace) * (1 - Math.exp(-3 * dt));
  viz.render({ audioLevels: signal.frame(now), elapsedTime: dt * pace });
  requestAnimationFrame(frame);
}
frame();
