// =============================================================================
// J6: Halftone with Tonal off picks its dots by the Pattern (grids + Blue — a
// diffusion pattern reads as Blue, never flickering), and grain Drift slides a layer's grid of
// bits / dots over its still picture: speed × beats so far (summed frame by frame when ∿ moves
// it), in its Direction, the same in every output; a looping export renders every frame.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  SCREEN_LOOK_DEFAULT,
  LAYER_LOOK_KEYS,
  renderPrintScreen,
  type ScreenLook,
  type ScreenRaster,
} from '../src/core/print-screen';
import { evaluateScene } from '../src/core/loop-events';
import { renderLoopFrameImage, type LoopRenderInput } from '../src/core/loop-render';
import { fastPathEligible } from '../src/core/loop-export-plan';
import { makeRng } from '../src/core/seeded-rng';
import type { BeatClock } from '../src/core/tempo';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

const ramp = (w: number, h: number): ScreenRaster => {
  const tones = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tones[y * w + x] = (x * 255) / (w - 1);
  return { w, h, tones, covered: new Uint8Array(w * h).fill(1) };
};
const flat = (w: number, h: number, t: number): ScreenRaster => ({
  w,
  h,
  tones: new Uint8Array(w * h).fill(t),
  covered: new Uint8Array(w * h).fill(1),
});
const draw = (r: ScreenRaster, look: Partial<ScreenLook>) =>
  renderPrintScreen({
    layers: [
      {
        raster: r,
        placement: { x: 20, y: 15, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        look: { ...SCREEN_LOOK_DEFAULT, ...look },
      },
    ],
    dims: { w: 40, h: 30 },
    scale: 10,
    background: [0, 0, 0],
  }).rgba;

describe('Halftone with Tonal off', () => {
  it('the Pattern picks the dots; a diffusion pattern reads as Blue (no flicker)', () => {
    const r = ramp(40, 30);
    const off = { style: 'halftone' as const, tonal: false };
    expect(draw(r, { ...off, pattern: 4 })).not.toEqual(draw(r, { ...off, pattern: 'blue' }));
    expect(draw(r, { ...off, pattern: 'floyd' })).toEqual(draw(r, { ...off, pattern: 'blue' }));
  });
});

describe('grain Drift', () => {
  const beat: BeatClock = {
    bpm: 120,
    fps: 24,
    offsetSec: 0,
    frames: 24,
    loopBeats: 2,
    song: false,
  };
  const node = (look: SceneNode['look'], mods?: SceneNode['mods']): SceneNode => ({
    id: 'n1',
    assetId: 'a1',
    kind: 'paint',
    z: 1,
    placement: { x: 20, y: 15, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look,
    motion: null,
    opacity: 100,
    ...(mods ? { mods } : {}),
  });
  const grainAt = (n: SceneNode, abs: number) =>
    evaluateScene([n], SCENE_LOOK_DEFAULT, [], abs % 24, 24, null, makeRng(1), new Set(), {
      beat,
      absFrame: abs,
    }).nodes[0].grain;

  it('slides speed × beats so far, in its Direction (0° right, 90° up); still = none', () => {
    // 12 frames a beat: 2 squares a beat for 2 beats = 4 squares.
    expect(grainAt(node({ drift: 2 }), 24)).toEqual({ x: 4, y: -0 });
    const up = grainAt(node({ drift: 2, driftDir: 90 }), 24)!;
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-4);
    expect(grainAt(node({}), 24)).toBeUndefined();
    expect(grainAt(node({ drift: 0 }), 24)).toBeUndefined();
    // It keeps travelling across loop repeats (the absolute frame, not the loop's).
    expect(grainAt(node({ drift: 2 }), 48)!.x).toBe(8);
  });

  it('a moving speed (∿) sums frame by frame, so the grain never jumps back', () => {
    const n = node(
      { drift: 0 },
      { drift: { kind: 'wave', shape: 'smooth', beats: 1, from: 0, to: 4 } },
    );
    let prev = -1;
    for (let f = 0; f < 48; f += 3) {
      const x = grainAt(n, f)!.x;
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    expect(prev).toBeGreaterThan(0);
  });

  it('only the grid moves: a whole pattern repeat looks the same, half a square does not', () => {
    const r = flat(40, 30, 140);
    const look = { style: 'dither' as const, pattern: 8 as const };
    expect(draw(r, { ...look, grain: { x: 8, y: 0 } })).toEqual(draw(r, look));
    expect(draw(r, { ...look, grain: { x: 3, y: 0 } })).not.toEqual(draw(r, look));
  });

  it('every output draws it; drift is a layer look key; a drifting loop renders every frame', () => {
    const input: LoopRenderInput = {
      nodes: [node({ drift: 1, style: 'dither', matrix: 8 })],
      scene: SCENE_LOOK_DEFAULT,
      events: [],
      frames: 24,
      seed: 1,
      dims: { w: 40, h: 30 },
      assets: new Map([['a1', { ...ramp(40, 30) }]]),
      mutedLayers: new Set(),
      features: null,
      background: { rgb: [0, 0, 0] },
      beat,
    };
    expect(renderLoopFrameImage(input, 0, 10).rgba).not.toEqual(
      renderLoopFrameImage(input, 6, 10).rgba,
    );
    expect(LAYER_LOOK_KEYS).toContain('drift');
    expect(LAYER_LOOK_KEYS).toContain('driftDir');
    const plan = {
      totalFrames: 96,
      frames: 24,
      events: [],
      features: null,
      videoFrameCounts: [],
      beat,
    };
    expect(fastPathEligible({ ...plan, nodes: [node({})] })).toBe(true);
    expect(fastPathEligible({ ...plan, nodes: [node({ drift: 1 })] })).toBe(false);
  });
});
