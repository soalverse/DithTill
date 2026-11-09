// =============================================================================
// Seeded PRNG for the looper (Group E/F) — KEYED, STATELESS draws.
//
// THE LOAD-BEARING RULE: never a global advancing stream. Every random value is a
// pure hash of (seed, eventId, frame, channel). This is MANDATORY, not a nicety:
// the live loop's rAF coalesces / skips frames (SceneStage.schedule), so a global
// stream PRNG would draw a different COUNT of randoms live (with skips) vs export
// (no skips) and silently desync — the preview would diverge from the export with
// no error. Keyed draws make frame N's randomness independent of frames 0..N-1, so
// a skipped live frame can never desync from the deterministic export.
//
// The formula is locked like dither-constants: changing it changes every seeded
// loop's output. mulberry32 over an FNV-1a-style 32-bit mix of the key. Zero deps.
// =============================================================================

/** A keyed, stateless source of reproducible [0,1) values. */
export interface SeededRng {
  /** Deterministic value in [0,1) for this (eventId, frame, channel) under the seed.
   *  `channel` separates independent random streams within one event (e.g. x vs y
   *  jitter, or per-particle). Order of calls never matters — each is independent. */
  value: (eventId: string, frame: number, channel: number) => number;
}

/** 32-bit FNV-1a-style mix of (seed, eventId chars, frame, channel) → uint32. */
function hashKey(seed: number, eventId: string, frame: number, channel: number): number {
  // FNV-1a offset basis, perturbed by the master seed so different loops diverge.
  let h = (0x811c9dc5 ^ (seed | 0)) >>> 0;
  const FNV_PRIME = 0x01000193;
  // Fold the integer key parts first (frame, channel), byte by byte.
  for (const n of [frame | 0, channel | 0]) {
    let v = n >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= v & 0xff;
      h = Math.imul(h, FNV_PRIME) >>> 0;
      v >>>= 8;
    }
  }
  // Then the eventId characters.
  for (let i = 0; i < eventId.length; i++) {
    h ^= eventId.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** One mulberry32 step seeded by `a` → a single [0,1) value (stateless: no carry). */
function mulberry32(a: number): number {
  let t = (a + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Build a keyed-stateless RNG from a 32-bit master seed (stored in loop meta). */
export function makeRng(seed: number): SeededRng {
  return {
    value: (eventId, frame, channel) => mulberry32(hashKey(seed, eventId, frame, channel)),
  };
}

/** A small deterministic helper to mint a 32-bit seed from a string (e.g. for a
 *  reroll keyed off a label) without touching Math.random. */
export function seedFromString(s: string): number {
  return hashKey(0x9e3779b9, s, 0, 0);
}
