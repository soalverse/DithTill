// =============================================================================
// Detect a song's tempo + where bar 1 starts (Group J1 — FL Studio's "Detect tempo").
// Pure and deterministic: PCM in, { bpm, offsetSec } out. No DOM, no wall clock.
//
//   1. An ONSET envelope at 100 frames/s: spectral flux of the log-compressed STFT
//      (how much new energy arrives each 10 ms), with its local average removed so
//      only the hits remain. A second, BASS-only flux marks the kicks.
//   2. A COARSE tempo from the envelope's autocorrelation over 60–200 BPM, weighted
//      toward ~120 BPM (the usual octave-error guard: a 70 BPM ballad and its 140 BPM
//      double-time both correlate, the weighting prefers the musical one).
//   3. A FINE tempo + beat phase across the WHOLE song: for each candidate BPM
//      (±2 around the coarse one, 0.01 steps) the envelope is folded at the beat
//      period; the sharpest fold wins and its peak is the beat phase. Fitting the whole
//      song is what makes it drift-free — a 0.05 BPM error is a third of a beat over 3
//      minutes. Productions are usually on a whole BPM, so a whole number that fits
//      almost as well is preferred.
//   4. BAR 1: of the four beats in a bar, the one with the most kick energy is beat 1.
// =============================================================================
import { hann, magnitudeSpectrum } from './fft';

export interface TempoEstimate {
  /** Beats per minute, to 0.01. */
  bpm: number;
  /** Seconds from the start of the audio to the first bar line (in [0, one bar)). */
  offsetSec: number;
  /** How clearly the beat stands out (≥ 1; ~1 = no clear beat). */
  confidence: number;
}

const ENV_RATE = 100; // onset-envelope frames per second
const FFT_N = 1024;
const BPM_LO = 60;
const BPM_HI = 200;
const BASS_HZ = 150;

/** The onset envelope (all bands) + the bass-only one, at ENV_RATE frames/s. */
export function onsetEnvelopes(
  mono: Float32Array,
  sampleRate: number,
): { all: Float64Array; bass: Float64Array } {
  const hop = Math.max(1, Math.round(sampleRate / ENV_RATE));
  const frames = Math.max(0, Math.floor((mono.length - FFT_N) / hop) + 1);
  const all = new Float64Array(frames);
  const bass = new Float64Array(frames);
  const bins = FFT_N / 2 + 1;
  const bassBins = Math.max(2, Math.ceil((BASS_HZ * FFT_N) / sampleRate));
  let prev: Float64Array = new Float64Array(bins);
  const win = new Float64Array(FFT_N);
  const w = Float64Array.from({ length: FFT_N }, (_, i) => hann(i, FFT_N));
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < FFT_N; i++) win[i] = mono[o + i] * w[i];
    const mag = magnitudeSpectrum(win);
    let sAll = 0;
    let sBass = 0;
    for (let k = 1; k < bins; k++) {
      const c = Math.log1p(100 * mag[k]);
      const d = c - prev[k];
      if (d > 0) {
        sAll += d;
        if (k < bassBins) sBass += d;
      }
      mag[k] = c;
    }
    all[f] = sAll;
    bass[f] = sBass;
    prev = mag;
  }
  return { all: detrend(all), bass: detrend(bass) };
}

/** Remove the local average (±0.25 s) and keep what pokes above it — the hits. */
function detrend(x: Float64Array): Float64Array {
  const half = Math.round(ENV_RATE * 0.25);
  const out = new Float64Array(x.length);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + half)) sum += x[++hi];
    while (lo < i - half) sum -= x[lo++];
    const mean = sum / (hi - lo + 1);
    out[i] = Math.max(0, x[i] - mean);
  }
  return out;
}

/** The coarse tempo: the autocorrelation peak over 60–200 BPM, weighted toward 120. */
function coarseBpm(env: Float64Array): number {
  const lagLo = Math.floor((ENV_RATE * 60) / BPM_HI);
  const lagHi = Math.ceil((ENV_RATE * 60) / BPM_LO);
  const acf = new Float64Array(lagHi + 2);
  for (let L = lagLo - 1; L <= lagHi + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < env.length; i++) s += env[i] * env[i + L];
    acf[L] = s / Math.max(1, env.length - L);
  }
  let best = lagLo;
  let bestScore = -Infinity;
  for (let L = lagLo; L <= lagHi; L++) {
    const bpm = (ENV_RATE * 60) / L;
    const oct = Math.log2(bpm / 120) / 0.9;
    const score = acf[L] * Math.exp(-0.5 * oct * oct);
    if (score > bestScore) {
      bestScore = score;
      best = L;
    }
  }
  // Parabolic refinement of the peak lag.
  const a = acf[best - 1];
  const b = acf[best];
  const c = acf[best + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return (ENV_RATE * 60) / (best + shift);
}

const FOLD_BINS = 96;

/** Fold the envelope at the beat period: the circular profile's sharpest bin + its
 *  phase (envelope frames into the beat). */
function fold(env: Float64Array, bpm: number): { peak: number; mean: number; phase: number } {
  const period = (ENV_RATE * 60) / bpm;
  const hist = new Float64Array(FOLD_BINS);
  for (let i = 0; i < env.length; i++) {
    if (env[i] === 0) continue;
    const pos = (i % period) / period;
    hist[Math.min(FOLD_BINS - 1, Math.floor(pos * FOLD_BINS))] += env[i];
  }
  // Smooth over three bins (a hit straddling a bin edge still counts once).
  let peak = -Infinity;
  let at = 0;
  let total = 0;
  for (let k = 0; k < FOLD_BINS; k++) {
    const v =
      hist[(k + FOLD_BINS - 1) % FOLD_BINS] * 0.5 + hist[k] + hist[(k + 1) % FOLD_BINS] * 0.5;
    total += hist[k];
    if (v > peak) {
      peak = v;
      at = k;
    }
  }
  return { peak, mean: (2 * total) / FOLD_BINS, phase: ((at + 0.5) / FOLD_BINS) * period };
}

/** Detect the tempo + bar 1 of a song. Null when it's too short or has no clear beat. */
export function detectTempo(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): TempoEstimate | null {
  if (left.length < sampleRate * 4) return null; // under 4 s: not enough to judge
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = right ? (left[i] + right[i]) / 2 : left[i];
  const { all, bass } = onsetEnvelopes(mono, sampleRate);
  if (!all.some((v) => v > 0)) return null;

  const coarse = coarseBpm(all);
  let best = { bpm: coarse, ...fold(all, coarse) };
  for (let bpm = coarse - 2; bpm <= coarse + 2 + 1e-9; bpm += 0.01) {
    const f = fold(all, bpm);
    if (f.peak > best.peak) best = { bpm, ...f };
  }
  // Prefer a whole BPM that fits (nearly) as well — most music is made on one.
  const whole = Math.round(best.bpm);
  const wf = fold(all, whole);
  if (wf.peak >= best.peak * 0.97) best = { bpm: whole, ...wf };

  // Bar 1: the beat (of four) carrying the most kick energy.
  const period = (ENV_RATE * 60) / best.bpm;
  const kick = [0, 0, 0, 0];
  for (let k = 0; ; k++) {
    const t = best.phase + k * period;
    const i = Math.round(t);
    if (i >= bass.length) break;
    let s = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(bass.length - 1, i + 2); j++) s += bass[j];
    kick[k % 4] += s;
  }
  const beat1 = kick.indexOf(Math.max(...kick));
  const barFrames = 4 * period;
  const firstBar = (((best.phase + beat1 * period) % barFrames) + barFrames) % barFrames;
  return {
    bpm: Math.round(best.bpm * 100) / 100,
    offsetSec: Math.round((firstBar / ENV_RATE) * 1000) / 1000,
    confidence: best.mean > 0 ? best.peak / best.mean : 1,
  };
}
