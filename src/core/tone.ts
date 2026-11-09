// =============================================================================
// Pre-dither TONE controls (G3, Group G) — gamma + levels applied to the
// downscaled grid RGBA at the ONE sourceToGrid seam, BEFORE the quantizer.
//
// Parity is structural, not promised: the GPU preview, the CPU export and the
// video exporter all consume the SAME treated grid bytes (the GPU does not
// downscale or tone-map), so no shader change and no new integer
// mirror is needed. The LUT is built once per render from the three params;
// alpha is never touched (transparency/coverage is a separate axis).
// =============================================================================

export interface Tone {
  /** Mid-tone curve: 1 = linear; >1 brightens mids, <1 darkens (out = u^(1/γ)). */
  gamma: number;
  /** Levels black point 0..254 — input at/below maps to 0. */
  black: number;
  /** Levels white point 1..255 — input at/above maps to 255. */
  white: number;
  /** Brightness offset -100..100 (0 = none), added after the curve:
   *  ±100 shifts every byte by ±BRIGHTNESS_REACH. Absent = 0. */
  brightness?: number;
}

export const TONE_NEUTRAL: Tone = { gamma: 1, black: 0, white: 255 };

/** UI clamp ranges (the store/sliders honour these; the LUT re-clamps anyway). */
export const GAMMA_MIN = 0.4;
export const GAMMA_MAX = 2.5;
/** Bytes a ±100 Brightness shifts every tone by. */
export const BRIGHTNESS_REACH = 128;

export const isNeutralTone = (t: Tone | undefined | null): boolean =>
  !t || (t.gamma === 1 && t.black === 0 && t.white === 255 && !t.brightness);

/** Build the 256-entry tone LUT: levels remap [black, white] → [0, 1], then the
 *  gamma curve, then back to bytes. Monotonic; endpoints exact. */
export function toneLut(t: Tone): Uint8Array {
  const black = Math.min(254, Math.max(0, t.black));
  const white = Math.max(black + 1, Math.min(255, t.white));
  const gamma = Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, t.gamma));
  const exp = 1 / gamma;
  const shift = (Math.min(100, Math.max(-100, t.brightness ?? 0)) / 100) * BRIGHTNESS_REACH;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const u = Math.min(1, Math.max(0, (v - black) / (white - black)));
    lut[v] = Math.min(255, Math.max(0, Math.round(255 * Math.pow(u, exp) + shift)));
  }
  return lut;
}

/** Apply a tone LUT to grid RGBA in place (R/G/B; alpha untouched). */
export function applyToneLut(rgba: Uint8ClampedArray | Uint8Array, lut: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = lut[rgba[i]];
    rgba[i + 1] = lut[rgba[i + 1]];
    rgba[i + 2] = lut[rgba[i + 2]];
  }
}
