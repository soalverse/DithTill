// =============================================================================
// MODULATORS (Group J2,: "any setting can move on its
// own", the FL Studio way). A slider's move runs between two values, FROM → TO:
//   - on the BEAT (FL's LFO): a shape and one swing's length in BEATS on the project's beat
//     clock (core/tempo) carry it from FROM to TO and back;
//   - with the SOUND (FL's Peak Controller): Bass / Mid / Treble / Beat / Everything — it
//     sits at FROM when it's quiet and reaches TO on loud parts, with a Smoothness.
// Or it follows a DRAWN line (J2b, FL's automation clip): dots on a lane under the layer in
// the timeline, over the whole video (absolute frames), each line Smooth / Straight / Jump;
// before the first dot and after the last it holds.
// The result is always kept inside the slider's own range (MOD_RANGE).
//
// PURE: no DOM, no store, no wall clock. A modulated value is a function of (the modulator, the ABSOLUTE frame, the beat clock, the frame-indexed features),
// evaluated inside evaluateScene — the ONE seam the live canvas and every exported frame
// share — so preview == export by construction. The Random shape draws from a keyed hash
// of (the modulator's key, the cycle number), never Math.random.
// =============================================================================
import { FX_RANGE } from './layer-fx';
import type { FeatureArray } from './audio-features';
import {
  BIT_SIZE_MAX,
  BIT_SIZE_MIN,
  HALFTONE_DENSITY_MAX,
  HALFTONE_DENSITY_MIN,
  HALFTONE_SIZE_MAX,
  HALFTONE_SIZE_MIN,
} from './cell-style';
import { TEXT_SIZE_MAX, TEXT_SPACING_MAX } from './dot-font';
import { beatAt, beatSpanLoops, type BeatClock } from './tempo';
import { vizFeature } from './visualizer';

/** Grain Drift's fastest (canvas squares per beat, J6). */
export const DRIFT_MAX = 8;

/** Wave shapes, in the panel's order. */
export const MOD_SHAPES = ['smooth', 'zigzag', 'rampUp', 'rampDown', 'onoff', 'random'] as const;
export type ModShape = (typeof MOD_SHAPES)[number];

export const MOD_SHAPE_LABEL: Record<ModShape, string> = {
  smooth: 'Smooth',
  zigzag: 'Zigzag',
  rampUp: 'Ramp up',
  rampDown: 'Ramp down',
  onoff: 'On / off',
  random: 'Random',
};

/** What Follow sound listens to (the visualizer's bands). */
export type ModBand = 'low' | 'mid' | 'high' | 'onset' | 'rms';

export interface WaveMod {
  kind: 'wave';
  shape: ModShape;
  /** One cycle's length in beats (¼ beat … 8 bars = 32), like a motion's Speed. */
  beats: number;
  /** The two values it swings between (the slider's stored units). */
  from: number;
  to: number;
}

export interface SoundMod {
  kind: 'sound';
  band: ModBand;
  /** The value when it's quiet, and when it's loudest (the slider's stored units). */
  from: number;
  to: number;
  /** 0..1 how slowly it falls back after a hit (the visualizer's Smoothness). */
  smooth: number;
}

/** How a drawn line runs from one dot to the next (J2b). */
export const DRAWN_CURVES = ['smooth', 'straight', 'jump'] as const;
export type DrawnCurve = (typeof DRAWN_CURVES)[number];

export const DRAWN_CURVE_LABEL: Record<DrawnCurve, string> = {
  smooth: 'Smooth',
  straight: 'Straight',
  jump: 'Jump',
};

/** One dot on a drawn lane: an ABSOLUTE frame, a value (the slider's stored units) and how
 *  the line runs on to the next dot. */
export interface DrawnPoint {
  f: number;
  v: number;
  curve: DrawnCurve;
}

export interface DrawnMod {
  kind: 'drawn';
  /** At least one dot, in frame order (two dots may share a frame: an instant step). */
  points: DrawnPoint[];
}

export type Modulator = WaveMod | SoundMod | DrawnMod;

/** Every slider a modulator can drive (owner: all on-canvas sliders except Pixel and the
 *  canvas shape). Layer sliders are on the layer's node; Dot size + Density are the
 *  canvas's. */
export type ModParam =
  | 'opacity'
  | 'dotSize'
  | 'density'
  | 'bitSize'
  | 'drift'
  | 'photo.brightness'
  | 'photo.contrast'
  | 'photo.gamma'
  | 'photo.black'
  | 'photo.white'
  | 'text.size'
  | 'text.spacing'
  | 'viz.gain'
  | 'viz.smooth'
  | 'viz.amount'
  | 'motion.amp'
  // Effects (J5).
  | 'fx.blur'
  | 'fx.posterize'
  | 'fx.outline'
  | 'fx.kaleido.wedges'
  | 'fx.kaleido.turn'
  | 'fx.wave.amount'
  | 'fx.wave.size'
  | 'fx.wave.flow'
  | 'fx.trail.length'
  | 'fx.trail.fade';

/** A layer's (or the canvas's) modulators: at most one per slider. */
export type ModMap = Partial<Record<ModParam, Modulator>>;

/** Each slider's range in its STORED units (the panel's sliders show the same range) and
 *  whether it holds whole numbers. */
export const MOD_RANGE: Record<ModParam, { min: number; max: number; int: boolean }> = {
  opacity: { min: 0, max: 100, int: true },
  dotSize: { min: HALFTONE_SIZE_MIN, max: HALFTONE_SIZE_MAX, int: true },
  density: { min: HALFTONE_DENSITY_MIN, max: HALFTONE_DENSITY_MAX, int: true },
  bitSize: { min: BIT_SIZE_MIN, max: BIT_SIZE_MAX, int: true },
  drift: { min: 0, max: DRIFT_MAX, int: false },
  'photo.brightness': { min: -100, max: 100, int: true },
  'photo.contrast': { min: 0.5, max: 2.5, int: false },
  'photo.gamma': { min: 0.4, max: 2.5, int: false },
  'photo.black': { min: 0, max: 120, int: true },
  'photo.white': { min: 135, max: 255, int: true },
  'text.size': { min: 1, max: TEXT_SIZE_MAX, int: true },
  'text.spacing': { min: 0, max: TEXT_SPACING_MAX, int: true },
  'viz.gain': { min: 0, max: 1, int: false },
  'viz.smooth': { min: 0, max: 1, int: false },
  'viz.amount': { min: 0, max: 1, int: false },
  'motion.amp': { min: 1, max: 30, int: true },
  'fx.blur': { ...FX_RANGE.blur, int: false },
  'fx.posterize': { ...FX_RANGE.posterize, int: true },
  'fx.outline': { ...FX_RANGE.outline, int: true },
  'fx.kaleido.wedges': { ...FX_RANGE.wedges, int: true },
  'fx.kaleido.turn': { ...FX_RANGE.turn, int: false },
  'fx.wave.amount': { ...FX_RANGE.waveAmount, int: false },
  'fx.wave.size': { ...FX_RANGE.waveSize, int: false },
  'fx.wave.flow': { ...FX_RANGE.waveFlow, int: false },
  'fx.trail.length': { ...FX_RANGE.trailLength, int: false },
  'fx.trail.fade': { ...FX_RANGE.trailFade, int: true },
};

/** A new move on a slider sitting at `value`: FROM = where it sits, TO = 40% of the range
 *  further up — or down, when up has too little room (a slider at its top still moves). */
export function moveRange(param: ModParam, value: number): { from: number; to: number } {
  const r = MOD_RANGE[param];
  const span = r.max - r.min;
  const from = Math.min(r.max, Math.max(r.min, value));
  const up = Math.min(r.max, from + 0.4 * span);
  const to = up - from >= 0.2 * span ? up : Math.max(r.min, from - 0.4 * span);
  const round = (v: number) => (r.int ? Math.round(v) : Math.round(v * 100) / 100);
  return { from: round(from), to: round(to) };
}

/** A new Beat move (one bar, Smooth) / Sound move (Bass) on a slider sitting at `value`. */
export const newWave = (param: ModParam, value: number): WaveMod => ({
  kind: 'wave',
  shape: 'smooth',
  beats: 4,
  ...moveRange(param, value),
});
export const newSound = (param: ModParam, value: number): SoundMod => ({
  kind: 'sound',
  band: 'low',
  smooth: 0.3,
  ...moveRange(param, value),
});

/** A new Drawn move over a video of `frames` frames: a Smooth line from FROM at the start
 *  to TO at the end (switching a Beat / Sound move to Drawn keeps its two values). */
export const newDrawn = (from: number, to: number, frames: number): DrawnMod => ({
  kind: 'drawn',
  points: [
    { f: 0, v: from, curve: 'smooth' },
    { f: Math.max(1, Math.round(frames) - 1), v: to, curve: 'smooth' },
  ],
});

/** A value kept inside the slider's range (whole numbers rounded; others to 0.01). */
export function clampMod(param: ModParam, v: number): number {
  const r = MOD_RANGE[param];
  const c = !Number.isFinite(v) ? r.min : v < r.min ? r.min : v > r.max ? r.max : v;
  return r.int ? Math.round(c) : Math.round(c * 100) / 100;
}

/** The drawn line's value at an absolute frame (null with no dots). Holds the first dot's
 *  value before it and the last dot's after it; Smooth eases (never overshoots), Straight
 *  runs straight, Jump holds until the next dot. */
export function drawnAt(points: readonly DrawnPoint[], f: number): number | null {
  const n = points.length;
  if (n === 0) return null;
  if (f < points[0].f) return points[0].v;
  let i = 0;
  while (i + 1 < n && points[i + 1].f <= f) i++;
  if (i === n - 1) return points[i].v;
  const a = points[i];
  const b = points[i + 1];
  const t = (f - a.f) / (b.f - a.f);
  switch (a.curve) {
    case 'jump':
      return a.v;
    case 'straight':
      return a.v + (b.v - a.v) * t;
    case 'smooth':
      return a.v + ((b.v - a.v) * (1 - Math.cos(Math.PI * t))) / 2;
  }
}

/** Add a dot (frame order kept; after any dot on the same frame). The new dot's line takes
 *  the curve of the line it lands on. */
export function addDot(
  points: readonly DrawnPoint[],
  f: number,
  v: number,
): { points: DrawnPoint[]; index: number } {
  let i = 0;
  while (i < points.length && points[i].f <= f) i++;
  const curve = points[Math.max(0, i - 1)]?.curve ?? 'smooth';
  const out = [...points];
  out.splice(i, 0, { f: Math.max(0, Math.round(f)), v, curve });
  return { points: out, index: i };
}

/** Move dot `i` to (f, v); it can't pass its neighbours (it stops on their frame). */
export function moveDot(
  points: readonly DrawnPoint[],
  i: number,
  f: number,
  v: number,
): DrawnPoint[] {
  if (!points[i]) return [...points];
  const lo = i > 0 ? points[i - 1].f : 0;
  const hi = i + 1 < points.length ? points[i + 1].f : Infinity;
  const out = [...points];
  out[i] = { ...points[i], f: Math.min(hi, Math.max(lo, Math.round(f))), v };
  return out;
}

/** Remove dot `i` (the last dot stays: a lane always has one). */
export const removeDot = (points: readonly DrawnPoint[], i: number): DrawnPoint[] =>
  points.length <= 1 ? [...points] : points.filter((_, k) => k !== i);

/** Set how the line from dot `i` to the next runs. */
export const setDotCurve = (
  points: readonly DrawnPoint[],
  i: number,
  curve: DrawnCurve,
): DrawnPoint[] => points.map((p, k) => (k === i ? { ...p, curve } : p));

/** The inputs every modulator reads for one frame. */
export interface ModContext {
  /** The ABSOLUTE frame (the song's / the export's own timeline). */
  absFrame: number;
  /** F — the loop length (the fallback clock when there is no beat clock). */
  frames: number;
  /** The project's beat clock; absent = one wave cycle per loop. */
  beat?: BeatClock;
  /** Frame-indexed audio features (absolute); null = no sound → Follow sound rests. */
  features: FeatureArray | null;
}

const frac = (v: number): number => v - Math.floor(v);

/** A deterministic 0..1 value for (key, cycle) — the Random shape's step. */
function hashUnit(key: string, n: number): number {
  let h = 0x811c9dc5 ^ Math.imul(n | 0, 0x9e3779b1);
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}

/** One wave shape at phase u ∈ [0,1) → 0..1 (0 = FROM, 1 = TO). Smooth and Zigzag start
 *  at FROM, reach TO halfway and come back; On / off holds TO for the first half. */
export function waveShape(shape: ModShape, u: number, key: string, cycle: number): number {
  switch (shape) {
    case 'smooth':
      return (1 - Math.cos(2 * Math.PI * u)) / 2;
    case 'zigzag':
      return u < 0.5 ? 2 * u : 2 - 2 * u;
    case 'rampUp':
      return u;
    case 'rampDown':
      return 1 - u;
    case 'onoff':
      return u < 0.5 ? 1 : 0;
    case 'random':
      return hashUnit(key, cycle);
  }
}

/** Wave position (cycle number + phase) at a frame. On the beat clock one cycle =
 *  `beats` beats; without a song a loop of whole bars repeats exactly, so the cycle
 *  number wraps with the stretched live clock (Random repeats like the export). */
function wavePhase(mod: WaveMod, ctx: ModContext): { u: number; cycle: number } {
  const beats = mod.beats > 0 ? mod.beats : 4;
  if (!ctx.beat) {
    const F = Math.max(1, ctx.frames);
    const p = ctx.absFrame / F;
    return { u: frac(p), cycle: Math.floor(p) };
  }
  const pos = beatAt(ctx.beat, ctx.absFrame) / beats;
  let cycle = Math.floor(pos);
  const b = ctx.beat;
  if (!b.song && b.loopBeats != null && b.loopBeats > 0) {
    const n = Math.max(1, Math.round((beatSpanLoops(b, beats) * b.loopBeats) / beats));
    cycle = ((cycle % n) + n) % n;
  }
  return { u: frac(pos), cycle };
}

/** Where the move is at this frame, 0 (FROM) … 1 (TO). No sound = it rests at FROM. */
export function modPosition(mod: WaveMod | SoundMod, key: string, ctx: ModContext): number {
  if (mod.kind === 'wave') {
    const { u, cycle } = wavePhase(mod, ctx);
    return waveShape(mod.shape, u, key, cycle);
  }
  const f = vizFeature(ctx.features, ctx.absFrame, mod.smooth);
  if (!f) return 0;
  const v = f[mod.band];
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A move's two values. A move without them (damaged) starts where the slider sits and
 *  heads 40% of the range away (moveRange). A drawn line's are its first dot and the dot
 *  farthest from it (what a switch to Beat / Sound keeps). */
export function modEnds(
  param: ModParam,
  mod: Modulator,
  base: number,
): { from: number; to: number } {
  if (mod.kind === 'drawn') {
    const pts = mod.points;
    if (!pts.length) return moveRange(param, base);
    const from = pts[0].v;
    let to = from;
    for (const p of pts) if (Math.abs(p.v - from) > Math.abs(to - from)) to = p.v;
    return to === from ? moveRange(param, from) : { from, to };
  }
  return Number.isFinite(mod.from) && Number.isFinite(mod.to)
    ? { from: mod.from, to: mod.to }
    : moveRange(param, base);
}

/** The slider's value this frame: FROM → TO by the move's position, kept inside the
 *  slider's range. `base` is the slider's own value (see modEnds). */
export function modulate(
  param: ModParam,
  base: number,
  mod: Modulator,
  key: string,
  ctx: ModContext,
): number {
  const r = MOD_RANGE[param];
  let v: number;
  if (mod.kind === 'drawn') v = drawnAt(mod.points, ctx.absFrame) ?? base;
  else {
    const { from, to } = modEnds(param, mod, base);
    v = from + (to - from) * modPosition(mod, key, ctx);
  }
  const c = !Number.isFinite(v) ? base : v < r.min ? r.min : v > r.max ? r.max : v;
  return r.int ? Math.round(c) : c;
}

/** Is any modulator in this map set? */
export const hasMods = (m: ModMap | undefined): m is ModMap =>
  !!m && Object.values(m).some((x) => !!x);

/** How many loops one cycle of every Wave spans (the live clock + the export's Loop
 *  length stretch to it, as for slow motions). */
export function modSpan(maps: readonly (ModMap | undefined)[], beat?: BeatClock): number {
  let k = 1;
  if (!beat) return k;
  for (const m of maps)
    for (const mod of Object.values(m ?? {}))
      if (mod?.kind === 'wave') k = Math.max(k, beatSpanLoops(beat, mod.beats));
  return k;
}

/** Does any Wave ride a song's beat (so no two loops look the same)? */
export const hasSongBeatMod = (maps: readonly (ModMap | undefined)[], beat?: BeatClock): boolean =>
  !!beat?.song && maps.some((m) => Object.values(m ?? {}).some((x) => x?.kind === 'wave'));

/** Does anything Follow sound (it reads the absolute features)? */
export const hasSoundMod = (maps: readonly (ModMap | undefined)[]): boolean =>
  maps.some((m) => Object.values(m ?? {}).some((x) => x?.kind === 'sound'));

/** Does anything follow a drawn line (it reads the absolute frame across the video)? */
export const hasDrawnMod = (maps: readonly (ModMap | undefined)[]): boolean =>
  maps.some((m) => Object.values(m ?? {}).some((x) => x?.kind === 'drawn'));

/** The key a modulator's live value + Random steps are filed under: `<layer>|<param>`
 *  ('' layer = the canvas). */
export const modKey = (nodeId: string, param: ModParam): string => `${nodeId}|${param}`;
