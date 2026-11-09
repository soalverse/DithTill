// W2 / v15 — the canonical loop-audio mix (core/loop-audio.buildLoopAudioMix), the
// soundtrack the MP4 export hands the codec. Proves the spec'd
// BYTE-IDENTICAL DOUBLE-EXPORT guarantee for the audio path — same pure inputs → the
// same samples — and pins the duration (mix samples == round(F/fps · rate)), the pure
// half of "MP4 duration == F/fps".
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  AUDIO_RATE,
  buildLoopAudioMix,
  loopSampleCount,
  type LoopAudioSource,
} from '../src/core/loop-audio';

/** A tiny deterministic stereo source: L = ramp, R = alternating sign. */
function rampSource(samples: number, clipSamples: number): LoopAudioSource {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    left[i] = (i / samples) * 0.8;
    right[i] = i % 2 ? 0.5 : -0.5;
  }
  return { pcm: { left, right }, clipSamples };
}

const bytesOf = (a: Float32Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe('the canonical loop-audio mix (the MP4 soundtrack)', () => {
  it('BYTE-IDENTICAL double export: same pure inputs → the same samples', () => {
    const frames = 48;
    const fps = 12;
    const make = () => {
      const sources = [
        rampSource(loopSampleCount(frames, fps), loopSampleCount(24, fps)),
        rampSource(9000, 9000),
      ];
      return buildLoopAudioMix(sources, frames, fps, true);
    };
    const a = make();
    const b = make();
    expect(bytesOf(a.left).equals(bytesOf(b.left))).toBe(true);
    expect(bytesOf(a.right).equals(bytesOf(b.right))).toBe(true);
  });

  it('the mix duration is exactly the loop: samples == round(F/fps · 48000)', () => {
    for (const [frames, fps] of [
      [60, 30],
      [48, 12],
      [7, 3],
    ] as const) {
      const mix = buildLoopAudioMix([rampSource(100, 100)], frames, fps, false);
      expect(mix.left.length).toBe(loopSampleCount(frames, fps));
      expect(mix.right.length).toBe(mix.left.length);
      expect(mix.left.length).toBe(Math.max(1, Math.round((frames / fps) * AUDIO_RATE)));
    }
  });

  it('a long export covers the whole length: totalFrames → round(T/fps · 48000)', () => {
    const mix = buildLoopAudioMix([rampSource(4000, 4000)], 12, 12, false, AUDIO_RATE, 30);
    expect(mix.left.length).toBe(loopSampleCount(30, 12));
  });
});
