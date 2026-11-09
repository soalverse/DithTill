// =============================================================================
// Generative music visualizers (the deferred generative element).
// A "visualizer" scene node's PRE-DITHER tone raster is regenerated every loop
// frame by THIS pure module from the frame's audio features — then it flows
// through the SAME resolveSceneGrid/quantizeCell dither as every other element,
// so it comes out 1-bit, obeys the node's palette/matrix/look, and preview ==
// export holds (the raster is a deterministic function of features[frame], the
// integer frame, and the keyed PRNG — no wall clock, no Math.random, no DOM).
//
// This is the video-element pattern (a per-frame raster) but PROCEDURAL: instead
// of decoding a clip, we draw the shape from the music. Output = grayscale tones
// [0,255] + a covered mask; bright shapes on an uncovered (transparent) ground so
// the dither screens the tonal falloff into crisp 1-bit texture.
// =============================================================================
import { SPECTRUM_BINS, type FeatureArray, type FrameFeature } from './audio-features';
import type { CachedAsset } from './scene-resolver';
import type { SeededRng } from './seeded-rng';

export type VisualizerStyle =
  | 'orb'
  | 'speaker'
  | 'lava'
  | 'sunburst'
  | 'ridgeline'
  | 'waterfall'
  | 'leds'
  | 'warp'
  | 'bars'
  | 'waveform'
  | 'particles'
  | 'dust'
  | 'stars'
  | 'vinyl'
  // Retired from the gallery — still drawn so older canvases load.
  | 'radial'
  | 'rings'
  | 'tunnel';

/** The gallery, in order (bold shapes + classics first). */
export const VISUALIZER_STYLES: VisualizerStyle[] = [
  'orb',
  'speaker',
  'lava',
  'sunburst',
  'ridgeline',
  'waterfall',
  'leds',
  'warp',
  'bars',
  'waveform',
  'particles',
  'dust',
  'stars',
  'vinyl',
];

/** Every style the renderer draws — the gallery's plus the retired ones. */
export const ALL_VISUALIZER_STYLES: VisualizerStyle[] = [
  ...VISUALIZER_STYLES,
  'radial',
  'rings',
  'tunnel',
];

/** A band a non-spectral visualizer pulses to. */
export type VisualizerBand = 'rms' | 'low' | 'mid' | 'high' | 'onset';

/** Fold the finished raster: left half onto the right, or into all four quarters. */
export type VisualizerMirror = 'off' | 'lr' | 'quad';

export interface VisualizerConfig {
  style: VisualizerStyle;
  /** Drives global intensity for the pulsing styles (spectrum/wave styles ignore it). */
  band: VisualizerBand;
  /** 0..1 overall sensitivity/amount. */
  gain: number;
  /** 0..1 how slowly it falls back after a hit (peak hold with decay). Absent = 0. */
  smooth?: number;
  mirror?: VisualizerMirror;
  /** 0..1 the style's count/thickness extra (STYLE_EXTRAS names it). Absent = the
   *  style's original fixed value, so older visualizers draw exactly as before. */
  amount?: number;
  /** 0..1 the style's speed extra — whole cycles per loop, so loops stay seamless. */
  pace?: number;
  /** The raster's width ÷ height — set to the canvas's shape when added so it FILLS the
   *  canvas. Absent = the original square. */
  aspect?: number;
}

export const VISUALIZER_DEFAULT: VisualizerConfig = {
  style: 'bars',
  band: 'low',
  gain: 0.6,
  smooth: 0.3,
  mirror: 'off',
  amount: 0.5,
  pace: 0.25,
};

/** Styles drawn from the whole spectrum / the wave shape, so "Listens to" means nothing. */
export const STYLE_SELF_DRIVEN: ReadonlySet<VisualizerStyle> = new Set([
  'bars',
  'radial',
  'waveform',
  'sunburst',
  'ridgeline',
  'waterfall',
  'leds',
]);

/** Each style's extras (the panel's "More"): the plain label for `amount` / `pace`, and
 *  the most whole cycles per loop `pace` reaches. */
export const STYLE_EXTRAS: Record<
  VisualizerStyle,
  { amount?: string; pace?: string; paceMax?: number }
> = {
  orb: { amount: 'Spikes' },
  speaker: { amount: 'Pump' },
  lava: { amount: 'Blobs', pace: 'Flow', paceMax: 3 },
  sunburst: { amount: 'Rays', pace: 'Spin', paceMax: 3 },
  ridgeline: { amount: 'Lines' },
  waterfall: { amount: 'Speed' },
  leds: { amount: 'Columns' },
  warp: { amount: 'Trails', pace: 'Spin', paceMax: 3 },
  bars: { amount: 'Bars' },
  waveform: { amount: 'Thickness' },
  particles: { amount: 'Amount', pace: 'Drift', paceMax: 4 },
  dust: { amount: 'Amount', pace: 'Drift', paceMax: 3 },
  stars: { amount: 'Stars', pace: 'Speed', paceMax: 4 },
  vinyl: { pace: 'Spin', paceMax: 4 },
  radial: { amount: 'Spokes' },
  rings: { amount: 'Rings' },
  tunnel: { amount: 'Rings', pace: 'Speed', paceMax: 4 },
};

/** The feature HISTORY a visualizer may read (Ridgeline, Waterfall, LED peaks, Warp
 *  trails): the circular feature array + the absolute frame being drawn. Pure — the live
 *  render and the export pass the same array + frame, so they agree. */
export interface VizPast {
  features: FeatureArray | null | undefined;
  at: number;
}
/** `amount` → an integer count in [lo, hi] (absent → the style's original `orig`). */
const countOf = (amount: number | undefined, lo: number, hi: number, orig: number): number =>
  amount === undefined ? orig : Math.round(lo + clamp01(amount) * (hi - lo));
/** `pace` → whole cycles per loop in [1, max] (absent → `orig`). */
export const cyclesOf = (pace: number | undefined, max: number, orig: number): number =>
  pace === undefined ? orig : 1 + Math.round(clamp01(pace) * (max - 1));

/**
 * The feature a visualizer draws at `frame`: the frame's own, or — with Smoothness — a
 * PEAK HOLD that falls back slowly (each earlier frame's value decayed by r^k, the max
 * wins), so hits land instantly and fall gently. Pure over the circular feature array
 * (the analysis is circular), so live == export. Out of range / no audio → null.
 */
export function vizFeature(
  features: FeatureArray | null | undefined,
  frame: number,
  smooth = 0,
): FrameFeature | null {
  const cur = features?.[frame];
  if (!features || !cur) return null;
  const r = clamp01(smooth) * 0.92;
  if (r <= 0) return cur;
  const n = features.length;
  const out: FrameFeature = { ...cur, spectrum: cur.spectrum ? [...cur.spectrum] : undefined };
  const keys = ['rms', 'low', 'mid', 'high', 'onset'] as const;
  for (let k = 1, w = r; k < n && w > 0.02; k++, w *= r) {
    const f = features[(((frame - k) % n) + n) % n];
    for (const key of keys) if (f[key] * w > out[key]) out[key] = f[key] * w;
    if (out.spectrum && f.spectrum)
      for (let b = 0; b < out.spectrum.length; b++) {
        const v = (f.spectrum[b] ?? 0) * w;
        if (v > out.spectrum[b]) out.spectrum[b] = v;
      }
  }
  return out;
}

/** The internal square raster resolution. The node's placement scales it onto the
 *  glass; the dither handles the upscale, so a modest raster stays crisp. */
export const VIZ_RASTER = 128;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const bandValue = (f: FrameFeature, b: VisualizerBand): number => f[b];

/** A gentle resting pose used when there is NO audio at all (feature === null) — so a
 *  just-placed visualizer is visible and positionable rather than blank. A real silent
 *  FRAME during playback is ZERO_FEATURE (bars drop to nothing), which is different. */
const IDLE_FEATURE: FrameFeature = {
  rms: 0.3,
  low: 0.32,
  mid: 0.26,
  high: 0.2,
  onset: 0,
  spectrum: Array.from(
    { length: SPECTRUM_BINS },
    (_, b) => 0.18 + 0.26 * Math.sin((Math.PI * b) / (SPECTRUM_BINS - 1)),
  ),
};

// ---- pure raster primitives (max-blend bright tones onto a covered mask) --------
class Raster {
  readonly tones: Uint8Array;
  readonly covered: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.tones = new Uint8Array(w * h);
    this.covered = new Uint8Array(w * h);
  }
  /** Plot a tone at (x,y) with soft coverage `a` in [0,1]; max-blends. */
  plot(x: number, y: number, tone: number, a = 1): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = y * this.w + x;
    const t = tone < 0 ? 0 : tone > 255 ? 255 : tone;
    const scaled = Math.round(t * (a < 1 ? a : 1));
    if (scaled > this.tones[i]) this.tones[i] = scaled;
    if (a > 0.001) this.covered[i] = 1;
  }
  /** Vertical-gradient filled column [x, x] from y0..y1 (bright at yBright). */
  vbar(x: number, y0: number, y1: number, toneTop: number, toneBase: number): void {
    if (y1 < y0) return;
    const span = Math.max(1, y1 - y0);
    for (let y = y0; y <= y1; y++) {
      const frac = (y - y0) / span; // 0 top → 1 base
      this.plot(x, y, toneTop + frac * (toneBase - toneTop));
    }
  }
}

/** A soft filled disc (falloff over ~1.5px so edges dither instead of aliasing). */
function disc(r: Raster, cx: number, cy: number, radius: number, tone: number): void {
  if (radius <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(r.w - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(r.h - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = clamp01(radius - d + 0.5); // 1 inside, feathered at the rim
      if (a > 0) r.plot(x, y, tone, a);
    }
  }
}

/** A soft annulus (ring) of a given mid-radius + half-thickness. */
function annulus(
  r: Raster,
  cx: number,
  cy: number,
  radius: number,
  half: number,
  tone: number,
): void {
  if (radius <= 0 || half <= 0) return;
  const outer = radius + half + 1;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const x1 = Math.min(r.w - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const y1 = Math.min(r.h - 1, Math.ceil(cy + outer));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - radius);
      const a = clamp01(half - d + 0.5);
      if (a > 0) r.plot(x, y, tone, a);
    }
  }
}

/** A soft-gradient tone (glows, halftone-friendly fields): covers only where there's
 *  real light, so a faint skirt never paints dark cells over a light background. */
function shade(r: Raster, x: number, y: number, tone: number): void {
  if (tone >= 6) r.plot(x, y, tone);
}

/** OVERWRITE a cell (occlusion — a nearer Ridgeline hides the lines behind it). */
function setCell(r: Raster, x: number, y: number, tone: number): void {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
  const i = y * r.w + x;
  r.tones[i] = tone < 0 ? 0 : tone > 255 ? 255 : Math.round(tone);
  r.covered[i] = 1;
}

/** A filled rectangle (LED segments). */
function rect(r: Raster, x0: number, y0: number, x1: number, y1: number, tone: number): void {
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(r.h - 1, Math.floor(y1)); y++)
    for (let x = Math.max(0, Math.ceil(x0)); x <= Math.min(r.w - 1, Math.floor(x1)); x++)
      r.plot(x, y, tone);
}

/** A thick line (discs along it). */
function line(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  half: number,
  tone: number,
): void {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.6));
  for (let i = 0; i <= n; i++)
    disc(r, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, half, tone);
}

/** The spectrum read continuously at t ∈ [0,1] (low → high), linear between bins. */
function specAt(f: FrameFeature, t: number): number {
  const spec = f.spectrum;
  if (!spec) return 0;
  const p = clamp01(t) * (SPECTRUM_BINS - 1);
  const i = Math.floor(p);
  const j = Math.min(SPECTRUM_BINS - 1, i + 1);
  return (spec[i] ?? 0) * (1 - (p - i)) + (spec[j] ?? 0) * (p - i);
}

/** The wave read continuously at t ∈ [0,1) (wrapping — for circular scopes). */
function waveAt(f: FrameFeature, t: number): number {
  const w = f.wave;
  if (!w || w.length < 2) return 0;
  const p = (((t % 1) + 1) % 1) * w.length;
  const i = Math.floor(p) % w.length;
  const j = (i + 1) % w.length;
  return w[i] * (1 - (p - Math.floor(p))) + w[j] * (p - Math.floor(p));
}

/** No audio at all: a gently rolling resting spectrum + wave, so history styles still
 *  show their shape (a pure function of the frame; periodic over the loop). */
function idleAt(frame: number, frames: number): FrameFeature {
  const ph = frames > 0 ? frame / frames : 0;
  const roll = (b: number) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (ph * 2 + b / 6));
  return {
    ...IDLE_FEATURE,
    low: 0.25 + 0.15 * roll(0),
    spectrum: Array.from(
      { length: SPECTRUM_BINS },
      (_, b) => (0.12 + 0.3 * roll(b)) * Math.sin((Math.PI * (b + 1)) / (SPECTRUM_BINS + 1)),
    ),
    wave: Array.from({ length: 64 }, (_, p) => 0.3 * Math.sin(2 * Math.PI * (p / 32 + ph))),
  };
}

/** `k` frames ago (k = 0 → the frame being drawn, smoothing included). */
type History = (k: number) => FrameFeature;
function historyOf(
  past: VizPast | undefined,
  cur: FrameFeature,
  idle: boolean,
  frame: number,
  frames: number,
): History {
  const fs = past?.features;
  if (fs && fs.length > 0 && !idle) {
    const n = fs.length;
    const at = past.at;
    return (k) => (k === 0 ? cur : fs[(((at - k) % n) + n) % n]);
  }
  return (k) => (k === 0 && !idle ? cur : idleAt(frame - k, frames));
}
// ---- the styles -------------------------------------------------------------
/** The spectrum resampled to `n` values (linear between bins; n === SPECTRUM_BINS reads
 *  the bins as-is). Absent spectrum = silence. */
function spectrumAt(f: FrameFeature, n: number): number[] {
  const spec = f.spectrum;
  if (!spec) return new Array<number>(n).fill(0);
  if (n === SPECTRUM_BINS) return Array.from({ length: n }, (_, b) => spec[b] ?? 0);
  return Array.from({ length: n }, (_, b) => {
    const t = n > 1 ? (b / (n - 1)) * (SPECTRUM_BINS - 1) : 0;
    const i = Math.floor(t);
    const j = Math.min(SPECTRUM_BINS - 1, i + 1);
    return (spec[i] ?? 0) * (1 - (t - i)) + (spec[j] ?? 0) * (t - i);
  });
}

function drawBars(r: Raster, f: FrameFeature, gain: number, amount?: number): void {
  const n = countOf(amount, 8, 32, SPECTRUM_BINS);
  const spec = spectrumAt(f, n);
  const slot = r.w / n;
  const barW = Math.max(1, Math.floor(slot * 0.72)); // leave a gap between bars
  const boost = 0.6 + gain; // gain scales bar height
  for (let b = 0; b < n; b++) {
    const v = clamp01(spec[b] * boost);
    const barH = Math.round(v * (r.h - 2));
    if (barH <= 0) continue;
    const xStart = Math.floor(b * slot + (slot - barW) / 2);
    for (let x = xStart; x < xStart + barW; x++) {
      r.vbar(x, r.h - barH, r.h - 1, 150, 255); // dim at top, solid at base
    }
  }
}

/** Spokes round a circle bursting outward — the spectrum runs low → high → low so the
 *  burst is symmetric. */
function drawRadial(r: Raster, f: FrameFeature, gain: number, amount?: number): void {
  const n = countOf(amount, 12, 48, 32);
  const spec = spectrumAt(f, Math.ceil(n / 2) + 1);
  const cx = r.w / 2;
  const cy = r.h / 2;
  const maxR = Math.min(r.w, r.h) / 2 - 2;
  const onset = clamp01(f.onset);
  const r0 = maxR * 0.26 * (1 + onset * 0.12);
  const boost = 0.6 + gain;
  annulus(r, cx, cy, r0 - 2, 0.8, 170 + Math.round(onset * 85));
  for (let k = 0; k < n; k++) {
    const half = k <= n / 2 ? k : n - k;
    const v = clamp01((spec[half] ?? 0) * boost);
    const len = v * (maxR - r0);
    const ang = (2 * Math.PI * k) / n - Math.PI / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let d = 0; d <= len; d += 0.75) {
      const tone = 255 - Math.round((105 * d) / Math.max(1, maxR - r0)); // solid root, dim tip
      disc(r, cx + c * (r0 + d), cy + s * (r0 + d), 1.1, tone);
    }
  }
}

/** An oscilloscope line drawing the sound wave itself (FrameFeature.wave). */
function drawWaveform(
  r: Raster,
  f: FrameFeature,
  gain: number,
  frame: number,
  frames: number,
  idle: boolean,
  amount?: number,
): void {
  const thick = 0.6 + clamp01(amount ?? 0.25) * 1.8;
  const cy = r.h / 2;
  const amp = (r.h / 2 - 4) * (0.5 + gain);
  const wave = f.wave;
  const phase = frames > 0 ? frame / frames : 0;
  const at = (x: number): number => {
    const t = x / (r.w - 1);
    if (wave && wave.length > 1) {
      const p = t * (wave.length - 1);
      const i = Math.floor(p);
      const j = Math.min(wave.length - 1, i + 1);
      return wave[i] * (1 - (p - i)) + wave[j] * (p - i);
    }
    // No samples: a gentle resting sine when there's no audio at all, else flat (silence).
    return idle ? 0.3 * Math.sin(2 * Math.PI * (t * 2 + phase)) : 0;
  };
  let prev = cy - at(0) * amp;
  for (let x = 0; x < r.w; x++) {
    const y = cy - Math.max(-1, Math.min(1, at(x))) * amp;
    // Join to the previous column so steep edges stay one connected line.
    const lo = Math.min(prev, y);
    const hi = Math.max(prev, y);
    for (let yy = lo; yy <= hi + 0.01; yy += 0.75) disc(r, x, yy, thick, 235);
    prev = y;
  }
}

function drawRings(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  amount?: number,
): void {
  const cx = r.w / 2;
  const cy = r.h / 2;
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const maxR = Math.min(r.w, r.h) / 2 - 2;
  const RINGS = countOf(amount, 2, 8, 4);
  for (let i = 0; i < RINGS; i++) {
    const base = ((i + 1) / RINGS) * maxR;
    const radius = base * (0.7 + 0.3 * drive) + drive * 6;
    const tone = 150 + Math.round((105 * (onset + drive)) / 2);
    annulus(r, cx, cy, radius, 1 + drive * 1.5, tone);
  }
  disc(r, cx, cy, 3 + drive * 5, 180 + Math.round(onset * 75)); // a pulsing core
}

/** Rings rushing toward you out of the centre (whole laps per loop = seamless); the
 *  music swells and brightens them. */
function drawTunnel(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  amount?: number,
  pace?: number,
): void {
  const cx = r.w / 2;
  const cy = r.h / 2;
  const maxR = Math.hypot(r.w, r.h) / 2; // the nearest rings leave through the corners
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const N = countOf(amount, 4, 14, 8);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.tunnel.paceMax ?? 1, 1);
  const phase = frames > 0 ? frame / frames : 0;
  for (let i = 0; i < N; i++) {
    const z = (((i / N + phase * cycles) % 1) + 1) % 1; // 0 far → 1 near
    const radius = maxR * z * z * (1 + drive * 0.18 * z);
    if (radius < 1.5) continue;
    const tone = 80 + Math.round(z * 140 + onset * 35);
    annulus(r, cx, cy, radius, 0.5 + z * (1.2 + drive * 2), tone);
  }
}

// ---- bold shapes: mass + soft gradients, so halftone dots swell ----

/** A big glowing orb: the edge ripples with the spectrum (bass at the top, mirrored),
 *  the whole thing punches out on the beat, and a soft halo glows around it. */
function drawOrb(r: Raster, f: FrameFeature, band: VisualizerBand, gain: number, amount?: number) {
  const W = Math.min(r.w, r.h); // round things size off the short side
  const cx = r.w / 2;
  const cy = r.h / 2;
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const R0 = W * 0.18 * (1 + drive * 0.38 + onset * 0.12);
  const spike = W * (0.08 + clamp01(amount ?? 0.5) * 0.26) * (0.5 + gain);
  const rim = W * 0.07; // a solid blazing band — reads even on a coarse halftone grid
  const glow = W * (0.02 + 0.045 * drive + 0.03 * onset);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const t = Math.abs(Math.atan2(dx, -dy)) / Math.PI; // 0 top → 1 bottom, mirrored
      const edge = R0 + clamp01(specAt(f, t)) * spike;
      if (d > edge) shade(r, x, y, 210 * Math.exp(-(d - edge) / glow));
      else if (d > edge - rim) r.plot(x, y, 255);
      else {
        const k = d / Math.max(1, edge - rim); // a dark heart that flashes on the beat
        shade(r, x, y, 30 + 120 * k * k + onset * 110 * (1 - k));
      }
    }
}

/** A subwoofer: a shaded cone pumping on the bass inside its rubber surround, a domed
 *  dust cap that flares on hits, on a dark bolted plate. Lit from the top-left. */
function drawSpeaker(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  amount?: number,
) {
  const W = Math.min(r.w, r.h); // round things size off the short side
  const cx = r.w / 2;
  const cy = r.h / 2;
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const pump = (0.1 + clamp01(amount ?? 0.5) * 0.3) * drive;
  const R = W * 0.47;
  const rollIn = R * 0.8;
  const cap = R * 0.3 * (1 + pump * 1.4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R + 1.5) continue; // no plate — the speaker floats on your background
      const light = d > 0 ? (-dx - dy) / (d * Math.SQRT2) : 0; // −1..1, from the top-left
      let tone: number;
      if (d > R)
        tone = 210; // the metal frame lip
      else if (d > rollIn) {
        // The rubber roll: a bold lit crescent top-left, falling into shadow.
        const p = Math.sin((Math.PI * (d - rollIn)) / (R - rollIn));
        tone = 20 + 235 * p * Math.max(0, light) ** 0.7;
      } else if (d > cap + 1.5) {
        // The cone: dark paper whose ridges ripple OUTWARD as it pumps, glowing on hits.
        const k = (d - cap) / (rollIn - cap); // 0 at the cap → 1 at the roll
        const ridge = Math.cos(2 * Math.PI * (k * 4 - pump * 2.5)) > 0.8 ? 1 : 0;
        tone =
          24 + 150 * ridge * (0.5 + 0.5 * Math.max(0, light) + pump) + 120 * pump * (1 - k) ** 2;
      } else if (d > cap)
        tone = 0; // the dark seam round the cap
      else {
        const k = d / cap; // the dust cap dome — the brightest thing, flaring on hits
        tone = 175 + 80 * (1 - k * k) * (0.6 + 0.4 * light) + onset * 60;
      }
      r.plot(x, y, tone);
    }
}

/** Lava-lamp blobs: soft metaballs wandering on closed paths (whole cycles = seamless),
 *  swelling and merging with the music. Pure gradients — dreamy in halftone. */
function drawLava(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  rng: SeededRng,
  nodeId: string,
  amount?: number,
  pace?: number,
) {
  const W = Math.min(r.w, r.h);
  const K = countOf(amount, 3, 9, 6);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.lava.paceMax ?? 1, 1);
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const ph = frames > 0 ? frame / frames : 0;
  const TAU = 2 * Math.PI;
  const blobs = Array.from({ length: K }, (_, i) => {
    const s1 = rng.value(nodeId, i, 0);
    const s2 = rng.value(nodeId, i, 1);
    const s3 = rng.value(nodeId, i, 2);
    const c1 = cycles * (1 + Math.floor(s3 * 2));
    const c2 = cycles * (1 + Math.floor(s1 * 2));
    const rad = W * (0.08 + 0.05 * s2) * (1 + drive * 0.75 + onset * 0.3);
    return {
      x: r.w * (0.5 + 0.3 * Math.sin(TAU * (ph * c1 + s1))),
      y: r.h * (0.5 + 0.3 * Math.cos(TAU * (ph * c2 + s2))),
      r2: rad * rad,
    };
  });
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      let field = 0;
      for (const b of blobs) field += b.r2 / ((x - b.x) ** 2 + (y - b.y) ** 2 + 1);
      if (field >= 1) shade(r, x, y, 205 + 50 * clamp01((field - 1) / 2));
      else if (field > 0.3) shade(r, x, y, 205 * ((field - 0.3) / 0.7) ** 1.6);
    }
}

/** Soft light rays fanning from a bright core; each ray's reach is a slice of the
 *  spectrum (mirrored, bass at the top) and the core flares on the beat. */
function drawSunburst(
  r: Raster,
  f: FrameFeature,
  gain: number,
  frame: number,
  frames: number,
  amount?: number,
  pace?: number,
) {
  const W = Math.min(r.w, r.h); // round things size off the short side
  const cx = r.w / 2;
  const cy = r.h / 2;
  const N = countOf(amount, 8, 32, 16);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.sunburst.paceMax ?? 1, 1);
  const rot = 2 * Math.PI * (frames > 0 ? frame / frames : 0) * cycles;
  const onset = clamp01(f.onset);
  const coreR = W * (0.045 + 0.08 * onset + 0.03 * clamp01(f.rms));
  const reach = Array.from({ length: N }, (_, j) => {
    const t = Math.min(j, N - j) / (N / 2); // mirrored round the circle
    return W * (0.16 + 0.8 * clamp01(specAt(f, t) * (0.5 + gain)));
  });
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dx, -dy) - rot;
      const j = ((Math.round((a * N) / (2 * Math.PI)) % N) + N) % N;
      const prof = (0.5 + 0.5 * Math.cos(N * a)) ** 3; // wide beams read on a coarse grid
      const ray = 235 * prof * Math.exp(-d / reach[j]);
      const core = 255 * Math.exp(-d / coreR);
      shade(r, x, y, Math.max(ray, core));
    }
}

// ---- the classics (they read the recent past via History) --------------------

/** "Unknown Pleasures": the last moments' spectra stacked as ridges receding up the
 *  frame, bass peaking in the middle; each nearer ridge hides the ones behind it. */
function drawRidgeline(r: Raster, hist: History, gain: number, amount?: number) {
  const N = countOf(amount, 8, 28, 16);
  const step = 2; // frames between ridges
  const top = r.h * 0.2;
  const bottom = r.h - 3;
  const gap = (bottom - top) / Math.max(1, N - 1);
  const amp = r.h * 0.3 * (0.5 + gain);
  for (let i = N - 1; i >= 0; i--) {
    const g = hist(i * step);
    const base = bottom - i * gap;
    let prev = base;
    for (let x = 0; x < r.w; x++) {
      const c = Math.abs(x / (r.w - 1) - 0.5) * 2; // 0 centre → 1 edges
      const env = (1 - c) ** 1.6;
      const y = base - amp * clamp01(specAt(g, c)) * env;
      for (let yy = Math.ceil(y) + 1; yy <= base; yy++) setCell(r, x, yy, 0); // hide behind
      const lo = Math.min(prev, y);
      const hi = Math.max(prev, y);
      for (let yy = lo; yy <= hi + 0.01; yy += 0.6) disc(r, x, yy, 1, 250);
      prev = y;
    }
  }
}

/** A scrolling spectrogram: the newest moment along the top, flowing down; bass on the
 *  left, treble on the right. Halftone prints it like a newspaper heat map. */
function drawWaterfall(r: Raster, hist: History, gain: number, amount?: number) {
  const rowsPer = countOf(amount, 1, 4, 2);
  const boost = 0.6 + gain;
  for (let y = 0; y < r.h; y++) {
    const g = hist(Math.floor(y / rowsPer));
    for (let x = 0; x < r.w; x++)
      shade(r, x, y, 255 * clamp01(specAt(g, x / (r.w - 1)) * boost) ** 1.5);
  }
}

/** Hi-fi LED meters: segmented columns, the top segments hottest, a peak cap that holds
 *  and falls slowly; unlit segments stay faintly visible. */
function drawLeds(r: Raster, hist: History, gain: number, amount?: number) {
  const cols = countOf(amount, 6, 24, 12);
  const segs = 14;
  const colW = r.w / cols;
  const segH = (r.h - 2) / segs;
  const boost = 0.6 + gain;
  for (let c = 0; c < cols; c++) {
    const t = (c + 0.5) / cols;
    const level = clamp01(specAt(hist(0), t) * boost);
    let peak = level;
    for (let k = 1; k <= 40; k++)
      peak = Math.max(peak, clamp01(specAt(hist(k), t) * boost) - k * 0.02);
    const lit = Math.round(level * segs);
    const cap = Math.max(lit, Math.ceil(peak * segs));
    for (let s = 0; s < segs; s++) {
      const on = s < lit;
      const tone = on ? (s >= segs * 0.75 ? 255 : 215) : s === cap - 1 ? 255 : 0; // unlit = dark glass
      rect(
        r,
        c * colW + 1,
        r.h - 1 - (s + 1) * segH + 1,
        (c + 1) * colW - 2,
        r.h - 1 - s * segH - 1,
        tone,
      );
    }
  }
}

/** MilkDrop-style warp: a circular scope of the sound wave, with its recent past
 *  echoing outward as zooming, spinning, fading trails. Each trail is drawn from its own
 *  moment (no frame feedback), so any frame can be drawn alone — scrub/export agree. */
function drawWarp(
  r: Raster,
  f: FrameFeature,
  hist: History,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  amount?: number,
  pace?: number,
) {
  const W = Math.min(r.w, r.h); // round things size off the short side
  const cx = r.w / 2;
  const cy = r.h / 2;
  const K = countOf(amount, 6, 20, 12);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.warp.paceMax ?? 1, 1);
  const spin = 2 * Math.PI * (frames > 0 ? frame / frames : 0) * cycles;
  const zoom = 1.08 + 0.06 * clamp01(bandValue(f, band) * (0.5 + gain));
  const P = 160;
  for (let k = K - 1; k >= 0; k--) {
    const g = hist(k);
    const scale = zoom ** k;
    const tone = 255 * 0.84 ** k;
    const rot = spin + k * 0.1;
    const R0 = W * 0.11 * (1 + clamp01(bandValue(g, band)) * 0.5 * (0.5 + gain));
    const wob = W * 0.07 * (0.5 + gain);
    let px = 0;
    let py = 0;
    for (let p = 0; p <= P; p++) {
      const a = (2 * Math.PI * p) / P;
      const rr = (R0 + waveAt(g, p / P) * wob) * scale;
      const x = cx + Math.cos(a + rot) * rr;
      const y = cy + Math.sin(a + rot) * rr;
      if (p > 0) line(r, px, py, x, y, 0.6 + 0.25 * Math.sqrt(scale), tone);
      px = x;
      py = y;
    }
  }
}

// ---- punched up ("not super reactive") ----------------------

/** A starfield flying outward; the music shoves the whole field out, swells the stars
 *  and streaks them on hits, and a hit flashes the core. */
function drawStars(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  rng: SeededRng,
  nodeId: string,
  amount?: number,
  pace?: number,
): void {
  const cx = r.w / 2;
  const cy = r.h / 2;
  const maxR = Math.hypot(r.w, r.h) / 2;
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const COUNT = countOf(amount, 30, 200, 90);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.stars.paceMax ?? 1, 1);
  const phase = frames > 0 ? frame / frames : 0;
  const shove = 1 + drive * 0.35 + onset * 0.25;
  // The core flash on a hit.
  const flash = Math.min(r.w, r.h) * 0.05 * (1 + onset * 3);
  if (onset > 0.05)
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++)
        shade(r, x, y, 255 * onset * Math.exp(-Math.hypot(x - cx, y - cy) / flash));
  for (let i = 0; i < COUNT; i++) {
    const ang = 2 * Math.PI * rng.value(nodeId, i, 0);
    const z = (rng.value(nodeId, i, 1) + phase * cycles) % 1;
    const dist = maxR * z * z * shove;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const size = 0.4 + z * (1.1 + 2.6 * drive);
    const tone = 70 + Math.round(z * 120 + drive * 65);
    const streak = (onset * 16 + drive * 6) * z;
    for (let d = 0; d <= streak; d += 0.75) {
      const rr = dist - d;
      if (rr < 0) break;
      disc(r, cx + c * rr, cy + s * rr, size * (1 - (d / (streak + 1)) * 0.6), tone);
    }
    if (streak < 0.75) disc(r, cx + c * dist, cy + s * dist, size, tone);
  }
}

/** Bubbles: soft rings with a highlight, wandering on closed paths; the music inflates
 *  them and a hit blows them outward. */
function drawParticles(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  rng: SeededRng,
  nodeId: string,
  amount?: number,
  pace?: number,
): void {
  const COUNT = countOf(amount, 8, 48, 28);
  const cycles = cyclesOf(pace, STYLE_EXTRAS.particles.paceMax ?? 1, 1);
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const phase = frames > 0 ? frame / frames : 0;
  const unit = Math.min(r.w, r.h) / 128;
  for (let i = 0; i < COUNT; i++) {
    const hx = rng.value(nodeId, i, 0);
    const hy = rng.value(nodeId, i, 1);
    const drift = rng.value(nodeId, i, 2);
    const ang = 2 * Math.PI * (drift + phase * cycles);
    const push = onset * 0.35 * (0.4 + drift);
    const px = clamp01(hx + Math.cos(ang) * 0.05 + (hx - 0.5) * push) * r.w;
    const py = clamp01(hy + Math.sin(ang) * 0.05 + (hy - 0.5) * push) * r.h;
    const R = unit * (2.6 + drive * 7 * (0.4 + drift) + onset * 3 * drift);
    disc(r, px, py, R, 60 + drive * 40); // the soft body
    annulus(r, px, py, R, 0.55 * unit, 200 + drive * 55); // the film
    disc(r, px - R * 0.35, py - R * 0.35, Math.max(0.6, R * 0.22), 255); // the glint
  }
}

/** Fine dust floating in the air: specks wander on closed paths and twinkle; the music
 *  swells and brightens them, hits push them out and make many sparkle as crosses. */
function drawDust(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  rng: SeededRng,
  nodeId: string,
  amount?: number,
  pace?: number,
): void {
  const COUNT = countOf(amount, 40, 240, 120);
  const base = cyclesOf(pace, STYLE_EXTRAS.dust.paceMax ?? 1, 1);
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const phase = frames > 0 ? frame / frames : 0;
  const TAU = 2 * Math.PI;
  const unit = Math.min(r.w, r.h) / 128;
  for (let i = 0; i < COUNT; i++) {
    const hx = rng.value(nodeId, i, 0);
    const hy = rng.value(nodeId, i, 1);
    const seed = rng.value(nodeId, i, 2);
    const kind = rng.value(nodeId, i, 3);
    // Whole cycles per loop on both axes → a closed wander, seamless at the wrap.
    const cxs = base * (1 + Math.floor(kind * 2));
    const cys = base * (1 + Math.floor(seed * 2));
    const push = onset * 0.22 * (0.3 + seed);
    const px = hx + 0.035 * Math.sin(TAU * (phase * cxs + seed)) + (hx - 0.5) * push;
    const py = hy + 0.035 * Math.cos(TAU * (phase * cys + kind)) + (hy - 0.5) * push;
    const x = (((px % 1) + 1) % 1) * r.w;
    const y = (((py % 1) + 1) % 1) * r.h;
    const twinkle = 0.55 + 0.45 * Math.sin(TAU * (phase * (1 + Math.floor(kind * 3)) + hx));
    const size = unit * (0.3 + seed * 0.4 + drive * (0.4 + 1.6 * seed));
    disc(r, x, y, size, (70 + drive * 185) * twinkle);
    if (kind > 1 - (onset * 0.6 + drive * 0.12)) {
      const arm = unit * (2 + onset * 4);
      line(r, x - arm, y, x + arm, y, 0.45 * unit, 255); // a cross sparkle
      line(r, x, y - arm, x, y + arm, 0.45 * unit, 255);
    }
  }
}

/** A record on a turntable: fine grooves with a FIXED sheen (light doesn't turn with the
 *  disc), a two-tone label that turns, a tonearm, and the whole deck bouncing on hits. */
function drawVinyl(
  r: Raster,
  f: FrameFeature,
  band: VisualizerBand,
  gain: number,
  frame: number,
  frames: number,
  pace?: number,
): void {
  const W = Math.min(r.w, r.h); // round things size off the short side
  const cx = r.w / 2;
  const cy = r.h / 2;
  const drive = clamp01(bandValue(f, band) * (0.5 + gain));
  const onset = clamp01(f.onset);
  const R = (W / 2 - 2) * (0.9 + 0.08 * drive + 0.04 * onset);
  const turns = cyclesOf(pace, STYLE_EXTRAS.vinyl.paceMax ?? 1, 2);
  const spin = 2 * Math.PI * ((frames > 0 ? frame / frames : 0) * turns); // whole turns / loop
  const fine = 128 / W; // groove spacing in raster pixels stays the same at any size
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const a = Math.atan2(dy, dx);
      const k = d / R;
      let tone: number;
      if (k > 0.965)
        tone = 150; // the bevelled rim
      else if (k > 0.36) {
        const groove = 0.5 + 0.5 * Math.sin(d * 2.4 * fine);
        const sheen = Math.abs(Math.cos(a - Math.PI / 4)) ** 14; // two fixed highlight lobes
        tone = 38 + 22 * groove + 135 * sheen * (0.6 + 0.4 * groove) + drive * 20;
        if ((k > 0.56 && k < 0.575) || (k > 0.74 && k < 0.755)) tone = 18; // track gaps
      } else if (k > 0.34)
        tone = 22; // the lead-out
      else if (k > 0.03) {
        const half = Math.cos(a - spin) > 0; // the label's two halves turn with the disc
        tone = (half ? 235 : 165) + onset * 20;
        if (k > 0.31) tone = 120;
      } else tone = 0; // the spindle hole
      r.plot(x, y, tone);
    }
  disc(r, cx, cy, R * 0.012 + 0.6, 255); // spindle
  // The tonearm: pivot top-right, headshell resting in the grooves.
  const px = cx + W * 0.43;
  const py = cy - W * 0.42;
  const hx = cx + Math.cos(-0.7) * R * 0.62;
  const hy = cy + Math.sin(-0.7) * R * 0.62;
  disc(r, px, py, W * 0.04, 170);
  line(r, px, py, hx, hy, W * 0.011, 215);
  disc(r, hx, hy, W * 0.022, 240);
}
/** Fold the finished raster: copy the left half mirrored onto the right ('lr'), then
 *  the BOTTOM half onto the top too ('quad' — bottom, because Bars grow up from the
 *  floor; folding the top down would erase short bars). */
function mirrorRaster(r: Raster, mode: VisualizerMirror | undefined): void {
  if (!mode || mode === 'off') return;
  const { w, h, tones, covered } = r;
  for (let y = 0; y < h; y++)
    for (let x = Math.ceil(w / 2); x < w; x++) {
      const i = y * w + x;
      const j = y * w + (w - 1 - x);
      tones[i] = tones[j];
      covered[i] = covered[j];
    }
  if (mode !== 'quad') return;
  for (let y = 0; y < Math.floor(h / 2); y++) {
    tones.copyWithin(y * w, (h - 1 - y) * w, (h - y) * w);
    covered.copyWithin(y * w, (h - 1 - y) * w, (h - y) * w);
  }
}

/** A visualizer's raster size: `size` on the SHORT side, the long side stretched to its
 *  aspect (square when absent). The live render, the export and placement all use this. */
export function vizRasterDims(
  viz: Pick<VisualizerConfig, 'aspect'>,
  size: number = VIZ_RASTER,
): { w: number; h: number } {
  const a = viz.aspect;
  if (!a || !Number.isFinite(a)) return { w: size, h: size };
  const k = Math.min(3, Math.max(1 / 3, a));
  return k >= 1 ? { w: Math.round(size * k), h: size } : { w: size, h: Math.round(size / k) };
}

/**
 * Draw one loop frame of a visualizer into a fresh pre-dither tone raster.
 * `feature` null (no audio) → a resting frame (the export/live both pass
 * vizFeature(features, frame, smooth)). `past` = the feature history the classics read
 * (Ridgeline/Waterfall/LED peaks/Warp); absent → they roll a resting history.
 * Deterministic: a pure function of (config, feature, past, integer frame, keyed rng,
 * nodeId).
 */
export function renderVisualizerRaster(
  viz: VisualizerConfig,
  feature: FrameFeature | null,
  frame: number,
  frames: number,
  rng: SeededRng,
  nodeId: string,
  size: number = VIZ_RASTER,
  past?: VizPast,
): CachedAsset {
  const dims = vizRasterDims(viz, size);
  const r = new Raster(dims.w, dims.h);
  const idle = feature === null;
  const f = feature ?? IDLE_FEATURE; // no audio at all → a visible resting pose
  const gain = clamp01(viz.gain);
  const { band, amount, pace } = viz;
  const hist = (): History => historyOf(past, f, idle, frame, frames);
  switch (viz.style) {
    case 'orb':
      drawOrb(r, f, band, gain, amount);
      break;
    case 'speaker':
      drawSpeaker(r, f, band, gain, amount);
      break;
    case 'lava':
      drawLava(r, f, band, gain, frame, frames, rng, nodeId, amount, pace);
      break;
    case 'sunburst':
      drawSunburst(r, f, gain, frame, frames, amount, pace);
      break;
    case 'ridgeline':
      drawRidgeline(r, hist(), gain, amount);
      break;
    case 'waterfall':
      drawWaterfall(r, hist(), gain, amount);
      break;
    case 'leds':
      drawLeds(r, hist(), gain, amount);
      break;
    case 'warp':
      drawWarp(r, f, hist(), band, gain, frame, frames, amount, pace);
      break;
    case 'bars':
      drawBars(r, f, gain, amount);
      break;
    case 'radial':
      drawRadial(r, f, gain, amount);
      break;
    case 'waveform':
      drawWaveform(r, f, gain, frame, frames, idle, amount);
      break;
    case 'rings':
      drawRings(r, f, band, gain, amount);
      break;
    case 'tunnel':
      drawTunnel(r, f, band, gain, frame, frames, amount, pace);
      break;
    case 'stars':
      drawStars(r, f, band, gain, frame, frames, rng, nodeId, amount, pace);
      break;
    case 'particles':
      drawParticles(r, f, band, gain, frame, frames, rng, nodeId, amount, pace);
      break;
    case 'dust':
      drawDust(r, f, band, gain, frame, frames, rng, nodeId, amount, pace);
      break;
    case 'vinyl':
      drawVinyl(r, f, band, gain, frame, frames, pace);
      break;
  }
  mirrorRaster(r, viz.mirror);
  return { w: r.w, h: r.h, tones: r.tones, covered: r.covered };
}
