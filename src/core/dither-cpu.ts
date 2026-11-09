// =============================================================================
// CPU dither mirror — the faithful integer twin of the WebGL2 shader.
// Used by the export Worker (crisp PNG) and by the parity tests. Operates on an
// ALREADY-DOWNSCALED RGBA grid so the dither math is isolated from the
// downscale step (which has its own single shared rule, computeGrid()).
// =============================================================================
import {
  diffuseLums,
  floorDiv,
  isDiffusion,
  paletteLength,
  quantizeCell,
  quantizeContrast,
  ALPHA_CUTOFF,
  CONTRAST_ONE,
  LUMA,
  LUMA_HALF,
  LUMA_SCALE,
  PALETTES,
  type PaletteId,
  type PatternId,
} from './dither-constants';

export interface DitherOptions {
  palette: PaletteId;
  matrix: PatternId;
  contrast: number; // UI float; quantized to integer CT internally
  invert?: boolean;
}

/**
 * Dither a downscaled RGBA grid (length LW*LH*4) into palette indices
 * (length LW*LH). Bit-for-bit identical to the GPU path by construction.
 * Alpha is NOT consulted here — transparency is an additive channel applied at
 * the preview / export layer (see indicesToRgba), so the opaque
 * dither stays unchanged.
 */
export function ditherIndices(
  rgba: Uint8Array | Uint8ClampedArray,
  LW: number,
  LH: number,
  opts: DitherOptions,
): Uint8Array {
  const N = paletteLength(opts.palette);
  const CT = quantizeContrast(opts.contrast);
  if (isDiffusion(opts.matrix)) {
    // Error diffusion: the treated lumas of the whole grid in one pass, through
    // the same `diffuseLums` the print screens use.
    const S = LUMA_SCALE;
    const lums = new Int32Array(LW * LH);
    for (let i = 0; i < LW * LH; i++) {
      const lumI = LUMA.WR * rgba[i * 4] + LUMA.WG * rgba[i * 4 + 1] + LUMA.WB * rgba[i * 4 + 2];
      let lumC = floorDiv((lumI - LUMA_HALF) * CT, CONTRAST_ONE) + LUMA_HALF;
      if (opts.invert) lumC = S - lumC;
      lums[i] = lumC;
    }
    const mask = new Uint8Array(LW * LH).fill(1);
    return diffuseLums(lums, mask, LW, LH, N, opts.matrix);
  }
  const out = new Uint8Array(LW * LH);
  for (let y = 0; y < LH; y++) {
    for (let x = 0; x < LW; x++) {
      const i = (y * LW + x) * 4;
      out[y * LW + x] = quantizeCell({
        R: rgba[i],
        G: rgba[i + 1],
        B: rgba[i + 2],
        x,
        y,
        N,
        CT,
        matrix: opts.matrix,
        invert: opts.invert,
      });
    }
  }
  return out;
}

/**
 * Expand palette indices into an RGBA buffer (length P*4) for preview / PNG.
 * If `gridRgba` (the source grid) is given, cells whose source alpha is below
 * ALPHA_CUTOFF are written fully transparent (Stage 9) — matching the GPU
 * shader and the export.
 */
export function indicesToRgba(
  indices: Uint8Array,
  palette: PaletteId,
  gridRgba?: Uint8Array | Uint8ClampedArray,
): Uint8ClampedArray {
  const pal = PALETTES[palette];
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let p = 0; p < indices.length; p++) {
    const c = indices[p] * 3;
    const o = p * 4;
    out[o] = pal[c];
    out[o + 1] = pal[c + 1];
    out[o + 2] = pal[c + 2];
    out[o + 3] = gridRgba && gridRgba[p * 4 + 3] < ALPHA_CUTOFF ? 0 : 255;
  }
  return out;
}
