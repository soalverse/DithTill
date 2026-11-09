// =============================================================================
// Detail: a project keeps every layer's picture at Normal (one value
// per canvas square) or Fine (4× each way). A finer picture covers the same squares —
// the renderer, the Library grid and the marquee read its density — drawings switch
// Normal ⇄ Fine in one undo step (up is lossless, down averages), crops follow.
// =============================================================================
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SCREEN_LOOK_DEFAULT,
  renderPrintScreen,
  type ScreenRaster,
} from '../src/core/print-screen';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import { sceneToElementCell } from '../src/core/scene-affine';
import { SCENE_LOOK_DEFAULT, useSceneStore, type SceneNode } from '../src/state/scene-store';
import { getAssetCache, setAsset } from '../src/ui/scene-assets';
import { regridPaintForDetail } from '../src/ui/paint-node';

/** A w×h picture (tones from `fn`) and its copy holding k×k values per square. */
function pic(w: number, h: number, fn: (x: number, y: number) => number): CachedAsset {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      tones[y * w + x] = v;
      covered[y * w + x] = v > 0 ? 1 : 0;
    }
  return { w, h, tones, covered };
}
function finer(a: CachedAsset, k: number): CachedAsset {
  const f = pic(a.w * k, a.h * k, (x, y) => a.tones[Math.floor(y / k) * a.w + Math.floor(x / k)]);
  for (let i = 0; i < f.covered.length; i++) {
    const x = i % f.w;
    const y = Math.floor(i / f.w);
    f.covered[i] = a.covered[Math.floor(y / k) * a.w + Math.floor(x / k)];
  }
  return { ...f, per: k };
}
const base = pic(24, 12, (x, y) => ((x + y) % 5 === 0 ? 0 : 20 + ((x * 23 + y * 11) % 230)));
const fine = finer(base, 4);
const place = { x: 20, y: 10, scaleX: 1, scaleY: 1, rotationDeg: 0 };

describe('a finer picture covers the same squares', () => {
  const draw = (r: ScreenRaster, look: typeof SCREEN_LOOK_DEFAULT) =>
    renderPrintScreen({
      layers: [{ raster: r, placement: place, look }],
      dims: { w: 40, h: 20 },
      scale: 10,
      background: [0, 0, 0],
    }).rgba;
  const inked = (rgba: Uint8ClampedArray) => {
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) n += rgba[i];
    return n;
  };

  it('dither (one bit per square): a 4× finer copy draws the same picture', () => {
    const look = { ...SCREEN_LOOK_DEFAULT, style: 'dither' as const };
    expect(draw(fine, look)).toEqual(draw(base, look));
  });

  it('halftone: the same dot screen, the ink within a few percent (the finer sample is exact)', () => {
    const look = { ...SCREEN_LOOK_DEFAULT, density: 14 };
    const a = inked(draw(base, look));
    const b = inked(draw(fine, look));
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(b - a) / a).toBeLessThan(0.05);
  });

  it('the Library grid samples it in squares', () => {
    const grid = (a: CachedAsset) =>
      resolveSceneGrid({
        nodes: [
          {
            id: 'n',
            assetId: 'a',
            kind: 'paint',
            z: 1,
            placement: place,
            crop: null,
            look: {},
            motion: null,
            opacity: 100,
          } as SceneNode,
        ],
        scene: SCENE_LOOK_DEFAULT,
        dims: { w: 40, h: 20 },
        assets: new Map([['a', a]]),
      });
    const g1 = grid(base);
    const g4 = grid(fine);
    expect(g4.covered).toEqual(g1.covered);
    expect(g4.tones).toEqual(g1.tones);
  });

  it('the marquee measures its footprint in squares', () => {
    const at = (a: CachedAsset) =>
      evaluateScene(
        [
          {
            id: 'n',
            assetId: 'a',
            kind: 'paint',
            z: 1,
            placement: place,
            crop: null,
            look: {},
            opacity: 100,
            motion: { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 },
          } as SceneNode,
        ],
        SCENE_LOOK_DEFAULT,
        [],
        7,
        48,
        null,
        makeRng(1),
        new Set(),
        { dims: { w: 40, h: 20 }, assetDims: () => a },
      ).nodes[0].placement.x;
    expect(at(fine)).toBeCloseTo(at(base), 9);
  });

  it('the brush lands on the same spot of a finer drawing', () => {
    const e1 = sceneToElementCell(place, base.w, base.h, 13.3, 7.8);
    const e4 = sceneToElementCell(place, fine.w, fine.h, 13.3, 7.8, 4);
    expect(e4.x).toBeCloseTo(e1.x * 4, 9);
    expect(e4.y).toBeCloseTo(e1.y * 4, 9);
  });
});

describe('switching Detail', () => {
  beforeEach(() => {
    useSceneStore.setState({ nodes: [], detail: 'normal' });
    useSceneStore.temporal.getState().clear();
  });

  it('Normal → Fine copies each square into 4×4 (nothing lost), Fine → Normal averages', () => {
    setAsset('paint:900', { ...pic(3, 2, (x, y) => 10 + x * 40 + y * 100) });
    useSceneStore.getState().addPaintNode('paint:900', 1.5, 1);
    const up = regridPaintForDetail('fine');
    const fineId = up.get('paint:900')!;
    const f = getAssetCache().get(fineId)!;
    expect([f.w, f.h, f.per]).toEqual([12, 8, 4]);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 12; x++)
        expect(f.tones[y * 12 + x]).toBe(10 + Math.floor(x / 4) * 40 + Math.floor(y / 4) * 100);
    useSceneStore.getState().setDetail('fine', up);
    expect(useSceneStore.getState().nodes[0].assetId).toBe(fineId);
    // A stroke of fine detail inside one square averages away going back.
    f.tones[0] = 210;
    const down = regridPaintForDetail('normal');
    const n = getAssetCache().get(down.get(fineId)!)!;
    expect([n.w, n.h, n.per]).toEqual([3, 2, 1]);
    expect(n.tones[0]).toBe(Math.round((210 + 15 * 10) / 16));
    expect(n.tones[1]).toBe(50);
  });

  it('is one undo step: the drawing, its crop and the Detail come back together', () => {
    setAsset(
      'paint:901',
      pic(8, 8, () => 99),
    );
    useSceneStore.getState().addPaintNode('paint:901', 4, 4);
    const id = useSceneStore.getState().nodes[0].id;
    useSceneStore.getState().setCrop(id, { x: 1, y: 2, w: 3, h: 4 });
    useSceneStore.temporal.getState().clear();
    useSceneStore.getState().setDetail('fine', regridPaintForDetail('fine'));
    const after = useSceneStore.getState().nodes[0];
    expect(useSceneStore.getState().detail).toBe('fine');
    expect(after.crop).toEqual({ x: 4, y: 8, w: 12, h: 16 });
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(1);
    useSceneStore.temporal.getState().undo();
    const back = useSceneStore.getState().nodes[0];
    expect(useSceneStore.getState().detail).toBe('normal');
    expect(back.assetId).toBe('paint:901');
    expect(back.crop).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(getAssetCache().get('paint:901')!.w).toBe(8); // the original is untouched
  });
});
