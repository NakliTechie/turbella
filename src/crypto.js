// Hashing for event signatures. WebCrypto only, so the page and Node share it.

const enc = new TextEncoder();

export async function sha256Hex(text) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Canonical JSON (sorted keys), so equal values hash equally. Nesting past
// MAX_DEPTH collapses to one marker instead of overflowing the stack.
const MAX_DEPTH = 32;
export function stable(v, depth = 0) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (depth >= MAX_DEPTH) return '"…"';
  if (Array.isArray(v)) return '[' + v.map((x) => stable(x, depth + 1)).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k], depth + 1)).join(',') + '}';
}

// `sha256:<hex>` of a string as is, or of any other value's canonical JSON.
export async function contentHash(value) {
  return 'sha256:' + (await sha256Hex(typeof value === 'string' ? value : stable(value ?? null)));
}
