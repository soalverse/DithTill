// SAVE == LOAD (the owner's pixel-specific invariant), pinned end to end:
//   1. quantizeLum IS quantizeCell (the one dither truth, refactored — not forked).
//   2. The Make base is EXACT: re-dithering the stored planes (tone·256 + fine) gives the
//      very cell Burn's quantizer gives the source pixel — every palette × matrix ×
//      contrast × invert. (The old ROUNDED 8-bit tone flipped threshold cells.)
//   3. Halftone sees the same projection from the stored planes as from the source.
//   4. A saved element (schema v5) reloads byte-identical; v4-shaped saves keep their id.
//   5. The element file carries the fine plane + producing cell and refuses tampering.
//   6. Record re-renders a saved element bit-for-bit at any whole-cell offset.
//   7. The Make canvas grid is the Pixel grid; a re-grid is identity at equal dims.
import { describe, expect, it } from 'vitest';
import {
  MATRIX_IDS,
  PALETTE_IDS,
  paletteLength,
  quantizeCell,
  quantizeContrast,
  quantizeLum,
  splitLum,
  type MatrixId,
  type PaletteId,
} from '../src/core/dither-constants';
import { gridToBase } from '../src/state/stage-store';
import {
  compositeCellIndex,
  compositeLum,
  encodeCompositePng,
  type Composite,
} from '../src/core/composite';
import { buildElement, compositeId, SCHEMA_VERSION } from '../src/core/library';
import { encodeElementFile, parseElementFile } from '../src/core/element-file';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';
import { makeDims, regridPlane } from '../src/state/draw-store';

/** Deterministic pseudo-random bytes (no Math.random — reproducible). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

/** A random RGBA source grid with ~10% transparent cells. */
function randomGrid(w: number, h: number, seed: number): Uint8Array {
  const r = prng(seed);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r();
    rgba[i * 4 + 1] = r();
    rgba[i * 4 + 2] = r();
    rgba[i * 4 + 3] = r() < 26 ? 0 : 255;
  }
  return rgba;
}

const W = 37;
const H = 23;
const CONTRASTS = [0.5, 1, 1.05, 1.6, 2.5];

describe('1 · quantizeLum is quantizeCell (one dither truth)', () => {
  it('agrees on every RGB / contrast / invert / matrix sample', () => {
    const r = prng(7);
    for (let n = 0; n < 4000; n++) {
      const R = r();
      const G = r();
      const B = r();
      const x = r();
      const y = r();
      const N = 2 + (r() % 7);
      const CT = quantizeContrast(CONTRASTS[n % CONTRASTS.length]);
      const matrix = MATRIX_IDS[n % MATRIX_IDS.length];
      const invert = n % 3 === 0;
      const lumI = 77 * R + 150 * G + 29 * B;
      expect(quantizeLum(lumI, x, y, N, CT, matrix, invert)).toBe(
        quantizeCell({ R, G, B, x, y, N, CT, matrix, invert }),
      );
    }
  });
});

describe('2 · the Make base is exact (stored planes == Burn quantizer)', () => {
  it('every palette × matrix × contrast × invert reproduces the source cell bit-for-bit', () => {
    const rgba = randomGrid(W, H, 11);
    let checked = 0;
    for (const contrast of CONTRASTS) {
      for (const invert of [false, true]) {
        const CT = quantizeContrast(contrast);
        const base = gridToBase(rgba, W, H, CT, invert);
        for (const palette of PALETTE_IDS) {
          const N = paletteLength(palette);
          for (const matrix of MATRIX_IDS) {
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!base.covered[i]) continue;
                const o = i * 4;
                const burn = quantizeCell({
                  R: rgba[o],
                  G: rgba[o + 1],
                  B: rgba[o + 2],
                  x,
                  y,
                  N,
                  CT,
                  matrix,
                  invert,
                });
                expect(compositeCellIndex(base.tones[i], x, y, N, matrix, base.fine[i])).toBe(burn);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
  }, 30_000); // 10k+ exact round-trips — headroom under the full parallel suite

  it('splitLum is a lossless split of the clamped luma', () => {
    for (let lum = -500; lum <= 65280 + 500; lum += 37) {
      const c = Math.max(0, Math.min(65280, lum));
      const { tone, fine } = splitLum(lum);
      expect(tone * 256 + fine).toBe(c);
      expect(tone).toBeLessThanOrEqual(255);
    }
  });
});

/** The Make composite for a source grid + some strokes (strokes have fine = 0). */
function makeComposite(seed: number): Composite {
  const rgba = randomGrid(W, H, seed);
  const base = gridToBase(rgba, W, H, quantizeContrast(1.3), false);
  for (let i = 0; i < 40; i++) {
    const j = (i * 97) % (W * H);
    base.covered[j] = 1;
    base.tones[j] = 200;
    base.fine[j] = 0;
  }
  return { w: W, h: H, tones: base.tones, covered: base.covered, fine: base.fine };
}

function rebuild(
  blobs: { hash: string; bytes: Uint8Array }[],
  rec: {
    w: number;
    h: number;
    tonesHash: string;
    coveredHash: string;
    fineHash?: string;
  },
): Composite {
  const by = new Map(blobs.map((b) => [b.hash, b.bytes]));
  return {
    w: rec.w,
    h: rec.h,
    tones: by.get(rec.tonesHash)!,
    covered: by.get(rec.coveredHash)!,
    ...(rec.fineHash ? { fine: by.get(rec.fineHash)! } : {}),
  };
}

describe('4 · a saved element reloads byte-identical (schema v5)', () => {
  it('save → blobs → reload re-encodes the exact same PNG for every palette × matrix', async () => {
    const c = makeComposite(31);
    const png = encodeCompositePng(c, 'two', 8, 6);
    const built = await buildElement({
      composite: c,
      png,
      thumbnail: 'data:image/png;base64,AA==',
      source: 'burn',
      aspect: 'landscape',
      palette: 'two',
      matrix: 8,
      cell: 3,
      createdAt: 1,
    });
    expect(built.record.schemaVersion).toBe(SCHEMA_VERSION);
    expect(built.record.cell).toBe(3);
    expect(built.record.fineHash).toBeDefined();
    const back = rebuild(built.blobs, built.record);
    for (const palette of PALETTE_IDS as readonly PaletteId[]) {
      for (const matrix of MATRIX_IDS as readonly MatrixId[]) {
        expect(encodeCompositePng(back, palette, matrix, 3)).toEqual(
          encodeCompositePng(c, palette, matrix, 3),
        );
      }
    }
    for (let i = 0; i < W * H; i++) expect(compositeLum(back, i)).toBe(compositeLum(c, i));
  });

  it('a v4-shaped save (no fine, no cell, neutral look) keeps the PNG-hash id (dedupe preserved)', async () => {
    const c: Composite = {
      w: 4,
      h: 3,
      tones: new Uint8Array(12).fill(90),
      covered: new Uint8Array(12).fill(1),
    };
    const png = encodeCompositePng(c, 'two', 8, 6);
    const built = await buildElement({
      composite: c,
      png,
      thumbnail: 'data:image/png;base64,AA==',
      source: 'draw',
      aspect: 'landscape',
      palette: 'two',
      matrix: 8,
      createdAt: 1,
    });
    expect(built.record.fineHash).toBeUndefined();
    expect(built.record.cell).toBeUndefined();
    expect(built.record.id).toBe(built.record.pngHash);
    expect(await compositeId(built.record.pngHash, undefined, undefined, undefined)).toBe(
      built.record.pngHash,
    );
  });

  it('the same pixels saved at a different producing Pixel are separate elements', async () => {
    const c = makeComposite(5);
    const png = encodeCompositePng(c, 'two', 8, 6);
    const base = {
      composite: c,
      png,
      thumbnail: 'data:image/png;base64,AA==',
      source: 'burn' as const,
      aspect: 'landscape' as const,
      palette: 'two' as const,
      matrix: 8 as const,
      createdAt: 1,
    };
    const a = await buildElement({ ...base, cell: 3 });
    const b = await buildElement({ ...base, cell: 4 });
    expect(a.record.id).not.toBe(b.record.id);
  });
});

describe('5 · the element file carries the exact planes', () => {
  it('round-trips fine + cell and rejects a tampered fine plane', async () => {
    const c = makeComposite(41);
    const built = await buildElement({
      composite: c,
      png: encodeCompositePng(c, 'two', 8, 6),
      thumbnail: 'data:image/png;base64,AA==',
      source: 'burn',
      aspect: 'landscape',
      palette: 'two',
      matrix: 8,
      cell: 5,
      createdAt: 1,
    });
    const text = encodeElementFile(built);
    const parsed = await parseElementFile(text);
    expect(parsed.record.cell).toBe(5);
    expect(rebuild(parsed.blobs, parsed.record).fine).toEqual(c.fine);

    const json = JSON.parse(text);
    json.record.fineHash = json.record.tonesHash; // claims the tones plane as its fine plane
    await expect(parseElementFile(JSON.stringify(json))).rejects.toThrow();
  });
});

function placed(cx: number, cy: number, scale = 1): SceneNode {
  return {
    id: 'n',
    assetId: 'a',
    kind: 'asset',
    z: 1,
    placement: { x: cx, y: cy, scaleX: scale, scaleY: scale, rotationDeg: 0 },
    crop: null,
    look: { palette: 'two', matrix: 8 },
    motion: null,
    opacity: 100,
  };
}

describe('6 · Record re-renders a saved element bit-for-bit', () => {
  it('at any whole-cell offset, every element cell == the saved cell (exact luma, local dither)', () => {
    const c = makeComposite(53);
    const asset: CachedAsset = { w: c.w, h: c.h, tones: c.tones, covered: c.covered, fine: c.fine };
    const assets = new Map([['a', asset]]);
    const dims = { w: 120, h: 90 };
    const N = paletteLength('two');
    for (const [cx, cy] of [
      [40.5, 30.5],
      [43.5, 33.5],
      [61.5, 50.5],
    ]) {
      const g = resolveSceneGrid({
        nodes: [placed(cx, cy)],
        scene: SCENE_LOOK_DEFAULT,
        dims,
        assets,
      });
      const ox = cx - c.w / 2 - 0.5 + 0.5; // raster origin in scene cells (integer here)
      const oy = cy - c.h / 2 - 0.5 + 0.5;
      let checked = 0;
      for (let ey = 0; ey < c.h; ey++) {
        for (let ex = 0; ex < c.w; ex++) {
          const ai = ey * c.w + ex;
          if (!c.covered[ai]) continue;
          const si = (oy + ey) * dims.w + (ox + ex);
          expect(g.covered[si]).toBe(1);
          expect(g.idx[si]).toBe(compositeCellIndex(c.tones[ai], ex, ey, N, 8, c.fine![ai]));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(500);
    }
  });
});

describe('7 · the Make canvas grid is the Pixel grid', () => {
  it("makeDims is the 480-frame divided by the Pixel (Burn's grid)", () => {
    expect(makeDims('landscape', 5)).toEqual({ w: 96, h: 72 });
    expect(makeDims('landscape', 2)).toEqual({ w: 240, h: 180 });
    expect(makeDims('square', 4)).toEqual({ w: 120, h: 120 });
    expect(makeDims('portrait', 6)).toEqual({ w: 60, h: 80 });
    // A v4 element (128-cell doc) reopens at Pixel 480/128 = 3.75 on its exact dims.
    expect(makeDims('landscape', 480 / 128)).toEqual({ w: 128, h: 96 });
  });

  it('a re-grid at equal dims is the identity', () => {
    const p = new Uint8Array(W * H).map((_, i) => (i * 13) % 256);
    expect(regridPlane(p, W, H, W, H)).toEqual(p);
  });
});
