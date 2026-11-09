// =============================================================================
// Layer effects (J5 step 1): the six effects on a layer's pre-dither tones, in
// their fixed order, pure (the input raster is never touched), sized in canvas squares
// (Detail-proof), drawn by every output through the one layer adapter and the Library's
// tone grid, their amounts moving with ∿ like any slider, and an effect that goes taking its
// moving amounts with it.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { FX_DEFAULT, FX_ORDER, applyLayerFx, hasFx, type LayerFx } from '../src/core/layer-fx';
import { sceneScreenLayers } from '../src/core/scene-screen';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import { SCENE_LOOK_DEFAULT, useSceneStore, type SceneNode } from '../src/state/scene-store';

function raster(w: number, h: number, fn: (x: number, y: number) => number, per?: number) {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) tones[y * w + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
  return { w, h, tones, covered, ...(per ? { per } : {}) } as CachedAsset;
}
const ramp = raster(24, 16, (x, y) => x * 10 + y * 3);
const tone = (r: CachedAsset, x: number, y: number) => r.tones[y * r.w + x];

describe('the effects', () => {
  it('no effect = the same raster; effects never touch the input', () => {
    expect(applyLayerFx(ramp, undefined)).toBe(ramp);
    expect(applyLayerFx(ramp, {})).toBe(ramp);
    expect(hasFx({})).toBe(false);
    const before = ramp.tones.slice();
    const all: LayerFx = { ...FX_DEFAULT };
    applyLayerFx(ramp, all);
    expect(ramp.tones).toEqual(before);
    expect(FX_ORDER).toEqual([
      'mirror',
      'kaleido',
      'wave',
      'blur',
      'posterize',
      'outline',
      'trail',
    ]);
    // A Trail alone leaves the picture to the layer adapter (it needs the past).
    expect(applyLayerFx(ramp, { trail: { kind: 'echo', length: 1, fade: 60 } })).toBe(ramp);
  });

  it('Mirror reflects the left / top half (and the shape) onto the other', () => {
    const shape = raster(10, 6, (x) => x * 20);
    for (let y = 0; y < 6; y++) for (let x = 5; x < 10; x++) shape.covered[y * 10 + x] = 0;
    const lr = applyLayerFx(shape, { mirror: { mode: 'lr' } });
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 10; x++) {
        expect(tone(lr, x, y)).toBe(tone(lr, 9 - x, y));
        expect(lr.covered[y * 10 + x]).toBe(1); // the left shape now fills both halves
      }
    const quad = applyLayerFx(ramp, { mirror: { mode: 'quad' } });
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 24; x++) {
        expect(tone(quad, x, y)).toBe(tone(quad, 23 - x, y));
        expect(tone(quad, x, y)).toBe(tone(quad, x, 15 - y));
      }
  });

  it('Kaleidoscope folds into mirrored wedges (symmetric about the middle line)', () => {
    const r = raster(40, 40, (x, y) => (x * 7 + y * 13) % 256);
    const k = applyLayerFx(r, { kaleido: { wedges: 6, turn: 0 } });
    let diff = 0;
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) if (tone(k, x, y) !== tone(k, x, 39 - y)) diff++;
    expect(diff / 1600).toBeLessThan(0.02); // float ties at wedge edges only
    expect(applyLayerFx(r, { kaleido: { wedges: 6, turn: 40 } }).tones).not.toEqual(k.tones);
  });

  it('Wave slides rows by a sine; Amount 0 and a whole Flow cycle change nothing', () => {
    expect(applyLayerFx(ramp, { wave: { amount: 0, size: 8, flow: 30 } }).tones).toEqual(
      ramp.tones,
    );
    const a = applyLayerFx(ramp, { wave: { amount: 3, size: 8, flow: 0 } });
    const b = applyLayerFx(ramp, { wave: { amount: 3, size: 8, flow: 100 } });
    expect(b.tones).toEqual(a.tones);
    expect(a.tones).not.toEqual(ramp.tones);
  });

  it('Blur softens without darkening a shape from its empty surroundings', () => {
    const disc = raster(20, 20, () => 200);
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++)
        if ((x - 10) ** 2 + (y - 10) ** 2 > 36) disc.covered[y * 20 + x] = 0;
    const b = applyLayerFx(disc, { blur: { radius: 3 } });
    for (let i = 0; i < 400; i++) if (disc.covered[i]) expect(b.tones[i]).toBe(200);
    expect(b.covered).toEqual(disc.covered);
    const soft = applyLayerFx(ramp, { blur: { radius: 2 } });
    expect(tone(soft, 12, 8)).toBe(Math.round(((10 + 11 + 12 + 13 + 14) * 10) / 5 + 8 * 3));
  });

  it('Posterize leaves only its steps', () => {
    const p = applyLayerFx(ramp, { posterize: { steps: 3 } });
    expect(new Set(p.tones)).toEqual(new Set([0, 128, 255].filter((v) => p.tones.includes(v))));
    for (const v of p.tones) expect([0, 128, 255]).toContain(v);
  });

  it('Outline lights where the tone changes and stays dark on flat areas', () => {
    const step = raster(20, 10, (x) => (x < 10 ? 0 : 200));
    const o = applyLayerFx(step, { outline: { strength: 50 } });
    expect(tone(o, 3, 5)).toBe(0);
    expect(tone(o, 16, 5)).toBe(0);
    expect(tone(o, 10, 5)).toBeGreaterThan(100);
  });

  it('sizes are in canvas squares: a Fine picture (4 per square) blurs the same distance', () => {
    const fine = raster(96, 4, (x) => (x < 48 ? 0 : 255), 4);
    const normal = raster(24, 1, (x) => (x < 12 ? 0 : 255));
    const bf = applyLayerFx(fine, { blur: { radius: 2 } });
    const bn = applyLayerFx(normal, { blur: { radius: 2 } });
    // The soft edge spans 2 squares each side at both Details.
    const soft = (r: CachedAsset, per: number) => {
      let n = 0;
      for (let x = 0; x < r.w; x++) if (r.tones[x] > 0 && r.tones[x] < 255) n++;
      return n / per;
    };
    expect(soft(bf, 4)).toBeCloseTo(soft(bn, 1), 0);
  });
});

// ---- every output draws them ---------------------------------------------------------

const node = (fx?: LayerFx, mods?: SceneNode['mods']): SceneNode => ({
  id: 'n1',
  assetId: 'a1',
  kind: 'image',
  z: 1,
  placement: { x: 12, y: 8, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: {},
  motion: null,
  opacity: 100,
  ...(fx ? { fx } : {}),
  ...(mods ? { mods } : {}),
});
const assets = new Map<string, CachedAsset>([['a1', ramp]]);

describe('every output draws the effects', () => {
  it('the layer adapter (live canvas, PNG, SVG, video) hands the print screens the effected picture', () => {
    const [plain] = sceneScreenLayers([node()], SCENE_LOOK_DEFAULT, assets, null);
    expect(plain.raster).toBe(ramp);
    const [fx] = sceneScreenLayers(
      [node({ posterize: { steps: 2 } })],
      SCENE_LOOK_DEFAULT,
      assets,
      null,
    );
    for (const v of fx.raster.tones) expect([0, 255]).toContain(v);
  });

  it("the Library save's tone grid sees them too", () => {
    const input = (n: SceneNode) => ({
      nodes: [n],
      scene: SCENE_LOOK_DEFAULT,
      dims: { w: 24, h: 16 },
      assets,
    });
    const g = resolveSceneGrid(input(node({ posterize: { steps: 2 } })));
    for (let i = 0; i < g.tones.length; i++)
      if (g.covered[i]) expect([0, 255]).toContain(g.tones[i]);
    expect(resolveSceneGrid(input(node())).tones).not.toEqual(g.tones);
  });

  it('an effect amount moves with ∿ (Beat) like any slider', () => {
    const n = node(
      { blur: { radius: 1 } },
      { 'fx.blur': { kind: 'wave', shape: 'rampUp', beats: 4, from: 0, to: 8 } },
    );
    const at = (f: number) =>
      evaluateScene([n], SCENE_LOOK_DEFAULT, [], f, 48, null, makeRng(1), new Set()).nodes[0].fx!
        .blur!.radius;
    expect(at(0)).not.toBe(at(20));
    expect(at(20)).toBe(at(20));
  });
});

describe('editing effects', () => {
  it('setFx adds, changes and removes; removing takes its moving amounts with it', () => {
    const st = useSceneStore.getState();
    useSceneStore.setState({ nodes: [node()] });
    st.setFx('n1', 'kaleido', { wedges: 6, turn: 0 });
    st.setMod('n1', 'fx.kaleido.turn', {
      kind: 'wave',
      shape: 'rampUp',
      beats: 8,
      from: 0,
      to: 360,
    });
    st.setMod('n1', 'opacity', { kind: 'wave', shape: 'smooth', beats: 4, from: 100, to: 50 });
    expect(useSceneStore.getState().nodes[0].fx).toEqual({ kaleido: { wedges: 6, turn: 0 } });
    st.setFx('n1', 'kaleido', null);
    const n = useSceneStore.getState().nodes[0];
    expect(n.fx).toBeUndefined();
    expect(Object.keys(n.mods ?? {})).toEqual(['opacity']);
    // Saved with the project: the node carries it as plain data.
    st.setFx('n1', 'mirror', { mode: 'quad' });
    const saved = JSON.parse(JSON.stringify(useSceneStore.getState().nodes[0])) as SceneNode;
    expect(saved.fx).toEqual({ mirror: { mode: 'quad' } });
  });
});
