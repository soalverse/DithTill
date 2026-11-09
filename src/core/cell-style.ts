// =============================================================================
// The Look's STYLE axis: Dither bits or Halftone dots, their size /
// density ranges, the Density → spacing mapping and the shared anti-aliased dot edges the
// print screens draw with (core/print-screen). PURE, dep-free, no wall clock / no random
// (determinism-lint covered).
// =============================================================================

// 'square' = the classic 1-bit pixel dither ("Dither" mode). 'round' + 'block' = the clean
// tonal-dot halftone ("Halftone" mode) in its CIRCLE and SQUARE shapes — same blue-noise
// screen, different dot shape. 'dot' + 'halftone' are the earlier styles, kept renderable
// for old scenes but retired from the picker.
export type CellStyle = 'square' | 'dot' | 'halftone' | 'round' | 'block';

/** True for the tonal-dot "Halftone" mode (either shape) — reads pre-dither tone, places by
 *  blue-noise (no checker), anti-aliased. */
export const isHalftoneStyle = (s: CellStyle): boolean => s === 'round' || s === 'block';

export const CELL_STYLE_DEFAULT: CellStyle = 'square';

/** Halftone dot SIZE — the dot DIAMETER in output pixels, INDEPENDENT of spacing. MIN 1 is
 *  a crisp 1px stipple; larger = fatter dots. */
export const HALFTONE_SIZE_DEFAULT = 10;
export const HALFTONE_SIZE_MIN = 1;
export const HALFTONE_SIZE_MAX = 32;

/** Halftone DENSITY — how packed the dots are: MIN = sparse (dots far apart), MAX = a tight
 *  cluster. Maps to a lattice SPACING in output px via halftoneSpacing(). Independent of size. */
export const HALFTONE_DENSITY_DEFAULT = 10;
export const HALFTONE_DENSITY_MIN = 1;
export const HALFTONE_DENSITY_MAX = 20;
/** A dither layer's Bit size range (px at the live render scale; 10 = one canvas square at
 *  Normal detail). */
export const BIT_SIZE_MIN = 2;
export const BIT_SIZE_MAX = 40;

/** Density (1..MAX) → dot-lattice SPACING in output px: high density = tight spacing (many
 *  dots), low = wide spacing (few, scattered). The ONE shared mapping → live == export. */
export function halftoneSpacing(density: number): number {
  const d =
    density < HALFTONE_DENSITY_MIN
      ? HALFTONE_DENSITY_MIN
      : density > HALFTONE_DENSITY_MAX
        ? HALFTONE_DENSITY_MAX
        : density;
  const SPARSE = 40;
  const DENSE = 3;
  const t = (d - HALFTONE_DENSITY_MIN) / (HALFTONE_DENSITY_MAX - HALFTONE_DENSITY_MIN);
  return Math.max(1, Math.round(SPARSE - t * (SPARSE - DENSE)));
}

/** How many ANTI-ALIAS steps a round dot's edge is quantized into — the ink fades from
 *  full to nothing across a 1px rim so the disc is a true smooth circle, not a hard
 *  octagon. 8 steps → a compact indexed palette (mono round = 4-bit) that live == export
 *  can BOTH reproduce exactly (a shared integer quantization → no drift). */
export const ROUND_AA_LEVELS = 8;

/** The ink COVERAGE level (0..ROUND_AA_LEVELS) of a pixel whose centre is `dist` px from a
 *  dot of radius `r`: a 1px linear edge rim (full inside, fading over the last pixel). 0 =
 *  outside the dot (no ink). The ONE shared formula → the AA edge is identical on the live
 *  canvas and in the exported PNG. */
export function roundCoverageLevel(dist: number, r: number): number {
  const c = r + 0.5 - dist;
  if (c <= 0) return 0;
  if (c >= 1) return ROUND_AA_LEVELS;
  return Math.round(c * ROUND_AA_LEVELS);
}

/** The ink COVERAGE level (0..ROUND_AA_LEVELS) of a pixel at offset (dx, dy) from the centre
 *  of an axis-aligned SQUARE dot of half-side `r` — the exact pixel/square overlap (product
 *  of the two 1px edge ramps), so a tone-sized block gets clean anti-aliased sides. The
 *  square shape of the Halftone mode; same quantization as the circle → live == export. */
export function squareCoverageLevel(dx: number, dy: number, r: number): number {
  const cx = r + 0.5 - Math.abs(dx);
  const cy = r + 0.5 - Math.abs(dy);
  if (cx <= 0 || cy <= 0) return 0;
  const c = (cx < 1 ? cx : 1) * (cy < 1 ? cy : 1);
  return Math.round(c * ROUND_AA_LEVELS);
}
