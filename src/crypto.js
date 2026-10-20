// Crypto primitives — WebCrypto only, no dependency. Isomorphic Node 22+/browser.
// Mirrors the NakliOS SDK (vendored at sluice/vendor/naklios/identity/crypto.mjs,
// pinned to nakliOS ec8f1fe): sha256Hex for content hashes, stable across engines.
//
// Turbella uses sha256Hex to compute the `sig` on every event — a content hash of
// tool arguments or error text, never the raw data (AGENTS.md privacy rule).
const enc = (s) => new TextEncoder().encode(String(s));

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? enc(input) : input;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Canonical JSON with sorted keys so a hash is stable across engines and runs.
// Mirrors NakliOS history/ledger.mjs `stable()`.
export function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// Content hash of a payload, prefixed like NakliOS (`sha256:<hex>`).
export async function contentHash(payload) {
  return 'sha256:' + (await sha256Hex(stable(payload ?? null)));
}

// Truncate a string to `cap` characters so oversized inputs / errors stay bounded
// (tracelens caps: INPUT_CAP 4000, ERR_CAP 1000, TEXT_CAP 20000).
export function truncate(s, cap) {
  s = String(s ?? '');
  if (s.length <= cap) return s;
  return s.slice(0, cap);
}
