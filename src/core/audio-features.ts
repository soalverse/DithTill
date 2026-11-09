// =============================================================================
// Audio features + reaction mapping for the visualizer (Group F). PURE —
// no AudioContext, no DOM (that lives in audio-engine.ts). This module is the single
// definition of (1) the per-frame feature shape, (2) the OFFLINE pre-analysis that
// builds it (preAnalyze), and (3) how an AudioReactEvent maps a feature value → a
// Look/param delta. LOCKED 2026-07-03: the LIVE preview reads the SAME pre-analyzed,
// frame-indexed FeatureArray the export reads (features[frame]) — never a live
// AnalyserNode — so preview == export holds at any speed-knob setting by construction.
//
// Envelopes (attack/release) are BAKED INTO the FeatureArray at analysis time,
// iterated over the CIRCULAR loop to convergence (a fixed pass count would leak a
// seam whenever the release tail is longer than the loop), so `reactionDelta` stays
// a pure stateless lookup.
// =============================================================================
import { hann, magnitudeSpectrum } from './fft';
import type { AudioReactEvent } from './loop-events';

/** How many log-spaced bins the spectrum carries (the Bars visualizer + friends).
 *  16 reads well dithered without bloating the stored per-frame feature. */
export const SPECTRUM_BINS = 16;

/** Points per frame in the stored wave shape, and the samples they span. */
export const WAVE_POINTS = 64;
const WAVE_SPAN = 1024;

/** One frame's audio features, each normalised to ~[0,1] (envelope already baked). */
export interface FrameFeature {
  rms: number;
  low: number;
  mid: number;
  high: number;
  onset: number;
  /** Log-binned magnitude spectrum, SPECTRUM_BINS bins, each ~[0,1] (loop-normalised).
   *  Optional so pre-spectrum FrameFeature literals (tests, ZERO_FEATURE) stay valid;
   *  visualizers treat an absent spectrum as silence. */
  spectrum?: number[];
  /** The sound wave itself around this frame (the Waveform visualizer): WAVE_POINTS
   *  values in [-1,1], started at a rising zero crossing so the line holds still on a
   *  steady tone, scaled by ONE loop-wide peak (quiet stays small). Optional like
   *  `spectrum`. */
  wave?: number[];
}

/** Frame-indexed features: length === F, index === loop frame. The single source of
 *  audio truth for the deterministic export (read as features[frame]). */
export type FeatureArray = FrameFeature[];

export const ZERO_FEATURE: FrameFeature = { rms: 0, low: 0, mid: 0, high: 0, onset: 0 };

/** The delta an audio reaction contributes to a node's / the scene's effective look
 *  for one frame. Additive numeric fields; integer "step" fields shift an enumerated
 *  Look field (palette / matrix) which `evaluateScene` resolves against the id arrays. */
export interface ReactionDelta {
  /** Additive tone offset (-255..255 domain of Look.brightness). */
  brightness?: number;
  /** Additive contrast offset (Look.contrast is a multiplier about mid-grey). */
  contrast?: number;
  /** Beat-gated invert request for this frame. */
  invert?: boolean;
  /** Integer step through PALETTE_IDS (wrapped by evaluateScene). */
  paletteStep?: number;
  /** Integer step toward a chunkier matrix (the Record-safe "cellSize" reaction). */
  matrixStep?: number;
  /** MOVE (scene cells): Bounce lifts, Shake jitters. */
  dx?: number;
  dy?: number;
  /** MOVE: Pulse swells the art by this fraction (0.2 = 20% bigger). */
  dscale?: number;
  /** Additive halftone dot size (px) — Dots swell with the music. */
  dotSize?: number;
}

/** How far each MOVE reaction goes at full depth + a full-scale band. */
export const MOVE_REACH = { pulse: 0.3, bounce: 10, shake: 4, dotSize: 8, flash: 200 } as const;

/** A deterministic −1..1 jitter for (event, frame, axis) — no Math.random, so the
 *  export shakes exactly like the preview. */
function jitter(id: string, frame: number, axis: number): number {
  let h = 0x811c9dc5 ^ (axis * 0x9e3779b1);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ frame, 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Read the band value for an event from a frame's features. */
function bandValue(f: FrameFeature, band: AudioReactEvent['band']): number {
  return f[band];
}

/**
 * Map one AudioReactEvent against the features at `frame` → its look delta. PURE: a
 * lookup + scale (the envelope is already in the array). Returns an empty delta when
 * there are no features (without-audio mode) or the frame is out of range.
 */
export function reactionDelta(
  ev: AudioReactEvent,
  features: FeatureArray | null,
  frame: number,
): ReactionDelta {
  if (!features || frame < 0 || frame >= features.length) return {};
  const v = Math.max(0, Math.min(1, bandValue(features[frame], ev.band)));
  const scaled = v * ev.depth;
  // Gated targets (invert / palette): depth = SENSITIVITY (locked 2026-07-03) —
  // full depth fires at the classic 0.5, lower depth needs a stronger beat, and
  // depth 0 never fires (threshold 1). One rule: depth always means "how easily
  // it reacts", so the panel's slider is meaningful for every effect.
  const fired = ev.depth > 0 && v >= gateThreshold(ev.depth);
  switch (ev.target.kind) {
    case 'look':
      return ev.target.key === 'contrast'
        ? { contrast: scaled } // +0..depth on the contrast multiplier
        : { brightness: Math.round(scaled * 255) };
    case 'invert':
      return fired ? { invert: true } : {}; // beat-gated flip
    case 'palette':
      return fired ? { paletteStep: 1 } : {}; // pulse to the next palette on a beat
    case 'matrixStep':
      return { matrixStep: Math.round(scaled * 3) }; // chunkier dither on the beat (no lattice move)
    case 'pulse':
      return { dscale: scaled * MOVE_REACH.pulse }; // swells with the band
    case 'bounce':
      return { dy: -scaled * MOVE_REACH.bounce }; // hops up on the hit, falls with the band
    case 'shake':
      return scaled > 0.02
        ? {
            dx: jitter(ev.id, frame, 0) * scaled * MOVE_REACH.shake,
            dy: jitter(ev.id, frame, 1) * scaled * MOVE_REACH.shake,
          }
        : {};
    case 'flash':
      return fired ? { brightness: Math.round(MOVE_REACH.flash) } : {}; // beat-gated white flash
    case 'dotSize':
      return { dotSize: scaled * MOVE_REACH.dotSize };
    default:
      return {};
  }
}

/** The band level a gated (invert/palette) reaction fires at, for a depth in
 *  (0, 1]: threshold = 1 − depth/2 ∈ [0.5, 1). */
export function gateThreshold(depth: number): number {
  return 1 - Math.max(0, Math.min(1, depth)) * 0.5;
}

// =============================================================================
// Offline pre-analysis: mono PCM (the canonical loop-audio mix at the pinned
// rate, loop-audio.ts) → the frame-indexed FeatureArray. Deterministic: fixed
// FFT size, fixed band edges, circular windows/envelopes — no wall clock, no
// AnalyserNode, no dependence on where playback happens to be.
// =============================================================================

/** Analysis window (samples). 2048 @ 48 kHz ≈ 43 ms / ≈ 23 Hz per bin — enough
 *  low-band resolution while staying well under a 30 fps frame pair. */
export const ANALYSIS_FFT_SIZE = 2048;

/** Band edges in Hz: low = kick/bass, mid = body/vocals, high = hats/air. */
export const BAND_EDGES_HZ = { low: [20, 250], mid: [250, 2000], high: [2000, 8000] } as const;

/** Envelope follower per-frame smoothing factors (attack fast, release slow) and
 *  the convergence iteration bounds for the circular bake. */
const ENV_ATTACK = 0.55;
const ENV_RELEASE = 0.15;
const ENV_EPS = 1e-4;
const ENV_MAX_PASSES = 64;

/** Onset pulse decay per frame (~3-frame tail at 30 fps) — a one-frame spike is
 *  invisible at display rate, so the flux peak is shaped into a short pulse. */
const ONSET_DECAY = 0.6;

/** A band's max must clear this to normalize; below it the band is SILENT and
 *  stays all-zero (the guard against amplifying noise in a quiet loop). */
const SILENT_MAX = 1e-6;

export interface PreAnalyzeInput {
  /** MONO PCM of the canonical loop buffer (loop-audio monoMix), pinned rate. */
  pcm: Float32Array;
  sampleRate: number;
  /** F — the loop length in frames, and the length of the returned array. */
  frames: number;
  /** The loop clock rate (meta.fps). */
  fps: number;
}

/** Normalize `vals` to [0,1] in place by `max` (silent-guarded). Defaults to the
 *  sequence's own max; pass a shared max to keep RELATIVE scale across sequences
 *  (the three bands share one max — otherwise a pure-bass loop's negligible
 *  high-band leakage would normalize to full scale and "treble" would fire). */
function normalize(vals: Float64Array, max?: number): void {
  const m = max ?? maxOf(vals);
  if (m < SILENT_MAX) {
    vals.fill(0);
    return;
  }
  for (let i = 0; i < vals.length; i++) vals[i] = Math.min(1, vals[i] / m);
}

function maxOf(vals: Float64Array): number {
  let max = 0;
  for (let i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
  return max;
}

/** Bake an attack/release envelope over a CIRCULAR value sequence, iterating
 *  whole passes until the state converges (a release tail longer than the loop
 *  needs more than one lap to settle — "run it twice" is not enough). */
function bakeEnvelope(vals: Float64Array): void {
  const n = vals.length;
  if (n === 0) return;
  const out = Float64Array.from(vals);
  let env = 0;
  for (let pass = 0; pass < ENV_MAX_PASSES; pass++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const k = vals[i] > env ? ENV_ATTACK : ENV_RELEASE;
      env += k * (vals[i] - env);
      const d = Math.abs(env - out[i]);
      if (d > maxDelta) maxDelta = d;
      out[i] = env;
    }
    if (maxDelta < ENV_EPS && pass > 0) break;
  }
  vals.set(out);
}

/** Shape the (normalized) onset flux into a multi-frame decaying pulse, wrapped
 *  circularly to convergence like the envelopes. */
function bakeOnsetPulse(vals: Float64Array): void {
  const n = vals.length;
  if (n === 0) return;
  let carry = 0;
  for (let pass = 0; pass < ENV_MAX_PASSES; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const shaped = Math.max(vals[i], carry * ONSET_DECAY);
      if (shaped !== vals[i]) {
        vals[i] = shaped;
        changed = true;
      }
      carry = vals[i];
    }
    if (!changed) break;
  }
}

/** Fill `out` with the wave around a window: start at the first rising zero crossing in
 *  the window's first quarter (lightly smoothed so noise doesn't pick it), then average
 *  WAVE_SPAN samples down to WAVE_POINTS. Returns the shape's peak |value|. */
function waveShape(raw: Float64Array, out: Float64Array): number {
  const quarter = raw.length >> 2;
  const smooth = (i: number): number => {
    let sum = 0;
    for (let k = -3; k <= 4; k++) sum += raw[Math.max(0, Math.min(raw.length - 1, i + k))];
    return sum;
  };
  let start = quarter;
  for (let i = 1; i < quarter; i++)
    if (smooth(i - 1) <= 0 && smooth(i) > 0) {
      start = i;
      break;
    }
  const chunk = WAVE_SPAN / WAVE_POINTS;
  let peak = 0;
  for (let p = 0; p < WAVE_POINTS; p++) {
    let sum = 0;
    for (let k = 0; k < chunk; k++) sum += raw[Math.min(raw.length - 1, start + p * chunk + k)];
    out[p] = sum / chunk;
    peak = Math.max(peak, Math.abs(out[p]));
  }
  return peak;
}

/**
 * Analyze the canonical loop buffer → one FrameFeature per loop frame. Windows
 * are centered mid-frame and WRAP the loop circularly (the loop is a circle —
 * frame 0's window sees the tail, so features are seamless at the wrap). Bands
 * are normalized to [0,1] per loop (silent-guarded), envelopes + the onset
 * pulse are baked in (circular, iterated to convergence).
 */
export function preAnalyze(input: PreAnalyzeInput): FeatureArray {
  const { pcm, sampleRate, frames, fps } = input;
  const F = Math.max(1, Math.round(frames));
  if (pcm.length === 0) return Array.from({ length: F }, () => ({ ...ZERO_FEATURE }));

  const N = ANALYSIS_FFT_SIZE;
  const hzPerBin = sampleRate / N;
  const binRange = (lo: number, hi: number): [number, number] => [
    Math.max(0, Math.ceil(lo / hzPerBin)),
    Math.min(N >> 1, Math.floor(hi / hzPerBin)),
  ];
  const [lowLo, lowHi] = binRange(BAND_EDGES_HZ.low[0], BAND_EDGES_HZ.low[1]);
  const [midLo, midHi] = binRange(BAND_EDGES_HZ.mid[0], BAND_EDGES_HZ.mid[1]);
  const [highLo, highHi] = binRange(BAND_EDGES_HZ.high[0], BAND_EDGES_HZ.high[1]);

  // Log-spaced spectrum bins (40 Hz → 12 kHz) → their FFT-bin ranges (the Bars viz).
  const SPEC_LO_HZ = 40;
  const SPEC_HI_HZ = Math.min(12000, sampleRate / 2);
  const specRanges: [number, number][] = [];
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const f0 = SPEC_LO_HZ * Math.pow(SPEC_HI_HZ / SPEC_LO_HZ, b / SPECTRUM_BINS);
    const f1 = SPEC_LO_HZ * Math.pow(SPEC_HI_HZ / SPEC_LO_HZ, (b + 1) / SPECTRUM_BINS);
    specRanges.push(binRange(f0, f1));
  }

  const rms = new Float64Array(F);
  const low = new Float64Array(F);
  const mid = new Float64Array(F);
  const high = new Float64Array(F);
  const flux = new Float64Array(F);
  const spec = Array.from({ length: F }, () => new Float64Array(SPECTRUM_BINS));

  const windowed = new Float64Array(N);
  const raw = new Float64Array(N);
  const waves = Array.from({ length: F }, () => new Float64Array(WAVE_POINTS));
  let wavePeak = 0;
  let prevMag: Float64Array | null = null;
  let firstMag: Float64Array | null = null;

  const bandAmp = (mag: Float64Array, lo: number, hi: number): number => {
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += mag[k] * mag[k];
    return Math.sqrt(sum);
  };

  for (let f = 0; f < F; f++) {
    // Window centered on the middle of frame f, wrapped modulo the loop buffer.
    const center = Math.round(((f + 0.5) / fps) * sampleRate);
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      let idx = (center - (N >> 1) + i) % pcm.length;
      if (idx < 0) idx += pcm.length;
      const s = pcm[idx];
      sumSq += s * s;
      windowed[i] = s * hann(i, N);
      raw[i] = s;
    }
    wavePeak = Math.max(wavePeak, waveShape(raw, waves[f]));
    rms[f] = Math.sqrt(sumSq / N);

    const mag = magnitudeSpectrum(windowed);
    low[f] = bandAmp(mag, lowLo, lowHi);
    mid[f] = bandAmp(mag, midLo, midHi);
    high[f] = bandAmp(mag, highLo, highHi);
    for (let b = 0; b < SPECTRUM_BINS; b++)
      spec[f][b] = bandAmp(mag, specRanges[b][0], specRanges[b][1]);

    // Spectral flux vs the previous frame (frame 0's is deferred to the wrap).
    if (prevMag) {
      let sum = 0;
      for (let k = 0; k < mag.length; k++) {
        const d = mag[k] - prevMag[k];
        if (d > 0) sum += d;
      }
      flux[f] = sum;
    } else {
      firstMag = mag;
    }
    prevMag = mag;
  }
  // Close the circle: frame 0's flux compares against frame F−1.
  if (firstMag && prevMag && F > 1) {
    let sum = 0;
    for (let k = 0; k < firstMag.length; k++) {
      const d = firstMag[k] - prevMag[k];
      if (d > 0) sum += d;
    }
    flux[0] = sum;
  }

  normalize(rms);
  const bandMax = Math.max(maxOf(low), maxOf(mid), maxOf(high));
  normalize(low, bandMax);
  normalize(mid, bandMax);
  normalize(high, bandMax);
  normalize(flux);
  bakeEnvelope(rms);
  bakeEnvelope(low);
  bakeEnvelope(mid);
  bakeEnvelope(high);
  bakeOnsetPulse(flux);

  // Spectrum bins share ONE loop-wide max so a bar's height is comparable to its
  // neighbours (per-bin normalization would flatten every bar to full-scale).
  let specMax = 0;
  for (let f = 0; f < F; f++)
    for (let b = 0; b < SPECTRUM_BINS; b++) if (spec[f][b] > specMax) specMax = spec[f][b];
  const specGain = specMax < SILENT_MAX ? 0 : 1 / specMax;

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const out: FeatureArray = new Array(F);
  for (let f = 0; f < F; f++) {
    const bins = new Array<number>(SPECTRUM_BINS);
    for (let b = 0; b < SPECTRUM_BINS; b++) bins[b] = clamp01(spec[f][b] * specGain);
    out[f] = {
      rms: clamp01(rms[f]),
      low: clamp01(low[f]),
      mid: clamp01(mid[f]),
      high: clamp01(high[f]),
      onset: clamp01(flux[f]),
      spectrum: bins,
      wave: Array.from(waves[f], (v) => (wavePeak < SILENT_MAX ? 0 : v / wavePeak)),
    };
  }
  return out;
}
