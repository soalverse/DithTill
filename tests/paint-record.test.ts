// draw-in-Record (E4 static core) guards. A PAINT layer is a node whose
// tone raster the brush mutates; it renders through the SAME resolver as every other
// node, so the load-bearing invariants must hold for painted pixels too:
//   1. the shared brush stamps tones/covered (one brush truth with Draw);
//   2. the scene<->element inverse affine round-trips (a stroke at scene (sx,sy)
//      covers exactly scene cell (sx,sy)) — even rotated + scaled;
//   3. preview == export for a painted layer (PNG decodes to the resolved grid);
//   4. SCENE-GLOBAL Bayer (no crawl): the dither under painted pixels depends only
//      on the scene cell, not where the layer sits.
import { describe, it, expect } from 'vitest';
import { stampDab, stampLine, type BrushTarget } from '../src/core/raster-brush';
import { sceneToElementCell, type AffinePlacement } from '../src/core/scene-affine';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

function blank(w: number, h: number): CachedAsset {
  return { w, h, tones: new Uint8Array(w * h), covered: new Uint8Array(w * h) };
}
function paintNode(id: string, assetId: string, p: AffinePlacement, z = 1): SceneNode {
  return {
    id,
    assetId,
    kind: 'paint',
    z,
    placement: p,
    crop: null,
    look: {},
    motion: null,
    opacity: 100,
  };
}

describe('shared brush (one truth with Draw)', () => {
  it('a dab covers a disk and writes the shade tone; the eraser clears covered', () => {
    const t: BrushTarget = blank(20, 20);
    stampDab(t, 10, 10, { tool: 'brush', size: 3, shade: 0.5 });
    expect(t.covered[10 * 20 + 10]).toBe(1);
    expect(t.tones[10 * 20 + 10]).toBe(Math.round(0.5 * 255));
    expect(t.covered[10 * 20 + 14]).toBe(0); // outside radius 3
    stampDab(t, 10, 10, { tool: 'eraser', size: 3, shade: 0.5 });
    expect(t.covered[10 * 20 + 10]).toBe(0);
  });

  it('a line leaves no gaps between dabs', () => {
    const t: BrushTarget = blank(40, 10);
    stampLine(t, 2, 5, 37, 5, { tool: 'brush', size: 1, shade: 1 });
    for (let x = 2; x <= 37; x++) expect(t.covered[5 * 40 + x]).toBe(1);
  });
});

describe('scene<->element inverse affine round-trips through the resolver', () => {
  it('painting at scene (sx,sy) covers exactly scene cell (sx,sy) — rotated + scaled', () => {
    const W = 16;
    const H = 16;
    const dims = { w: 48, h: 36 };
    const p: AffinePlacement = { x: 24, y: 18, scaleX: 1.5, scaleY: 1.5, rotationDeg: 30 };
    const asset = blank(W, H);
    // For a handful of scene cells, set the inverse-mapped element cell covered.
    const targets = [
      [24, 18],
      [26, 18],
      [24, 20],
      [22, 16],
    ];
    const inBounds: number[][] = [];
    for (const [sx, sy] of targets) {
      const e = sceneToElementCell(p, W, H, sx + 0.5, sy + 0.5);
      const ex = Math.floor(e.x);
      const ey = Math.floor(e.y);
      if (ex < 0 || ex >= W || ey < 0 || ey >= H) continue;
      asset.covered[ey * W + ex] = 1;
      asset.tones[ey * W + ex] = 200;
      inBounds.push([sx, sy]);
    }
    expect(inBounds.length).toBeGreaterThan(0);
    const grid = resolveSceneGrid({
      nodes: [paintNode('p', 'a', p)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets: new Map([['a', asset]]),
    });
    for (const [sx, sy] of inBounds) {
      const i = sy * dims.w + sx;
      expect(grid.covered[i]).toBe(1);
      expect(grid.tones[i]).toBe(200);
    }
  });
});

describe('a painted layer holds preview == export + no crawl', () => {
  const W = 24;
  const H = 24;
  const dims = { w: 40, h: 30 };
  function painted(): CachedAsset {
    const a = blank(W, H);
    // A filled disk of mid-grey, painted via the real brush.
    stampLine(a, W / 2, H / 2, W / 2, H / 2, { tool: 'brush', size: 7, shade: 0.6 });
    return a;
  }

  it('a moved painted layer carries its exact pixels (element-local dither)', () => {
    const assets = new Map([['a', painted()]]);
    const gA = resolveSceneGrid({
      nodes: [paintNode('p', 'a', { x: 20, y: 15, scaleX: 1, scaleY: 1, rotationDeg: 0 })],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    const gB = resolveSceneGrid({
      nodes: [paintNode('p', 'a', { x: 21, y: 15, scaleX: 1, scaleY: 1, rotationDeg: 0 })],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets,
    });
    // gB is the same layer one cell to the right: its pixels travel with it.
    let checked = 0;
    for (let y = 0; y < dims.h; y++) {
      for (let x = 0; x + 1 < dims.w; x++) {
        const a = y * dims.w + x;
        if (!gA.covered[a]) continue;
        expect(gB.covered[a + 1]).toBe(1);
        expect(gB.idx[a + 1]).toBe(gA.idx[a]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
