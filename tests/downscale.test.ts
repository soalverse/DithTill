import { describe, it, expect } from 'vitest';
import { downscale } from '../src/core/downscale';

describe('downscale (shared source -> grid rule)', () => {
  it('area-averages a 2x2 image down to 1x1', () => {
    // grayscale 40, 80, 120, 160 -> mean 100
    const src = new Uint8Array([
      40, 40, 40, 255, 80, 80, 80, 255, 120, 120, 120, 255, 160, 160, 160, 255,
    ]);
    const out = downscale(src, 2, 2, 1, 1);
    expect([...out]).toEqual([100, 100, 100, 255]);
  });

  it('is a 1:1 copy when the dimensions already match', () => {
    const src = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
    const out = downscale(src, 2, 1, 2, 1);
    expect([...out]).toEqual([...src]);
  });

  it('produces exactly the requested dimensions', () => {
    const src = new Uint8Array(8 * 8 * 4).fill(200);
    const out = downscale(src, 8, 8, 4, 4);
    expect(out.length).toBe(4 * 4 * 4);
    expect(out[0]).toBe(200);
  });
});
