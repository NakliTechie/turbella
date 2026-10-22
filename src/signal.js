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

export function createSignal({ random = Math.random } = {}) {
  let voices = [];
  let turbulence = 0;
  let last = null;
  const mono = new Uint8Array(SAMPLES);
  const left = new Uint8Array(SAMPLES);
  const right = new Uint8Array(SAMPLES);

  return {
    hit(e) {
      if (e.kind === 'stop') { for (const v of voices) v.decay = Math.max(v.decay, 4); return; }
      const v = voiceFor(e);
      if (v) voices.push({ ...v, phase: random() * TAU });
      if (voices.length > 64) voices = voices.slice(-64);
    },
    setTurbulence(g) { turbulence = Math.min(1, Math.max(0, g || 0)); },
    get voices() { return voices.length; },

    // Advance to `nowMs` and fill the three channels.
    frame(nowMs) {
      const dt = last == null ? 0 : Math.max(0, (nowMs - last) / 1000);
      last = nowMs;
      for (const v of voices) {
        v.amp *= Math.exp(-v.decay * dt);
        v.noise *= Math.exp(-v.decay * 1.5 * dt);
        v.phase += v.freq * dt * 2;
      }
      voices = voices.filter((v) => v.amp > 0.5 || v.noise > 0.5);
      const floor = turbulence * 35;
      const wobble = turbulence * 25;
      for (let i = 0; i < SAMPLES; i++) {
        const x = (i / SAMPLES) * TAU;
        let l = wobble * Math.sin(3 * x + nowMs / 300);
        let r = wobble * Math.sin(3 * x + nowMs / 260);
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
