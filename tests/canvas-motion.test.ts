// =============================================================================
// The Whole canvas Motion: a Motion on the Whole canvas row moves the
// whole picture as one — every layer turns, grows and travels together about the canvas
// centre, on top of its own motion; slow ones stretch the loop; it is one undo step.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { evaluateScene, motionPeriodFrames, hasSongBeatMotion } from '../src/core/loop-events';
import { fastPathEligible } from '../src/core/loop-export-plan';
import { makeRng } from '../src/core/seeded-rng';
import {
  SCENE_LOOK_DEFAULT,
  layerLookFrom,
  useSceneStore,
  type MotionDescriptor,
  type SceneNode,
} from '../src/state/scene-store';

const DIMS = { w: 100, h: 60 };
const layer = (id: string, x: number, y: number, motion: MotionDescriptor | null = null) =>
  ({
    id,
    assetId: id,
    kind: 'paint',
    z: 1,
    placement: { x, y, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: layerLookFrom(SCENE_LOOK_DEFAULT),
    motion,
    opacity: 100,
  }) as SceneNode;
const motion = (type: MotionDescriptor['type'], extra: Partial<MotionDescriptor> = {}) =>
  ({ type, amp: 10, cycles: 1, ax: 1, ay: 0, phase0: 0, ...extra }) as MotionDescriptor;
const at = (nodes: SceneNode[], canvasMotion: MotionDescriptor | null, frame: number, F = 48) =>
  evaluateScene(nodes, SCENE_LOOK_DEFAULT, [], frame, F, null, makeRng(1), new Set(), {
    dims: DIMS,
    assetDims: () => ({ w: 20, h: 10 }),
    canvasMotion,
  }).nodes;

describe('the Whole canvas Motion', () => {
  it('a Spin turns every layer together about the canvas centre', () => {
    const nodes = [layer('a', 50, 30), layer('b', 70, 30)];
    const q = at(nodes, motion('spin'), 12); // a quarter turn
    // The layer at the centre only turns; the other swings round it (90° → straight down).
    expect(q[0].placement.x).toBeCloseTo(50);
    expect(q[0].placement.y).toBeCloseTo(30);
    expect(q[0].placement.rotationDeg).toBeCloseTo(90);
    expect(q[1].placement.x).toBeCloseTo(50);
    expect(q[1].placement.y).toBeCloseTo(50);
    expect(q[1].placement.rotationDeg).toBeCloseTo(90);
  });

  it('loops seamlessly (frame 0 == frame F) and leaves the base layers untouched', () => {
    const nodes = [layer('a', 20, 10), layer('b', 70, 40)];
    for (const t of ['spin', 'bob', 'pulse', 'pendulum', 'drift', 'bounce'] as const) {
      const f0 = at(nodes, motion(t), 0);
      const fF = at(nodes, motion(t), 48);
      for (let i = 0; i < nodes.length; i++) {
        expect(fF[i].placement.x).toBeCloseTo(f0[i].placement.x);
        expect(fF[i].placement.y).toBeCloseTo(f0[i].placement.y);
        expect(fF[i].placement.rotationDeg % 360).toBeCloseTo(f0[i].placement.rotationDeg % 360);
      }
    }
    expect(nodes[1].placement).toEqual({ x: 70, y: 40, scaleX: 1, scaleY: 1, rotationDeg: 0 });
  });

  it('a Pulse grows the whole picture: layers spread from the centre as they grow', () => {
    const q = at([layer('a', 70, 30)], motion('pulse', { amp: 50 }), 12); // the peak: ×1.5
    expect(q[0].placement.scaleX).toBeCloseTo(1.5);
    expect(q[0].placement.x).toBeCloseTo(80); // 20 from the centre → 30
  });

  it("adds on top of a layer's own motion", () => {
    const own = layer('a', 50, 30, motion('bob'));
    const alone = at([own], null, 12)[0].placement;
    const both = at([own], motion('drift'), 12)[0].placement;
    expect(both.y).toBeCloseTo(alone.y);
    expect(both.x).toBeCloseTo(alone.x + 10); // Drift's peak, amp 10 along x
  });

  it('a Marquee scrolls the whole picture off one edge and back in from the other', () => {
    const nodes = [layer('a', 30, 30), layer('b', 60, 30)];
    const gaps = new Set<number>();
    let offCanvas = false;
    for (let f = 0; f < 48; f++) {
      const q = at(nodes, motion('marquee', { amp: 0 }), f);
      gaps.add(Math.round((q[1].placement.x - q[0].placement.x) * 1000));
      if (q.every((n) => n.placement.x > DIMS.w + 10 || n.placement.x < -10)) offCanvas = true;
    }
    expect([...gaps]).toEqual([30000]); // the picture keeps its shape
    expect(offCanvas).toBe(true);
  });

  it('a slow canvas Motion stretches the loop; a song-synced one rules out the fast path', () => {
    expect(
      motionPeriodFrames(48, [], [], undefined, undefined, motion('spin', { cycles: 0.25 })),
    ).toBe(192);
    const beat = { bpm: 120, fps: 24, offsetSec: 0, frames: 48, loopBeats: 4, song: true };
    expect(hasSongBeatMotion([], [], beat, undefined, motion('bob', { beats: 4 }))).toBe(true);
    expect(
      fastPathEligible({
        totalFrames: 480,
        frames: 48,
        events: [],
        nodes: [],
        features: null,
        videoFrameCounts: [],
        canvasMotion: motion('spin', { cycles: 0.5 }),
      }),
    ).toBe(false);
  });

  it('is one undo step, and Undo brings the canvas back to still', () => {
    const st = useSceneStore.getState();
    st.setMotion('', null);
    useSceneStore.temporal.getState().clear();
    st.setMotion('', motion('spin'));
    expect(useSceneStore.getState().canvasMotion?.type).toBe('spin');
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().canvasMotion).toBeNull();
  });
});
