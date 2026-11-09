// =============================================================================
// Composite — the flattened "stage" raster (base + strokes), as per-cell TONE +
// a covered flag, plus the ONE encoder that turns it into a transparent indexed
// PNG. This is the shared seam behind BOTH the Draw export and the Library bake,
// so flatten == preview == stored element (one dither truth).
//
// Palette + Matrix are LIVE display params (not baked into the tone), so a stored
// composite re-renders / recolours through the same quantizer — exactly what the
// Record scene (increment 3) needs to recolour/re-dither an element.
// =============================================================================
import {
  bitDepthForCount,
  PALETTES,
  quantizeContrast,
  quantizeLum,
  type MatrixId,
  type PaletteId,
} from './dither-constants';
import { PackedIndexBuffer } from './packed-index-buffer';
import { encodeIndexedPng } from './png-indexed';
import { clampRgb, type Swatch } from './color';

/** Quantizer contrast for the composite/Draw path (fixed at 1.0 — the tone has
 *  Burn's contrast/invert already baked in; Draw has no contrast knob). */
export const COMPOSITE_CT = quantizeContrast(1);

/** A flattened stage raster at its canvas resolution: per-cell tone (0..255) + covered,
 *  plus an OPTIONAL low-byte `fine` plane. The exact pre-dither
 *  luma of a cell is `tones·256 + fine` — a Burn/Make-imported base carries Burn's lumC
 *  this way so re-dithering reproduces the canvas bit-for-bit. Absent = 0 everywhere,
 *  which is exactly the old 8-bit behaviour (Draw strokes, v4 elements). */
export interface Composite {
  w: number;
  h: number;
  tones: Uint8Array;
  covered: Uint8Array;
  fine?: Uint8Array;
  /** v6: per-cell halftone dot-ink slot into `inks` (0 = inherit the
   *  canvas dot colour) — a saved canvas keeps its layers' dot colours. */
  ink?: Uint8Array;
  inks?: Swatch[];
}

/** The exact pre-dither luma (0..65280) of composite cell `i`. */
export function compositeLum(c: Composite, i: number): number {
  return c.tones[i] * 256 + (c.fine ? c.fine[i] : 0);
}

/** Dither one composite cell to a palette index via the SHARED quantizer (so the
 *  composite matches the live preview and the export). `N` = palette length. `fine`
 *  is the cell's low luma byte — 0 reproduces the old tone-only result
 *  exactly (grey RGB t → lumI = 256·t). */
export function compositeCellIndex(
  tone: number,
  x: number,
  y: number,
  N: number,
  matrix: MatrixId,
  fine = 0,
): number {
  return quantizeLum(tone * 256 + fine, x, y, N, COMPOSITE_CT, matrix);
}

/** True if any cell is covered (i.e. there is something to save / show). */
export function compositeHasContent(c: Composite): boolean {
  for (let i = 0; i < c.covered.length; i++) if (c.covered[i]) return true;
  return false;
}

/**
 * Encode a composite as a transparent indexed PNG: each covered cell is dithered
 * with the selected palette via the shared quantizer, block-upscaled NEAREST by
 * `scale`, and encoded VERBATIM. The palette gets a leading transparent entry
 * (index 0, marked tRNS) so empty cells export see-through. This is the exact
 * transform the Draw export used inline — now shared with the Library bake.
 *
 * `background`: a flat colour for uncovered
 * cells — a palette shade INDEX (byte-identical to before) or a CUSTOM `[r,g,b]`
 * (appended as one extra palette entry). They export as that EXACT colour (never
 * dithered) and the file is fully opaque (no tRNS). null/undefined = the
 * transparent behaviour, byte-identical to before.
 */
export function encodeCompositePng(
  c: Composite,
  palette: PaletteId,
  matrix: MatrixId,
  scale: number,
  background?: Swatch,
): Uint8Array {
  const pal = PALETTES[palette];
  const N = pal.length / 3;
  const custom = Array.isArray(background) ? clampRgb(background) : null;
  const presetIdx =
    typeof background === 'number' ? Math.max(0, Math.min(N - 1, background | 0)) : -1;
  const hasBg = custom !== null || presetIdx >= 0;
  // Export palette: index 0 = transparent, then the selected ramp, then (custom bg
  // only) one appended RGB entry.
  let exPal: Uint8Array;
  let bgIdx = 0;
  let count = N + 1; // transparent + ramp
  if (custom) {
    exPal = new Uint8Array(3 + pal.length + 3);
    exPal.set(pal, 3);
    exPal[3 + pal.length] = custom[0];
    exPal[3 + pal.length + 1] = custom[1];
    exPal[3 + pal.length + 2] = custom[2];
    bgIdx = N + 1;
    count = N + 2;
  } else {
    exPal = new Uint8Array(3 + pal.length);
    exPal.set(pal, 3);
    if (presetIdx >= 0) bgIdx = presetIdx + 1;
  }
  const trns = hasBg ? undefined : new Uint8Array([0]);
  const S = Math.max(1, scale | 0);
  const { w, h, tones, covered, fine } = c;
  const big = new PackedIndexBuffer(w * S, h * S, bitDepthForCount(count));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const idx = covered[i]
        ? compositeCellIndex(tones[i], x, y, N, matrix, fine ? fine[i] : 0) + 1 // +1: reserved entry
        : bgIdx; // 0 = transparent (buffer pre-zeroed) or the flat background
      if (idx === 0) continue;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) big.set(x * S + sx, y * S + sy, idx);
      }
    }
  }
  return encodeIndexedPng(big, exPal, trns);
}
