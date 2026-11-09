// =============================================================================
// DithTill — SHARED DITHER CONSTANTS  (the single source of truth)
// =============================================================================
// Imported VERBATIM by:
//   - the canvas's scene resolver + every exporter (src/core/scene-resolver.ts & co)
//   - the CPU reference (src/core/dither-cpu.ts) + the parity tests
//     (tests/dither-parity.test.ts). The old WebGL2 preview shader retired with the
//     Burn tab (step 4); it lives on in the `legacy` branch.
//
// There is exactly ONE copy of the Bayer matrices, luma coefficients, the
// quantization formula and the gamma policy. Changing anything in this file
// changes the DEFINITION of the dither and REQUIRES regenerating the golden
// snapshots in tests/dither-parity.test.ts (preview == export guard).
//
// LOCKED DECISIONS (SCOPE.md §2/§3/§7, confirmed with the user):
//   * 8x8 Bayer ordered dithering now; blue-noise later = swap the threshold
//     table only (the formula is unchanged).
//   * INTEGER-ONLY quantization so the WebGL2 (float32) preview and the
//     TypeScript (float64) export agree BIT-FOR-BIT. No float touches the
//     luma / contrast / quant decision on either path.
//   * Gamma policy = sRGB-direct: luma is computed straight from stored 8-bit
//     sRGB bytes, NO linearize/delinearize. (Linear-light is a future opt-in
//     that, if added, lives here and re-triggers the snapshot test.)
//
// NOTE: this integer formula is the canonical definition. It equals exact
// round-half-up and is self-consistent GPU==CPU; it does NOT bit-match the old
// float64 prototype at rare exact-half grey ties (visually invisible). The
// prototype (src/lab, scripts/render-dither-video.cjs) is a VISUAL reference,
// not a byte reference. See tests/dither-parity.test.ts for the locked cases.
// =============================================================================

export type MatrixId = 'none' | 2 | 4 | 8 | 'dot' | 'lines' | 'cross' | 'blue';
export type PaletteId =
  | 'dusk'
  | 'clay'
  | 'cream'
  | 'two'
  // Monochrome PAPER / neutral ramps (owner request): newsprint tones — sepia, grey,
  // beige, off-white — anchored on a SOFT black (not the shared harsh near-black), so
  // switching palettes actually changes the whole tonal range, and the halftone dot
  // reads as a warm paper tone rather than a hard white.
  | 'sepia'
  | 'grey'
  | 'paper';

/** Gamma policy. sRGB-direct = no linearization on either path. Locked. */
export const GAMMA_POLICY = 'srgb-direct' as const;

/** Integer Rec.601 luma weights. Sum to 256 exactly (clean fixed-point scale).
 *  WR=round(0.299*256)=77, WG=round(0.587*256)=150, WB=round(0.114*256)=29. */
export const LUMA = { WR: 77, WG: 150, WB: 29, SUM: 256 } as const;

/** Luma fixed-point scale S = 256 * 255. lumI in [0, S] equals luma * S. */
export const LUMA_SCALE = 65280;
/** S / 2 — the mid-grey pivot for contrast and the round-half-up bias. */
export const LUMA_HALF = 32640;

/** Contrast crosses into the math ONLY as an integer CT = round(ct * 2^FRAC).
 *  The UI float `ct` is converted exactly once, here, and the same CT is used
 *  by the shader uniform AND the CPU mirror. */
export const CONTRAST_FRAC_BITS = 12;
export const CONTRAST_ONE = 1 << CONTRAST_FRAC_BITS; // 4096 == contrast 1.0
// Hard ceiling so the integer math stays exact on the GPU's 32-bit `highp int`:
// the worst-case intermediate (lumI - S/2) * CT must stay < 2^31. With
// |lumI - S/2| <= S/2 = 32640, ct <= 16 keeps it in range (ct=17 overflows int32
// on the GPU while float64 on the CPU would not — silently breaking preview==export).
// This is a safety ceiling far above any sane UI value, not a UX limit.
export const MAX_CONTRAST = 16;
export const quantizeContrast = (ct: number): number => {
  const clamped = ct < 0 ? 0 : ct > MAX_CONTRAST ? MAX_CONTRAST : ct;
  return Math.round(clamped * CONTRAST_ONE);
};

// ---- Bayer matrices: raw integers 0..n*n-1 (NOT pre-normalized) -------------
// Built by the exact prototype recurrence. Normalization is folded into
// quantizeCell() so the threshold stays an exact integer on both paths.
function buildBayer(n: number): Int32Array {
  let m: number[][] = [[0]];
  for (let k = 1; k < n; k *= 2) {
    const s = m.length;
    const q = [
      [0, 2],
      [3, 1],
    ];
    const nm: number[][] = [];
    for (let y = 0; y < 2 * s; y++) {
      nm.push([]);
      for (let x = 0; x < 2 * s; x++) {
        nm[y][x] = m[y % s][x % s] * 4 + q[(y / s) | 0][(x / s) | 0];
      }
    }
    m = nm;
  }
  const out = new Int32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = m[y][x];
  return out;
}

export const BAYER: Record<2 | 4 | 8, Int32Array> = {
  2: buildBayer(2),
  4: buildBayer(4),
  8: buildBayer(8),
};

// ---- Group G threshold tables (additive — new Matrix OPTIONS; Bayer and every
// existing output are untouched). Each table is a PERMUTATION of 0..n*n-1 and
// drops into the SAME quantizeCell formula, so preview == export holds for
// every screen by construction. The GPU uploads tables as R8UI (max value 255),
// which caps the side at 16 — enforced by the registry test.
//
// Threshold semantics: HIGHER t lights EARLIER as tone rises from black, so a
// screen's "grow order" is descending t.

/** Classic 8x8 clustered-dot halftone (45° dot screen, two interleaved spiral
 *  clusters) — tone renders as GROWING ROUND DOTS, the newspaper-print /
 *  dot-matrix look (the owner's reference imagery). Standard published table. */
// prettier-ignore
const CLUSTERED_DOT_8 = Int32Array.from([
  24, 10, 12, 26, 35, 47, 49, 37,
   8,  0,  2, 14, 45, 59, 61, 51,
  22,  6,  4, 16, 43, 57, 63, 53,
  30, 20, 18, 28, 33, 41, 55, 39,
  34, 46, 48, 36, 25, 11, 13, 27,
  44, 58, 60, 50,  9,  1,  3, 15,
  42, 56, 62, 52, 23,  7,  5, 17,
  32, 40, 54, 38, 31, 21, 19, 29,
]);

/** 8x8 horizontal LINE screen (contour family): rows light centre-out, each
 *  line materialising dispersed (bit-reversed x) before solidifying — tone
 *  reads as thickening horizontal contour lines. */
function buildLineScreen(): Int32Array {
  const rankOfRow = [6, 4, 2, 0, 1, 3, 5, 7]; // centre rows (3,4) light first
  const bitrev3 = [0, 4, 2, 6, 1, 5, 3, 7]; // dispersed within-line growth
  const out = new Int32Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) out[y * 8 + x] = 63 - (rankOfRow[y] * 8 + bitrev3[x]);
  return out;
}

/** 8x8 CROSSHATCH screen: cells rank by distance to the nearest diagonal line
 *  of either family (x+y and x-y, period 8), Bayer-dispersed within each band —
 *  tone reads as both diagonal line sets appearing then thickening (hatching). */
function buildCrossHatch(): Int32Array {
  const dist = (v: number): number => Math.min(v, 8 - v);
  const cells: { i: number; score: number; tie: number }[] = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const dA = dist((x + y) % 8);
      const dB = dist((x - y + 8) % 8);
      cells.push({ i: y * 8 + x, score: Math.min(dA, dB), tie: BAYER[8][y * 8 + x] });
    }
  // Lights-first = on-diagonal first; within a band, Bayer-high first (dispersed).
  cells.sort((a, b) => a.score - b.score || b.tie - a.tie || a.i - b.i);
  const out = new Int32Array(64);
  cells.forEach((c, rank) => {
    out[c.i] = 63 - rank;
  });
  return out;
}

/** 16x16 BLUE-NOISE table via Ulichney void-and-cluster (toroidal, gaussian
 *  energy) — organic, clump-free grain vs Bayer's woven crosshatch. Built
 *  DETERMINISTICALLY at module load from a fixed-seed mulberry32, so the table
 *  is as locked as a literal: same bytes every run, GPU == CPU == snapshots. */
function buildBlueNoise(): Int32Array {
  const n = 16;
  const count = n * n;
  const SIGMA = 1.9;
  // Precomputed toroidal gaussian kernel, indexed by (dy, dx).
  const kernel = new Float64Array(count);
  for (let dy = 0; dy < n; dy++)
    for (let dx = 0; dx < n; dx++) {
      const wy = Math.min(dy, n - dy);
      const wx = Math.min(dx, n - dx);
      kernel[dy * n + dx] = Math.exp(-(wx * wx + wy * wy) / (2 * SIGMA * SIGMA));
    }
  const energy = new Float64Array(count);
  const addEnergy = (i: number, sign: number): void => {
    const iy = (i / n) | 0;
    const ix = i % n;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        energy[y * n + x] +=
          sign * kernel[((((y - iy) % n) + n) % n) * n + ((((x - ix) % n) + n) % n)];
  };
  // Deterministic PRNG (fixed seed — the table is part of the dither truth).
  let prngState = 0x9e3779b9 | 0;
  const rand = (): number => {
    let t = (prngState = (prngState + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pattern = new Uint8Array(count);
  const initial = Math.round(count / 10); // ~10% minority points
  let placed = 0;
  while (placed < initial) {
    const i = Math.floor(rand() * count) % count;
    if (!pattern[i]) {
      pattern[i] = 1;
      addEnergy(i, 1);
      placed++;
    }
  }
  const argBest = (want1: boolean, wantMax: boolean): number => {
    let best = -1;
    let bestE = wantMax ? -Infinity : Infinity;
    for (let i = 0; i < count; i++) {
      if ((pattern[i] === 1) !== want1) continue;
      if (wantMax ? energy[i] > bestE : energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };
  // Relax the initial pattern: move the tightest cluster into the largest void
  // until they coincide (Ulichney phase 0).
  for (let iter = 0; iter < count * 4; iter++) {
    const cluster = argBest(true, true);
    pattern[cluster] = 0;
    addEnergy(cluster, -1);
    const voidCell = argBest(false, false);
    pattern[voidCell] = 1;
    addEnergy(voidCell, 1);
    if (voidCell === cluster) break;
  }
  const rank = new Int32Array(count).fill(-1);
  // Phase 1: rank the initial minority points by removing tightest clusters.
  const snapshot = pattern.slice();
  for (let r = initial - 1; r >= 0; r--) {
    const i = argBest(true, true);
    pattern[i] = 0;
    addEnergy(i, -1);
    rank[i] = r;
  }
  // Phase 2/3: restore, then fill every remaining cell at the largest void.
  pattern.set(snapshot);
  for (let i = 0; i < count; i++) energy[i] = 0;
  for (let i = 0; i < count; i++) if (pattern[i]) addEnergy(i, 1);
  for (let r = initial; r < count; r++) {
    const i = argBest(false, false);
    pattern[i] = 1;
    addEnergy(i, 1);
    rank[i] = r;
  }
  return Int32Array.from(rank);
}

/** A threshold screen: side n + a table that is a permutation of 0..n*n-1.
 *  R8UI on the GPU caps n at 16 (max stored value 255). */
export interface ThresholdMatrix {
  side: number;
  table: Int32Array;
}

/** THE matrix registry — every screen the quantizer can use ('none' aside).
 *  Adding an entry here is the ONLY step to add a screen: the CPU, the GPU
 *  (table texture + side/den uniforms) and the parity suite all read this. */
export const MATRICES: Record<Exclude<MatrixId, 'none'>, ThresholdMatrix> = {
  2: { side: 2, table: BAYER[2] },
  4: { side: 4, table: BAYER[4] },
  8: { side: 8, table: BAYER[8] },
  dot: { side: 8, table: CLUSTERED_DOT_8 },
  lines: { side: 8, table: buildLineScreen() },
  cross: { side: 8, table: buildCrossHatch() },
  blue: { side: 16, table: buildBlueNoise() },
};

/** The 16×16 blue-noise (void-and-cluster) rank table, 0..255 — reused by the 'round'
 *  cell style for stochastic dot PLACEMENT. Same fixed-seed table the 'blue'
 *  dither screen uses, so it stays a locked constant (GPU==CPU==export). */
export const BLUE_TABLE: Int32Array = MATRICES.blue.table;

/** Side length n of a matrix (1 for 'none'). */
export const matrixSide = (m: MatrixId): number => (m === 'none' ? 1 : MATRICES[m].side);
/** Threshold denominator D = n*n (1 for 'none'). */
export const matrixDenominator = (m: MatrixId): number => {
  const n = matrixSide(m);
  return n * n;
};

/** Threshold lookup t = T_n(y mod n, x mod n) in [0, n*n-1] (0 for 'none').
 *  Mirrors the GPU `texelFetch(uBayer, ivec2(x % n, y % n))`. */
export const bayerThreshold = (m: MatrixId, x: number, y: number): number => {
  if (m === 'none') return 0;
  const { side: n, table } = MATRICES[m];
  return table[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
};

// ---- Palettes: dark -> light ramps, N RGB triplets --------------------------
const PALETTE_HEX: Record<PaletteId, string[]> = {
  dusk: ['#0e0b18', '#211a3a', '#3b3290', '#534ab7', '#8a82d8', '#d6d1f5'],
  clay: ['#191210', '#3d281d', '#7a4a33', '#cc785c', '#e0a87f', '#f0e9d8'],
  cream: ['#17140f', '#3a342b', '#6e6458', '#9b9384', '#c8bfac', '#efe9da'],
  two: ['#0d0d0d', '#f4f4f4'],
  // Monochrome paper / neutral ramps — SOFT black -> a warm/neutral paper tone. The
  // brightest entry is the ink the halftone dot uses, so dots read as sepia / grey /
  // beige / off-white on the dark glass (newsprint feel), and no ramp bottoms out on
  // the same harsh black.
  sepia: ['#1c1712', '#3a2c20', '#63492f', '#8f6f4a', '#bfa079', '#e9d8bf'],
  grey: ['#161617', '#313236', '#565860', '#82858c', '#b0b3b8', '#e4e6e9'],
  paper: ['#1b1813', '#38342b', '#666055', '#96907f', '#c7c1b0', '#f2ece0'],
};

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function buildPalette(hexes: string[]): Uint8Array {
  const out = new Uint8Array(hexes.length * 3);
  hexes.forEach((h, i) => {
    const [r, g, b] = hexToRgb(h);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  });
  return out;
}

/** Flat RGB bytes, length 3*N, per palette. */
export const PALETTES: Record<PaletteId, Uint8Array> = {
  dusk: buildPalette(PALETTE_HEX.dusk),
  clay: buildPalette(PALETTE_HEX.clay),
  cream: buildPalette(PALETTE_HEX.cream),
  two: buildPalette(PALETTE_HEX.two),
  sepia: buildPalette(PALETTE_HEX.sepia),
  grey: buildPalette(PALETTE_HEX.grey),
  paper: buildPalette(PALETTE_HEX.paper),
};
export const paletteLength = (p: PaletteId): number => PALETTES[p].length / 3;
/** RGB triplet of palette entry `i` (clamped to the ramp — a background pick
 *  survives switching to a shorter palette). */
export function paletteRgbAt(p: PaletteId, i: number): [number, number, number] {
  const N = paletteLength(p);
  const c = Math.max(0, Math.min(N - 1, i | 0)) * 3;
  const pal = PALETTES[p];
  return [pal[c], pal[c + 1], pal[c + 2]];
}
/** Integer luma (0..255) of palette entry `i` — the TONE a flat background
 *  contributes when blended under semi-transparent elements or baked into a
 *  portable composite. Same Rec.601 integer weights as the quantizer. */
export function paletteToneAt(p: PaletteId, i: number): number {
  const [r, g, b] = paletteRgbAt(p, i);
  return (LUMA.WR * r + LUMA.WG * g + LUMA.WB * b) >> 8;
}
/** Minimal PNG bit depth (1/2/4/8) that can index `count` palette entries. */
export const bitDepthForCount = (count: number): 1 | 2 | 4 | 8 =>
  count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
export const PALETTE_IDS: PaletteId[] = ['dusk', 'clay', 'cream', 'two', 'sepia', 'grey', 'paper'];
/** Bayer sizes ascending, then the Group G screen families (additive). */
export const MATRIX_IDS: MatrixId[] = ['none', 2, 4, 8, 'dot', 'lines', 'cross', 'blue'];

// ---- Aspect framing (Stage 6): the viewing-window shape --------------------
// Display + framing only — NOT part of the quant formula, so the parity
// snapshots are unaffected. Picks the target frame ratio that both the glass
// (CSS) and the shared grid (imageToGrid) obey, so preview == export holds.
export type AspectId = 'square' | 'landscape' | 'portrait';
export const ASPECT_IDS: AspectId[] = ['square', 'landscape', 'portrait'];
/** Target frame ratio (w / h) per aspect. landscape = 4:3 (the default glass). */
export const ASPECT_RATIO: Record<AspectId, { w: number; h: number }> = {
  square: { w: 1, h: 1 },
  landscape: { w: 4, h: 3 },
  portrait: { w: 3, h: 4 },
};

// ---- Transparency (Stage 9) ------------------------------------------------
/** A downscaled cell is transparent iff its alpha byte is below this. The SAME
 *  threshold is used by the CPU preview, the GPU shader, and the export, so
 *  see-through is consistent across all three (preview == export). */
export const ALPHA_CUTOFF = 128;

// ---- Grid rule: ONE definition both engines share ---------------------------
// Matches the prototype: round(out / cellSize), floored to a minimum cell count.
/** The long-edge (px) of the aspect frame a source is downscaled into before the
 *  grid rule divides by cellSize/Pixel. Burn's preview frame, the scene "Pixel"
 *  frame, and image-to-grid's PREVIEW_MAX are ALL this one number — kept here (the
 *  single-definition module) so the scene-lattice ↔ Burn-lattice equality can't drift. */
export const FRAME_LONG = 480;
/** Floor on grid size so an extreme cellSize can't produce a degenerate grid.
 *  Distinct from the 8x8 Bayer side and the 8-bit palette depth. */
export const MIN_GRID_CELLS = 8;
/** Grid dimensions in CELLS (lattice width/height), not pixels. */
export interface Grid {
  LW: number;
  LH: number;
}
export const computeGrid = (outW: number, outH: number, cellSize: number): Grid => ({
  LW: Math.max(MIN_GRID_CELLS, Math.round(outW / cellSize)),
  LH: Math.max(MIN_GRID_CELLS, Math.round(outH / cellSize)),
});

// ---- Integer floor-division: the decisive op, mirrored exactly in GLSL ------
// GLSL int '/' truncates toward zero; the shader re-derives true floor for
// negative numerators (see dither.frag.glsl `floorDivPos`). In JS, Math.floor
// on an exact-integer ratio IS true floor, so this is the reference.
export const floorDiv = (num: number, den: number): number => Math.floor(num / den);

export interface QuantizeArgs {
  R: number; // 0..255 int
  G: number; // 0..255 int
  B: number; // 0..255 int
  x: number; // cell column on the LW x LH grid
  y: number; // cell row
  N: number; // palette length
  CT: number; // integer contrast (output of quantizeContrast)
  matrix: MatrixId;
  invert?: boolean;
}

/**
 * THE canonical quantizer. Integer-only. Returns a palette index in [0, N-1].
 * The GPU fragment shader mirrors this line-for-line in `highp int`.
 *
 *   lumI = WR*R + WG*G + WB*B                         in [0, S]
 *   lumC = floorDiv((lumI - S/2) * CT, 4096) + S/2    (contrast about mid-grey)
 *   [invert: lumC = S - lumC]
 *   matrix 2/4/8 :  NUM = lumC*(N-1)*D + t*S ; DEN = S*D
 *   matrix none  :  NUM = lumC*(N-1) + S/2  ; DEN = S        (round-half-up)
 *   idx = clamp(floorDiv(NUM, DEN), 0, N-1)
 *
 * All magnitudes stay < 2^31, so the result is exact in both int32 (GPU) and
 * float64 (JS) — this is what makes preview == export provable.
 */
export function quantizeCell(a: QuantizeArgs): number {
  const lumI = LUMA.WR * a.R + LUMA.WG * a.G + LUMA.WB * a.B;
  return quantizeLum(lumI, a.x, a.y, a.N, a.CT, a.matrix, a.invert);
}

/**
 * The quantizer from an integer LUMA (`lumI` in [0, S]) instead of RGB — the body of
 * `quantizeCell` after its first line, so the two are one truth. A stored
 * element keeps its exact pre-dither luma as `tones·256 + fine`; feeding that here
 * reproduces the cell Burn showed bit-for-bit (an 8-bit tone alone is lumC rounded to
 * 256 steps and can flip a cell that sits on its threshold). Grey RGB (R=G=B=t) gives
 * lumI = 256·t exactly, so `quantizeCell` on a tone == `quantizeLum(256·t)`.
 */
export function quantizeLum(
  lumI: number,
  x: number,
  y: number,
  N: number,
  CT: number,
  matrix: MatrixId,
  invert?: boolean,
): number {
  const S = LUMA_SCALE;
  const H = LUMA_HALF;
  let lumC = floorDiv((lumI - H) * CT, CONTRAST_ONE) + H;
  if (invert) lumC = S - lumC;

  let num: number;
  let den: number;
  if (matrix === 'none') {
    num = lumC * (N - 1) + H;
    den = S;
  } else {
    const D = matrixDenominator(matrix);
    const t = bayerThreshold(matrix, x, y);
    num = lumC * (N - 1) * D + t * S;
    den = S * D;
  }
  let idx = floorDiv(num, den);
  if (idx < 0) idx = 0;
  else if (idx > N - 1) idx = N - 1;
  return idx;
}

/** A treated luma (contrast/invert already applied, `lumC` in [0, S] after clamp) split
 *  into the stored element planes: `tone = floor(lumC/256)` (the 0..255 plane every
 *  halftone/thumbnail reader uses) and
 *  `fine = lumC mod 256` (the low byte that makes the round-trip exact). S/256 = 255. */
export function splitLum(lumC: number): { tone: number; fine: number } {
  const c = lumC < 0 ? 0 : lumC > LUMA_SCALE ? LUMA_SCALE : lumC;
  return { tone: (c / 256) | 0, fine: c & 255 };
}

// ---- Error diffusion (J4) ------------------------------------------------
// The second quantizer family: instead of a threshold table, walk a grid bit by bit, round
// each to the nearest palette level and hand the rounding error to the neighbours not yet
// drawn. Integer-only (lumas in [0, S], levels idx·S/(N−1), the error split by truncating
// division) and a pure function of its inputs, so preview == export holds by construction.
// The grain is the classic one: it follows every change in the picture, so it crawls when
// the picture moves (no "steady" variant — a calm grain is pinned to a
// fixed texture and looks like Blue, so Blue is the calm choice).
// Changing a recipe changes the DEFINITION of the dither and
// re-triggers the golden snapshots in tests/error-diffusion.test.ts.

export type DiffusionId = 'floyd' | 'atkinson' | 'jarvis' | 'stucki' | 'sierra';
/** A Look's Pattern: a threshold table or a diffusion recipe. */
export type PatternId = MatrixId | DiffusionId;

export interface DiffusionKernel {
  /** Weights are divided by this (Atkinson's sum to 6/8: it drops a quarter on purpose). */
  div: number;
  /** [dx, dy, weight] — dx mirrors on right-to-left (serpentine) rows. */
  taps: readonly (readonly [number, number, number])[];
}

// prettier-ignore
export const DIFFUSION: Record<DiffusionId, DiffusionKernel> = {
  floyd: { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  jarvis: { div: 48, taps: [
    [1, 0, 7], [2, 0, 5],
    [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
    [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
  ] },
  stucki: { div: 42, taps: [
    [1, 0, 8], [2, 0, 4],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
  ] },
  sierra: { div: 32, taps: [
    [1, 0, 5], [2, 0, 3],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
    [-1, 2, 2], [0, 2, 3], [1, 2, 2],
  ] },
};
export const DIFFUSION_IDS: DiffusionId[] = ['floyd', 'atkinson', 'jarvis', 'stucki', 'sierra'];
/** Every Pattern, in menu order: the threshold tables, then the diffusion recipes. */
export const PATTERN_IDS: PatternId[] = [...MATRIX_IDS, ...DIFFUSION_IDS];

export const isDiffusion = (p: unknown): p is DiffusionId =>
  typeof p === 'string' && Object.prototype.hasOwnProperty.call(DIFFUSION, p);
/** The threshold table that stands in for a diffusion recipe where only one cell can be
 *  decided at a time (text LED dots, Halftone's Tonal off, the per-cell tone grid). */
export const orderedPattern = (p: PatternId): MatrixId => (isDiffusion(p) ? 'blue' : p);

/**
 * Error-diffuse a w×h grid of integer lumas (each in [0, S]) to palette indices in [0, N−1].
 * Rows run serpentine (left→right on even ABSOLUTE rows, right→left on odd); `j0` is the
 * absolute row of cell (0, 0), so the row direction stays put
 * when the grid is a window onto a larger anchored screen. Cells with mask 0 take no ink and
 * neither receive nor pass on error (a layer's shape is a wall).
 */
export function diffuseLums(
  lum: Int32Array,
  mask: Uint8Array,
  w: number,
  h: number,
  N: number,
  id: DiffusionId,
  j0 = 0,
): Uint8Array {
  const S = LUMA_SCALE;
  const H = LUMA_HALF;
  const { div, taps } = DIFFUSION[id];
  const acc = Int32Array.from(lum);
  const out = new Uint8Array(w * h);
  const step = floorDiv(S, N - 1);
  for (let y = 0; y < h; y++) {
    const rtl = (((y + j0) % 2) + 2) % 2 === 1;
    for (let s = 0; s < w; s++) {
      const x = rtl ? w - 1 - s : s;
      const c = y * w + x;
      if (!mask[c]) continue;
      const v = acc[c];
      let idx = floorDiv(v * (N - 1) + H, S);
      if (idx < 0) idx = 0;
      else if (idx > N - 1) idx = N - 1;
      out[c] = idx;
      const e = v - idx * step;
      if (e === 0) continue;
      for (const [dx0, dy, wt] of taps) {
        const nx = x + (rtl ? -dx0 : dx0);
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const nc = ny * w + nx;
        if (mask[nc]) acc[nc] += Math.trunc((e * wt) / div);
      }
    }
  }
  return out;
}
