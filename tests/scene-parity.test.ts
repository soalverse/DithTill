// Record scene guards — the load-bearing invariants, TDD'd before any
// canvas wiring:
//   1. ELEMENT-LOCAL dither: an unrotated element at
//      an integer scale is dithered at its OWN raster cell, so moving it carries its
//      exact saved pixels along (a dragged / animated sprite never re-shuffles), and
//      an integer upscale is a clean pixel zoom of the same pattern.
//   2. preview == export: the live grid (covered/pal/idx) decodes byte-for-byte
//      from the exported PNG, including a MULTI-palette (union) scene.
//   3. topmost-z wins each overlapped cell (tone + palette).
import { describe, it, expect } from 'vitest';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { SCENE_LOOK_DEFAULT, type LookOverride, type SceneNode } from '../src/state/scene-store';
import { PALETTE_IDS } from '../src/core/dither-constants';

function flatAsset(w: number, h: number, tone: number): CachedAsset {
  return { w, h, tones: new Uint8Array(w * h).fill(tone), covered: new Uint8Array(w * h).fill(1) };
}
function node(
  id: string,
  assetId: string,
  z: number,
  cx: number,
  cy: number,
  look: LookOverride = {},
  opacity = 100,
): SceneNode {
  return {
    id,
    assetId,
    kind: 'asset',
    z,
    placement: { x: cx, y: cy, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look,
    motion: null,
    opacity,
  };
}

/** A tone ramp (so a dither pattern actually varies across the element). */
function rampAsset(w: number, h: number): CachedAsset {
  const tones = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) tones[y * w + x] = (x * 23 + y * 11) % 256;
  return { w, h, tones, covered: new Uint8Array(w * h).fill(1) };
}

describe('element-local dither', () => {
  it('moving an element carries its exact pixels: same ELEMENT cell → same index, any offset', () => {
    const assets = new Map([['a', rampAsset(10, 10)]]);
    const dims = { w: 40, h: 30 };
    const at = (cx: number, cy: number) =>
      resolveSceneGrid({
        nodes: [node('1', 'a', 1, cx, cy)],
        scene: SCENE_LOOK_DEFAULT,
        dims,
        assets,
      });
    const gA = at(10, 10);
    // 1, 3 and 5 cells over — none a multiple of the 8×8 matrix period.
    for (const [ox, oy] of [
      [1, 0],
      [3, 2],
      [5, 7],
    ]) {
      const gB = at(10 + ox, 10 + oy);
      let checked = 0;
      for (let y = 0; y + oy < dims.h; y++) {
        for (let x = 0; x + ox < dims.w; x++) {
          const a = y * dims.w + x;
          const b = (y + oy) * dims.w + (x + ox);
          if (!gA.covered[a]) continue;
          expect(gB.covered[b]).toBe(1);
          expect(gB.idx[b]).toBe(gA.idx[a]);
          checked++;
        }
      }
      expect(checked).toBe(100);
    }
  });

  it('an integer upscale is a clean pixel zoom: every element cell is a uniform k×k block', () => {
    const assets = new Map([['a', rampAsset(6, 6)]]);
    const dims = { w: 40, h: 30 };
    const g1 = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 10, 10)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    const n2 = node('1', 'a', 1, 20, 15);
    n2.placement = { ...n2.placement, scaleX: 2, scaleY: 2 };
    const g2 = resolveSceneGrid({ nodes: [n2], scene: SCENE_LOOK_DEFAULT, dims, assets });
    // Scale-1 element cell (u,v) sits at scene (7+u, 7+v); the ×2 copy's raster origin is
    // at scene (20−6, 15−6) = (14, 9), so cell (u,v) covers scene (14+2u.., 9+2v..).
    for (let v = 0; v < 6; v++) {
      for (let u = 0; u < 6; u++) {
        const want = g1.idx[(7 + v) * dims.w + (7 + u)];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            expect(g2.idx[(9 + 2 * v + dy) * dims.w + (14 + 2 * u + dx)]).toBe(want);
          }
        }
      }
    }
  });
});

describe('z-order', () => {
  it('the topmost element wins an overlapped cell (tone + palette)', () => {
    const assets = new Map([
      ['a', flatAsset(12, 12, 90)],
      ['b', flatAsset(12, 12, 200)],
    ]);
    const dims = { w: 40, h: 30 };
    // Same centre; b has higher z → wins the overlap.
    const nodes = [
      node('1', 'a', 1, 18, 14, { palette: 'two' }),
      node('2', 'b', 2, 18, 14, { palette: 'dusk' }),
    ];
    const grid = resolveSceneGrid({ nodes, scene: SCENE_LOOK_DEFAULT, dims, assets });
    const ci = 14 * dims.w + 18; // a cell inside the overlap
    expect(grid.covered[ci]).toBe(1);
    expect(grid.tones[ci]).toBe(200);
    expect(PALETTE_IDS[grid.pal[ci]]).toBe('dusk');
  });
});

describe('node opacity -- pre-dither tone over-compositing', () => {
  const dims = { w: 40, h: 30 };
  const ci = 14 * dims.w + 18; // a cell inside every overlap below

  it('opacity 100 is bit-identical to the plain topmost-wins walk', () => {
    const assets = new Map([
      ['a', flatAsset(12, 12, 90)],
      ['b', flatAsset(12, 12, 200)],
    ]);
    const plain = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 18, 14), node('2', 'b', 2, 18, 14)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    const explicit = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 18, 14, {}, 100), node('2', 'b', 2, 18, 14, {}, 100)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(explicit.tones).toEqual(plain.tones);
    expect(explicit.idx).toEqual(plain.idx);
    expect(explicit.covered).toEqual(plain.covered);
  });

  it('a 50% element over an opaque one blends tones half-half; the TOP look dithers', () => {
    const assets = new Map([
      ['under', flatAsset(12, 12, 100)],
      ['over', flatAsset(12, 12, 200)],
    ]);
    const grid = resolveSceneGrid({
      nodes: [
        node('1', 'under', 1, 18, 14, { palette: 'two' }),
        node('2', 'over', 2, 18, 14, { palette: 'dusk' }, 50),
      ],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(grid.covered[ci]).toBe(1);
    expect(grid.tones[ci]).toBe(150); // (200*128 + 100*128) / 256
    expect(PALETTE_IDS[grid.pal[ci]]).toBe('dusk'); // topmost covering look wins
  });

  it('a lone semi-transparent element fades toward PAPER inside its silhouette (ink density)', () => {
    const assets = new Map([['a', flatAsset(12, 12, 200)]]);
    const half = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 18, 14, {}, 50)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(half.covered[ci]).toBe(1);
    expect(half.tones[ci]).toBe(228); // round((200*128 + 255*128) / 256)
    // Lower opacity = lighter wash, still covered — the slider is continuous
    // (no vanish pop) and cells the element never touched stay transparent.
    const faint = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 18, 14, {}, 45)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(faint.covered[ci]).toBe(1);
    expect(faint.tones[ci]).toBe(230); // O=115: round((200*115 + 255*141) / 256)
    expect(faint.covered[0]).toBe(0); // outside the silhouette: transparent
  });

  it('stacked 50% + 50% over an opaque base composites "over" exactly', () => {
    const assets = new Map([
      ['t', flatAsset(12, 12, 240)],
      ['m', flatAsset(12, 12, 120)],
      ['b', flatAsset(12, 12, 0)],
    ]);
    const grid = resolveSceneGrid({
      nodes: [
        node('1', 'b', 1, 18, 14),
        node('2', 'm', 2, 18, 14, {}, 50),
        node('3', 't', 3, 18, 14, {}, 50),
      ],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    // top a=128, mid a=floor(128*128/256)=64, base a=64 -> acc=256
    // tone = round((240*128 + 120*64 + 0*64) / 256) = round(150) = 150
    expect(grid.covered[ci]).toBe(1);
    expect(grid.tones[ci]).toBe(150);
  });

  it('opacity 0 is invisible: skipped over others, uncovered alone', () => {
    const assets = new Map([
      ['a', flatAsset(12, 12, 90)],
      ['ghost', flatAsset(12, 12, 255)],
    ]);
    const over = resolveSceneGrid({
      nodes: [node('1', 'a', 1, 18, 14), node('2', 'ghost', 2, 18, 14, {}, 0)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(over.covered[ci]).toBe(1);
    expect(over.tones[ci]).toBe(90); // the ghost contributed nothing
    const alone = resolveSceneGrid({
      nodes: [node('2', 'ghost', 2, 18, 14, {}, 0)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    expect(alone.covered[ci]).toBe(0);
  });
});
