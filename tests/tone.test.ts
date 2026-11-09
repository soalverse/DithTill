// G3 pre-dither tone (gamma + levels) — the LUT is the whole feature: it treats
// the grid bytes at the one sourceToGrid seam, so these properties are what keep
// preview == export and the treatment predictable.
import { describe, it, expect } from 'vitest';
import {
  applyToneLut,
  BRIGHTNESS_REACH,
  isNeutralTone,
  toneLut,
  TONE_NEUTRAL,
} from '../src/core/tone';

describe('tone LUT (G3)', () => {
  it('neutral tone is the identity', () => {
    expect(isNeutralTone(TONE_NEUTRAL)).toBe(true);
    expect(isNeutralTone(undefined)).toBe(true);
    const lut = toneLut(TONE_NEUTRAL);
    for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v);
  });

  it('is monotonic non-decreasing with exact endpoints for any params', () => {
    for (const t of [
      { gamma: 0.4, black: 0, white: 255 },
      { gamma: 2.5, black: 0, white: 255 },
      { gamma: 1, black: 40, white: 200 },
      { gamma: 1.6, black: 120, white: 135 },
    ]) {
      const lut = toneLut(t);
      expect(lut[0]).toBe(0);
      expect(lut[255]).toBe(255);
      for (let v = 1; v < 256; v++)
        expect(lut[v], `γ=${t.gamma} v=${v}`).toBeGreaterThanOrEqual(lut[v - 1]);
    }
  });

  it('levels crush below black and clip above white', () => {
    const lut = toneLut({ gamma: 1, black: 50, white: 200 });
    expect(lut[50]).toBe(0);
    expect(lut[49]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[220]).toBe(255);
    expect(lut[125]).toBe(128); // midpoint of [50,200] → mid-grey
  });

  it('gamma > 1 brightens mids; < 1 darkens', () => {
    expect(toneLut({ gamma: 2, black: 0, white: 255 })[128]).toBeGreaterThan(128);
    expect(toneLut({ gamma: 0.5, black: 0, white: 255 })[128]).toBeLessThan(128);
  });

  it('applyToneLut treats RGB in place and never touches alpha', () => {
    const rgba = new Uint8Array([10, 128, 250, 7, 0, 255, 128, 200]);
    const lut = toneLut({ gamma: 1, black: 50, white: 200 });
    applyToneLut(rgba, lut);
    expect([...rgba]).toEqual([0, lut[128], 255, 7, 0, 255, lut[128], 200]);
  });

  it('Brightness shifts every tone, clamped, and 0 stays neutral', () => {
    expect(isNeutralTone({ ...TONE_NEUTRAL, brightness: 0 })).toBe(true);
    expect(isNeutralTone({ ...TONE_NEUTRAL, brightness: 10 })).toBe(false);
    const up = toneLut({ ...TONE_NEUTRAL, brightness: 50 });
    const down = toneLut({ ...TONE_NEUTRAL, brightness: -100 });
    expect(up[100]).toBe(100 + BRIGHTNESS_REACH / 2);
    expect(up[255]).toBe(255); // clamped
    expect(down[100]).toBe(0); // clamped
    expect(down[255]).toBe(255 - BRIGHTNESS_REACH);
    for (let v = 1; v < 256; v++) expect(up[v]).toBeGreaterThanOrEqual(up[v - 1]);
  });
});
