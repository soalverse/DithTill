// =============================================================================
// Layer effects (J5): what a layer's picture goes through BEFORE its dots — the
// six effects on its pre-dither tones (never on dots), in one fixed order:
//   Mirror → Kaleidoscope → Wave → Blur → Posterize → Outline → Trail.
// Trail needs the layer's past frames, so it is drawn by the layer adapter (core/layer-trail),
// not here.
// Pure and deterministic: a new raster from the old one, never cached (drawings and video
// frames are rewritten in place). Sizes are in canvas squares, scaled by the picture's
// Detail (`per`), so an effect looks the same at Normal and Fine. Effects work on the
// layer's own cells, so they turn and grow with the layer; Mirror / Kaleidoscope / Wave move
// the picture's coverage too (a drawing's shape mirrors with it).
// =============================================================================
import type { CachedAsset } from './scene-resolver';

export type MirrorMode = 'lr' | 'tb' | 'quad';
export type TrailKind = 'echo' | 'smear';

/** A layer's effects: one optional entry per kind (present = on). */
export interface LayerFx {
  mirror?: { mode: MirrorMode };
  kaleido?: { wedges: number; turn: number };
  wave?: { amount: number; size: number; flow: number };
  blur?: { radius: number };
  posterize?: { steps: number };
  outline?: { strength: number };
  /** Trail (step 2): Echo = fading copies where the layer was; Smear = its picture keeps
   *  the brightest of its recent past. Length in beats, Fade 0..100. */
  trail?: { kind: TrailKind; length: number; fade: number };
}
export type FxKind = keyof LayerFx;

/** The fixed order effects apply in, which is also the list's order. */
export const FX_ORDER: readonly FxKind[] = [
  'mirror',
  'kaleido',
  'wave',
  'blur',
  'posterize',
  'outline',
  'trail',
];

export const FX_LABEL: Record<FxKind, string> = {
  mirror: 'Mirror',
  kaleido: 'Kaleidoscope',
  wave: 'Wave',
  blur: 'Blur',
  posterize: 'Posterize',
  outline: 'Outline',
  trail: 'Trail',
};

/** What an effect starts at when it is added. */
export const FX_DEFAULT: { [K in FxKind]-?: NonNullable<LayerFx[K]> } = {
  mirror: { mode: 'lr' },
  kaleido: { wedges: 6, turn: 0 },
  wave: { amount: 3, size: 16, flow: 0 },
  blur: { radius: 2 },
  posterize: { steps: 4 },
  outline: { strength: 50 },
  trail: { kind: 'echo', length: 1, fade: 60 },
};

export const TRAIL_KINDS: readonly TrailKind[] = ['echo', 'smear'];
export const TRAIL_LABEL: Record<TrailKind, string> = { echo: 'Echo', smear: 'Smear' };

export const MIRROR_MODES: readonly MirrorMode[] = ['lr', 'tb', 'quad'];
export const MIRROR_LABEL: Record<MirrorMode, string> = {
  lr: 'Left–right',
  tb: 'Top–bottom',
  quad: '4-way',
};

/** Slider ranges (stored units). */
export const FX_RANGE = {
  blur: { min: 0, max: 10 },
  posterize: { min: 2, max: 8 },
  outline: { min: 0, max: 100 },
  wedges: { min: 3, max: 12 },
  turn: { min: 0, max: 360 },
  waveAmount: { min: 0, max: 20 },
  waveSize: { min: 2, max: 60 },
  waveFlow: { min: 0, max: 100 },
  trailLength: { min: 0.25, max: 4 },
  trailFade: { min: 0, max: 100 },
} as const;

/** Does this layer have any effect? */
export const hasFx = (fx: LayerFx | undefined): fx is LayerFx =>
  !!fx && FX_ORDER.some((k) => fx[k] !== undefined);

type Raster = Pick<CachedAsset, 'w' | 'h' | 'tones' | 'covered' | 'per'>;

/** The layer's raster through its effects (the original when it has none). Only tones,
 *  coverage and Detail travel: an effected picture drops its exact-luma / ink planes. */
export function applyLayerFx<R extends Raster>(r: R, fx: LayerFx | undefined): R | CachedAsset {
  if (!hasFx(fx) || FX_ORDER.every((k) => k === 'trail' || fx[k] === undefined)) return r;
  let cur: CachedAsset = {
    w: r.w,
    h: r.h,
    tones: r.tones,
    covered: r.covered,
    ...(r.per ? { per: r.per } : {}),
  };
  const per = r.per ?? 1;
  if (fx.mirror) cur = mirror(cur, fx.mirror.mode);
  if (fx.kaleido) cur = kaleido(cur, fx.kaleido.wedges, fx.kaleido.turn);
  if (fx.wave) cur = wave(cur, fx.wave.amount * per, fx.wave.size * per, fx.wave.flow);
  if (fx.blur) cur = blur(cur, Math.round(fx.blur.radius * per));
  if (fx.posterize) cur = posterize(cur, fx.posterize.steps);
  if (fx.outline) cur = outline(cur, fx.outline.strength);
  return cur;
}

const fresh = (r: CachedAsset): CachedAsset => ({
  w: r.w,
  h: r.h,
  tones: new Uint8Array(r.w * r.h),
  covered: new Uint8Array(r.w * r.h),
  ...(r.per ? { per: r.per } : {}),
});

/** Copy cell (sx, sy) of `r` into cell i of `o` (outside the picture = uncovered). */
function take(r: CachedAsset, o: CachedAsset, i: number, sx: number, sy: number): void {
  if (sx < 0 || sy < 0 || sx >= r.w || sy >= r.h) return;
  const j = sy * r.w + sx;
  o.tones[i] = r.tones[j];
  o.covered[i] = r.covered[j];
}

/** Mirror: the left (top) half reflected onto the right (bottom); 4-way = both. */
function mirror(r: CachedAsset, mode: MirrorMode): CachedAsset {
  const o = fresh(r);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const sx = mode !== 'tb' && 2 * x >= r.w ? r.w - 1 - x : x;
      const sy = mode !== 'lr' && 2 * y >= r.h ? r.h - 1 - y : y;
      take(r, o, y * r.w + x, sx, sy);
    }
  return o;
}

/** A cell index folded back into [0, n) like a mirror (… 2 1 0 | 0 1 2 … n−1 | n−1 …). */
function reflect(v: number, n: number): number {
  const m = ((v % (2 * n)) + 2 * n) % (2 * n);
  return m < n ? m : 2 * n - 1 - m;
}

/** Kaleidoscope: `n` mirrored wedges about the middle; `turn` (degrees) spins them. */
function kaleido(r: CachedAsset, n: number, turn: number): CachedAsset {
  const o = fresh(r);
  const wedges = Math.max(2, Math.round(n));
  const wedge = Math.PI / wedges;
  const cx = r.w / 2;
  const cy = r.h / 2;
  const t = (turn * Math.PI) / 180;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rr = Math.sqrt(dx * dx + dy * dy);
      let a = Math.atan2(dy, dx) - t;
      a = ((a % (2 * wedge)) + 2 * wedge) % (2 * wedge);
      if (a > wedge) a = 2 * wedge - a;
      // Sample the picture's own wedge (turned with it), so a spin turns the pattern; past the
      // picture's edge the sample reflects back in, so the kaleidoscope fills the frame.
      const b = a + t;
      const sx = reflect(Math.floor(cx + rr * Math.cos(b)), r.w);
      const sy = reflect(Math.floor(cy + rr * Math.sin(b)), r.h);
      take(r, o, y * r.w + x, sx, sy);
    }
  return o;
}

/** Wave: each row slides sideways along a sine `size` cells long; `flow` (0..100) moves it. */
function wave(r: CachedAsset, amount: number, size: number, flow: number): CachedAsset {
  const o = fresh(r);
  const len = Math.max(1, size);
  for (let y = 0; y < r.h; y++) {
    const dx = Math.round(amount * Math.sin(2 * Math.PI * (y / len + flow / 100)));
    for (let x = 0; x < r.w; x++) take(r, o, y * r.w + x, x - dx, y);
  }
  return o;
}

/** Blur: a box blur of `rad` cells over the covered cells only (the shape keeps its edge,
 *  uncovered cells never darken it). Two separable passes, integer sums. */
function blur(r: CachedAsset, rad: number): CachedAsset {
  if (rad <= 0) return r;
  const { w, h, tones, covered } = r;
  const sumH = new Float64Array(w * h);
  const cntH = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    let c = 0;
    const row = y * w;
    for (let x = -rad; x < w; x++) {
      const add = x + rad;
      if (add < w && covered[row + add]) {
        s += tones[row + add];
        c++;
      }
      const drop = x - rad - 1;
      if (drop >= 0 && covered[row + drop]) {
        s -= tones[row + drop];
        c--;
      }
      if (x >= 0) {
        sumH[row + x] = s;
        cntH[row + x] = c;
      }
    }
  }
  const o: CachedAsset = { ...fresh(r), covered: covered.slice() };
  for (let x = 0; x < w; x++) {
    let s = 0;
    let c = 0;
    for (let y = -rad; y < h; y++) {
      const add = y + rad;
      if (add < h) {
        s += sumH[add * w + x];
        c += cntH[add * w + x];
      }
      const drop = y - rad - 1;
      if (drop >= 0) {
        s -= sumH[drop * w + x];
        c -= cntH[drop * w + x];
      }
      if (y >= 0) {
        const i = y * w + x;
        o.tones[i] = covered[i] && c > 0 ? Math.round(s / c) : tones[i];
      }
    }
  }
  return o;
}

/** Posterize: `steps` flat tone bands, black and white included. */
function posterize(r: CachedAsset, steps: number): CachedAsset {
  const n = Math.max(2, Math.round(steps));
  const o: CachedAsset = { ...fresh(r), covered: r.covered.slice() };
  for (let i = 0; i < r.tones.length; i++)
    o.tones[i] = Math.round((Math.round((r.tones[i] * (n - 1)) / 255) * 255) / (n - 1));
  return o;
}

/** Outline: bright where the tone (or the layer's edge) changes, dark elsewhere (a Sobel
 *  edge strength); `strength` 0..100 sets how bright an edge gets. Keeps the shape. */
function outline(r: CachedAsset, strength: number): CachedAsset {
  const { w, h, tones, covered } = r;
  const o: CachedAsset = { ...fresh(r), covered: covered.slice() };
  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const i = cy * w + cx;
    return covered[i] ? tones[i] : 0;
  };
  const gain = strength / 25;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1);
      const v = Math.round((Math.sqrt(gx * gx + gy * gy) / 4) * gain);
      o.tones[y * w + x] = v > 255 ? 255 : v;
    }
  return o;
}
