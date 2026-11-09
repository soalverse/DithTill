// =============================================================================
// Custom-colour Phase 1 (gap-plan §8.B). The free-RGB SWATCH funnel (core/color.ts)
// + its flow through every render/encode path. Contracts:
//   - resolveSwatch: number → clamped palette shade; [r,g,b] → itself; null → null.
//   - a PRESET shade TRACKS the palette on a switch; a CUSTOM RGB PINS.
//   - a custom-RGB background bakes the EXACT bytes (opaque) in the square PNG,
//     the composite PNG, and the SVG; a custom-RGB dot INK renders in that exact
//     colour through the live painter AND the PNG export, BYTE-IDENTICAL.
//   - null/undefined everywhere stays byte-identical to the preset/legacy paths.
// =============================================================================
import { describe, it, expect } from 'vitest';
import UPNG from 'upng-js';
import {
  clampRgb,
  hexToRgb,
  resolveInk,
  resolveSwatch,
  rgbToHex,
  rgbTone,
  swatchTone,
  type Rgb,
} from '../src/core/color';
import { PALETTE_IDS, paletteRgbAt, paletteLength, LUMA } from '../src/core/dither-constants';
import { encodeCompositePng, type Composite } from '../src/core/composite';

const decodeRgba = (png: Uint8Array): Uint8Array => {
  const dec = UPNG.decode(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(UPNG.toRGBA8(dec)[0]);
};

describe('resolveSwatch — the one funnel (custom-colour Phase 1)', () => {
  it('number → the clamped palette shade (existing paletteRgbAt policy)', () => {
    for (const p of PALETTE_IDS) {
      const N = paletteLength(p);
      expect(resolveSwatch(0, p)).toEqual(paletteRgbAt(p, 0));
      expect(resolveSwatch(N - 1, p)).toEqual(paletteRgbAt(p, N - 1));
      // Stale (out-of-range) index clamps to the last shade — survives a shorter ramp.
      expect(resolveSwatch(99, p)).toEqual(paletteRgbAt(p, N - 1));
      expect(resolveSwatch(-5, p)).toEqual(paletteRgbAt(p, 0));
    }
  });

  it('[r,g,b] → itself (clamped to bytes); null → null', () => {
    expect(resolveSwatch([10, 20, 30], 'two')).toEqual([10, 20, 30]);
    expect(resolveSwatch([300, -4, 128.6], 'two')).toEqual([255, 0, 129]);
    expect(resolveSwatch(null, 'two')).toBeNull();
  });

  it('a PRESET shade TRACKS the palette; a CUSTOM RGB PINS across a switch', () => {
    // Same index resolves to DIFFERENT colours on different palettes (tracks).
    expect(resolveSwatch(2, 'dusk')).not.toEqual(resolveSwatch(2, 'clay'));
    // A custom RGB is identical regardless of palette (pins).
    const custom: Rgb = [12, 200, 90];
    expect(resolveSwatch(custom, 'dusk')).toEqual(resolveSwatch(custom, 'clay'));
    expect(resolveSwatch(custom, 'dusk')).toEqual(custom);
  });

  it('resolveInk: null/undefined → the palette BRIGHTEST shade; number/array as given', () => {
    for (const p of PALETTE_IDS) {
      const bright = paletteRgbAt(p, paletteLength(p) - 1);
      expect(resolveInk(null, p)).toEqual(bright);
      expect(resolveInk(undefined, p)).toEqual(bright);
      expect(resolveInk(0, p)).toEqual(paletteRgbAt(p, 0));
      expect(resolveInk([1, 2, 3], p)).toEqual([1, 2, 3]);
    }
  });

  it('tone helpers: rgbTone = the shared Rec.601 luma; swatchTone null = undefined', () => {
    const rgb: Rgb = [200, 100, 50];
    expect(rgbTone(rgb)).toBe((LUMA.WR * 200 + LUMA.WG * 100 + LUMA.WB * 50) >> 8);
    expect(swatchTone(null, 'two')).toBeUndefined();
    expect(swatchTone([200, 100, 50], 'two')).toBe(rgbTone(rgb));
    expect(swatchTone(1, 'two')).toBe(rgbTone(paletteRgbAt('two', 1)));
  });

  it('hex round-trips; clampRgb bytes-only', () => {
    expect(rgbToHex([255, 0, 129])).toBe('#ff0081');
    expect(hexToRgb('#ff0081')).toEqual([255, 0, 129]);
    expect(hexToRgb('#f08')).toEqual([255, 0, 136]);
    expect(clampRgb([300, -1, 12.4])).toEqual([255, 0, 12]);
  });
});

// ---- Custom-RGB BACKGROUND through the square/composite/SVG paths -------------
describe('custom-RGB background bakes the EXACT bytes (never dithered)', () => {
  const custom: Rgb = [37, 211, 102]; // not in any palette ramp

  it('composite PNG: uncovered cells are the custom RGB; covered unchanged vs no-bg', () => {
    const c: Composite = {
      w: 8,
      h: 4,
      tones: new Uint8Array(32),
      covered: new Uint8Array(32),
    };
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        c.covered[y * 8 + x] = 1;
        c.tones[y * 8 + x] = x * 60;
      }
    const withBg = decodeRgba(encodeCompositePng(c, 'dusk', 8, 1, custom));
    const plain = decodeRgba(encodeCompositePng(c, 'dusk', 8, 1));
    for (let y = 0; y < 4; y++) {
      for (let x = 4; x < 8; x++) {
        const o = (y * 8 + x) * 4;
        expect([withBg[o], withBg[o + 1], withBg[o + 2], withBg[o + 3]]).toEqual([...custom, 255]);
      }
      for (let x = 0; x < 4; x++) {
        const o = (y * 8 + x) * 4;
        expect(withBg.slice(o, o + 3)).toEqual(plain.slice(o, o + 3)); // covered = unchanged
      }
    }
  });
});
