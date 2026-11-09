// Generative visualizer core (the deferred F element) — the PURE, headless
// half, TDD'd before any scene/render wiring:
//   1. every style produces a raster of the right shape.
//   2. DETERMINISM: same (config, feature, frame, seed) → byte-identical raster.
//   3. the visualizers RESPOND to the audio (louder feature → more coverage/tone).
//   4. no audio (null / ZERO feature) → a resting, non-crashing raster.
//   5. preAnalyze now carries a normalised spectrum of SPECTRUM_BINS.
import { describe, it, expect } from 'vitest';
import {
  renderVisualizerRaster,
  vizFeature,
  vizRasterDims,
  STYLE_EXTRAS,
  ALL_VISUALIZER_STYLES,
  VISUALIZER_STYLES,
  VIZ_RASTER,
  type VisualizerConfig,
  type VisualizerStyle,
} from '../src/core/visualizer';
import {
  preAnalyze,
  SPECTRUM_BINS,
  WAVE_POINTS,
  ZERO_FEATURE,
  type FrameFeature,
} from '../src/core/audio-features';
import { AUDIO_RATE, loopSampleCount } from '../src/core/loop-audio';
import { makeRng } from '../src/core/seeded-rng';

const RNG = makeRng(0x1337beef);
const cfg = (style: VisualizerStyle, over: Partial<VisualizerConfig> = {}): VisualizerConfig => ({
  style,
  band: 'low',
  gain: 0.6,
  ...over,
});

const coverage = (a: { covered: Uint8Array }): number => a.covered.reduce((s, v) => s + v, 0);
const toneSum = (a: { tones: Uint8Array }): number => a.tones.reduce((s, v) => s + v, 0);

const loudFeature: FrameFeature = {
  rms: 0.9,
  low: 0.9,
  mid: 0.8,
  high: 0.7,
  onset: 0.9,
  spectrum: Array.from({ length: SPECTRUM_BINS }, (_, i) => 0.4 + 0.5 * ((i % 4) / 4)),
};

describe('visualizer core', () => {
  it('every style renders a VIZ_RASTER-square tones+covered raster', () => {
    for (const style of ALL_VISUALIZER_STYLES) {
      const a = renderVisualizerRaster(cfg(style), loudFeature, 3, 60, RNG, 'v1');
      expect(a.w).toBe(VIZ_RASTER);
      expect(a.h).toBe(VIZ_RASTER);
      expect(a.tones.length).toBe(VIZ_RASTER * VIZ_RASTER);
      expect(a.covered.length).toBe(VIZ_RASTER * VIZ_RASTER);
      // Tones only where covered (Uint8 keeps them in 0..255). One check per style —
      // a per-pixel expect is ~half a million assertions and times out under load.
      let stray = 0;
      for (let i = 0; i < a.tones.length; i++) if (a.tones[i] > 0 && a.covered[i] !== 1) stray++;
      expect({ style, stray }).toEqual({ style, stray: 0 });
    }
  });

  it('is deterministic: same inputs → byte-identical raster (preview == export)', () => {
    for (const style of ALL_VISUALIZER_STYLES) {
      const a = renderVisualizerRaster(cfg(style), loudFeature, 7, 60, makeRng(42), 'node');
      const b = renderVisualizerRaster(cfg(style), loudFeature, 7, 60, makeRng(42), 'node');
      expect(Array.from(b.tones)).toEqual(Array.from(a.tones));
      expect(Array.from(b.covered)).toEqual(Array.from(a.covered));
    }
  });

  it('responds to the audio: a loud frame covers/tones MORE than silence', () => {
    // Wave draws the wave itself (its own test below feeds one).
    for (const style of VISUALIZER_STYLES.filter((s) => s !== 'waveform')) {
      const loud = renderVisualizerRaster(cfg(style), loudFeature, 5, 60, RNG, 'v');
      const quiet = renderVisualizerRaster(cfg(style), ZERO_FEATURE, 5, 60, RNG, 'v');
      // A loud Ridgeline's tall front ridge HIDES the ones behind (darkens), so it's
      // measured by how much it covers; everything else by how bright it gets.
      if (style === 'ridgeline') expect(coverage(loud)).toBeGreaterThan(coverage(quiet));
      else expect(toneSum(loud)).toBeGreaterThan(toneSum(quiet));
    }
  });

  it('no audio (null feature) → a resting raster, never a crash', () => {
    for (const style of ALL_VISUALIZER_STYLES) {
      const a = renderVisualizerRaster(cfg(style), null, 0, 60, RNG, 'v');
      expect(a.tones.length).toBe(VIZ_RASTER * VIZ_RASTER);
      expect(a.tones.every((t) => Number.isFinite(t))).toBe(true);
    }
  });

  it('bars track the spectrum: a spectrum-heavy frame paints tall bars', () => {
    const full: FrameFeature = {
      ...ZERO_FEATURE,
      spectrum: Array.from({ length: SPECTRUM_BINS }, () => 1),
    };
    const a = renderVisualizerRaster(cfg('bars'), full, 0, 60, RNG, 'v');
    // Full spectrum → substantial coverage (bars near full height across the width).
    expect(coverage(a)).toBeGreaterThan(VIZ_RASTER * VIZ_RASTER * 0.2);
  });

  it('vinyl + particles animate over frames (different frames → different rasters)', () => {
    // frame 15 of 60 = a quarter turn — avoids vinyl's 2-turns/loop landing back at 0.
    for (const style of ['vinyl', 'particles'] as VisualizerStyle[]) {
      const f0 = renderVisualizerRaster(cfg(style), loudFeature, 0, 60, makeRng(1), 'v');
      const f15 = renderVisualizerRaster(cfg(style), loudFeature, 15, 60, makeRng(1), 'v');
      expect(Array.from(f15.tones)).not.toEqual(Array.from(f0.tones));
    }
  });
});

describe('preAnalyze spectrum', () => {
  it('carries a normalised SPECTRUM_BINS spectrum per frame', () => {
    const F = 20;
    const fps = 30;
    const loop = loopSampleCount(F, fps, AUDIO_RATE);
    const pcm = new Float32Array(loop);
    for (let i = 0; i < loop; i++) pcm[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / AUDIO_RATE);
    const feats = preAnalyze({ pcm, sampleRate: AUDIO_RATE, frames: F, fps });
    for (const f of feats) {
      expect(f.spectrum).toBeDefined();
      expect(f.spectrum).toHaveLength(SPECTRUM_BINS);
      for (const v of f.spectrum!) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    // A 220 Hz tone should light the LOW-ish bins more than the very top bins.
    const avgLow = feats.reduce((s, f) => s + (f.spectrum![1] + f.spectrum![2]), 0) / feats.length;
    const avgHigh =
      feats.reduce(
        (s, f) => s + (f.spectrum![SPECTRUM_BINS - 1] + f.spectrum![SPECTRUM_BINS - 2]),
        0,
      ) / feats.length;
    expect(avgLow).toBeGreaterThan(avgHigh);
  });

  it('silence → all-zero spectrum (the silent guard covers it)', () => {
    const F = 10;
    const feats = preAnalyze({
      pcm: new Float32Array(loopSampleCount(F, 30, AUDIO_RATE)),
      sampleRate: AUDIO_RATE,
      frames: F,
      fps: 30,
    });
    for (const f of feats) for (const v of f.spectrum!) expect(v).toBe(0);
  });
});

// visualizer pass: new styles, Mirror, Smoothness, extras, the real wave.
describe('visualizer pass (gallery styles, mirror, smoothness, wave)', () => {
  const W = VIZ_RASTER;
  const diff = (a: { tones: Uint8Array }, b: { tones: Uint8Array }): number =>
    a.tones.reduce((n, v, i) => n + (v !== b.tones[i] ? 1 : 0), 0);

  it('mirror lr folds left onto right; quad also folds the bottom up (short bars survive)', () => {
    const short: FrameFeature = {
      ...loudFeature,
      spectrum: Array.from({ length: SPECTRUM_BINS }, () => 0.2),
    };
    const lr = renderVisualizerRaster(
      cfg('particles', { mirror: 'lr' }),
      loudFeature,
      4,
      60,
      RNG,
      'm',
    );
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) expect(lr.tones[y * W + x]).toBe(lr.tones[y * W + (W - 1 - x)]);
    const q = renderVisualizerRaster(cfg('bars', { mirror: 'quad' }), short, 0, 60, RNG, 'm');
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        expect(q.tones[y * W + x]).toBe(q.tones[y * W + (W - 1 - x)]);
        expect(q.tones[y * W + x]).toBe(q.tones[(W - 1 - y) * W + x]);
      }
    expect(coverage(q)).toBeGreaterThan(0); // short bars are still there (top + bottom)
  });

  it('absent extras draw exactly the original (older visualizers are unchanged)', () => {
    // Bars' original 16 = amount 1/3 on the 8..32 range.
    const old = renderVisualizerRaster(cfg('bars'), loudFeature, 3, 60, RNG, 'o');
    const same = renderVisualizerRaster(
      cfg('bars', { amount: 1 / 3 }),
      loudFeature,
      3,
      60,
      RNG,
      'o',
    );
    expect(diff(old, same)).toBe(0);
    const more = renderVisualizerRaster(cfg('bars', { amount: 1 }), loudFeature, 3, 60, RNG, 'o');
    expect(diff(old, more)).toBeGreaterThan(0);
  });

  it('every speed is whole cycles per loop: frame F lands back on frame 0 (seamless)', () => {
    for (const style of VISUALIZER_STYLES) {
      const max = STYLE_EXTRAS[style].paceMax ?? 1;
      for (let c = 1; c <= max; c++) {
        const pace = max > 1 ? (c - 1) / (max - 1) : undefined;
        const a = renderVisualizerRaster(cfg(style, { pace }), loudFeature, 0, 60, makeRng(9), 's');
        const b = renderVisualizerRaster(
          cfg(style, { pace }),
          loudFeature,
          60,
          60,
          makeRng(9),
          's',
        );
        expect(diff(a, b)).toBeLessThanOrEqual(W); // float noise only, never a jump
      }
    }
  });

  it('smoothness = peak hold: hits land instantly and fall back slowly; 0 = the raw frame', () => {
    const feats: FrameFeature[] = Array.from({ length: 10 }, (_, i) => ({
      ...ZERO_FEATURE,
      low: i === 2 ? 1 : 0,
      spectrum: Array.from({ length: SPECTRUM_BINS }, () => (i === 2 ? 1 : 0)),
    }));
    expect(vizFeature(feats, 4, 0)).toBe(feats[4]);
    expect(vizFeature(feats, 2, 0.8)!.low).toBe(1);
    const a = vizFeature(feats, 3, 0.8)!.low;
    const b = vizFeature(feats, 5, 0.8)!.low;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    expect(vizFeature(feats, 5, 0.8)!.spectrum![0]).toBeCloseTo(b);
    expect(vizFeature(feats, 99, 0.8)).toBeNull();
    expect(vizFeature(null, 0, 0.8)).toBeNull();
  });

  it('preAnalyze carries the wave: WAVE_POINTS in [-1,1], steady on a steady tone, 0 on silence', () => {
    const F = 12;
    const fps = 30;
    const loop = loopSampleCount(F, fps, AUDIO_RATE);
    const pcm = new Float32Array(loop);
    for (let i = 0; i < loop; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / AUDIO_RATE);
    const feats = preAnalyze({ pcm, sampleRate: AUDIO_RATE, frames: F, fps });
    for (const f of feats) {
      expect(f.wave).toHaveLength(WAVE_POINTS);
      for (const v of f.wave!) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    // Started at a rising zero crossing → the line holds still frame to frame.
    for (let p = 0; p < WAVE_POINTS; p++)
      expect(feats[7].wave![p]).toBeCloseTo(feats[3].wave![p], 1);
    const quiet = preAnalyze({
      pcm: new Float32Array(loop),
      sampleRate: AUDIO_RATE,
      frames: F,
      fps,
    });
    for (const f of quiet) for (const v of f.wave!) expect(v).toBe(0);
  });

  it('the waveform draws the wave it is given (a different wave → a different line)', () => {
    const up: FrameFeature = {
      ...loudFeature,
      wave: Array.from({ length: WAVE_POINTS }, () => 0.8),
    };
    const down: FrameFeature = {
      ...loudFeature,
      wave: Array.from({ length: WAVE_POINTS }, () => -0.8),
    };
    const a = renderVisualizerRaster(cfg('waveform'), up, 0, 60, RNG, 'w');
    const b = renderVisualizerRaster(cfg('waveform'), down, 0, 60, RNG, 'w');
    expect(diff(a, b)).toBeGreaterThan(0);
    // "up" sits in the top half, "down" in the bottom half.
    const half = (r: { covered: Uint8Array }, top: boolean): number =>
      r.covered.reduce((n, v, i) => n + (v && i < (W * W) / 2 === top ? 1 : 0), 0);
    expect(half(a, true)).toBeGreaterThan(half(a, false));
    expect(half(b, false)).toBeGreaterThan(half(b, true));
  });

  it('the classics read the recent past: a hit 4 frames ago still shows in Ridgeline/Waterfall/LEDs/Warp', () => {
    const silent: FrameFeature[] = Array.from({ length: 20 }, () => ({
      ...ZERO_FEATURE,
      spectrum: new Array<number>(SPECTRUM_BINS).fill(0),
      wave: new Array<number>(WAVE_POINTS).fill(0),
    }));
    const hit = silent.map((f, i) =>
      i === 6
        ? { ...loudFeature, wave: Array.from({ length: WAVE_POINTS }, (_, p) => Math.sin(p / 4)) }
        : f,
    );
    for (const style of ['ridgeline', 'waterfall', 'leds', 'warp'] as VisualizerStyle[]) {
      const draw = (fs: FrameFeature[]) =>
        renderVisualizerRaster(cfg(style), fs[10], 10, 20, RNG, 'h', W, { features: fs, at: 10 });
      expect(diff(draw(hit), draw(silent))).toBeGreaterThan(0);
    }
  });

  it('fill: a canvas-shaped visualizer is wide (or tall), short side = VIZ_RASTER; square when unset', () => {
    expect(vizRasterDims({})).toEqual({ w: W, h: W });
    expect(vizRasterDims({ aspect: 4 / 3 })).toEqual({ w: Math.round((W * 4) / 3), h: W });
    expect(vizRasterDims({ aspect: 9 / 16 })).toEqual({ w: W, h: Math.round((W * 16) / 9) });
    for (const style of ALL_VISUALIZER_STYLES) {
      const a = renderVisualizerRaster(
        cfg(style, { aspect: 16 / 9 }),
        loudFeature,
        3,
        60,
        RNG,
        'f',
      );
      expect([a.w, a.h]).toEqual([Math.round((W * 16) / 9), W]);
      expect(a.tones.length).toBe(a.w * a.h);
      expect({ style, lit: coverage(a) > 0 }).toEqual({ style, lit: true });
    }
  });
});
