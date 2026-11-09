// Custom-colour Phase 2 (§8.B) — the FULL look travels Burn/Draw → Library → Record
// (closes G-13), and the Burn→Draw seed's freshness rule (G-9) is pinned. Node env, no
// DOM: dropFromLibrary is pure store/cache plumbing, so we seed the library store +
// asset cache directly and drive the real rehydrate.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildElement, type CompositeLook } from '../src/core/library';
import { encodeCompositePng, type Composite } from '../src/core/composite';
import { useLibraryStore } from '../src/state/library-store';
import { useBurnStore } from '../src/state/burn-store';
import {
  useSceneStore,
  layerLookFrom,
  sceneDims,
  SCENE_LOOK_DEFAULT,
} from '../src/state/scene-store';
import { setAsset, getAssetCache } from '../src/ui/scene-assets';
import { dropFromLibrary } from '../src/ui/record-actions';
import { resolveSceneGrid } from '../src/core/scene-resolver';
import { HALFTONE_DENSITY_DEFAULT } from '../src/core/cell-style';

function ramp(w: number, h: number): Composite {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < w * h; i++) tones[i] = ((i * 255) / (w * h)) | 0;
  return { w, h, tones, covered };
}

/** Build an element, register it in the library store, and prime its asset cache — so
 *  dropFromLibrary finds both the record and its raster (no BlobStore needed). */
async function register(look?: CompositeLook) {
  const c = ramp(20, 20);
  const png = encodeCompositePng(c, 'two', 8, 1);
  const built = await buildElement({
    composite: c,
    png,
    thumbnail: '',
    source: 'burn',
    aspect: 'landscape',
    palette: 'two',
    matrix: 8,
    createdAt: 0,
    look,
  });
  useLibraryStore.setState((s) => ({ elements: [built.record, ...s.elements], ready: true }));
  setAsset(built.record.id, { w: c.w, h: c.h, tones: c.tones, covered: c.covered });
  return built.record;
}

const HALFTONE_LOOK: CompositeLook = {
  cellStyle: 'round',
  dotDensity: 14,
  dotSize: 6,
  dotGrow: false,
  dotInk: [200, 30, 30],
  background: [5, 5, 5],
};

beforeEach(() => {
  useSceneStore.setState({
    nodes: [],
    selected: [],
    background: null,
    dotInk: null,
    scene: { ...SCENE_LOOK_DEFAULT },
    cropId: null,
  });
  useLibraryStore.setState({ elements: [], selected: [], ready: true });
  useBurnStore.getState().setCellStyle('square');
  useBurnStore.getState().setDotDensity(HALFTONE_DENSITY_DEFAULT);
  getAssetCache().clear();
});

describe('look travels: drop into an EMPTY scene', () => {
  it('applies scene-wide knobs + threads per-element dotSize/dotGrow onto the node', async () => {
    const rec = await register(HALFTONE_LOOK);
    await dropFromLibrary([rec.id]);

    // Scene-wide fields establish the empty scene's look.
    expect(useBurnStore.getState().cellStyle).toBe('round');
    expect(useBurnStore.getState().dotDensity).toBe(14);
    expect(useSceneStore.getState().dotInk).toEqual([200, 30, 30]);
    expect(useSceneStore.getState().background).toEqual([5, 5, 5]);

    // Per-element fields land on the dropped node's Look override.
    const node = useSceneStore.getState().nodes[0];
    expect(node.look.palette).toBe('two');
    expect(node.look.matrix).toBe(8);
    expect(node.look.dotSize).toBe(6);
    expect(node.look.dotGrow).toBe(false);

    // ...and the resolved grid carries them per cell (what the producer showed).
    const grid = resolveSceneGrid({
      nodes: useSceneStore.getState().nodes,
      scene: useSceneStore.getState().scene,
      dims: sceneDims('landscape'),
      assets: getAssetCache(),
    });
    const covered = grid.covered.findIndex((v) => v === 1);
    expect(covered).toBeGreaterThanOrEqual(0);
    expect(grid.dSize[covered]).toBe(6);
    expect(grid.dGrow[covered]).toBe(0);
  });
});

describe('look travels: drop into a NON-empty scene', () => {
  it('never yanks the scene-wide look, but still applies the new node its own per-element look', async () => {
    const first = await register(HALFTONE_LOOK); // establishes round/14 on the empty scene
    await dropFromLibrary([first.id]);
    expect(useBurnStore.getState().cellStyle).toBe('round');

    const second = await register({
      cellStyle: 'block',
      dotDensity: 6,
      dotSize: 20,
      dotGrow: true,
      dotInk: [1, 2, 3],
      background: [9, 9, 9],
    });
    await dropFromLibrary([second.id]);

    // Scene-wide is UNTOUCHED by the second drop (first drop owns the scene's look).
    expect(useBurnStore.getState().cellStyle).toBe('round');
    expect(useBurnStore.getState().dotDensity).toBe(14);
    expect(useSceneStore.getState().dotInk).toEqual([200, 30, 30]);
    expect(useSceneStore.getState().background).toEqual([5, 5, 5]);

    // But the second node still carries its OWN per-element size/grow.
    const nodes = useSceneStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].look.dotSize).toBe(20);
    expect(nodes[1].look.dotGrow).toBe(true);
  });
});

describe('regression: a v3 / neutral record drops byte-identical to pre-v4', () => {
  it('the node override is exactly {palette,matrix} and no scene-wide knob is touched', async () => {
    const rec = await register(); // no look → v3-shaped record
    expect(rec.look).toBeUndefined();
    await dropFromLibrary([rec.id]);

    const node = useSceneStore.getState().nodes[0];
    // A new layer keeps its own look: the canvas look's, with the element's
    // palette + pattern on top.
    expect(node.look).toEqual({
      ...layerLookFrom(useSceneStore.getState().scene),
      palette: 'two',
      matrix: 8,
    });
    expect(useBurnStore.getState().cellStyle).toBe('square');
    expect(useBurnStore.getState().dotDensity).toBe(HALFTONE_DENSITY_DEFAULT);
    expect(useSceneStore.getState().dotInk).toBe(null);
    expect(useSceneStore.getState().background).toBe(null);
  });
});
