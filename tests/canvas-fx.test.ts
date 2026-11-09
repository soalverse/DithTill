// =============================================================================
// Whole canvas effects (J5 step 3): every layer, after its own effects, is laid
// onto the canvas and the canvas effects run on that about the canvas middle — so a Mirror
// reflects every layer across the middle. The same step feeds the live canvas, the video
// frames, PNG / SVG and the Library save; the amounts move with ∿; save + undo.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { applyCanvasFx, hasCanvasFx, layOnCanvas } from '../src/core/canvas-fx';
import {
  renderLoopFrameGrid,
  renderLoopFrameImage,
  renderLoopFramePng,
  renderStillPng,
  type LoopRenderInput,
} from '../src/core/loop-render';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import type { CachedAsset } from '../src/core/scene-resolver';
import type { LayerFx } from '../src/core/layer-fx';
import { SCENE_LOOK_DEFAULT, useSceneStore, type SceneNode } from '../src/state/scene-store';

const block = (w: number, h: number, tone = 255): CachedAsset => {
  const tones = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) tones[i] = (tone + i) % 256;
  return { w, h, tones, covered: new Uint8Array(w * h).fill(1) };
};
const dims = { w: 40, h: 24 };
const node = (patch: Partial<SceneNode> = {}): SceneNode => ({
  id: 'n1',
  assetId: 'a1',
  kind: 'paint',
  z: 1,
  placement: { x: 8, y: 12, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: {},
  motion: null,
  opacity: 100,
  ...patch,
});
const assets = () => new Map([['a1', block(6, 4)]]);
const input = (canvasFx?: LayerFx, patch: Partial<LoopRenderInput> = {}): LoopRenderInput => ({
  nodes: [node()],
  scene: SCENE_LOOK_DEFAULT,
  events: [],
  frames: 12,
  seed: 1,
  dims,
  assets: assets(),
  mutedLayers: new Set(),
  features: null,
  background: { rgb: [0, 0, 0] },
  ...(canvasFx ? { canvasFx } : {}),
  ...patch,
});
const litCols = (rgba: Uint8ClampedArray, w: number): Set<number> => {
  const out = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4)
    if (rgba[i] || rgba[i + 1] || rgba[i + 2]) out.add((i / 4) % w);
  return out;
};

describe('laying a layer onto the canvas', () => {
  it('puts each value where the print screens place it (centre, turn, crop)', () => {
    const r = block(6, 4);
    const laid = layOnCanvas(r, node(), dims);
    expect([laid.w, laid.h]).toEqual([40, 24]);
    // Centre (8, 12), 6×4 → canvas cells x 5..10, y 10..13.
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 40; x++) {
        const inside = x >= 5 && x < 11 && y >= 10 && y < 14;
        expect(laid.covered[y * 40 + x]).toBe(inside ? 1 : 0);
        if (inside) expect(laid.tones[y * 40 + x]).toBe(r.tones[(y - 10) * 6 + (x - 5)]);
      }
    // A quarter turn stands it up (4 wide, 6 tall); a crop keeps only its part.
    const turned = layOnCanvas(
      r,
      node({ placement: { ...node().placement, rotationDeg: 90 } }),
      dims,
    );
    let n = 0;
    for (const c of turned.covered) n += c;
    expect(n).toBe(24);
    const cropped = layOnCanvas(r, node({ crop: { x: 0, y: 0, w: 3, h: 4 } }), dims);
    expect(cropped.covered.reduce((a, b) => a + b, 0)).toBe(12);
    // Fine (4 values a square) lays at 4 per square.
    const fine = layOnCanvas({ ...block(24, 16), per: 4 }, node(), dims);
    expect([fine.w, fine.h, fine.per]).toEqual([160, 96, 4]);
  });

  it('no Whole canvas effect = the same layers and pictures', () => {
    const ns = [node()];
    const as = assets();
    expect(applyCanvasFx(ns, as, dims, null)).toEqual({ nodes: ns, assets: as });
    expect(
      applyCanvasFx(ns, as, dims, { trail: { kind: 'echo', length: 1, fade: 50 } }).nodes,
    ).toBe(ns);
    expect(hasCanvasFx({ blur: { radius: 1 } })).toBe(true);
  });

  it("a layer's own effects come first, then the canvas's; the layer keeps its look and Trail", () => {
    const own = node({
      fx: { posterize: { steps: 2 }, trail: { kind: 'echo', length: 1, fade: 50 } },
      opacity: 70,
      solid: true,
    });
    const out = applyCanvasFx([own], assets(), dims, { mirror: { mode: 'lr' } });
    const [n] = out.nodes;
    expect(n.placement).toEqual({ x: 20, y: 12, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    expect(n.fx).toEqual({ trail: { kind: 'echo', length: 1, fade: 50 } });
    expect([n.opacity, n.solid]).toEqual([70, true]);
    const r = out.assets.get(n.assetId)!;
    for (let i = 0; i < r.tones.length; i++)
      if (r.covered[i]) expect([0, 255]).toContain(r.tones[i]);
  });
});

describe('the whole picture, about the canvas middle', () => {
  it('Mirror reflects a layer on the left across the middle', () => {
    const plain = litCols(renderLoopFrameImage(input(), 0, 2).rgba, 80);
    expect([...plain].every((x) => x < 40)).toBe(true);
    const mirrored = litCols(
      renderLoopFrameImage(input({ mirror: { mode: 'lr' } }), 0, 2).rgba,
      80,
    );
    // The picture mirrors (the grain stays pinned to the canvas, so compare the picture).
    expect([...mirrored].some((x) => x >= 40)).toBe(true);
    const g = renderLoopFrameGrid(input({ mirror: { mode: 'lr' } }), 0);
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 40; x++) expect(g.covered[y * 40 + x]).toBe(g.covered[y * 40 + 39 - x]);
  });

  it('every output draws it: video frames, PNG / SVG stills, the Library tone grid', () => {
    const fx: LayerFx = { mirror: { mode: 'lr' } };
    const still = renderStillPng(
      {
        nodes: [node()],
        scene: SCENE_LOOK_DEFAULT,
        dims,
        assets: assets(),
        background: { rgb: [0, 0, 0] },
        canvasFx: fx,
      },
      2,
    );
    expect(renderLoopFramePng(input(fx), 0, 2)).toEqual(still);
    expect(renderLoopFramePng(input(), 0, 2)).not.toEqual(still);
    const g = renderLoopFrameGrid(input(fx), 0);
    expect(g.covered[12 * 40 + 34]).toBe(1); // the reflection of cell x 5
  });

  it('its amounts move with ∿ (Beat), like the canvas sliders', () => {
    const at = (f: number) =>
      evaluateScene([node()], SCENE_LOOK_DEFAULT, [], f, 12, null, makeRng(1), new Set(), {
        canvasFx: { kaleido: { wedges: 6, turn: 0 } },
        canvasMods: {
          'fx.kaleido.turn': { kind: 'wave', shape: 'rampUp', beats: 1, from: 0, to: 360 },
        },
        beat: { bpm: 120, fps: 24, offsetSec: 0, frames: 12, loopBeats: 1, song: false },
      }).canvasFx!.kaleido!.turn;
    expect(at(0)).not.toBe(at(6));
    expect(
      evaluateScene([node()], SCENE_LOOK_DEFAULT, [], 0, 12, null, makeRng(1), new Set()).canvasFx,
    ).toBeUndefined();
  });
});

describe('editing the Whole canvas effects', () => {
  it("setFx('') adds, changes and removes; removing takes its moving amounts; one undo each", () => {
    const st = useSceneStore.getState();
    useSceneStore.setState({ nodes: [], canvasFx: null, canvasMods: {} });
    useSceneStore.temporal.getState().clear();
    st.setFx('', 'kaleido', { wedges: 8, turn: 0 });
    st.setMod('', 'fx.kaleido.turn', { kind: 'wave', shape: 'rampUp', beats: 4, from: 0, to: 360 });
    st.setMod('', 'dotSize', { kind: 'wave', shape: 'smooth', beats: 4, from: 4, to: 8 });
    expect(useSceneStore.getState().canvasFx).toEqual({ kaleido: { wedges: 8, turn: 0 } });
    st.setFx('', 'kaleido', null);
    expect(useSceneStore.getState().canvasFx).toBeNull();
    expect(Object.keys(useSceneStore.getState().canvasMods)).toEqual(['dotSize']);
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().canvasFx).toEqual({ kaleido: { wedges: 8, turn: 0 } });
  });
});
