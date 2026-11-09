// the PURE export-length math (T_live derivation + the picker's
// duration parser/resolver). Pinning these keeps the live absolute clock and the
// export picker honest without the DOM/store/codec layers.
import { describe, it, expect } from 'vitest';
import {
  ceilToMultiple,
  liveTotalFrames,
  loopsFit,
  fitLoopsLength,
  GIF_MAX_SECONDS,
  formatClock,
  estimateRenderSeconds,
  CONFIRM_OVER_SECONDS,
} from '../src/core/export-length';

describe('ceilToMultiple', () => {
  it('rounds up to the next multiple of F (>= F)', () => {
    expect(ceilToMultiple(1, 60)).toBe(60);
    expect(ceilToMultiple(60, 60)).toBe(60);
    expect(ceilToMultiple(61, 60)).toBe(120);
    expect(ceilToMultiple(179, 60)).toBe(180);
    expect(ceilToMultiple(180, 60)).toBe(180);
  });
  it('never returns below F, and a non-integer input ceils', () => {
    expect(ceilToMultiple(0, 30)).toBe(30);
    expect(ceilToMultiple(30.1, 30)).toBe(60);
  });
});

describe('liveTotalFrames (T_live)', () => {
  it('is F when there are no absolute sources', () => {
    expect(liveTotalFrames(60, [])).toBe(60);
  });
  it('is the longest source EXACTLY — no longer rounded up to whole loops', () => {
    expect(liveTotalFrames(60, [250, 130])).toBe(250);
    expect(liveTotalFrames(60, [181])).toBe(181);
  });
  it('is never shorter than the loop', () => {
    expect(liveTotalFrames(60, [40])).toBe(60);
  });
});

describe('loopsFit / fitLoopsLength — a GIF that loops seamlessly', () => {
  it('a length fits when it ends every loop on a whole pass (within one frame)', () => {
    expect(loopsFit(110, [55])).toBe(true); // 2 passes
    expect(loopsFit(111, [55, 111])).toBe(true); // 1 bar + 2 bars at 130 BPM (55 / 111 frames)
    expect(loopsFit(80, [55])).toBe(false); // ends mid-way
    expect(loopsFit(40, [55])).toBe(false); // shorter than one pass
    expect(loopsFit(90, [])).toBe(true); // nothing loops
  });
  it('Fit finds the shortest length that ends every loop on a whole pass', () => {
    expect(fitLoopsLength([55, 111], 1800)).toBe(111);
    expect(fitLoopsLength([40, 60], 1800)).toBe(120);
    expect(fitLoopsLength([], 1800)).toBeNull();
  });
  it('Fit gives up past the cap (the 60 s GIF limit)', () => {
    expect(fitLoopsLength([997, 1009], 1800)).toBeNull();
    expect(GIF_MAX_SECONDS).toBe(60);
  });
});

describe('formatClock', () => {
  it('formats m:ss under an hour and h:mm:ss past it', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(3723)).toBe('1:02:03');
  });
});

describe('estimateRenderSeconds', () => {
  it('returns a fast/slow window bounded by the frame count', () => {
    const e = estimateRenderSeconds(7000);
    expect(e.fast).toBeCloseTo(100);
    expect(e.slow).toBeCloseTo(280);
    expect(e.fast).toBeLessThan(e.slow);
  });
  it('CONFIRM_OVER_SECONDS is 15 minutes', () => {
    expect(CONFIRM_OVER_SECONDS).toBe(900);
  });
});
