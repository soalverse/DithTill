// Unit coverage for the core seams the parity test doesn't exercise:
// the packed index storage, the indexed-PNG encoder fed straight from it, the
// shared grid rule, the contrast int32 safety ceiling, and the burn-store.
import { describe, it, expect } from 'vitest';
import UPNG from 'upng-js';
import { BitsetIndexBuffer } from '../src/core/bitset-index-buffer';
import { PackedIndexBuffer } from '../src/core/packed-index-buffer';
import { encodeIndexedPng } from '../src/core/png-indexed';
import {
  computeGrid,
  MIN_GRID_CELLS,
  quantizeContrast,
  MAX_CONTRAST,
  CONTRAST_ONE,
  LUMA_HALF,
  bitDepthForCount,
  PALETTES,
} from '../src/core/dither-constants';
import { useBurnStore, DEFAULT_PARAMS } from '../src/state/burn-store';
import { indicesToRgba } from '../src/core/dither-cpu';

function pngToArrayBuffer(png: Uint8Array): ArrayBuffer {
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}

describe('PackedIndexBuffer / BitsetIndexBuffer (storage seam)', () => {
  it('1-bit round-trips, MSB-first', () => {
    const b = new BitsetIndexBuffer(10, 3);
    b.set(0, 0, 1);
    b.set(9, 2, 1);
    expect(b.get(0, 0)).toBe(1);
    expect(b.get(1, 0)).toBe(0);
    expect(b.get(9, 2)).toBe(1);
    expect(b.toBytes()[0]).toBe(0b1000_0000); // x=0 -> high bit of byte 0
  });
  it('pads each row to whole bytes (width 10 -> 2 bytes/row)', () => {
    const b = new BitsetIndexBuffer(10, 2);
    expect(b.toBytes().length).toBe(2 * 2);
    b.set(8, 0, 1); // first bit of the second byte
    expect(b.toBytes()[1]).toBe(0b1000_0000);
  });
  it('4-bit packs two nibbles per byte, MSB-first', () => {
    const b = new PackedIndexBuffer(2, 1, 4);
    b.set(0, 0, 0xa);
    b.set(1, 0, 0x5);
    expect(b.get(0, 0)).toBe(0xa);
    expect(b.get(1, 0)).toBe(0x5);
    expect(b.toBytes()[0]).toBe(0xa5);
  });
  it('rejects an invalid bit depth', () => {
    expect(() => new PackedIndexBuffer(4, 4, 3)).toThrow();
  });
});

describe('computeGrid', () => {
  it('rounds out/cellSize', () => {
    expect(computeGrid(512, 512, 5)).toEqual({ LW: 102, LH: 102 });
  });
  it('floors at MIN_GRID_CELLS for an extreme cellSize', () => {
    expect(computeGrid(100, 100, 1000)).toEqual({ LW: MIN_GRID_CELLS, LH: MIN_GRID_CELLS });
  });
});

describe('bitDepthForCount', () => {
  it('picks the minimal depth', () => {
    expect(bitDepthForCount(2)).toBe(1);
    expect(bitDepthForCount(4)).toBe(2);
    expect(bitDepthForCount(6)).toBe(4);
    expect(bitDepthForCount(200)).toBe(8);
  });
});

describe('quantizeContrast (int32 safety ceiling)', () => {
  it('maps 1.0 to CONTRAST_ONE', () => {
    expect(quantizeContrast(1)).toBe(CONTRAST_ONE);
  });
  it('clamps to [0, MAX_CONTRAST]', () => {
    expect(quantizeContrast(-5)).toBe(0);
    expect(quantizeContrast(999)).toBe(quantizeContrast(MAX_CONTRAST));
  });
  it('keeps the worst-case dither intermediate inside int32 (GPU highp int)', () => {
    const CT = quantizeContrast(MAX_CONTRAST);
    const worst = Math.abs((0 - LUMA_HALF) * CT); // |lumI - S/2| maxes at S/2
    expect(worst).toBeLessThan(2 ** 31);
  });
});

describe('encodeIndexedPng (true indexed PNG from the buffer)', () => {
  it('1-bit two-tone decodes back with palette colors', () => {
    const w = 8;
    const h = 4;
    const b = new BitsetIndexBuffer(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(x, y, (x + y) & 1);
    const png = encodeIndexedPng(b, PALETTES.two);

    const dec = UPNG.decode(pngToArrayBuffer(png));
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.depth).toBe(1);
    const rgba = new Uint8Array(UPNG.toRGBA8(dec)[0]);
    const i = (0 * w + 1) * 4; // pixel (1,0) -> index 1 -> PALETTES.two[3..5]
    expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([
      PALETTES.two[3],
      PALETTES.two[4],
      PALETTES.two[5],
    ]);
  });
  it('6-color palette packs at 4-bit and decodes its colors', () => {
    const w = 4;
    const h = 2;
    const b = new PackedIndexBuffer(w, h, bitDepthForCount(6));
    let k = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(x, y, k++ % 6);
    const png = encodeIndexedPng(b, PALETTES.dusk);

    const dec = UPNG.decode(pngToArrayBuffer(png));
    expect(dec.depth).toBe(4);
    const rgba = new Uint8Array(UPNG.toRGBA8(dec)[0]);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([
      PALETTES.dusk[0],
      PALETTES.dusk[1],
      PALETTES.dusk[2],
    ]);
  });
});

describe('burn-store reducers', () => {
  it('setParam / applyPreset / reset', () => {
    const s = useBurnStore.getState();
    s.setParam('cellSize', 9);
    expect(useBurnStore.getState().cellSize).toBe(9);
    s.applyPreset({ palette: 'clay', matrix: 4 });
    expect(useBurnStore.getState().palette).toBe('clay');
    expect(useBurnStore.getState().matrix).toBe(4);
    s.reset();
    expect(useBurnStore.getState()).toMatchObject(DEFAULT_PARAMS);
  });
});

describe('transparency (Stage 9)', () => {
  it('indicesToRgba writes alpha 0 for sub-cutoff source alpha', () => {
    const indices = new Uint8Array([0, 1]);
    const grid = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]); // cell 0 opaque, cell 1 transparent
    const out = indicesToRgba(indices, 'two', grid);
    expect(out[3]).toBe(255);
    expect(out[7]).toBe(0);
  });
});
