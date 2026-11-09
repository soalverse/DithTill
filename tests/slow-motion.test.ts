// =============================================================================
// Slow motion speeds ("the marquee is still too fast even on speed 1").
// ½×, ¼×, ⅛× = one cycle every 2 / 4 / 8 loops, read on the absolute clock: a ½× motion
// on a loop of F frames moves exactly like a 1× motion on a loop of 2F; it never jumps at
// a loop boundary, it closes after whole trips, the live clock + the export's Loop length
// stretch to fit, and whole-number speeds are untouched.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  evaluateScene,
  motionPeriodFrames,
  motionSpan,
  type TimedEvent,
} from '../src/core/loop-events';
import { liveTotalFrames } from '../src/core/export-length';
import { fastPathEligible } from '../src/core/loop-export-plan';
import { makeRng } from '../src/core/seeded-rng';
import {
  SCENE_LOOK_DEFAULT,
  type MotionDescriptor,
  type SceneNode,
} from '../src/state/scene-store';
import { SPEED_STEPS, speedLabel, speedStep } from '../src/ui/motion-presets';

const F = 60;
const DIMS = { w: 192, h: 128 };
const NATIVE = { w: 40, h: 30 };
const RNG = makeRng(0x1337beef);
const NO_MUTE: ReadonlySet<number> = new Set();

const motion = (type: MotionDescriptor['type'], cycles: number): MotionDescriptor => ({
  type,
  cycles,
  amp: 8,
  ax: 1,
  ay: 0,
  phase0: 0,
});
function node(m: MotionDescriptor | null): SceneNode {
  return {
    id: 'a',
    assetId: 'asset-a',
    kind: 'asset',
    z: 1,
    placement: { x: 96, y: 64, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: m,
    opacity: 100,
  };
}
/** The node's placement at loop frame `abs mod frames`, absolute frame `abs`. */
function at(m: MotionDescriptor, abs: number, frames = F) {
  const n = evaluateScene(
    [node(m)],
    SCENE_LOOK_DEFAULT,
    [],
    abs % frames,
    frames,
    null,
    RNG,
    NO_MUTE,
    { dims: DIMS, assetDims: () => NATIVE, absFrame: abs },
  ).nodes[0];
  return n.placement;
}

describe('slow speeds', () => {
  it('span: ½ ¼ ⅛ → 2 4 8 loops; whole numbers and the noise types → 1', () => {
    expect([0.5, 0.25, 0.125].map((c) => motionSpan(motion('marquee', c)))).toEqual([2, 4, 8]);
    expect([1, 3, 8].map((c) => motionSpan(motion('spin', c)))).toEqual([1, 1, 1]);
    expect(motionSpan(motion('shake', 0.5))).toBe(1);
  });

  for (const type of ['marquee', 'drift', 'spin', 'pendulum', 'bounce'] as const) {
    it(`${type} at ¼× moves exactly like 1× on a loop four times as long`, () => {
      for (const abs of [0, 7, 59, 60, 61, 133, 239])
        expect(at(motion(type, 0.25), abs)).toEqual(at(motion(type, 1), abs, 4 * F));
    });
  }

  it('a ½× marquee keeps scrolling across the loop boundary (no jump back) and closes after 2 loops', () => {
    const m = motion('marquee', 0.5);
    const step = at(m, 30).x - at(m, 29).x;
    expect(at(m, 60).x - at(m, 59).x).toBeCloseTo(step, 9); // loop 1 → loop 2: same pace
    expect(at(m, 120)).toEqual(at(m, 0)); // whole trip: seamless
    // Half as fast as 1×: one trip takes two loops.
    const fast = motion('marquee', 1);
    expect(Math.abs(step)).toBeLessThan(Math.abs(at(fast, 30).x - at(fast, 29).x));
  });

  it('whole-number speeds ignore the absolute clock (unchanged)', () => {
    const m = motion('marquee', 2);
    const loopOnly = evaluateScene([node(m)], SCENE_LOOK_DEFAULT, [], 17, F, null, RNG, NO_MUTE, {
      dims: DIMS,
      assetDims: () => NATIVE,
    }).nodes[0].placement;
    expect(at(m, 17 + 3 * F)).toEqual(loopOnly);
  });
});

describe('the clock and the export fit whole trips', () => {
  const slow: SceneNode[] = [node(motion('marquee', 0.125)), node(motion('spin', 2))];

  it('motionPeriodFrames = F × the longest span (nodes and motion events)', () => {
    expect(motionPeriodFrames(F, [node(null), node(motion('bob', 3))])).toBe(F);
    expect(motionPeriodFrames(F, slow)).toBe(8 * F);
    const ev = { kind: 'motion', motion: motion('drift', 0.5) } as unknown as TimedEvent;
    expect(motionPeriodFrames(F, [], [ev])).toBe(2 * F);
  });

  it('the live clock spans whole trips and wraps only on them', () => {
    expect(liveTotalFrames(F, [])).toBe(F);
    expect(liveTotalFrames(F, [], 4 * F)).toBe(4 * F);
    // A song sets the video's length exactly: the video ends with the song,
    // slow motion or not.
    expect(liveTotalFrames(F, [5 * F - 10], 4 * F)).toBe(5 * F - 10);
    expect(liveTotalFrames(F, [5 * F - 10])).toBe(5 * F - 10);
  });

  it('a slow motion stops the cycle-repeat export shortcut', () => {
    const plan = {
      totalFrames: 8 * F,
      frames: F,
      events: [],
      features: null,
      videoFrameCounts: [],
    };
    expect(fastPathEligible({ ...plan, nodes: [node(motion('spin', 2))] })).toBe(true);
    expect(fastPathEligible({ ...plan, nodes: slow })).toBe(false);
  });
});

describe('the Speed slider', () => {
  it('runs ⅛× ¼× ½× 1× … 8×, finds the step for a saved speed, and labels it', () => {
    expect(SPEED_STEPS.map(speedLabel).join(' ')).toBe('⅛× ¼× ½× 1× 2× 3× 4× 5× 6× 7× 8×');
    expect(speedStep(1)).toBe(3);
    expect(speedStep(0.25)).toBe(1);
    expect(speedStep(8)).toBe(SPEED_STEPS.length - 1);
  });
});
