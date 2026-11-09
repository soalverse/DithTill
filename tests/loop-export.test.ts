// P8 keystone determinism — the pure
// loop-export pipe, no codec needed:
//   1. two export walks → byte-identical per-frame PNG streams (integer clock,
//      keyed-stateless PRNG, no wall time anywhere).
//   2. frame 0 == the still scene export (renderStillPng of the base scene)
//      when the timeline is empty —'s contract.
//   3. the video overlay seam: videoRasterAt swaps per-frame PRE-dither rasters
//      through the same mergedAssets seam paint-reveal uses; non-videos pass
//      through to the base cache untouched.
//   4. mutes are an explicit input (what you see is what you export) and the
//      seed actually reaches the render (a different seed changes twinkle).
//   5. the bounded-decode planner: exact partition, midpoint boundaries.
import { describe, it, expect } from 'vitest';
import {
  renderLoopFrameGrid,
  renderStillPng,
  renderLoopFramePng,
  type LoopRenderInput,
} from '../src/core/loop-render';
import type { CachedAsset } from '../src/core/scene-resolver';
import { planFrameTiles } from '../src/core/video-decode';
import { videoRasterDims, VIDEO_RASTER_LONG } from '../src/core/video-frames';
import type {
  AudioReactEvent,
  MotionEvent,
  ObjectPathEvent,
  PaintRevealEvent,
  TimedEvent,
} from '../src/core/loop-events';
import { ZERO_FEATURE, type FeatureArray, type FrameFeature } from '../src/core/audio-features';
import {
  SCENE_LOOK_DEFAULT,
  type MotionDescriptor,
  type Placement,
  type SceneNode,
} from '../src/state/scene-store';

const NO_MUTE: ReadonlySet<number> = new Set();
const DIMS = { w: 48, h: 27 };

function place(x: number, y: number, rot = 0): Placement {
  return { x, y, scaleX: 1, scaleY: 1, rotationDeg: rot };
}
function node(
  id: string,
  x: number,
  y: number,
  motion: MotionDescriptor | null = null,
  kind: SceneNode['kind'] = 'asset',
): SceneNode {
  return {
    id,
    assetId: `asset-${id}`,
    kind,
    z: 1,
    placement: place(x, y),
    crop: null,
    look: {},
    motion,
    opacity: 100,
  };
}
/** A deterministic tone raster (diagonal ramp), fully covered. */
function ramp(w: number, h: number, salt = 0): CachedAsset {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < tones.length; i++) tones[i] = (i * 7 + salt * 31) % 256;
  return { w, h, tones, covered };
}

function testScene(): { input: Omit<LoopRenderInput, 'videoRasterAt'>; events: TimedEvent[] } {
  const twinkle: MotionEvent = {
    id: 'm1',
    kind: 'motion',
    nodeId: 'a',
    pass: 0,
    layer: 0,
    startFrame: 0,
    endFrame: 12,
    motion: { type: 'twinkle', cycles: 1, amp: 0.5, ax: 1, ay: 1, phase0: 0 },
  };
  const path: ObjectPathEvent = {
    id: 'p1',
    kind: 'object-path',
    nodeId: 'b',
    pass: 1,
    layer: 1,
    startFrame: 2,
    endFrame: 6,
    samples: [place(30, 8), place(31, 9), place(33, 11), place(35, 13), place(36, 14)],
    interp: 'hold',
  };
  const reveal: PaintRevealEvent = {
    id: 'r1',
    kind: 'paint-reveal',
    nodeId: 'c',
    assetId: 'asset-c',
    pass: 2,
    layer: 2,
    startFrame: 1,
    endFrame: 4,
    stamps: [
      { frame: 1, x: 5, y: 5, r: 2, shade: 1, erase: false },
      { frame: 3, x: 9, y: 6, r: 2, shade: 0.5, erase: false },
      { frame: 4, x: 12, y: 8, r: 3, shade: 1, erase: false },
    ],
    holdFrames: 4, // a blink stroke — exercises the wrap-aware window
  };
  const events: TimedEvent[] = [twinkle, path, reveal];
  const assets = new Map<string, CachedAsset>([
    ['asset-a', ramp(10, 8, 1)],
    ['asset-b', ramp(6, 6, 2)],
    ['asset-c', ramp(16, 12, 3)],
  ]);
  const nodes = [node('a', 10, 12), node('b', 30, 8), node('c', 20, 14, null, 'paint')];
  return {
    input: {
      nodes,
      scene: SCENE_LOOK_DEFAULT,
      events,
      frames: 12,
      seed: 42,
      dims: DIMS,
      assets,
      mutedLayers: NO_MUTE,
      features: null,
    },
    events,
  };
}

const walk = (input: LoopRenderInput): Uint8Array[] =>
  Array.from({ length: input.frames }, (_, f) => renderLoopFramePng(input, f, 1));

describe('loop export — keystone determinism', () => {
  it('two walks produce byte-identical per-frame PNG streams', () => {
    const a = walk(testScene().input);
    const b = walk(testScene().input);
    expect(a.length).toBe(12);
    for (let f = 0; f < a.length; f++) {
      expect(Buffer.from(a[f]).equals(Buffer.from(b[f])), `frame ${f}`).toBe(true);
    }
  });

  it('the stored seed reaches the render (twinkle differs under another seed)', () => {
    const a = walk(testScene().input);
    const b = walk({ ...testScene().input, seed: 43 });
    expect(a.some((png, f) => !Buffer.from(png).equals(Buffer.from(b[f])))).toBe(true);
  });

  it('mutes are an explicit deterministic input (muting a layer changes the output)', () => {
    const a = walk(testScene().input);
    const b = walk({ ...testScene().input, mutedLayers: new Set([2]) });
    expect(a.some((png, f) => !Buffer.from(png).equals(Buffer.from(b[f])))).toBe(true);
    const b2 = walk({ ...testScene().input, mutedLayers: new Set([2]) });
    b.forEach((png, f) => expect(Buffer.from(png).equals(Buffer.from(b2[f]))).toBe(true));
  });

  it('frame 0 with an empty timeline == the still scene export', () => {
    const { input } = testScene();
    const still = renderStillPng(
      { nodes: input.nodes, scene: input.scene, dims: DIMS, assets: input.assets },
      1,
    );
    const frame0 = renderLoopFramePng({ ...input, events: [] }, 0, 1);
    expect(Buffer.from(frame0).equals(Buffer.from(still))).toBe(true);
  });
});

describe('loop export — the two-clock model (export length != loop length)', () => {
  const F = 4;
  const T = 8; // export = 2 loops
  const feat = (low: number): FrameFeature => ({ ...ZERO_FEATURE, low });
  // Features are ABSOLUTE (length T): silent in loop 0, loud-low in loop 1.
  const features: FeatureArray = Array.from({ length: T }, (_, i) => feat(i < F ? 0 : 1));

  const baseInput = (events: TimedEvent[]): LoopRenderInput => ({
    nodes: [node('a', 24, 13)],
    scene: SCENE_LOOK_DEFAULT,
    events,
    frames: F,
    totalFrames: T,
    seed: 7,
    dims: DIMS,
    assets: new Map([['asset-a', ramp(12, 10, 5)]]),
    mutedLayers: NO_MUTE,
    features,
  });

  it('setting totalFrames = frames is byte-identical to omitting it (the default clock)', () => {
    const { input } = testScene();
    const withT: LoopRenderInput = { ...input, totalFrames: input.frames };
    for (let f = 0; f < input.frames; f++) {
      const a = renderLoopFramePng(input, f, 1);
      const b = renderLoopFramePng(withT, f, 1);
      expect(Buffer.from(b).equals(Buffer.from(a)), `frame ${f}`).toBe(true);
    }
  });

  it('reaction-free: frame k and frame k+F are IDENTICAL grids (authored content cycles at loopFrame)', () => {
    const input = baseInput([]); // features present but NO audio-react event bound
    for (let k = 0; k < F; k++) {
      const a = renderLoopFrameGrid(input, k);
      const b = renderLoopFrameGrid(input, k + F);
      expect(Buffer.from(b.idx).equals(Buffer.from(a.idx)), `k=${k}`).toBe(true);
    }
  });

  it('a bound scene reaction makes frame k+F DIFFER from frame k (features read absolutely)', () => {
    const react: AudioReactEvent = {
      id: 'ar',
      kind: 'audio-react',
      nodeId: '', // scene-level
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: F - 1,
      band: 'low',
      target: { kind: 'look', key: 'brightness' },
      depth: 1,
    };
    const input = baseInput([react]);
    let anyDiff = false;
    for (let k = 0; k < F; k++) {
      const a = renderLoopFrameGrid(input, k); // absFrame k → low 0 → no brighten
      const b = renderLoopFrameGrid(input, k + F); // absFrame k+F → low 1 → brighten
      if (!Buffer.from(b.idx).equals(Buffer.from(a.idx))) anyDiff = true;
    }
    expect(anyDiff).toBe(true);
  });
});

describe('loop export — the video overlay seam', () => {
  it('videoRasterAt swaps the raster per frame; null falls through to the base cache', () => {
    const base = ramp(10, 8, 9);
    const input: LoopRenderInput = {
      nodes: [node('v', 24, 13), node('a', 8, 20)],
      scene: SCENE_LOOK_DEFAULT,
      events: [],
      frames: 4,
      seed: 1,
      dims: DIMS,
      assets: new Map([
        ['asset-v', ramp(10, 8, 0)],
        ['asset-a', base],
      ]),
      mutedLayers: NO_MUTE,
      features: null,
      videoRasterAt: (assetId, frame) => (assetId === 'asset-v' ? ramp(10, 8, 40 + frame) : null),
    };
    const f0 = renderLoopFrameGrid(input, 0);
    const f1 = renderLoopFrameGrid(input, 1);
    expect(Buffer.from(f0.idx).equals(Buffer.from(f1.idx))).toBe(false); // the video moved
    // The base cache is never mutated by the overlay.
    expect(input.assets.get('asset-a')).toBe(base);
    expect(input.assets.get('asset-v')!.tones[0]).toBe(ramp(10, 8, 0).tones[0]);
  });
});

describe('bounded-decode planning (core/video-decode)', () => {
  const pts = Array.from({ length: 10 }, (_, i) => i / 30); // perfect 30fps

  it('tiles partition the frame list exactly', () => {
    const tiles = planFrameTiles(pts, 4, 0, 10 / 30);
    expect(tiles.map((t) => [t.start, t.end])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
  });

  it('boundaries sit at midpoints between neighbouring pts; edges reuse the window', () => {
    const tiles = planFrameTiles(pts, 4, 0, 10 / 30);
    expect(tiles[0].trimStart).toBe(0);
    expect(tiles[0].trimEnd).toBeCloseTo((pts[3] + pts[4]) / 2, 12);
    expect(tiles[1].trimStart).toBe(tiles[0].trimEnd); // exact partition
    expect(tiles[2].trimEnd).toBeCloseTo(10 / 30, 12);
  });

  it('videoRasterDims: long edge pinned, short edge rounded, degenerate guarded', () => {
    expect(videoRasterDims(1920, 1080)).toEqual({ w: VIDEO_RASTER_LONG, h: 108 });
    expect(videoRasterDims(1080, 1920)).toEqual({ w: 108, h: VIDEO_RASTER_LONG });
    expect(videoRasterDims(0, 0)).toEqual({ w: VIDEO_RASTER_LONG, h: VIDEO_RASTER_LONG });
  });
});
