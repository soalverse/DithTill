// =============================================================================
// Trail (J5 step 2): Echo = fading copies where the layer was, under it; Smear =
// the picture keeps the brightest of its recent past. The past is the frames just drawn, so
// an exported frame is the same whether it renders alone or in a walk, from the top or from
// a marked part (the pre-roll), and a loop's first frames trail its last (seamless).
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  primeLoopTrail,
  renderLoopFrameImage,
  type LoopRenderInput,
} from '../src/core/loop-render';
import { smearRaster, trailReach, trailSamples, type TrailFrame } from '../src/core/layer-trail';
import { sceneScreenLayers } from '../src/core/scene-screen';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import type { CachedAsset } from '../src/core/scene-resolver';
import type { BeatClock } from '../src/core/tempo';
import type { LayerFx } from '../src/core/layer-fx';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

const square = (w: number, h: number, tone = 255): CachedAsset => ({
  w,
  h,
  tones: new Uint8Array(w * h).fill(tone),
  covered: new Uint8Array(w * h).fill(1),
});
const node = (fx?: LayerFx, patch: Partial<SceneNode> = {}): SceneNode => ({
  id: 'n1',
  assetId: 'a1',
  kind: 'paint',
  z: 1,
  placement: { x: 20, y: 18, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: {},
  motion: { type: 'drift', cycles: 1, amp: 12, ax: 1, ay: 0, phase0: 0 },
  opacity: 100,
  ...(fx ? { fx } : {}),
  ...patch,
});
// 120 BPM at 24 fps = 12 frames a beat; a 2-beat loop.
const beat: BeatClock = { bpm: 120, fps: 24, offsetSec: 0, frames: 24, loopBeats: 2, song: false };
const input = (nodes: SceneNode[], patch: Partial<LoopRenderInput> = {}): LoopRenderInput => ({
  nodes,
  scene: SCENE_LOOK_DEFAULT,
  events: [],
  frames: 24,
  seed: 1,
  dims: { w: 64, h: 36 },
  assets: new Map([['a1', square(6, 6)]]),
  mutedLayers: new Set(),
  features: null,
  background: { rgb: [0, 0, 0] },
  beat,
  ...patch,
});
const lit = (rgba: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] || rgba[i + 1] || rgba[i + 2]) n++;
  return n;
};
const echo: LayerFx = { trail: { kind: 'echo', length: 1, fade: 60 } };
const smear: LayerFx = { trail: { kind: 'smear', length: 1, fade: 60 } };

describe('the trail samples', () => {
  it('Echo: a copy every quarter beat, newest strongest; Fade 0 keeps them all whole', () => {
    const s = trailSamples('echo', 1, 60, 12);
    expect(s.map((x) => x.age)).toEqual([3, 6, 9, 12]);
    for (let i = 1; i < s.length; i++) expect(s[i].weight).toBeLessThan(s[i - 1].weight);
    expect(trailSamples('echo', 1, 0, 12).every((x) => x.weight === 256)).toBe(true);
    expect(trailSamples('echo', 2, 60, 12)).toHaveLength(8);
  });

  it('Smear reads every frame of its Length; a moving Length reaches as far as it can go', () => {
    expect(trailSamples('smear', 1, 60, 12).map((x) => x.age)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(trailReach([node(smear)], 12)).toBe(12);
    expect(trailReach([node()], 12)).toBe(0);
    const moving = node(smear, {
      mods: { 'fx.trail.length': { kind: 'wave', shape: 'smooth', beats: 4, from: 1, to: 2 } },
    });
    expect(trailReach([moving], 12)).toBe(48);
  });

  it("Smear keeps each cell's brightest, faded; coverage grows to the past's", () => {
    const cur = square(4, 1, 50);
    cur.covered[3] = 0;
    const past = square(4, 1, 200);
    const out = smearRaster(cur, [{ raster: past, weight: 128 }]);
    expect([...out.tones]).toEqual([100, 100, 100, 100]);
    expect([...out.covered]).toEqual([1, 1, 1, 1]);
    expect(smearRaster(cur, [{ raster: past, weight: 32 }]).tones[0]).toBe(50);
    expect(smearRaster(cur, [{ raster: square(3, 1), weight: 256 }]).tones).toEqual(cur.tones);
  });
});

describe('Echo and Smear on the layer', () => {
  const assets = new Map([['a1', square(6, 6)]]);
  const past = (n: SceneNode, x: number): TrailFrame =>
    new Map([[n.id, { node: { ...n, placement: { ...n.placement, x } }, raster: square(6, 6) }]]);

  it('Echo draws thinned copies at the past places, oldest first, under the layer', () => {
    const n = node(echo);
    const layers = sceneScreenLayers([n], SCENE_LOOK_DEFAULT, assets, null, {
      past: (age) => past(n, 20 - age),
      framesPerBeat: 12,
    });
    expect(layers).toHaveLength(5);
    expect(layers.map((l) => l.placement.x)).toEqual([8, 11, 14, 17, 20]);
    expect(layers.map((l) => l.opacity)).toEqual([52, 64, 76, 88, 100]);
    // No past (at rest, or the first frames live) = just the layer.
    expect(sceneScreenLayers([n], SCENE_LOOK_DEFAULT, assets, null)).toHaveLength(1);
  });

  it('Smear changes the picture, not the place', () => {
    const n = node(smear);
    const dim = new Map([['a1', square(6, 6, 40)]]);
    const [l] = sceneScreenLayers([n], SCENE_LOOK_DEFAULT, dim, null, {
      past: (age) => past(n, 0 + age),
      framesPerBeat: 12,
    });
    expect(l.placement.x).toBe(20);
    expect(l.raster.tones[0]).toBeGreaterThan(40);
  });
});

describe('every output draws the same trail (preview == export)', () => {
  it('a moving layer leaves an Echo in the export', () => {
    const plain = lit(renderLoopFrameImage(input([node()]), 6, 2).rgba);
    const trailed = lit(renderLoopFrameImage(input([node(echo)]), 6, 2).rgba);
    expect(trailed).toBeGreaterThan(plain);
  });

  it('a frame is the same alone, in a walk from the top, or after a marked-part pre-roll', () => {
    for (const fx of [echo, smear]) {
      const alone = (f: number) => renderLoopFrameImage(input([node(fx)]), f, 2).rgba;
      const walk = input([node(fx)], { trailMemory: new Map() });
      for (let f = 0; f < 24; f++)
        if (f % 4 === 0 || f === 23)
          expect(renderLoopFrameImage(walk, f, 2).rgba).toEqual(alone(f));
      // A marked part starting at frame 10: pre-roll, then walk.
      const part = input([node(fx)], { trailMemory: new Map() });
      for (let a = 12; a >= 1; a--) primeLoopTrail(part, part.trailMemory!, 10 - a);
      for (const f of [10, 13]) expect(renderLoopFrameImage(part, f, 2).rgba).toEqual(alone(f));
    }
  });

  it("a loop's first frame trails its last (seamless)", () => {
    const inp = input([node(echo)]);
    expect(renderLoopFrameImage(inp, 0, 2).rgba).toEqual(renderLoopFrameImage(inp, 24, 2).rgba);
    expect(lit(renderLoopFrameImage(inp, 0, 2).rgba)).toBeGreaterThan(
      lit(renderLoopFrameImage(input([node()]), 0, 2).rgba),
    );
  });

  it("a video's Smear reads its past frames", () => {
    // A bright bar sweeping across a still layer, one column a frame.
    const videoRasterAt = (_id: string, f: number): CachedAsset => {
      const r = square(16, 4, 0);
      for (let y = 0; y < 4; y++) r.tones[y * 16 + (f % 16)] = 255;
      return r;
    };
    const still = node(smear, { motion: null });
    const plain = lit(
      renderLoopFrameImage(input([node(undefined, { motion: null })], { videoRasterAt }), 8, 2)
        .rgba,
    );
    const smeared = lit(renderLoopFrameImage(input([still], { videoRasterAt }), 8, 2).rgba);
    expect(smeared).toBeGreaterThan(plain);
  });

  it('Length and Fade move with ∿ like any slider', () => {
    const n = node(echo, {
      mods: { 'fx.trail.fade': { kind: 'wave', shape: 'rampUp', beats: 2, from: 0, to: 100 } },
    });
    const at = (f: number) =>
      evaluateScene([n], SCENE_LOOK_DEFAULT, [], f, 24, null, makeRng(1), new Set(), { beat })
        .nodes[0].fx!.trail!;
    expect(at(0).fade).not.toBe(at(12).fade);
    expect(at(12).kind).toBe('echo');
  });
});
