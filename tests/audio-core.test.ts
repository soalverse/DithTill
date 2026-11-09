// v12 headless audio core (P6; decisions locked 2026-07-03):
//   1. fft.ts — impulse/sine sanity on the radix-2 transform.
//   2. audio-features.preAnalyze — silence guard, band separation, onset pulse,
//      circular envelope convergence, determinism.
//   3. gated reaction depth = sensitivity threshold (invert/palette).
//   4. loop-audio — canonical mix: tiling mirrors the frame modulo, zero-pad,
//      seam-fade toggle, clip-sum normalization.
import { describe, it, expect } from 'vitest';
import { fftComplex, hann, isPow2, magnitudeSpectrum } from '../src/core/fft';
import {
  ANALYSIS_FFT_SIZE,
  gateThreshold,
  preAnalyze,
  reactionDelta,
  ZERO_FEATURE,
  type FeatureArray,
} from '../src/core/audio-features';
import {
  AUDIO_RATE,
  SEAM_FADE_SECONDS,
  audioSourceKey,
  buildLoopAudioMix,
  clipSampleCount,
  loopSampleCount,
  monoMix,
  type StereoPcm,
} from '../src/core/loop-audio';
import type { AudioReactEvent } from '../src/core/loop-events';
import { useLoopStore } from '../src/state/loop-store';

// ---------------------------------------------------------------------------
// fft
// ---------------------------------------------------------------------------
describe('fft', () => {
  it('rejects non-power-of-two lengths', () => {
    expect(isPow2(1024)).toBe(true);
    expect(isPow2(1000)).toBe(false);
    expect(() => magnitudeSpectrum(new Float32Array(1000))).toThrow();
  });

  it('impulse → flat unit magnitude', () => {
    const x = new Float32Array(64);
    x[0] = 1;
    const mag = magnitudeSpectrum(x);
    expect(mag.length).toBe(33);
    for (const m of mag) expect(m).toBeCloseTo(1, 10);
  });

  it('pure sine at bin k → single peak at bin k', () => {
    const N = 256;
    const k = 12;
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * k * i) / N);
    const mag = magnitudeSpectrum(x);
    // Float32 sample quantization bounds the error around 1e-6 relative.
    expect(mag[k]).toBeCloseTo(N / 2, 3);
    for (let b = 0; b <= N / 2; b++) if (b !== k) expect(mag[b]).toBeLessThan(1e-4);
  });

  it('linearity of the complex transform (Parseval sanity)', () => {
    const N = 128;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let timeEnergy = 0;
    for (let i = 0; i < N; i++) {
      re[i] = Math.sin(i * 0.7) + 0.5 * Math.cos(i * 2.1);
      timeEnergy += re[i] * re[i];
    }
    fftComplex(re, im);
    let freqEnergy = 0;
    for (let i = 0; i < N; i++) freqEnergy += re[i] * re[i] + im[i] * im[i];
    expect(freqEnergy / N).toBeCloseTo(timeEnergy, 6);
  });

  it('hann window endpoints ~0, midpoint 1', () => {
    expect(hann(0, 512)).toBeCloseTo(0, 10);
    expect(hann(256, 512)).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// preAnalyze
// ---------------------------------------------------------------------------
const sine = (freq: number, samples: number, rate: number, amp = 0.8): Float32Array => {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};

describe('preAnalyze', () => {
  const F = 30;
  const FPS = 30;
  const SR = AUDIO_RATE;
  const LOOP = loopSampleCount(F, FPS, SR);

  it('silence → all-zero features, no NaN (the silent-band divide guard)', () => {
    const feats = preAnalyze({ pcm: new Float32Array(LOOP), sampleRate: SR, frames: F, fps: FPS });
    expect(feats.length).toBe(F);
    for (const f of feats) {
      expect([f.rms, f.low, f.mid, f.high, f.onset]).toEqual([0, 0, 0, 0, 0]);
      expect(f.spectrum?.every((v) => v === 0)).toBe(true);
    }
  });

  it('empty pcm → zero features of the right length', () => {
    const feats = preAnalyze({ pcm: new Float32Array(0), sampleRate: SR, frames: F, fps: FPS });
    expect(feats.length).toBe(F);
    expect(feats[7]).toEqual(ZERO_FEATURE);
  });

  it('100 Hz sine → low band dominates; 4 kHz sine → high band dominates', () => {
    const lowFeats = preAnalyze({ pcm: sine(100, LOOP, SR), sampleRate: SR, frames: F, fps: FPS });
    const highFeats = preAnalyze({
      pcm: sine(4000, LOOP, SR),
      sampleRate: SR,
      frames: F,
      fps: FPS,
    });
    const avg = (fa: FeatureArray, key: 'low' | 'high'): number =>
      fa.reduce((s, f) => s + f[key], 0) / fa.length;
    expect(avg(lowFeats, 'low')).toBeGreaterThan(5 * avg(lowFeats, 'high'));
    expect(avg(highFeats, 'high')).toBeGreaterThan(5 * avg(highFeats, 'low'));
  });

  it('a mid-loop burst → an onset pulse at the burst with a decaying multi-frame tail', () => {
    const pcm = new Float32Array(LOOP);
    const start = Math.round((10 / FPS) * SR);
    const burst = sine(880, Math.round(SR / FPS) * 2, SR);
    pcm.set(burst, start);
    const feats = preAnalyze({ pcm, sampleRate: SR, frames: F, fps: FPS });
    let peakFrame = 0;
    for (let f = 1; f < F; f++) if (feats[f].onset > feats[peakFrame].onset) peakFrame = f;
    expect(peakFrame).toBeGreaterThanOrEqual(9);
    expect(peakFrame).toBeLessThanOrEqual(11);
    expect(feats[peakFrame].onset).toBeCloseTo(1, 6);
    // The pulse tail: the next frames still carry a decayed echo (multi-frame).
    expect(feats[peakFrame + 1].onset).toBeGreaterThan(0.3);
    expect(feats[peakFrame + 1].onset).toBeLessThan(feats[peakFrame].onset);
  });

  it('all values in [0,1]; two runs are identical (deterministic)', () => {
    const pcm = sine(440, LOOP, SR);
    pcm.set(sine(60, LOOP >> 2, SR), LOOP >> 1);
    const a = preAnalyze({ pcm, sampleRate: SR, frames: F, fps: FPS });
    const b = preAnalyze({ pcm, sampleRate: SR, frames: F, fps: FPS });
    expect(b).toEqual(a);
    for (const f of a)
      for (const v of [f.rms, f.low, f.mid, f.high, f.onset, ...(f.spectrum ?? [])]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
  });

  it('a release tail longer than a SHORT loop still converges (envelope iterated, not "2 loops")', () => {
    // 6-frame loop (0.2 s) — far shorter than the release tail. The circular
    // envelope bake must still produce a finite fixed point.
    const shortF = 6;
    const shortLoop = loopSampleCount(shortF, FPS, SR);
    const pcm = new Float32Array(shortLoop);
    pcm.set(sine(440, Math.round(SR / FPS), SR), 0);
    const feats = preAnalyze({ pcm, sampleRate: SR, frames: shortF, fps: FPS });
    for (const f of feats)
      for (const v of [f.rms, f.low, f.mid, f.high, f.onset, ...(f.spectrum ?? [])]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    // Convergence means the bake is loop-consistent: re-running from the baked
    // state changes nothing (verified implicitly by determinism above), and the
    // envelope is non-trivial (the burst registered).
    expect(Math.max(...feats.map((f) => f.rms))).toBeGreaterThan(0.5);
  });

  it('ANALYSIS_FFT_SIZE is a power of two (the transform requires it)', () => {
    expect(isPow2(ANALYSIS_FFT_SIZE)).toBe(true);
  });

  it('analyzes a full 2-loop track: output length T, windows index the whole buffer', () => {
    // A T = 2F track. A burst sits ONLY at ~1.5F (deep in the second loop). If
    // preAnalyze wrongly assumed `frames` were a single loop it could never index
    // that region — so detecting it at frame ~1.5F proves the analysis is
    // length-generic over T (the export's T-frame timeline is what loops).
    const twoF = 2 * F;
    const buf = loopSampleCount(twoF, FPS, SR);
    const pcm = new Float32Array(buf);
    const burstFrame = Math.round(F + F / 2); // 45
    const start = Math.round((burstFrame / FPS) * SR);
    pcm.set(sine(220, Math.round(SR / FPS) * 2, SR), start);
    const feats = preAnalyze({ pcm, sampleRate: SR, frames: twoF, fps: FPS });
    expect(feats.length).toBe(twoF); // length T, NOT F
    expect(feats[burstFrame].rms).toBeGreaterThan(0.3); // the second-loop burst is seen
    // Localized, not smeared across every frame — a frame far from the burst is quiet.
    const farFrame = (burstFrame + F) % twoF; // 15, the circular opposite
    expect(feats[burstFrame].rms).toBeGreaterThan(3 * feats[farFrame].rms);
  });
});

// ---------------------------------------------------------------------------
// gated reaction depth = sensitivity threshold (locked decision 7)
// ---------------------------------------------------------------------------
describe('gated reaction depth (invert / palette)', () => {
  const feat = (onset: number): FeatureArray => [{ ...ZERO_FEATURE, onset }];
  const invertEv = (depth: number): AudioReactEvent => ({
    id: 'ar1',
    kind: 'audio-react',
    nodeId: '',
    pass: 0,
    layer: 0,
    startFrame: 0,
    endFrame: 0,
    band: 'onset',
    target: { kind: 'invert' },
    depth,
  });

  it('threshold mapping: full depth → 0.5, half depth → 0.75, zero → never', () => {
    expect(gateThreshold(1)).toBeCloseTo(0.5);
    expect(gateThreshold(0.5)).toBeCloseTo(0.75);
    expect(gateThreshold(0)).toBeCloseTo(1);
  });

  it('invert fires per the depth threshold', () => {
    expect(reactionDelta(invertEv(1), feat(0.5), 0).invert).toBe(true);
    expect(reactionDelta(invertEv(1), feat(0.4), 0)).toEqual({});
    expect(reactionDelta(invertEv(0.4), feat(0.7), 0)).toEqual({}); // needs 0.8
    expect(reactionDelta(invertEv(0.4), feat(0.9), 0).invert).toBe(true);
    expect(reactionDelta(invertEv(0), feat(1), 0).invert).toBeUndefined(); // never fires
  });

  it('palette pulses exactly one step when fired', () => {
    const ev: AudioReactEvent = { ...invertEv(1), target: { kind: 'palette' } };
    expect(reactionDelta(ev, feat(0.9), 0).paletteStep).toBe(1);
    expect(reactionDelta(ev, feat(0.2), 0).paletteStep).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loop-audio: the canonical mix
// ---------------------------------------------------------------------------
describe('loop-audio', () => {
  const stereo = (mono: Float32Array): StereoPcm => ({
    left: mono,
    right: Float32Array.from(mono),
  });

  it('sample-count math mirrors the integer frame clock', () => {
    expect(loopSampleCount(60, 30)).toBe(96000); // 2 s at 48 kHz
    expect(clipSampleCount(45, 30)).toBe(72000); // 1.5 s clip
    expect(loopSampleCount(1, 30)).toBe(1600);
  });

  it('a short clip tiles modulo its clipSamples — the audio mirror of loopFrameToClipTick', () => {
    const clip = new Float32Array(100);
    for (let i = 0; i < 100; i++) clip[i] = (i + 1) / 200;
    // 1 frame at fps 0.2 → nonsense in app terms; drive the rate directly instead:
    const mix = buildLoopAudioMix(
      [{ pcm: stereo(clip), clipSamples: 100 }],
      1,
      1,
      false,
      250, // loop = 250 samples → 2.5 tiles
    );
    expect(mix.left.length).toBe(250);
    expect(mix.left[0]).toBeCloseTo(clip[0], 6);
    expect(mix.left[137]).toBeCloseTo(clip[37], 6); // second tile
    expect(mix.left[249]).toBeCloseTo(clip[49], 6); // partial third tile
    expect(Array.from(mix.right)).toEqual(Array.from(mix.left));
  });

  it('pcm shorter than clipSamples zero-pads the tail of every tile', () => {
    const clip = new Float32Array(10).fill(0.5);
    const mix = buildLoopAudioMix([{ pcm: stereo(clip), clipSamples: 20 }], 1, 1, false, 60);
    expect(mix.left[5]).toBeCloseTo(0.5, 6);
    expect(mix.left[15]).toBe(0); // pad inside tile 1
    expect(mix.left[25]).toBeCloseTo(0.5, 6); // tile 2 audio again
    expect(mix.left[35]).toBe(0);
  });

  it('seam fade attenuates only the tile/loop edges; toggle off = untouched', () => {
    const rate = AUDIO_RATE;
    const fadeN = Math.round(SEAM_FADE_SECONDS * rate); // 240
    const clipLen = rate; // 1 s tile
    const clip = new Float32Array(clipLen).fill(1);
    const loopSamples = rate * 2; // two tiles
    const on = buildLoopAudioMix([{ pcm: stereo(clip), clipSamples: clipLen }], 2, 1, true, rate);
    const off = buildLoopAudioMix([{ pcm: stereo(clip), clipSamples: clipLen }], 2, 1, false, rate);
    expect(on.left.length).toBe(loopSamples);
    // Mid-tile untouched either way.
    expect(on.left[clipLen >> 1]).toBeCloseTo(1, 6);
    expect(off.left[clipLen >> 1]).toBeCloseTo(1, 6);
    // Edges: faded when on (buffer start, tile join, buffer end), full when off.
    expect(on.left[0]).toBeLessThan(0.05);
    expect(on.left[clipLen - 1]).toBeLessThan(0.05); // fade-out into the join
    expect(on.left[clipLen]).toBeLessThan(0.05); // fade-in out of the join
    expect(on.left[loopSamples - 1]).toBeLessThan(0.05); // the loop-wrap seam
    expect(on.left[fadeN + 10]).toBeCloseTo(1, 4); // just past the ramp
    expect(off.left[0]).toBeCloseTo(1, 6);
    expect(off.left[clipLen]).toBeCloseTo(1, 6);
    expect(off.left[loopSamples - 1]).toBeCloseTo(1, 6);
  });

  it('sources sum; a clipping sum is peak-normalized back to ≤ 1', () => {
    const a = new Float32Array(100).fill(0.3);
    const b = new Float32Array(100).fill(0.4);
    const quiet = buildLoopAudioMix(
      [
        { pcm: stereo(a), clipSamples: 100 },
        { pcm: stereo(b), clipSamples: 100 },
      ],
      1,
      1,
      false,
      100,
    );
    expect(quiet.left[50]).toBeCloseTo(0.7, 6); // unity-gain sum, no clip
    const loudA = new Float32Array(100).fill(0.8);
    const loudB = new Float32Array(100).fill(0.6);
    const loud = buildLoopAudioMix(
      [
        { pcm: stereo(loudA), clipSamples: 100 },
        { pcm: stereo(loudB), clipSamples: 100 },
      ],
      1,
      1,
      false,
      100,
    );
    expect(Math.max(...loud.left)).toBeLessThanOrEqual(1);
    expect(loud.left[50]).toBeCloseTo(1, 6); // 1.4 scaled by 1/1.4
  });

  it('no sources → a silent loop buffer of the right length', () => {
    const mix = buildLoopAudioMix([], 60, 30, true);
    expect(mix.left.length).toBe(96000);
    expect(mix.left.every((v) => v === 0)).toBe(true);
  });

  // ---: export length (totalFrames = T) != loop length (frames = F) ---
  it('totalFrames defaults to frames — byte-identical to the old 5-arg call (Float32Array-exact)', () => {
    const clip = new Float32Array(70);
    for (let i = 0; i < 70; i++) clip[i] = Math.sin(i) / 2;
    const src = [{ pcm: stereo(clip), clipSamples: 70 }];
    const oldShape = buildLoopAudioMix(src, 2, 1, true, 300); // no totalFrames arg
    const explicit = buildLoopAudioMix(src, 2, 1, true, 300, 2); // totalFrames === frames
    expect(Array.from(explicit.left)).toEqual(Array.from(oldShape.left));
    expect(Array.from(explicit.right)).toEqual(Array.from(oldShape.right));
    expect(explicit.left.length).toBe(loopSampleCount(2, 1, 300));
  });

  it('T = 2F: output length is loopSampleCount(T); a SHORT source repeats on song time', () => {
    // loop = 100 samples, clip = 40 (< loop); T = 2 frames → n = 200.
    const clip = new Float32Array(40);
    for (let i = 0; i < 40; i++) clip[i] = (i + 1) / 100;
    const src = [{ pcm: stereo(clip), clipSamples: 40 }];
    const mix = buildLoopAudioMix(src, 1, 1, false, 100, 2);
    expect(mix.left.length).toBe(200); // loopSampleCount(2, 1, 100)
    expect(mix.left[85]).toBeCloseTo(clip[5], 6); // 85 % 40 = 5
    // The loop boundary no longer restarts it: sample 105 is clip[25] (105 % 40), the same
    // song-time rule the picture follows.
    expect(mix.left[105]).toBeCloseTo(clip[25], 6);
    expect(clip[25]).not.toBeCloseTo(clip[5], 6);
  });

  it('a timed clip sounds at its SONG position and repeats its footage past the end', () => {
    // footage = 40 samples; one clip at song sample 150, 100 long, from the start.
    const clip = new Float32Array(40);
    for (let i = 0; i < 40; i++) clip[i] = (i + 1) / 100;
    const src = [
      { pcm: stereo(clip), clipSamples: 40, clips: [{ start: 150, duration: 100, sourceIn: 0 }] },
    ];
    const mix = buildLoopAudioMix(src, 1, 1, false, 100, 3);
    expect(mix.left[50]).toBe(0); // the loop length (100) no longer wraps it in early
    expect(mix.left[149]).toBe(0);
    expect(mix.left[155]).toBeCloseTo(clip[5], 6);
    expect(mix.left[195]).toBeCloseTo(clip[5], 6); // 45 in → the footage repeated (45 % 40)
    expect(mix.left[250]).toBe(0); // after the clip
  });

  it('T = 2F: an OUTLASTING source (clip > loop) advances ABSOLUTELY across the export', () => {
    // loopSamples = 100, clip = 250 (> loop) → absolute; n = 200 (< clip, no wrap).
    const clip = new Float32Array(250);
    for (let i = 0; i < 250; i++) clip[i] = (i + 1) / 300;
    const src = [{ pcm: stereo(clip), clipSamples: 250 }];
    const mix = buildLoopAudioMix(src, 1, 1, false, 100, 2);
    expect(mix.left.length).toBe(200);
    expect(mix.left[0]).toBeCloseTo(clip[0], 6);
    expect(mix.left[150]).toBeCloseTo(clip[150], 6); // the 150th sample absolute (not restarted)
    expect(mix.left[199]).toBeCloseTo(clip[199], 6);
  });

  it('audioSourceKey distinguishes trim variants of ONE source, shares look variants', () => {
    // The decode-cache key MUST include the trim window: two Library variants of
    // one source video (same videoHash, different trim) are distinct audio and
    // must not collide (the v13 review's unanimous MAJOR finding).
    const hash = 'abc123';
    expect(audioSourceKey(hash, 0, 2)).not.toBe(audioSourceKey(hash, 5, 7));
    // Same source + same trim (a palette/matrix-only variant) → one shared decode.
    expect(audioSourceKey(hash, 0, 2)).toBe(audioSourceKey(hash, 0, 2));
    // Different source, same trim → distinct.
    expect(audioSourceKey('def456', 0, 2)).not.toBe(audioSourceKey(hash, 0, 2));
  });

  it('monoMix averages the channels', () => {
    const pcm: StereoPcm = {
      left: Float32Array.from([1, 0.5]),
      right: Float32Array.from([0, 0.5]),
    };
    expect(Array.from(monoMix(pcm))).toEqual([0.5, 0.5]);
  });
});

// ---------------------------------------------------------------------------
// loop-store: the P6 audio fields keep the transient/stored split
// ---------------------------------------------------------------------------
describe('loop-store audio fields (P6)', () => {
  it('audio transients (features/mutes/sources/track) record NO undo entry', () => {
    useLoopStore.temporal.getState().clear();
    const s = useLoopStore.getState();
    s.setFeatures([{ rms: 1, low: 1, mid: 0, high: 0, onset: 0 }]);
    s.toggleAudioMute('vid-1');
    s.setAudioSources([{ id: 'vid-1', kind: 'video', label: 'video' }]);
    s.setTrackName('song.mp3');
    expect(useLoopStore.temporal.getState().pastStates.length).toBe(0);
    expect(useLoopStore.getState().audioMuted).toContain('vid-1');
    s.toggleAudioMute('vid-1');
    expect(useLoopStore.getState().audioMuted).not.toContain('vid-1');
    s.setCueSound(true);
    expect(useLoopStore.getState().cueSound).toBe(true);
    expect(useLoopStore.temporal.getState().pastStates.length).toBe(0); // cue is a live pref
    s.setFeatures(null);
    s.setAudioSources([]);
    s.setTrackName(null);
    s.setCueSound(false);
  });

  it('seamFade lives in META (stored, undoable — an export input)', () => {
    useLoopStore.temporal.getState().clear();
    expect(useLoopStore.getState().meta.seamFade).toBe(true); // default on
    useLoopStore.getState().setSeamFade(false);
    expect(useLoopStore.getState().meta.seamFade).toBe(false);
    expect(useLoopStore.temporal.getState().pastStates.length).toBe(1);
    useLoopStore.getState().setSeamFade(true);
  });
});
