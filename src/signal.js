// Turns agent events into a waveform the visualiser reads as music. No sound
// is played: the samples go straight to the renderer each frame.
//
//   tool call      a short pluck, pitched by tool name (a tool start is a faint click)
//   failure        a bass hit plus a burst of noise
//   permission     a held tone that fades slowly
//   thinking       a slow low swell, larger for longer thinking
//   subagent       a high chirp
//   new turn       a deep drop
//   stop           everything fades fast
//   turbulence     a noise floor and a wobble that grow with the gauge
//
// Between hooks the agent is still busy, so three sounds hold the gaps:
//
//   tool running   a steady tone from a tool's start to its end (2 minutes at most)
//   turn open      a low working tone from a prompt until the session stops
//   idle           a faint slow breath, so the picture never goes flat
//                  (the page also slows the preset's clock while idle)
//
// frame() returns 1,024 unsigned samples per channel centred on 128, the shape
// a browser analyser produces, so the renderer cannot tell it from audio.

export const SAMPLES = 1024;

const TAU = Math.PI * 2;
const hash = (s) => { let h = 7; for (const c of String(s ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

// amp in sample units (0–127), freq in cycles per frame window, decay per second
function voiceFor(e) {
  const pan = ((hash(e.tool ?? e.kind) % 100) / 100) * 2 - 1;
  switch (e.kind) {
    case 'tool':
      return e.status === 'waiting'
        ? { amp: 18, freq: 24 + (hash(e.tool) % 24), decay: 12, noise: 0, pan }
        : { amp: 55, freq: 6 + (hash(e.tool) % 30), decay: 6, noise: 0, pan };
    case 'tool_fail': return { amp: 110, freq: 2, decay: 2.5, noise: 45, pan: 0 };
    case 'permission': return { amp: 40, freq: 12, decay: 0.4, noise: 0, pan };
    case 'think': return { amp: Math.min(90, 20 + 12 * Math.log1p((e.dur_ms ?? 0) / 1000)), freq: 1.5, decay: 0.35, noise: 0, pan: 0 };
    case 'subagent': return { amp: 45, freq: 60, decay: 5, noise: 0, pan };
    case 'turn': return { amp: 120, freq: 1, decay: 1.2, noise: 10, pan: 0 };
    default: return null;
  }
}

export const HOLD_MAX_MS = 120_000; // a tool held longer than this fades
export const TURN_MAX_MS = 600_000; // a turn with no event for this long counts as over
const HOLD_AMP = 30;
const WORK_AMP = 16;
const IDLE_AMP = 2;

const callKey = (e) => `${e.session ?? ''}|${e.tool ?? ''}|${e.sig ?? ''}`;

export function createSignal({ random = Math.random } = {}) {
  let voices = [];
  let turbulence = 0;
  let last = null;
  let bed = IDLE_AMP; // the working or idle tone, eased toward its target
  const held = new Map(); // call key -> { voice, since }
  const turns = new Map(); // session -> ms of its latest event
  const mono = new Uint8Array(SAMPLES);
  const left = new Uint8Array(SAMPLES);
  const right = new Uint8Array(SAMPLES);

  function release(key) {
    const h = held.get(key);
    if (!h) return;
    h.voice.decay = 6;
    held.delete(key);
  }

  return {
    hit(e, nowMs = last ?? 0) {
      const session = e.session ?? '';
      if (e.kind === 'stop') {
        for (const v of voices) v.decay = Math.max(v.decay, 4);
        for (const [k] of held) if (k.startsWith(`${session}|`)) release(k);
        turns.delete(session);
        return;
      }
      if (e.kind !== 'notification') turns.set(session, nowMs);
      if (e.kind === 'tool' && e.status === 'waiting') {
        const key = callKey(e);
        release(key);
        const voice = { amp: HOLD_AMP, freq: 24 + (hash(e.tool) % 24), decay: 0, noise: 0,
          pan: ((hash(e.tool) % 100) / 100) * 2 - 1, phase: random() * TAU };
        voices.push(voice);
        held.set(key, { voice, since: nowMs });
      } else if (e.kind === 'tool' || e.kind === 'tool_fail') {
        const key = callKey(e);
        if (held.has(key)) release(key);
        else for (const k of held.keys()) if (k.startsWith(`${session}|${e.tool ?? ''}|`)) { release(k); break; }
      }
      const v = voiceFor(e);
      if (v) voices.push({ ...v, phase: random() * TAU });
      if (voices.length > 64) {
        const keep = new Set([...held.values()].map((h) => h.voice));
        voices = [...voices.filter((x) => keep.has(x)), ...voices.filter((x) => !keep.has(x)).slice(-(64 - keep.size))];
      }
    },
    setTurbulence(g) { turbulence = Math.min(1, Math.max(0, g || 0)); },
    get voices() { return voices.length; },
    get running() { return held.size; },
    get working() { return turns.size > 0; },

    // Advance to `nowMs` and fill the three channels.
    frame(nowMs) {
      const dt = last == null ? 0 : Math.max(0, (nowMs - last) / 1000);
      last = nowMs;
      for (const [k, h] of held) if (nowMs - h.since > HOLD_MAX_MS) { h.voice.decay = 0.5; held.delete(k); }
      for (const [s, t] of turns) if (nowMs - t > TURN_MAX_MS) turns.delete(s);
      for (const v of voices) {
        v.amp *= Math.exp(-v.decay * dt);
        v.noise *= Math.exp(-v.decay * 1.5 * dt);
        v.phase += v.freq * dt * 2;
      }
      voices = voices.filter((v) => v.amp > 0.5 || v.noise > 0.5);
      const target = turns.size ? WORK_AMP : IDLE_AMP;
      bed += (target - bed) * (1 - Math.exp(-1.5 * dt));
      const breath = bed * (0.75 + 0.25 * Math.sin(nowMs / (turns.size ? 700 : 4000)));
      const floor = turbulence * 35;
      const wobble = turbulence * 25;
      for (let i = 0; i < SAMPLES; i++) {
        const x = (i / SAMPLES) * TAU;
        const b = breath * Math.sin(2 * x + nowMs / 900);
        let l = b + wobble * Math.sin(3 * x + nowMs / 300);
        let r = b + wobble * Math.sin(3 * x + nowMs / 260);
        for (const v of voices) {
          const s = v.amp * Math.sin(v.freq * x + v.phase) + v.noise * (random() * 2 - 1);
          l += s * (1 - v.pan) / 2 * 2;
          r += s * (1 + v.pan) / 2 * 2;
        }
        const n = floor * (random() * 2 - 1);
        l += n; r += n;
        left[i] = clampByte(128 + l);
        right[i] = clampByte(128 + r);
        mono[i] = clampByte(128 + (l + r) / 2);
      }
      return { timeByteArray: mono, timeByteArrayL: left, timeByteArrayR: right };
    },
  };
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// Mean distance from silence (128), 0–127: how loud a frame is. For checks.
export function loudness(bytes) {
  let s = 0;
  for (const b of bytes) s += Math.abs(b - 128);
  return s / bytes.length;
}
