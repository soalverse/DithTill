import { create } from 'zustand';
import {
  LUMA,
  LUMA_SCALE,
  LUMA_HALF,
  CONTRAST_ONE,
  ALPHA_CUTOFF,
  floorDiv,
  splitLum,
} from '../core/dither-constants';

// =============================================================================
// Shared STAGE — the cross-mode artwork base. The four modes are one
// ecosystem; this singleton holds the BASE layer (seeded from a treated Burn
// source) so the artwork persists + flows between modes. The DRAW layer + undo
// stay in draw-store; the "stage" is the conceptual pair (stage.base + draw doc),
// read together by `resolveCell` (in draw-store) and by flatten/export.
//
// The base is stored as per-cell TONE (0..255) + a covered flag at draw-doc
// resolution — NOT baked palette pixels — so Draw re-dithers base + strokes
// together in ONE pass (live palette/matrix recolour the whole composite, and
// preview == export holds). Base tone bakes Burn's contrast/invert/reframe (the
// "treated look"); Draw only re-colours/dithers it.
// =============================================================================

interface StageState {
  w: number;
  h: number;
  baseTones: Uint8Array | null;
  baseCovered: Uint8Array | null;
  /** The base's low luma byte: exact lumC = baseTones·256 + baseFine. */
  baseFine: Uint8Array | null;
  rev: number; // bumps on seed/clear → DrawCanvas re-dithers
  /** True when the base was loaded explicitly (a Library element), so entering
   *  Draw must NOT auto-reseed it from the live Burn source. An
   *  auto-seed (or clear) resets it. */
  pinned: boolean;
  hasBase: () => boolean;
  /** Seed the base from a treated source's downscaled RGBA grid (at doc dims).
   *  `CT` = quantizeContrast(burnContrast); `invert` = burn invert. */
  seedFromGrid: (
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
    CT: number,
    invert: boolean,
  ) => void;
  /** Set the base directly from per-cell tone+covered (a loaded Library element).
   *  Pins it so the auto-seed-from-Burn never clobbers it. */
  /** Nearest re-grid of the base planes (a confirmed Pixel change on a pinned base). */
  regridBase: (w: number, h: number) => void;
  setBase: (
    tones: Uint8Array,
    covered: Uint8Array,
    w: number,
    h: number,
    fine?: Uint8Array | null,
  ) => void;
  clear: () => void;
}

/** RGBA grid → per-cell base {tone, fine, covered}: covered where alpha >= cutoff, the
 *  contrast/invert-adjusted luma split into the exact planes:
 *  `tone = floor(lumC/256)` + `fine = lumC mod 256`, so re-dithering `tone·256 + fine`
 *  through the shared quantizer reproduces Burn's cell bit-for-bit (the old ROUNDED 8-bit
 *  tone flipped cells sitting on their threshold), and the floored tone is the same
 *  projection the halftone readers use. Shared by the Make canvas base and
 *  the Library intake so both produce the same raster. */
export function gridToBase(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  CT: number,
  invert: boolean,
): { tones: Uint8Array; covered: Uint8Array; fine: Uint8Array } {
  const n = w * h;
  const tones = new Uint8Array(n);
  const covered = new Uint8Array(n);
  const fine = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < ALPHA_CUTOFF) continue; // off-frame / transparent source → no base
    covered[i] = 1;
    const t = splitLum(baseLum(rgba[o], rgba[o + 1], rgba[o + 2], CT, invert));
    tones[i] = t.tone;
    fine[i] = t.fine;
  }
  return { tones, covered, fine };
}

/** RGB → the contrast/invert-adjusted luma (lumC, unclamped) the quantizer would see.
 *  Mirrors quantizeCell's pre-dither luma steps (dither-constants.ts) exactly. */
function baseLum(r: number, g: number, b: number, CT: number, invert: boolean): number {
  const S = LUMA_SCALE;
  const H = LUMA_HALF;
  const lumI = LUMA.WR * r + LUMA.WG * g + LUMA.WB * b;
  let lumC = floorDiv((lumI - H) * CT, CONTRAST_ONE) + H;
  if (invert) lumC = S - lumC;
  return lumC;
}

/** Nearest re-grid of one plane (mirrors draw-store regridPlane; kept local so the
 *  stage store has no draw-store import cycle). */
function regrid(src: Uint8Array, sw: number, sh: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
      out[y * w + x] = src[sy * sw + sx];
    }
  }
  return out;
}

export const useStageStore = create<StageState>((set, get) => ({
  w: 0,
  h: 0,
  baseTones: null,
  baseCovered: null,
  baseFine: null,
  rev: 0,
  pinned: false,

  hasBase: () => get().baseCovered !== null,

  seedFromGrid: (rgba, w, h, CT, invert) => {
    const { tones, covered, fine } = gridToBase(rgba, w, h, CT, invert);
    set((s) => ({
      baseTones: tones,
      baseCovered: covered,
      baseFine: fine,
      w,
      h,
      pinned: false,
      rev: s.rev + 1,
    }));
  },

  regridBase: (w, h) => {
    const s = get();
    if (!s.baseTones || !s.baseCovered || (s.w === w && s.h === h)) return;
    set({
      baseTones: regrid(s.baseTones, s.w, s.h, w, h),
      baseCovered: regrid(s.baseCovered, s.w, s.h, w, h),
      baseFine: s.baseFine ? regrid(s.baseFine, s.w, s.h, w, h) : null,
      w,
      h,
      rev: s.rev + 1,
    });
  },

  setBase: (tones, covered, w, h, fine = null) =>
    set((s) => ({
      baseTones: tones,
      baseCovered: covered,
      baseFine: fine,
      w,
      h,
      pinned: true,
      rev: s.rev + 1,
    })),

  clear: () =>
    set((s) => ({
      baseTones: null,
      baseCovered: null,
      baseFine: null,
      pinned: false,
      rev: s.rev + 1,
    })),
}));
