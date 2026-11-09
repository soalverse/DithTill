// the canvas is ONE scene. Pins the pure pieces (the DOM-bound photo
// rendering is proven live in the browser preview: photo layer == Burn quantizer 0/8929,
// Save → Library → Add to canvas 0/9116):
//   1. one grid: the scene's grid at a Pixel IS Make's/Burn's grid (sceneDimsAt == makeDims);
//   2. photo layers: added full-frame + selected; their dials patch in one undo step;
//   3. each layer keeps its own look: the canvas look is the look new layers
//      start with, and Apply to all layers copies it to every layer in one undo step;
//   4. a confirmed (regrid) Pixel change keeps full-frame layers tracking the grid, and the
//      lock still holds without it;
//   5. drawing over a selected picture targets a NEW drawing layer, never 'frozen'.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  useSceneStore,
  sceneDimsAt,
  IMAGE_PARAMS_DEFAULT,
  SCENE_PIXEL_DEFAULT,
} from '../src/state/scene-store';
import { makeDims } from '../src/state/draw-store';
import { ASPECT_IDS } from '../src/core/dither-constants';
import { paintTarget } from '../src/ui/paint-node';
import { resolveSceneGrid, type CachedAsset, type SceneGrid } from '../src/core/scene-resolver';
import type { Swatch } from '../src/core/color';

/** A grid cell's dot ink as the Library save reads it: its layer's own, else the canvas's. */
const cellInk = (grid: SceneGrid, ci: number, ink?: Swatch): Swatch | undefined => {
  const s = grid.ink ? grid.ink[ci] : 0;
  return s && grid.inks ? grid.inks[s] : ink;
};
import { buildElement, referencedHashes } from '../src/core/library';
import { encodeElementFile, parseElementFile } from '../src/core/element-file';

beforeEach(() => {
  const s = useSceneStore.getState();
  s.clear();
  s.setScenePixel(SCENE_PIXEL_DEFAULT, true);
  useSceneStore.temporal.getState().clear();
});

describe('1 · one grid', () => {
  it("sceneDimsAt is Burn/Make's grid for every aspect and Pixel", () => {
    for (const a of ASPECT_IDS) {
      for (const p of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 14]) {
        expect(sceneDimsAt(a, p)).toEqual(makeDims(a, p));
      }
    }
    expect(sceneDimsAt('landscape', 2.5)).toEqual({ w: 192, h: 144 }); // the historic lattice
  });
});

describe('2 · photo layers', () => {
  it('a photo is a full-frame, selected, image layer with default dials', () => {
    const s = useSceneStore.getState();
    const id = s.addImageNode('img:t1', 96, 72);
    const n = useSceneStore.getState().nodes.find((x) => x.id === id)!;
    expect(n.kind).toBe('image');
    expect(n.image).toEqual(IMAGE_PARAMS_DEFAULT);
    expect(n.placement).toEqual({ x: 96, y: 72, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    expect(useSceneStore.getState().selected).toEqual([id]);
  });

  it('a dial change is one undo step and undoes cleanly', () => {
    const id = useSceneStore.getState().addImageNode('img:t2', 96, 72);
    const t = useSceneStore.temporal.getState();
    const past = t.pastStates.length;
    useSceneStore.getState().setImageParams(id, { contrast: 1.4, offsetX: 0.2 });
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(past + 1);
    useSceneStore.temporal.getState().undo();
    const n = useSceneStore.getState().nodes.find((x) => x.id === id)!;
    expect(n.image!.contrast).toBe(1);
    expect(n.image!.offsetX).toBe(0);
  });
});

describe('3 · each layer keeps its own look', () => {
  it('a new layer starts with the canvas look; changing the canvas look leaves it alone', () => {
    const s = useSceneStore.getState();
    s.setSceneLook({ style: 'halftone', dotSize: 12 });
    s.addPaintNode('paint:look', 20, 20);
    expect(useSceneStore.getState().nodes[0].look).toMatchObject({
      style: 'halftone',
      dotSize: 12,
    });
    useSceneStore.getState().setSceneLook({ style: 'dither', dotSize: 4 });
    expect(useSceneStore.getState().scene).toMatchObject({ style: 'dither', dotSize: 4 });
    expect(useSceneStore.getState().nodes[0].look).toMatchObject({
      style: 'halftone',
      dotSize: 12,
    });
  });

  it('Apply to all layers gives every layer the canvas look (own dot colour stays), one undo step', () => {
    const s = useSceneStore.getState();
    s.addNodes([
      { assetId: 'a', w: 10, h: 10, cx: 20, cy: 20, look: { palette: 'dusk', dotInk: 3 } },
    ]);
    s.addPaintNode('paint:look2', 20, 20);
    useSceneStore.getState().setSceneLook({ palette: 'sepia', angle: 15 });
    useSceneStore.temporal.getState().clear();
    useSceneStore.getState().applyLookToAll();
    const st = useSceneStore.getState();
    for (const n of st.nodes) expect(n.look).toMatchObject({ palette: 'sepia', angle: 15 });
    expect(st.nodes[0].look.dotInk).toBe(3);
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(1);
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().nodes[0].look.palette).toBe('dusk');
  });
});

describe('4 · Pixel', () => {
  it('a drawing locks the Pixel unless the change re-grids', () => {
    const s = useSceneStore.getState();
    s.addPaintNode('paint:t', 96, 72);
    useSceneStore.getState().setScenePixel(5);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT); // locked
    useSceneStore.getState().setScenePixel(5, true);
    const st = useSceneStore.getState();
    expect(st.pixel).toBe(5);
    // full-frame layers TRACK the grid: scale stays 1 (their rasters are rebuilt)
    expect(st.nodes[0].placement.scaleX).toBe(1);
  });

  it('a photo layer always tracks the grid', () => {
    useSceneStore.getState().addImageNode('img:t3', 96, 72);
    useSceneStore.getState().setScenePixel(5);
    const n = useSceneStore.getState().nodes[0];
    expect(useSceneStore.getState().pixel).toBe(5);
    expect(n.placement.scaleX).toBe(1);
  });
});

describe('5 · drawing over a picture', () => {
  it('a selected picture → a NEW drawing layer (null), never frozen', () => {
    useSceneStore.getState().addImageNode('img:t4', 96, 72); // selected
    expect(paintTarget()).toBeNull();
  });
  it('nothing selected + a drawing on top → that drawing; a picture on top → new layer', () => {
    const s = useSceneStore.getState();
    const p = s.addPaintNode('paint:t5', 96, 72);
    useSceneStore.getState().clearSelection();
    expect((paintTarget() as { id: string }).id).toBe(p);
    useSceneStore.getState().addImageNode('img:t5', 96, 72);
    useSceneStore.getState().clearSelection();
    expect(paintTarget()).toBeNull();
  });
});

// layer settings: drag reorder + a layer's own dot colour (saved exactly).
describe('6 · drag reorder', () => {
  it('moveLayer puts a layer at a z position in one undo step', () => {
    const s = useSceneStore.getState();
    s.addPaintNode('paint:a', 96, 72);
    s.addPaintNode('paint:b', 96, 72);
    s.addPaintNode('paint:c', 96, 72);
    const t = useSceneStore.temporal.getState();
    const past = t.pastStates.length;
    const top = useSceneStore.getState().nodes.find((n) => n.assetId === 'paint:c')!;
    useSceneStore.getState().moveLayer(top.id, 0); // to the bottom
    const order = () =>
      [...useSceneStore.getState().nodes].sort((a, b) => a.z - b.z).map((n) => n.assetId);
    expect(order()).toEqual(['paint:c', 'paint:a', 'paint:b']);
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(past + 1);
    useSceneStore.temporal.getState().undo();
    expect(order()).toEqual(['paint:a', 'paint:b', 'paint:c']);
  });
});

describe('7 · a layer’s own dot colour', () => {
  const asset = (tone: number): CachedAsset => ({
    w: 4,
    h: 4,
    tones: new Uint8Array(16).fill(tone),
    covered: new Uint8Array(16).fill(1),
  });
  const grid = () => {
    const st = useSceneStore.getState();
    return resolveSceneGrid({
      nodes: st.nodes,
      scene: st.scene,
      dims: { w: 8, h: 4 },
      assets: new Map([
        ['a', asset(200)],
        ['b', asset(120)],
      ]),
    });
  };

  it('no override → the grid keeps its old shape (no ink plane)', () => {
    useSceneStore.getState().addNodes([{ assetId: 'a', w: 4, h: 4, cx: 2, cy: 2 }]);
    expect(grid().ink).toBeUndefined();
  });

  it('an override inks just that layer’s cells; clearing it inherits again', () => {
    const s = useSceneStore.getState();
    s.addNodes([
      { assetId: 'a', w: 4, h: 4, cx: 2, cy: 2 },
      { assetId: 'b', w: 4, h: 4, cx: 6, cy: 2 },
    ]);
    const b = useSceneStore.getState().nodes.find((n) => n.assetId === 'b')!;
    useSceneStore.getState().setLayerInk(b.id, [10, 20, 30]);
    const g = grid();
    expect(cellInk(g, 0, 1)).toBe(1); // layer a → the canvas ink
    expect(cellInk(g, 7, 1)).toEqual([10, 20, 30]); // layer b → its own
    // a canvas-wide Look change keeps the layer's own dot colour
    useSceneStore.getState().setSceneLook({ palette: 'sepia' });
    expect(cellInk(grid(), 7, 1)).toEqual([10, 20, 30]);
    useSceneStore.getState().setLayerInk(b.id, undefined);
    expect('dotInk' in useSceneStore.getState().nodes.find((n) => n.id === b.id)!.look).toBe(false);
    expect(grid().ink).toBeUndefined();
  });

  it('a saved per-cell ink plane re-inks on reload; a layer override still wins', () => {
    const saved: CachedAsset = {
      ...asset(150),
      ink: new Uint8Array([0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]),
      inks: [null, [200, 0, 0]],
    };
    useSceneStore.getState().addNodes([{ assetId: 's', w: 4, h: 4, cx: 2, cy: 2 }]);
    const st = useSceneStore.getState();
    const run = () =>
      resolveSceneGrid({
        nodes: useSceneStore.getState().nodes,
        scene: st.scene,
        dims: { w: 4, h: 4 },
        assets: new Map([['s', saved]]),
      });
    const g = run();
    expect(cellInk(g, 0, 'canvas' as never)).toBe('canvas');
    expect(cellInk(g, 1, 0)).toEqual([200, 0, 0]);
    useSceneStore.getState().setLayerInk(st.nodes[0].id, 2);
    expect(cellInk(run(), 0, 0)).toBe(2);
  });

  it('the save format (v6) carries the ink plane and folds it into the id', async () => {
    const base = {
      w: 2,
      h: 1,
      tones: new Uint8Array([10, 20]),
      covered: new Uint8Array([1, 1]),
    };
    const input = {
      png: new Uint8Array([1, 2, 3]),
      thumbnail: 'data:image/png;base64,AA==',
      source: 'record' as const,
      aspect: 'landscape' as const,
      palette: 'two' as const,
      matrix: 8 as const,
      createdAt: 1,
    };
    const plain = await buildElement({ ...input, composite: base });
    const inked = await buildElement({
      ...input,
      composite: { ...base, ink: new Uint8Array([0, 1]), inks: [null, [1, 2, 3]] },
    });
    expect(plain.record.inkHash).toBeUndefined();
    expect(inked.record.inkHash).toBeDefined();
    expect(inked.record.inks).toEqual([null, [1, 2, 3]]);
    expect(inked.record.id).not.toBe(plain.record.id);
    expect(referencedHashes(inked.record)).toContain(inked.record.inkHash);
    // an element file round-trips and verifies its id with the ink plane
    const parsed = await parseElementFile(encodeElementFile(inked));
    expect(parsed.record.id).toBe(inked.record.id);
  });
});

describe('8 · hidden layers', () => {
  it('a hidden layer is not drawn (and so not saved or exported); Show brings it back', () => {
    const s = useSceneStore.getState();
    s.addNodes([{ assetId: 'h', w: 4, h: 4, cx: 2, cy: 2 }]);
    const id = useSceneStore.getState().nodes[0].id;
    const asset: CachedAsset = {
      w: 4,
      h: 4,
      tones: new Uint8Array(16).fill(100),
      covered: new Uint8Array(16).fill(1),
    };
    const run = () =>
      resolveSceneGrid({
        nodes: useSceneStore.getState().nodes,
        scene: useSceneStore.getState().scene,
        dims: { w: 4, h: 4 },
        assets: new Map([['h', asset]]),
      }).covered.reduce((a, v) => a + v, 0);
    expect(run()).toBe(16);
    useSceneStore.getState().setHidden(id, true);
    expect(run()).toBe(0);
    useSceneStore.temporal.getState().undo();
    expect(run()).toBe(16);
  });
});

describe('9 · pause holds the playhead', () => {
  it('pause stops at a frame; Play / Rec resume from it; a fresh Play starts at the top', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const lp = useLoopStore.getState();
    lp.setTransport('playing');
    useLoopStore.getState().pause(42);
    let st = useLoopStore.getState();
    expect(st.transport).toBe('stopped');
    expect(st.scrub).toBe(42);
    useLoopStore.getState().setTransport('playing');
    st = useLoopStore.getState();
    expect(st.resumeFrame).toBe(42);
    expect(st.scrub).toBeNull();
    useLoopStore.getState().setTransport('stopped'); // a plain stop (⏮) — back to the top
    useLoopStore.getState().setTransport('playing');
    expect(useLoopStore.getState().resumeFrame).toBeNull();
    useLoopStore.getState().pause(10);
    useLoopStore.getState().beginOverdub();
    expect(useLoopStore.getState().resumeFrame).toBe(10); // Rec resumes there too
    useLoopStore.getState().setTransport('stopped');
  });
});

describe('10 · one undo for every edit (step 4)', () => {
  it('walks canvas edits, reactions and loop length back and forth in the order made', async () => {
    const { initHistory, undo, redo, useHistory } = await import('../src/ui/history');
    const { useLoopStore } = await import('../src/state/loop-store');
    const { beginGesture, endGesture } = await import('../src/state/gesture');
    initHistory();
    const st = useSceneStore.getState;
    const lp = useLoopStore.getState;
    const id = st().addImageNode('img:h1', 10, 10);
    const frames0 = lp().meta.frames;

    st().setOpacity([id], 40); // canvas
    lp().addReaction({ nodeId: id, band: 'low', target: { kind: 'pulse' }, depth: 0.6 }); // loop
    lp().setLength({ frames: frames0 * 2 }); // loop length
    const op = () => st().nodes.find((n) => n.id === id)?.opacity;

    undo();
    expect(lp().meta.frames).toBe(frames0);
    expect(lp().reactions).toHaveLength(1);
    undo();
    expect(lp().reactions).toHaveLength(0);
    expect(op()).toBe(40);
    undo();
    expect(op()).toBe(100);
    redo();
    redo();
    redo();
    expect([op(), lp().reactions.length, lp().meta.frames]).toEqual([40, 1, frames0 * 2]);
    expect(useHistory.getState().canRedo).toBe(false);

    // A whole slider drag = ONE step, on the canvas and on a reaction alike.
    beginGesture();
    for (const v of [50, 60, 70]) st().setOpacity([id], v);
    endGesture();
    const rid = lp().reactions[0].id;
    beginGesture();
    for (const d of [0.7, 0.8, 0.9]) lp().updateReaction(rid, { depth: d });
    endGesture();
    undo();
    expect(lp().reactions[0].depth).toBeCloseTo(0.6);
    expect(op()).toBe(70);
    undo();
    expect(op()).toBe(40);
  });
});
