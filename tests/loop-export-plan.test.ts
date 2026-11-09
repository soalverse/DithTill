// W4b — the long-export branch decision pinned as pure data:
//   fastPathEligible gates the D4 render-once-and-repeat path: T > F AND no
//      absolute-frame reader (audio-react event / outlasting video / visualizer
//      while features are present). The visualizer exclusion is the subtle one —
//      it breaks cycle-identity even with NO audio-react event bound.
import { describe, it, expect } from 'vitest';
import { fastPathEligible, type FastPathInputs } from '../src/core/loop-export-plan';
import type { AudioReactEvent, TimedEvent } from '../src/core/loop-events';
import type { FeatureArray } from '../src/core/audio-features';
import { ZERO_FEATURE } from '../src/core/audio-features';
import type { Placement, SceneNode } from '../src/state/scene-store';

const place = (): Placement => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 });
function node(id: string, kind: SceneNode['kind']): SceneNode {
  return {
    id,
    assetId: `asset-${id}`,
    kind,
    z: 1,
    placement: place(),
    crop: null,
    look: {},
    motion: null,
    opacity: 100,
  };
}
const reactEvent = (): AudioReactEvent => ({
  id: 'ar',
  kind: 'audio-react',
  nodeId: '',
  pass: 0,
  layer: 0,
  startFrame: 0,
  endFrame: 3,
  band: 'low',
  target: { kind: 'look', key: 'brightness' },
  depth: 1,
});
const someFeatures = (t: number): FeatureArray =>
  Array.from({ length: t }, () => ({ ...ZERO_FEATURE }));

// T > F, clean scene — the baseline eligible case; each test flips ONE rule.
const base: FastPathInputs = {
  totalFrames: 10,
  frames: 4,
  events: [],
  nodes: [node('a', 'asset')],
  features: null,
  videoFrameCounts: [],
};

describe('fastPathEligible (D4 cycle-identity gate)', () => {
  it('a clean T > F scene is eligible', () => {
    expect(fastPathEligible(base)).toBe(true);
  });

  it('T <= F is never eligible (that is the single-pass path)', () => {
    expect(fastPathEligible({ ...base, totalFrames: 4 })).toBe(false);
    expect(fastPathEligible({ ...base, totalFrames: 3 })).toBe(false);
  });

  it('a bound audio-react event breaks eligibility', () => {
    const events: TimedEvent[] = [reactEvent()];
    expect(fastPathEligible({ ...base, events })).toBe(false);
  });

  it('a placed video that OUTLASTS the loop breaks eligibility', () => {
    expect(fastPathEligible({ ...base, videoFrameCounts: [5] })).toBe(false); // 5 > F(4)
    expect(fastPathEligible({ ...base, videoFrameCounts: [4] })).toBe(true); // == F, tiles per cycle
  });

  it('a short video that does not fit the loop a whole number of times breaks it (song time)', () => {
    expect(fastPathEligible({ ...base, videoFrameCounts: [3] })).toBe(false); // 4 % 3 ≠ 0
    expect(fastPathEligible({ ...base, videoFrameCounts: [2] })).toBe(true); // 2 fits twice
  });

  it('a layer on the song (clips) or with its own loop breaks eligibility', () => {
    const timed = {
      ...node('t', 'asset'),
      clips: [{ id: 'c', start: 2, duration: 3, sourceIn: 0 }],
    };
    expect(fastPathEligible({ ...base, nodes: [timed] })).toBe(false);
    expect(fastPathEligible({ ...base, layerLoops: { l: { frames: 3 } } })).toBe(false);
  });

  it('a visualizer node WITH features breaks eligibility (reads features[absFrame])', () => {
    expect(
      fastPathEligible({
        ...base,
        nodes: [node('v', 'visualizer')],
        features: someFeatures(base.totalFrames),
      }),
    ).toBe(false);
  });

  it('a visualizer node with NULL features stays eligible (deterministic per loopFrame)', () => {
    expect(fastPathEligible({ ...base, nodes: [node('v', 'visualizer')], features: null })).toBe(
      true,
    );
  });
});
