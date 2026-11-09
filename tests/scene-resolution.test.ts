// =============================================================================
// Scene-resolution pass — the dynamic Record lattice (replaces the fixed 192), the
// Burn-Pixel ↔ scene-long mapping, the empty-scene resolution ADOPT, the lock +
// placement-rescale, the PER-ELEMENT coarsen (exact block-average), and the v4 look
// blob round-trip of the producing Pixel. Node env, no DOM: dropFromLibrary is pure
// store/cache plumbing (as in look-travel.test.ts).
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  useSceneStore,
  sceneDims,
  sceneLongFromPixel,
  resolutionLockNodes,
  registerResolutionTracking,
  effectiveLook,
  SCENE_LONG,
  SCENE_PIXEL_DEFAULT,
  SCENE_LOOK_DEFAULT,
  type SceneNode,
  type LookOverride,
} from '../src/state/scene-store';
import { videoRasterDims, VIDEO_RASTER_LONG } from '../src/core/video-frames';
import { rebuildVideoRasters } from '../src/ui/video-assets';
import { videoRasterLongForCoverage, reframeCropCells, targetFrame } from '../src/ui/image-to-grid';
import { computeGrid } from '../src/core/dither-constants';
import {
  resolveSceneGrid,
  type CachedAsset,
  type SceneResolveInput,
} from '../src/core/scene-resolver';
import {
  buildElement,
  buildVideoElement,
  isNeutralLook,
  serializeLook,
  LOOK_CELL_SIZE_DEFAULT,
  type CompositeLook,
  type VideoReframe,
} from '../src/core/library';
import { encodeCompositePng, type Composite } from '../src/core/composite';
import {
  CELL_STYLE_DEFAULT,
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_SIZE_DEFAULT,
} from '../src/core/cell-style';
import { useLibraryStore } from '../src/state/library-store';
import { useLoopStore } from '../src/state/loop-store';
import { useBurnStore } from '../src/state/burn-store';
import { setAsset, getAssetCache } from '../src/ui/scene-assets';
import { dropFromLibrary } from '../src/ui/record-actions';

// ---- the Burn-Pixel ↔ scene-lattice mapping -------------------------------------
describe('Burn Pixel ↔ scene lattice mapping', () => {
  it('the DEFAULT Pixel reproduces today’s 192 lattice EXACTLY', () => {
    expect(SCENE_PIXEL_DEFAULT).toBe(2.5);
    expect(sceneLongFromPixel(SCENE_PIXEL_DEFAULT)).toBe(SCENE_LONG);
    expect(sceneLongFromPixel(SCENE_PIXEL_DEFAULT)).toBe(192);
  });

  it('uses Burn’s exact rule: long edge = round(480 / Pixel)', () => {
    expect(sceneLongFromPixel(2)).toBe(240); // a Pixel-2 burn → a 240-cell scene
    expect(sceneLongFromPixel(3)).toBe(160);
    expect(sceneLongFromPixel(5)).toBe(96); // Burn's default cellSize
    expect(sceneLongFromPixel(1)).toBe(480);
  });

  it('sceneDims defaults to the historic 192 lattice (byte-identical callers)', () => {
    expect(sceneDims('landscape')).toEqual({ w: 192, h: 144 });
    // …and derives the short edge from the aspect at any long edge.
    expect(sceneDims('landscape', sceneLongFromPixel(2))).toEqual({ w: 240, h: 180 });
    expect(sceneDims('portrait', 240)).toEqual({ w: 180, h: 240 });
  });
});

// ---- v4 look blob: the producing Pixel round-trips ------------------------------
const NEUTRAL: CompositeLook = {
  cellStyle: CELL_STYLE_DEFAULT,
  dotDensity: HALFTONE_DENSITY_DEFAULT,
  dotSize: HALFTONE_SIZE_DEFAULT,
  dotGrow: true,
  dotInk: null,
  background: null,
};

describe('v4 look blob carries the producing Pixel (cellSize)', () => {
  it('ONLY an absent cellSize is neutral — the save site omits its OWN default', () => {
    expect(isNeutralLook({ ...NEUTRAL })).toBe(true);
    expect(isNeutralLook({ ...NEUTRAL, cellSize: undefined })).toBe(true);
    // A PRESENT Pixel is deliberate → non-neutral, folded into the hash — EVEN at the value
    // that is Burn's default (5). Burn's save site omits the field at 5; a scene deliberately
    // set to Pixel 5 keeps it, and the two must stay distinguishable (the collision fix).
    expect(isNeutralLook({ ...NEUTRAL, cellSize: LOOK_CELL_SIZE_DEFAULT })).toBe(false);
    expect(isNeutralLook({ ...NEUTRAL, cellSize: 2 })).toBe(false);
    expect(serializeLook({ ...NEUTRAL, cellSize: LOOK_CELL_SIZE_DEFAULT })).toContain('cz:5');
    expect(serializeLook({ ...NEUTRAL, cellSize: 2 })).toContain('cz:2');
  });

  it('an ABSENT Pixel serializes byte-identically to the pre-feature look (dedupe preserved)', () => {
    const styled: CompositeLook = { ...NEUTRAL, cellStyle: 'round', dotInk: [1, 2, 3] };
    const noPixel: CompositeLook = { ...styled, cellSize: undefined };
    expect(serializeLook(noPixel)).toBe(serializeLook(styled)); // undefined ≡ absent, no id drift
  });

  it('buildElement mints a distinct id for a non-default Pixel, shares content blobs', async () => {
    const c: Composite = {
      w: 8,
      h: 8,
      tones: new Uint8Array(64).fill(120),
      covered: new Uint8Array(64).fill(1),
    };
    const png = encodeCompositePng(c, 'two', 8, 1);
    const base = {
      composite: c,
      png,
      thumbnail: '',
      source: 'burn' as const,
      aspect: 'landscape' as const,
      palette: 'two' as const,
      matrix: 8 as const,
      createdAt: 0,
    };
    const plain = await buildElement(base);
    const fine = await buildElement({ ...base, look: { ...NEUTRAL, cellSize: 2 } });
    expect(fine.record.id).not.toBe(plain.record.id);
    expect(fine.record.pngHash).toBe(plain.record.pngHash); // renderable bytes shared
    expect(fine.record.look?.cellSize).toBe(2);
  });
});

// ---- per-element coarsen = EXACT block-average ----------------------------------
describe('per-element Pixel coarsen (block-averaged PRE-dither tones)', () => {
  // A 4x4 asset, placed 1:1 on a 96-cell scene (scenePixel = 480/96 = 5); element Pixel 10
  // → factor round(10/5) = 2, so each 2x2 element block averages to one tone.
  const asset: CachedAsset = {
    w: 4,
    h: 4,
    // rows: [0,100,200,40] [50,150,60,80] [10,20,30,40] [250,210,190,170]
    tones: new Uint8Array([0, 100, 200, 40, 50, 150, 60, 80, 10, 20, 30, 40, 250, 210, 190, 170]),
    covered: new Uint8Array(16).fill(1),
  };
  const dims = { w: 96, h: 96 };
  const node = (look: LookOverride): SceneNode => ({
    id: 'n',
    assetId: 'a',
    kind: 'asset',
    z: 1,
    placement: { x: 48, y: 48, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look,
    motion: null,
    opacity: 100,
  });
  const resolve = (look: LookOverride) =>
    resolveSceneGrid({
      nodes: [node(look)],
      scene: SCENE_LOOK_DEFAULT,
      dims,
      assets: new Map([['a', asset]]),
    } as SceneResolveInput);
  const at = (g: ReturnType<typeof resolveSceneGrid>, x: number, y: number) =>
    g.tones[y * dims.w + x];

  it('Pixel 0 (inherit) reads the raster verbatim — byte-identical to today', () => {
    const g = resolve({});
    // scene cell (46,46) maps to element cell (0,0) at this placement.
    expect(at(g, 46, 46)).toBe(0);
    expect(at(g, 47, 46)).toBe(100);
    expect(at(g, 48, 46)).toBe(200);
    expect(at(g, 46, 47)).toBe(50);
  });

  it('a coarser Pixel averages each 2x2 block exactly (deterministic integer mean)', () => {
    const g = resolve({ pixel: 10 }); // factor 2
    // block(0,0)=mean(0,100,50,150)=75; block(1,0)=mean(200,40,60,80)=95
    // block(0,1)=mean(10,20,250,210)=122.5→123; block(1,1)=mean(30,40,190,170)=107.5→108
    expect(at(g, 46, 46)).toBe(75);
    expect(at(g, 47, 46)).toBe(75);
    expect(at(g, 48, 46)).toBe(95);
    expect(at(g, 49, 46)).toBe(95);
    expect(at(g, 46, 48)).toBe(123);
    expect(at(g, 48, 48)).toBe(108);
  });

  it('coarser-only: an element Pixel at/below the scene cell never sharpens', () => {
    const g = resolve({ pixel: 5 }); // == scenePixel → factor 1 → raw
    expect(at(g, 47, 46)).toBe(100);
  });
});

// ---- store: lock predicate + placement rescale ----------------------------------
function assetNode(id: string, x: number, y: number): SceneNode {
  return {
    id,
    assetId: id,
    kind: 'asset',
    z: 1,
    placement: { x, y, scaleX: 2, scaleY: 2, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: null,
    opacity: 100,
  };
}

describe('scene resolution lock + placement rescale', () => {
  beforeEach(() => {
    useSceneStore.setState({
      nodes: [],
      selected: [],
      background: null,
      dotInk: null,
      scene: { ...SCENE_LOOK_DEFAULT },
      pixel: SCENE_PIXEL_DEFAULT,
      cropId: null,
    });
  });

  it('resolutionLockNodes: paint layers pin the resolution; arrange nodes do not', () => {
    expect(resolutionLockNodes([assetNode('a', 10, 10)])).toBe(false);
    const paint: SceneNode = { ...assetNode('p', 10, 10), kind: 'paint' };
    expect(resolutionLockNodes([paint])).toBe(true);
  });

  it('changing the Pixel rescales arrange placements proportionally (elements stay put)', () => {
    useSceneStore.setState({ nodes: [assetNode('a', 96, 72)] });
    const before = useSceneStore.getState().nodes[0].placement;
    const r0 = sceneLongFromPixel(SCENE_PIXEL_DEFAULT); // 192
    // Move to a coarser lattice.
    useSceneStore.getState().setScenePixel(5); // long 96 → ratio 0.5
    const s = useSceneStore.getState();
    expect(s.pixel).toBe(5);
    const p = s.nodes[0].placement;
    const r1 = sceneLongFromPixel(5); // 96
    const ratio = r1 / r0;
    expect(p.x).toBeCloseTo(before.x * ratio, 6);
    expect(p.y).toBeCloseTo(before.y * ratio, 6);
    expect(p.scaleX).toBeCloseTo(before.scaleX * ratio, 6);
    // Fractional position + footprint are preserved across the resolution change.
    expect(p.x / r1).toBeCloseTo(before.x / r0, 6);
  });

  it('a paint layer blocks the change (defensive store backstop)', () => {
    useSceneStore.setState({ nodes: [{ ...assetNode('p', 96, 72), kind: 'paint' }] });
    useSceneStore.getState().setScenePixel(5);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT); // unchanged
  });
});

// ---- empty-scene ADOPT via dropFromLibrary --------------------------------------
function ramp(w: number, h: number): Composite {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < w * h; i++) tones[i] = ((i * 255) / (w * h)) | 0;
  return { w, h, tones, covered };
}

async function register(look?: CompositeLook) {
  const c = ramp(16, 16);
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

const fineLook = (cellSize: number): CompositeLook => ({ ...NEUTRAL, cellSize });

describe('empty-scene drop adopts the source resolution; non-empty does not', () => {
  beforeEach(() => {
    useSceneStore.setState({
      nodes: [],
      selected: [],
      background: null,
      dotInk: null,
      scene: { ...SCENE_LOOK_DEFAULT },
      pixel: SCENE_PIXEL_DEFAULT,
      cropId: null,
    });
    useLibraryStore.setState({ elements: [], selected: [], ready: true });
    useLoopStore.setState({ events: [] } as never);
    getAssetCache().clear();
  });

  it('an EMPTY-scene drop of a fine (Pixel 2) burn adopts Pixel 2 + threads the per-element coarsen', async () => {
    const rec = await register(fineLook(2));
    await dropFromLibrary([rec.id]);
    expect(useSceneStore.getState().pixel).toBe(2); // scene lattice adopted
    // The node also carries the producing Pixel as its own coarsen override.
    const node = useSceneStore.getState().nodes[0];
    expect(node.look.pixel).toBe(2);
    // Effective factor is 1 in the adopted (matching) scene — no over-coarsening.
    const eff = effectiveLook(useSceneStore.getState().scene, node);
    expect(eff.pixel).toBe(2);
  });

  it('a NON-empty scene keeps its resolution; a later coarse drop rides a per-element coarsen', async () => {
    const first = await register(); // neutral → scene stays at the default
    await dropFromLibrary([first.id]);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT);

    const coarse = await register(fineLook(8));
    await dropFromLibrary([coarse.id]);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT); // untouched
    const nodes = useSceneStore.getState().nodes;
    expect(nodes[nodes.length - 1].look.pixel).toBe(8); // coarser element override
  });

  it('a default-Pixel (neutral) drop leaves the resolution at the default and sets no coarsen', async () => {
    const rec = await register(); // no look
    await dropFromLibrary([rec.id]);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT);
    expect(useSceneStore.getState().nodes[0].look.pixel).toBeUndefined();
  });

  it('a scene deliberately at Pixel 5 (== Burn’s default value) round-trips — sentinel-collision regression', async () => {
    // 5 is BOTH a real scene Pixel stop AND Burn's default cellSize. Before the fix, the
    // shared "is it 5?" neutrality test mistook a deliberate Pixel 5 for "unset" and the drop
    // reverted the scene to 2.5. Now only `undefined` is neutral, so a present 5 is adopted.
    const rec = await register(fineLook(LOOK_CELL_SIZE_DEFAULT));
    await dropFromLibrary([rec.id]);
    expect(useSceneStore.getState().pixel).toBe(5); // adopted, NOT lost to the 2.5 default
    expect(useSceneStore.getState().nodes[0].look.pixel).toBe(5); // and rides as the element coarsen
  });
});

// ---- VIDEO half: raster dims track the scene lattice -----------------------------
describe('video tone rasters track the scene resolution', () => {
  it('videoRasterDims: the default long stays 192 (golden parity shape, byte-identical)', () => {
    expect(videoRasterDims(1920, 1080)).toEqual({ w: VIDEO_RASTER_LONG, h: 108 });
    expect(VIDEO_RASTER_LONG).toBe(192);
  });

  it('a non-default long resizes the raster with the lattice (Pixel 2 scene → 240-long)', () => {
    const long = sceneLongFromPixel(2); // 240
    expect(videoRasterDims(1920, 1080, long)).toEqual({ w: 240, h: 135 });
    expect(videoRasterDims(1080, 1920, long)).toEqual({ w: 135, h: 240 });
    expect(videoRasterDims(0, 0, long)).toEqual({ w: 240, h: 240 }); // degenerate guard
  });

  it('rebuildVideoRasters is a safe no-op with no live previewers (headless)', () => {
    expect(rebuildVideoRasters(240)).toEqual([]);
  });

  // Source-scan pins (the determinism-lint technique): the plumbing that needs the
  // codec / DOM to execute is pinned at the source seam instead.
  const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

  it('the ui export builder computes each clip’s crop-aware rasterLong (the shared S2 formula)', () => {
    const code = src('ui/RecordExportMenu.tsx');
    // The ui builder (not the deterministic export module) computes the crop-aware long via
    // videoRasterLongForCoverage and threads it per-video as plain data.
    expect(code).toMatch(/videoRasterLongForCoverage\(/);
    expect(code).toMatch(/rasterLong/);
  });

  it('the export decoder consumes the per-video rasterLong (stays ui-free for the determinism lint)', () => {
    const code = src('platform/loop-export.ts');
    expect(code).toMatch(/videoRasterDims\(rec\.w,\s*rec\.h,\s*rasterLong\)/);
    expect(code).toMatch(/VideoTickSource\(v\.rec,\s*v\.bytes,\s*v\.rasterLong(,\s*v\.clips)?\)/);
    expect(code).not.toMatch(/from\s+'\.\.\/ui\//); // never imports ui (deterministic module)
  });

  it('the live previewer sizes its grab raster via the same crop-aware coverage formula', () => {
    const code = src('ui/video-assets.ts');
    expect(code).toMatch(/sceneRasterLong\(\)/);
    expect(code).toMatch(/videoRasterLongForCoverage\(/);
  });
});

// ---- store: video (scene-tracking) nodes under a resolution change ---------------
describe('setScenePixel with scene-tracking (video) rasters', () => {
  beforeEach(() => {
    useSceneStore.setState({
      nodes: [],
      selected: [],
      background: null,
      dotInk: null,
      scene: { ...SCENE_LOOK_DEFAULT },
      pixel: SCENE_PIXEL_DEFAULT,
      cropId: null,
    });
  });

  it('keeps a tracking node’s placement SCALE (its raster rebuilds) and scales its crop', () => {
    const video: SceneNode = {
      ...assetNode('vid', 96, 72),
      crop: { x: 10, y: 20, w: 40, h: 30 },
    };
    useSceneStore.setState({ nodes: [video] });
    registerResolutionTracking((n) => n.assetId === 'vid');
    try {
      useSceneStore.getState().setScenePixel(2); // 192 → 240, r = 1.25
      const n = useSceneStore.getState().nodes[0];
      expect(n.placement.x).toBeCloseTo(96 * 1.25, 6); // position rescales
      expect(n.placement.scaleX).toBe(2); // scale untouched — the raster grew instead
      expect(n.crop).toEqual({ x: 12.5, y: 25, w: 50, h: 37.5 }); // crop tracks the raster
    } finally {
      registerResolutionTracking(() => false); // restore the default (no live previewers)
    }
  });
});

// =============================================================================
// VIDEO FIDELITY Burn -> Library -> Record (the deep fix). Two sinks:
//   S1: a VIDEO record carried NO v4 look, so the empty-scene resolution ADOPT never
//       fired for the owner's primary medium (a fine-burned clip landed on the default
//       lattice, not its producing one).
//   S2: even at a matching lattice, a REFRAMED clip's cropped-to-fill window sampled a
//       scene-long raster at < 1 texel/scene-cell — blockier than 192 cells alone explain.
// The trace for the owner's exact case (1280x720, Burn Pixel 2, reframe zoom ~1.4):
//   Burn effective long = 240 cells.
//   Record BEFORE : scene 192, raster 192x108, crop.w=137 texels over 192 cells → 0.71
//                   texel/cell → ~137 effective cells (coarser than the 192 lattice).
//   Record S1 only: scene 240, raster 240x135, crop.w=171 over 240 → 0.71 → ~171 cells.
//   Record S1+S2  : scene 240, raster 337x190, crop.w=241 over 240 → 1.01 texel/cell →
//                   240 effective cells == Burn. Both fixes are needed to match Burn.
// =============================================================================

describe('Burn Pixel == Record adopted lattice (the S1 equality that matches detail)', () => {
  it('a Pixel-2 burn and the Record scene it adopts share the SAME long-edge cell count', () => {
    const tf = targetFrame('landscape');
    const burn = computeGrid(tf.targetW, tf.targetH, 2);
    expect(burn.LW).toBe(240); // Burn burns the clip at a 240-cell lattice
    expect(sceneLongFromPixel(2)).toBe(burn.LW); // adopting Pixel 2 gives the SAME 240
  });
});

describe('videoRasterLongForCoverage (S2 crop-aware raster sizing)', () => {
  it('a full-frame (neutral) clip stays at the scene long — byte-identical to before', () => {
    expect(videoRasterLongForCoverage(1280, 720, 'landscape', undefined, 192, 144, 192)).toBe(192);
    expect(
      videoRasterLongForCoverage(
        1280,
        720,
        'landscape',
        { zoom: 1, offsetX: 0, offsetY: 0 },
        240,
        180,
        240,
      ),
    ).toBe(240);
  });

  it('a zoom-1.4 reframe grows the raster so the cropped-to-fill window is >= 1 texel/cell', () => {
    const reframe: VideoReframe = { zoom: 1.4, offsetX: 0.05, offsetY: -0.02 };
    const long = videoRasterLongForCoverage(1280, 720, 'landscape', reframe, 240, 180, 240);
    expect(long).toBeGreaterThan(240); // grown beyond the plain lattice
    // The crop at that raster spans >= the scene cells it fills → no magnification (S2 met).
    const { w, h } = videoRasterDims(1280, 720, long);
    const crop = reframeCropCells(1280, 720, 'landscape', reframe, w, h)!;
    expect(crop.w).toBeGreaterThanOrEqual(240);
    expect(crop.h).toBeGreaterThanOrEqual(180);
  });

  it('caps at the source native long (never upsamples past the source)', () => {
    // A big zoom on a small source demands more texels than the source HAS — the detail
    // simply is not there, an inherent floor. Cap at the source native long, do not upsample.
    const long = videoRasterLongForCoverage(
      320,
      240,
      'landscape',
      { zoom: 8, offsetX: 0, offsetY: 0 },
      240,
      180,
      240,
    );
    expect(long).toBe(320); // max(320, 240) — the source's own long edge
  });
});

describe('video id / dedupe with the v4 look', () => {
  const vbase = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mime: 'video/mp4',
    w: 1280,
    h: 720,
    inSeconds: 0,
    outSeconds: 2,
    fps: 30,
    thumbnail: '',
    source: 'burn' as const,
    aspect: 'landscape' as const,
    palette: 'dusk' as const,
    matrix: 2 as const,
    createdAt: 0,
  };

  it('a neutral (or absent) look mints the pre-v4 id byte-identically (dedupe preserved)', async () => {
    const plain = await buildVideoElement(vbase);
    const neutralLook = await buildVideoElement({
      ...vbase,
      look: { ...NEUTRAL }, // the real save omits cellSize at Burn's default → absent → neutral
    });
    expect(neutralLook.record.id).toBe(plain.record.id); // no id drift
    expect(neutralLook.record.look).toBeUndefined(); // neutral look omitted from the record
  });

  it('a non-neutral look = its own element sharing the ONE source blob', async () => {
    const plain = await buildVideoElement(vbase);
    const styled = await buildVideoElement({
      ...vbase,
      look: { ...NEUTRAL, cellStyle: 'round', cellSize: 2 },
    });
    expect(styled.record.id).not.toBe(plain.record.id);
    expect(styled.record.videoHash).toBe(plain.record.videoHash); // one shared source blob
    expect(styled.record.look?.cellSize).toBe(2);
  });
});

describe('video look travels + adopts on an empty-scene drop (S1 + S2 end-to-end)', () => {
  const REFRAME: VideoReframe = { zoom: 1.4, offsetX: 0.05, offsetY: -0.02 };
  const VLOOK: CompositeLook = {
    cellStyle: 'round',
    dotDensity: 14,
    dotSize: 6,
    dotGrow: false,
    dotInk: [200, 30, 30],
    background: [5, 5, 5],
    cellSize: 2, // the producing Pixel (fine burn)
  };

  async function registerVideo(look?: CompositeLook, reframe?: VideoReframe) {
    const built = await buildVideoElement({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mime: 'video/mp4',
      w: 1280,
      h: 720,
      inSeconds: 0,
      outSeconds: 2,
      fps: 30,
      thumbnail: '',
      source: 'burn',
      aspect: 'landscape',
      palette: 'dusk',
      matrix: 2,
      reframe,
      look,
      createdAt: 0,
    });
    useLibraryStore.setState((s) => ({ elements: [built.record, ...s.elements], ready: true }));
    // Prime the crop-aware raster the live previewer WOULD produce at the adopted scene
    // (ensureVideoAsset needs a DOM video; here we mirror its coverageRasterDims result).
    const adoptLong = sceneLongFromPixel(look?.cellSize ?? SCENE_PIXEL_DEFAULT);
    const d = sceneDims('landscape', adoptLong);
    const cvLong = videoRasterLongForCoverage(1280, 720, 'landscape', reframe, d.w, d.h, adoptLong);
    const { w, h } = videoRasterDims(1280, 720, cvLong);
    setAsset(built.record.id, {
      w,
      h,
      tones: new Uint8Array(w * h),
      covered: new Uint8Array(w * h).fill(1),
    });
    return built.record;
  }

  beforeEach(() => {
    useSceneStore.setState({
      nodes: [],
      selected: [],
      background: null,
      dotInk: null,
      scene: { ...SCENE_LOOK_DEFAULT },
      pixel: SCENE_PIXEL_DEFAULT,
      cropId: null,
    });
    useLibraryStore.setState({ elements: [], selected: [], ready: true });
    useLoopStore.setState({ events: [] } as never);
    useBurnStore.getState().setParam('aspect', 'landscape');
    useBurnStore.getState().setCellStyle('square');
    useBurnStore.getState().setDotDensity(HALFTONE_DENSITY_DEFAULT);
    getAssetCache().clear();
  });

  it('adopts the producing Pixel, travels the scene-wide + per-element look, and lands >= 1 texel/cell', async () => {
    const rec = await registerVideo(VLOOK, REFRAME);
    await dropFromLibrary([rec.id]);

    // S1: the empty scene adopts the clip's producing Pixel 2 (== Burn's 240-cell lattice),
    // NOT the default 2.5/192 — this is the adopt that never fired for videos before.
    expect(useSceneStore.getState().pixel).toBe(2);

    // Scene-wide look established the empty scene.
    expect(useBurnStore.getState().cellStyle).toBe('round');
    expect(useBurnStore.getState().dotDensity).toBe(14);
    expect(useSceneStore.getState().dotInk).toEqual([200, 30, 30]);
    expect(useSceneStore.getState().background).toEqual([5, 5, 5]);

    // Per-element look landed on the dropped node (palette/matrix + Halftone size/grow + the
    // producing Pixel as a per-element coarsen, exactly like a composite).
    const node = useSceneStore.getState().nodes[0];
    expect(node.look.palette).toBe('dusk');
    expect(node.look.matrix).toBe(2);
    expect(node.look.dotSize).toBe(6);
    expect(node.look.dotGrow).toBe(false);
    expect(node.look.pixel).toBe(2);

    // S2: the saved reframe arrived as the node crop, and the crop-aware raster lets the
    // cropped-to-fill window land WITHOUT magnification (placement scale <= 1 <=> texels/
    // scene-cell >= 1). Before the fix this scale was ~1.4 (0.71 texel/cell → blocky).
    expect(node.crop).not.toBeNull();
    expect(Math.abs(node.placement.scaleX)).toBeLessThanOrEqual(1);
    expect(Math.abs(node.placement.scaleY)).toBeLessThanOrEqual(1);
    // Concretely: the crop spans at least the scene cells it fills on the long axis.
    expect(node.crop!.w).toBeGreaterThanOrEqual(sceneDims('landscape', sceneLongFromPixel(2)).w);
  });

  it('a Halftone video re-enters Record as Halftone (look-travel, extended to a video record)', async () => {
    const rec = await registerVideo(VLOOK, undefined); // full-frame Halftone clip
    await dropFromLibrary([rec.id]);
    expect(useBurnStore.getState().cellStyle).toBe('round'); // the Halftone style travelled
    expect(useBurnStore.getState().dotDensity).toBe(14);
    const node = useSceneStore.getState().nodes[0];
    expect(node.look.dotSize).toBe(6);
    expect(node.look.dotGrow).toBe(false);
  });

  it('a neutral (v3 / no-look) video drops byte-identical to before: {palette,matrix}, no adopt', async () => {
    const rec = await registerVideo(undefined, REFRAME); // reframe but NO look
    await dropFromLibrary([rec.id]);
    expect(useSceneStore.getState().pixel).toBe(SCENE_PIXEL_DEFAULT); // no adopt (no look)
    const node = useSceneStore.getState().nodes[0];
    expect(node.look).toMatchObject({ palette: 'dusk', matrix: 2 }); // the element's own, on its own look
    expect(node.look.pixel).toBeUndefined();
    expect(useBurnStore.getState().cellStyle).toBe('square'); // scene-wide untouched
  });
});
