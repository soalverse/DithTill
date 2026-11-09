// =============================================================================
// Print screens: every layer draws its OWN screen — dither
// bits or a dot screen at its own size, angle and colour — anchored to the layer,
// and the layers' inks overprint. The one renderer the live canvas and every export
// will call (P3); pure and deterministic (a function of its inputs, no clock, no RNG).
//
// - ANCHOR: a layer's screen origin is its centre rounded to the whole output pixel,
//   and the tone sampling uses that same rounded centre — so moving a layer by whole
//   pixels shifts its output exactly (a marquee never re-samples, never blinks).
// - TURN / SIZE: by default the screen stays UPRIGHT at its set size while the layer
//   turns or grows (its dots are redrawn); `dotsTurn` glues the screen to the layer's
//   rotation + scale instead.
// - The dither decision is the ONE quantizer (`quantizeLum` + the threshold tables in
//   dither-constants); dot edges use the shared coverage functions (cell-style).
// - Text (`led`) keeps its LED rule: one letter dot = one dot / bit on its own cell.
// - Opacity thins the layer (fewer / smaller dots), every dot keeps its full colour.
// - Inks OVERPRINT: lighter where they meet on a dark (or transparent) background,
//   darker on a light one; a `solid` layer first clears what's under its shape.
// =============================================================================
import {
  CONTRAST_ONE,
  LUMA_HALF,
  LUMA_SCALE,
  bayerThreshold,
  floorDiv,
  matrixDenominator,
  paletteLength,
  paletteRgbAt,
  quantizeContrast,
  quantizeLum,
  diffuseLums,
  isDiffusion,
  orderedPattern,
  type MatrixId,
  type PatternId,
  type PaletteId,
} from './dither-constants';
import {
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_SIZE_DEFAULT,
  ROUND_AA_LEVELS,
  halftoneSpacing,
  roundCoverageLevel,
  squareCoverageLevel,
} from './cell-style';
import { CELL_RENDER_SCALE } from './scene-resolver';
import type { Rgb } from './color';
import type { Look, Placement } from '../state/scene-store';

/** A layer's ink: one colour, or dither between a palette's shades. */
export type ScreenColour = { mode: 'ink'; ink: Rgb } | { mode: 'palette'; palette: PaletteId };

/** One layer's look. Pixel sizes are at the live render scale
 *  (CELL_RENDER_SCALE px per scene cell) and scale with the output. */
export interface ScreenLook {
  style: 'dither' | 'halftone';
  colour: ScreenColour;
  /** The Pattern: a threshold table or an error-diffusion recipe (dither bits
   *  only); Halftone's on/off when Tonal is off reads its threshold stand-in. */
  pattern: PatternId;
  /** Dither: one bit's side (px). */
  bitSize: number;
  /** Halftone dot shape. */
  shape: 'circle' | 'square';
  /** Halftone: the largest dot's diameter (px). */
  dotSize: number;
  /** Halftone: how close the dots sit (the Density knob → halftoneSpacing). */
  density: number;
  /** Halftone: dots grow with the tone (on) or keep one size and switch on/off (off). */
  tonal: boolean;
  /** Halftone: the screen's angle (degrees). */
  angle: number;
  /** The screen turns + grows with the layer (off = stays upright at its set size). */
  dotsTurn: boolean;
  /** Grain Drift this frame (J6): how far the screen's grid of bits / dots has slid
   *  over the picture, in canvas squares. Absent = none. */
  grain?: { x: number; y: number };
  /** The tone stage, as today's Look: contrast (UI float), brightness (-255..255), invert. */
  contrast: number;
  brightness: number;
  invert: boolean;
}

/** The Look fields every layer keeps for itself: the left rail's Look.
 *  A new layer starts with the canvas look's (Whole canvas = the look new layers start
 *  with); after that, changing the canvas look leaves existing layers alone. The tone
 *  stage (brightness / contrast / invert) and the dot colour still come from the canvas. */
export const LAYER_LOOK_KEYS = [
  'palette',
  'matrix',
  'dotSize',
  'dotGrow',
  'style',
  'shape',
  'density',
  'angle',
  'dotsTurn',
  'bitSize',
  'colourMode',
  'drift',
  'driftDir',
] as const satisfies readonly (keyof Look)[];

/** The Look's screen fields as the canvas starts: today's Dither, one canvas
 *  square per bit, one ink. (The scene store's Look carries these per layer.) */
export const LOOK_SCREEN_DEFAULT = {
  style: 'dither' as ScreenLook['style'],
  shape: 'circle' as ScreenLook['shape'],
  density: HALFTONE_DENSITY_DEFAULT,
  angle: 45,
  dotsTurn: false,
  bitSize: CELL_RENDER_SCALE,
  colourMode: 'ink' as 'ink' | 'palette',
};

/** The Look's screen fields that mirror a canvas-wide cell style + density: 'square' =
 *  Dither, 'round' / 'block' = Halftone with circle / square dots. */
export function screenLookFromCellStyle(
  cellStyle: string,
  density: number,
): { style: ScreenLook['style']; shape: ScreenLook['shape']; density: number } {
  return {
    style: cellStyle === 'square' ? 'dither' : 'halftone',
    shape: cellStyle === 'block' ? 'square' : 'circle',
    density,
  };
}

export const SCREEN_LOOK_DEFAULT: ScreenLook = {
  style: 'halftone',
  colour: { mode: 'ink', ink: [244, 244, 244] },
  pattern: 8,
  bitSize: CELL_RENDER_SCALE,
  shape: 'circle',
  dotSize: HALFTONE_SIZE_DEFAULT,
  density: HALFTONE_DENSITY_DEFAULT,
  tonal: true,
  angle: 45,
  dotsTurn: false,
  contrast: 1,
  brightness: 0,
  invert: false,
};

/** A layer's pre-dither tones (the scene asset cache's shape). */
export interface ScreenRaster {
  w: number;
  h: number;
  tones: Uint8Array;
  covered: Uint8Array;
  /** Picture values per canvas square (Detail; default 1). */
  per?: number;
}

export interface ScreenLayer {
  raster: ScreenRaster;
  /** Scene-cell placement (the evaluated frame's — motion already folded in). */
  placement: Placement;
  crop?: { x: number; y: number; w: number; h: number } | null;
  look: ScreenLook;
  /** 0..100 (default 100). */
  opacity?: number;
  /** Blocks what's under it inside its shape. */
  solid?: boolean;
  /** Dot-matrix text: every covered cell is one dot / bit on its own cell. */
  led?: boolean;
  /** The animation window: a box fixed on the CANVAS (scene cells) the layer is
   *  seen through as it moves. Only whole marks whose centre is inside it show. */
  window?: { x: number; y: number; w: number; h: number } | null;
}

export interface PrintScreenInput {
  /** Bottom → top. */
  layers: readonly ScreenLayer[];
  /** The canvas in scene cells. */
  dims: { w: number; h: number };
  /** Output px per scene cell. */
  scale: number;
  /** The flat background, or null = transparent (mixes like a dark one). */
  background: Rgb | null;
}

export interface PrintFrame {
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

const L = ROUND_AA_LEVELS;

/** Is this background light (inks darken on it) or dark (inks lighten)? */
export function isLightBackground(bg: Rgb | null): boolean {
  return bg !== null && (77 * bg[0] + 150 * bg[1] + 29 * bg[2]) >> 8 >= 128;
}

// ---- tone sampling: a summed-area table per raster (+ crop), built every frame ------
// Never cached: drawings and video frames are rewritten IN PLACE (a brush stroke, the
// next video frame), so the same array can hold a new picture on the next frame.
interface Sat {
  w: number;
  sum: Float64Array;
  cnt: Float64Array;
}
function satOf(r: ScreenRaster, crop: ScreenLayer['crop']): Sat {
  const W1 = r.w + 1;
  const sum = new Float64Array(W1 * (r.h + 1));
  const cnt = new Float64Array(W1 * (r.h + 1));
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const inCrop =
        !crop || (x >= crop.x && x < crop.x + crop.w && y >= crop.y && y < crop.y + crop.h);
      const c = inCrop && r.covered[y * r.w + x] ? 1 : 0;
      const i = (y + 1) * W1 + x + 1;
      sum[i] = c * r.tones[y * r.w + x] + sum[i - 1] + sum[i - W1] - sum[i - W1 - 1];
      cnt[i] = c + cnt[i - 1] + cnt[i - W1] - cnt[i - W1 - 1];
    }
  }
  return { w: r.w, sum, cnt };
}
/** Mean tone of the covered cells in a box around (ex, ey) of half-size `half` (raster
 *  cells), and the covered share of the box. A box under one cell reads that cell. */
function sampleBox(
  r: ScreenRaster,
  sat: Sat,
  ex: number,
  ey: number,
  half: number,
): { tone: number; cov: number } {
  let x0: number, x1: number, y0: number, y1: number;
  if (half < 0.5) {
    x0 = Math.floor(ex);
    y0 = Math.floor(ey);
    x1 = x0 + 1;
    y1 = y0 + 1;
  } else {
    x0 = Math.round(ex - half);
    x1 = Math.round(ex + half);
    y0 = Math.round(ey - half);
    y1 = Math.round(ey + half);
  }
  const n = (x1 - x0) * (y1 - y0);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(r.w, x1);
  y1 = Math.min(r.h, y1);
  if (x1 <= x0 || y1 <= y0 || n <= 0) return { tone: 0, cov: 0 };
  const W1 = sat.w + 1;
  const at = (t: Float64Array) =>
    t[y1 * W1 + x1] - t[y0 * W1 + x1] - t[y1 * W1 + x0] + t[y0 * W1 + x0];
  const c = at(sat.cnt);
  return c > 0 ? { tone: at(sat.sum) / c, cov: c / n } : { tone: 0, cov: 0 };
}

/** A sampled tone through the layer's tone stage + opacity → integer luma in [0, S]. */
function treat(tone: number, look: ScreenLook, CT: number, opacity: number): number {
  const S = LUMA_SCALE;
  let lum = Math.round((tone + look.brightness) * 256);
  lum = lum < 0 ? 0 : lum > S ? S : lum;
  lum = floorDiv((lum - LUMA_HALF) * CT, CONTRAST_ONE) + LUMA_HALF;
  lum = lum < 0 ? 0 : lum > S ? S : lum;
  if (look.invert) lum = S - lum;
  return opacity >= 100 ? lum : Math.floor((lum * Math.max(0, opacity)) / 100);
}

/** Halftone with Tonal off: is the fixed-size dot at screen cell (i, j) on? */
function fmOn(lum: number, pattern: MatrixId, i: number, j: number): boolean {
  if (pattern === 'none') return lum * 2 >= LUMA_SCALE;
  const D = matrixDenominator(pattern);
  return lum * D > (bayerThreshold(pattern, i, j) + 0.5) * LUMA_SCALE;
}

const pack = (c: Rgb): number => (c[0] << 16) | (c[1] << 8) | c[2];

/** Render one frame: every layer's own screen, overprinted, as RGBA. */
export function renderPrintScreen(input: PrintScreenInput): PrintFrame {
  const { dims, scale, background } = input;
  const W = Math.round(dims.w * scale);
  const H = Math.round(dims.h * scale);
  const n = W * H;
  const light = isLightBackground(background);
  // Flat background: the RGB planes start as it. Transparent: track each channel's
  // strongest ink × coverage and the coverage itself (like light on a dark ground).
  const R = new Uint16Array(n);
  const G = new Uint16Array(n);
  const B = new Uint16Array(n);
  const A = new Uint8Array(n);
  if (background) {
    R.fill(background[0]);
    G.fill(background[1]);
    B.fill(background[2]);
  }
  for (const layer of input.layers) drawLayer(layer, W, H, scale, background, light, R, G, B, A);
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (background) {
      rgba[o] = R[i];
      rgba[o + 1] = G[i];
      rgba[o + 2] = B[i];
      rgba[o + 3] = 255;
    } else if (A[i] > 0) {
      rgba[o] = Math.round(R[i] / A[i]);
      rgba[o + 1] = Math.round(G[i] / A[i]);
      rgba[o + 2] = Math.round(B[i] / A[i]);
      rgba[o + 3] = Math.round((A[i] / L) * 255);
    }
  }
  return { w: W, h: H, rgba };
}

/** Where a layer's marks go when it is drawn as VECTORS (the SVG export) instead of pixels:
 *  each dot / bit with its screen matrix, and the rows of its shape a Solid layer clears. */
interface VectorSink {
  mark: (
    kind: 'circle' | 'square' | 'bit',
    m: number[],
    x: number,
    y: number,
    rad: number,
    colour: number,
  ) => void;
  solidRun: (x0: number, x1: number, y: number) => void;
}

function drawLayer(
  layer: ScreenLayer,
  W: number,
  H: number,
  scale: number,
  background: Rgb | null,
  light: boolean,
  R: Uint16Array,
  G: Uint16Array,
  B: Uint16Array,
  A: Uint8Array,
  sink?: VectorSink,
): void {
  const opacity = layer.opacity ?? 100;
  const r = layer.raster;
  if (opacity <= 0 || r.w <= 0 || r.h <= 0) return;
  const look = layer.look;
  const crop = layer.crop ?? null;
  const p = layer.placement;
  const k = scale / CELL_RENDER_SCALE;
  // Raster cells → scene cells: the placement's scale over the picture's density.
  const per = r.per ?? 1;
  const psx = p.scaleX || 1e-6; // the layer's own size (the screen follows this)
  const psy = p.scaleY || 1e-6;
  const sx = psx / per;
  const sy = psy / per;
  const th = (p.rotationDeg * Math.PI) / 180;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  // The anchor: the layer's centre on the whole output pixel.
  const cxp = Math.round(p.x * scale);
  const cyp = Math.round(p.y * scale);
  // Output px (continuous) → raster cell coords (continuous), about the anchor.
  const toRaster = (X: number, Y: number): [number, number] => {
    const dx = X - cxp;
    const dy = Y - cyp;
    return [
      r.w / 2 + (dx * ct + dy * st) / (sx * scale),
      r.h / 2 + (-dx * st + dy * ct) / (sy * scale),
    ];
  };
  const toOutput = (ex: number, ey: number): [number, number] => {
    const u = (ex - r.w / 2) * sx * scale;
    const v = (ey - r.h / 2) * sy * scale;
    return [cxp + u * ct - v * st, cyp + u * st + v * ct];
  };
  const inShape = (ex: number, ey: number): boolean => {
    const x = Math.floor(ex);
    const y = Math.floor(ey);
    if (x < 0 || y < 0 || x >= r.w || y >= r.h) return false;
    if (crop && (x < crop.x || x >= crop.x + crop.w || y < crop.y || y >= crop.y + crop.h))
      return false;
    return r.covered[y * r.w + x] === 1;
  };

  // The screen: screen units → output px offset from the anchor, M = [m00 m01; m10 m11].
  // Upright = just the screen angle; dotsTurn = the layer's turn + size, then the angle.
  const al = look.style === 'halftone' ? (look.angle * Math.PI) / 180 : 0;
  const ca = Math.cos(al);
  const sa = Math.sin(al);
  const turn = look.dotsTurn;
  const mScreen = (cosA: number, sinA: number): number[] =>
    turn
      ? [
          ct * psx * cosA - st * psy * sinA,
          -ct * psx * sinA - st * psy * cosA,
          st * psx * cosA + ct * psy * sinA,
          -st * psx * sinA + ct * psy * cosA,
        ]
      : [cosA, -sinA, sinA, cosA];
  const sAvg = Math.sqrt(Math.abs(psx * psy));
  const f = turn ? sAvg : 1; // screen unit → output px (for dot edges)

  // The layer's output box (its raster or crop corners), widened for whole dots.
  const cx0 = crop ? crop.x : 0;
  const cy0 = crop ? crop.y : 0;
  const cx1 = crop ? crop.x + crop.w : r.w;
  const cy1 = crop ? crop.y + crop.h : r.h;
  const corners = [toOutput(cx0, cy0), toOutput(cx1, cy0), toOutput(cx0, cy1), toOutput(cx1, cy1)];
  const big =
    Math.max(look.dotSize, look.bitSize, halftoneSpacing(look.density)) * k * Math.max(1, f) + 2;
  // The animation window in output px (whole pixels): marks whose centre is inside
  // show whole, so the box is widened by a mark's reach.
  const win = layer.window ?? null;
  const wx0 = win ? Math.round(win.x * scale) : 0;
  const wy0 = win ? Math.round(win.y * scale) : 0;
  const wx1 = win ? Math.round((win.x + win.w) * scale) : W;
  const wy1 = win ? Math.round((win.y + win.h) * scale) : H;
  const pad = win ? Math.ceil(big) : 0;
  const bx0 = Math.max(0, wx0 - pad, Math.floor(Math.min(...corners.map((c) => c[0])) - big));
  const by0 = Math.max(0, wy0 - pad, Math.floor(Math.min(...corners.map((c) => c[1])) - big));
  const bx1 = Math.min(W, wx1 + pad, Math.ceil(Math.max(...corners.map((c) => c[0])) + big));
  const by1 = Math.min(H, wy1 + pad, Math.ceil(Math.max(...corners.map((c) => c[1])) + big));
  if (bx1 <= bx0 || by1 <= by0) return;
  const bw = bx1 - bx0;
  const lvl = new Uint8Array(bw * (by1 - by0));
  const col = new Int32Array(bw * (by1 - by0));
  const mark = (X: number, Y: number, level: number, c: number): void => {
    if (X < bx0 || Y < by0 || X >= bx1 || Y >= by1 || level <= 0) return;
    const i = (Y - by0) * bw + (X - bx0);
    if (level > lvl[i]) {
      lvl[i] = level;
      col[i] = c;
    }
  };

  const N = look.colour.mode === 'palette' ? paletteLength(look.colour.palette) : 2;
  const colourAt = (idx: number): number =>
    look.colour.mode === 'palette'
      ? pack(paletteRgbAt(look.colour.palette, idx))
      : pack(look.colour.ink);
  const CT = quantizeContrast(look.contrast);

  /** Stamp one mark centred at output (Xc, Yc), oriented by the screen matrix `m`:
   *  a disc / square of radius `rad` (screen units), or a hard square bit of half-side `rad`. */
  const stamp = (
    m: number[],
    Xc: number,
    Yc: number,
    rad: number,
    kind: 'circle' | 'square' | 'bit',
    c: number,
  ) => {
    if (win && (Xc < wx0 || Yc < wy0 || Xc >= wx1 || Yc >= wy1)) return;
    if (sink) return sink.mark(kind, m, Xc, Yc, rad, c);
    const det = m[0] * m[3] - m[1] * m[2];
    const i00 = m[3] / det;
    const i01 = -m[1] / det;
    const i10 = -m[2] / det;
    const i11 = m[0] / det;
    const reach =
      rad * Math.max(Math.abs(m[0]) + Math.abs(m[1]), Math.abs(m[2]) + Math.abs(m[3])) + 1;
    const fr = f;
    for (let Y = Math.floor(Yc - reach); Y <= Math.ceil(Yc + reach); Y++) {
      for (let X = Math.floor(Xc - reach); X <= Math.ceil(Xc + reach); X++) {
        const dx = X + 0.5 - Xc;
        const dy = Y + 0.5 - Yc;
        const a = i00 * dx + i01 * dy;
        const b = i10 * dx + i11 * dy;
        let level: number;
        if (kind === 'bit') level = a >= -rad && a < rad && b >= -rad && b < rad ? L : 0;
        else if (kind === 'circle')
          level = roundCoverageLevel(Math.sqrt(a * a + b * b) * fr, rad * fr);
        else level = squareCoverageLevel(a * fr, b * fr, rad * fr);
        mark(X, Y, level, c);
      }
    }
  };

  if (layer.led) {
    // Text: one dot / bit per covered cell, on the cell's own centre; no screen angle.
    const m = mScreen(1, 0);
    const ledPattern = orderedPattern(look.pattern);
    for (let ey = cy0; ey < cy1; ey++) {
      for (let ex = cx0; ex < cx1; ex++) {
        if (!inShape(ex + 0.5, ey + 0.5)) continue;
        const lum = treat(r.tones[ey * r.w + ex], look, CT, opacity);
        const [Xc, Yc] = toOutput(ex + 0.5, ey + 0.5);
        if (look.style === 'dither') {
          const idx = quantizeLum(lum, ex, ey, N, CONTRAST_ONE, ledPattern, false);
          if (idx > 0) stamp(m, Xc, Yc, Math.max(1, look.bitSize * k) / 2, 'bit', colourAt(idx));
        } else {
          const level = lum / LUMA_SCALE;
          const on = look.tonal ? level > 0 : fmOn(lum, ledPattern, ex, ey);
          const rad = ((look.dotSize * k) / 2) * (look.tonal ? Math.sqrt(level) : 1);
          if (on && rad > 0) stamp(m, Xc, Yc, rad, look.shape, colourAt(paletteIdx(level, N)));
        }
      }
    }
  } else {
    // The layer's own screen: cells of `cs` screen units on axes anchored at the centre.
    const m = mScreen(ca, sa);
    // Grain Drift (J6): the grid of bits / dots slides; the picture under it stays put.
    const gxp = cxp + (look.grain ? look.grain.x * scale : 0);
    const gyp = cyp + (look.grain ? look.grain.y * scale : 0);
    const det = m[0] * m[3] - m[1] * m[2];
    const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
    const dither = look.style === 'dither';
    const cs = dither
      ? Math.max(1, Math.round(look.bitSize * k))
      : halftoneSpacing(look.density) * k;
    // Screen-cell range covering the box.
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [X, Y] of [
      [bx0, by0],
      [bx1, by0],
      [bx0, by1],
      [bx1, by1],
    ]) {
      const dx = X - gxp;
      const dy = Y - gyp;
      const a = inv[0] * dx + inv[1] * dy;
      const b = inv[2] * dx + inv[3] * dy;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const sat = satOf(r, crop);
    const half = (cs * f * per) / (2 * scale * sAvg); // one screen cell, in raster cells
    const diff = dither && isDiffusion(look.pattern) ? look.pattern : null;
    if (diff) {
      // Error diffusion: sample every bit of the layer over its UNCLIPPED extent,
      // diffuse, then stamp. The grid is anchored like the threshold tables (serpentine rows
      // by absolute bit), so moving the layer or sliding it out of the
      // frame shifts its bits exactly and never re-runs the diffusion differently.
      let ua0 = Infinity;
      let ua1 = -Infinity;
      let ub0 = Infinity;
      let ub1 = -Infinity;
      for (const [X, Y] of corners) {
        const dx = X - gxp;
        const dy = Y - gyp;
        const a = inv[0] * dx + inv[1] * dy;
        const b = inv[2] * dx + inv[3] * dy;
        ua0 = Math.min(ua0, a);
        ua1 = Math.max(ua1, a);
        ub0 = Math.min(ub0, b);
        ub1 = Math.max(ub1, b);
      }
      const i0 = Math.floor(ua0 / cs) - 1;
      const j0 = Math.floor(ub0 / cs) - 1;
      const gw = Math.floor(ua1 / cs) + 2 - i0;
      const gh = Math.floor(ub1 / cs) + 2 - j0;
      const lums = new Int32Array(gw * gh);
      const mask = new Uint8Array(gw * gh);
      for (let gj = 0; gj < gh; gj++) {
        for (let gi = 0; gi < gw; gi++) {
          const ac = (gi + i0 + 0.5) * cs;
          const bc = (gj + j0 + 0.5) * cs;
          const [ex, ey] = toRaster(gxp + m[0] * ac + m[1] * bc, gyp + m[2] * ac + m[3] * bc);
          const sm = sampleBox(r, sat, ex, ey, half);
          if (sm.cov < 0.5) continue;
          mask[gj * gw + gi] = 1;
          lums[gj * gw + gi] = treat(sm.tone, look, CT, opacity);
        }
      }
      const idxs = diffuseLums(lums, mask, gw, gh, N, diff, j0);
      for (let gj = 0; gj < gh; gj++) {
        for (let gi = 0; gi < gw; gi++) {
          const idx = idxs[gj * gw + gi];
          if (!idx) continue;
          const ac = (gi + i0 + 0.5) * cs;
          const bc = (gj + j0 + 0.5) * cs;
          const Xc = gxp + m[0] * ac + m[1] * bc;
          const Yc = gyp + m[2] * ac + m[3] * bc;
          if (Xc < bx0 - cs || Yc < by0 - cs || Xc > bx1 + cs || Yc > by1 + cs) continue;
          stamp(m, Xc, Yc, cs / 2, 'bit', colourAt(idx));
        }
      }
    } else {
      for (let j = Math.floor(b0 / cs) - 1; j <= Math.floor(b1 / cs) + 1; j++) {
        for (let i = Math.floor(a0 / cs) - 1; i <= Math.floor(a1 / cs) + 1; i++) {
          const ac = (i + 0.5) * cs;
          const bc = (j + 0.5) * cs;
          const Xc = gxp + m[0] * ac + m[1] * bc;
          const Yc = gyp + m[2] * ac + m[3] * bc;
          if (Xc < bx0 - cs || Yc < by0 - cs || Xc > bx1 + cs || Yc > by1 + cs) continue;
          const [ex, ey] = toRaster(Xc, Yc);
          const s = sampleBox(r, sat, ex, ey, half);
          if (s.cov < 0.5) continue;
          const lum = treat(s.tone, look, CT, opacity);
          if (dither) {
            const idx = quantizeLum(
              lum,
              i,
              j,
              N,
              CONTRAST_ONE,
              orderedPattern(look.pattern),
              false,
            );
            if (idx > 0) stamp(m, Xc, Yc, cs / 2, 'bit', colourAt(idx));
          } else {
            const level = lum / LUMA_SCALE;
            const on = look.tonal ? level > 0 : fmOn(lum, orderedPattern(look.pattern), i, j);
            const rad = ((look.dotSize * k) / 2) * (look.tonal ? Math.sqrt(level) : 1);
            if (on && rad > 0) stamp(m, Xc, Yc, rad, look.shape, colourAt(paletteIdx(level, N)));
          }
        }
      }
    }
  }

  if (sink) {
    // Vectors: a Solid layer's shape as pixel rows (it clears what's under it).
    if (layer.solid)
      for (let Y = Math.max(by0, wy0); Y < Math.min(by1, wy1); Y++) {
        let run = -1;
        const x1 = Math.min(bx1, wx1);
        for (let X = Math.max(bx0, wx0); X <= x1; X++) {
          const [ex, ey] = toRaster(X + 0.5, Y + 0.5);
          const inside = X < x1 && inShape(ex, ey);
          if (inside && run < 0) run = X;
          else if (!inside && run >= 0) {
            sink.solidRun(run, X, Y);
            run = -1;
          }
        }
      }
    return;
  }
  // Solid: clear what's below inside this layer's shape, then lay its ink.
  if (layer.solid) {
    for (let Y = Math.max(by0, wy0); Y < Math.min(by1, wy1); Y++) {
      for (let X = Math.max(bx0, wx0); X < Math.min(bx1, wx1); X++) {
        const [ex, ey] = toRaster(X + 0.5, Y + 0.5);
        if (!inShape(ex, ey)) continue;
        const i = Y * W + X;
        if (background) {
          R[i] = background[0];
          G[i] = background[1];
          B[i] = background[2];
        } else {
          R[i] = G[i] = B[i] = 0;
          A[i] = 0;
        }
      }
    }
  }
  // Overprint the layer's ink.
  for (let Y = by0; Y < by1; Y++) {
    for (let X = bx0; X < bx1; X++) {
      const li = (Y - by0) * bw + (X - bx0);
      const level = lvl[li];
      if (level === 0) continue;
      const c = col[li];
      const ink: Rgb = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      const i = Y * W + X;
      if (background) {
        const t = level / L;
        const v0 = Math.round(background[0] + (ink[0] - background[0]) * t);
        const v1 = Math.round(background[1] + (ink[1] - background[1]) * t);
        const v2 = Math.round(background[2] + (ink[2] - background[2]) * t);
        if (light) {
          R[i] = Math.min(R[i], v0);
          G[i] = Math.min(G[i], v1);
          B[i] = Math.min(B[i], v2);
        } else {
          R[i] = Math.max(R[i], v0);
          G[i] = Math.max(G[i], v1);
          B[i] = Math.max(B[i], v2);
        }
      } else {
        // Transparent: strongest ink × coverage per channel, coverage = the max.
        R[i] = Math.max(R[i], ink[0] * level);
        G[i] = Math.max(G[i], ink[1] * level);
        B[i] = Math.max(B[i], ink[2] * level);
        if (level > A[i]) A[i] = level;
      }
    }
  }
}

/** A Palette-mode halftone dot's shade: its tone picks the ramp step (never the darkest,
 *  which is "no ink" on the dark glass). One-ink layers ignore it. */
function paletteIdx(level: number, N: number): number {
  const i = Math.round(level * (N - 1));
  return i < 1 ? 1 : i > N - 1 ? N - 1 : i;
}

// ---- the SVG export ------------------------------------------------------

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');
const n2 = (v: number): string => String(Math.round(v * 100) / 100);

/** The same frame as `renderPrintScreen`, as an SVG: every layer's dots and bits as vector
 *  shapes (grouped by colour), overprinting with the same rule (lighten on a dark or
 *  transparent background, darken on a light one, via mix-blend-mode); a Solid layer first
 *  paints its shape in the background colour (black on a transparent canvas). */
export function printScreenSvg(input: PrintScreenInput): string {
  const { dims, scale, background } = input;
  const W = Math.round(dims.w * scale);
  const H = Math.round(dims.h * scale);
  const light = isLightBackground(background);
  const blend = light ? 'darken' : 'lighten';
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  ];
  if (background) out.push(`<rect width="${W}" height="${H}" fill="${hex(pack(background))}"/>`);
  const none = new Uint16Array(0);
  for (const layer of input.layers) {
    const paths = new Map<number, string[]>();
    const solid: string[] = [];
    drawLayer(layer, W, H, scale, background, light, none, none, none, new Uint8Array(0), {
      mark: (kind, m, x, y, rad, colour) => {
        let d: string;
        if (kind === 'circle') {
          // An upright (or uniformly turned) dot: a circle of its on-screen radius.
          const r = rad * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
          d = `M${n2(x - r)} ${n2(y)}a${n2(r)} ${n2(r)} 0 1 0 ${n2(2 * r)} 0a${n2(r)} ${n2(r)} 0 1 0 ${n2(-2 * r)} 0z`;
        } else {
          const pt = (a: number, b: number) =>
            `${n2(x + m[0] * a + m[1] * b)} ${n2(y + m[2] * a + m[3] * b)}`;
          d = `M${pt(-rad, -rad)}L${pt(rad, -rad)}L${pt(rad, rad)}L${pt(-rad, rad)}z`;
        }
        let list = paths.get(colour);
        if (!list) paths.set(colour, (list = []));
        list.push(d);
      },
      solidRun: (x0, x1, y) => solid.push(`M${x0} ${y}h${x1 - x0}v1h${x0 - x1}z`),
    });
    if (solid.length)
      out.push(
        `<path fill="${background ? hex(pack(background)) : '#000000'}" d="${solid.join('')}"/>`,
      );
    if (paths.size) {
      out.push(`<g style="mix-blend-mode:${blend}">`);
      for (const [colour, list] of paths)
        out.push(`<path fill="${hex(colour)}" d="${list.join('')}"/>`);
      out.push('</g>');
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
