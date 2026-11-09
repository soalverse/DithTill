// =============================================================================
// the song clock: every layer is a clip on the song with its OWN loop.
// Pins the pure rules the live canvas, the export and the sound share:
//   - layerClock: a layer's loop frame from the song frame (through its clip, wrapped by
//     its own loop length; null in a gap);
//   - evaluateScene: clips on SONG time (no repeat every canvas loop), each layer's
//     recorded events replay on its own clock, from its clip's in-point;
//   - applyPaintReveal: a stroke draws in on its layer's clock.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  applyPaintReveal,
  evaluateScene,
  layerClock,
  type LayerLoop,
  type ObjectPathEvent,
  type PaintRevealEvent,
} from '../src/core/loop-events';
import { SCENE_LOOK_DEFAULT, type Placement, type SceneNode } from '../src/state/scene-store';
import type { TimelineClip } from '../src/core/timeline-edit';
import type { CachedAsset } from '../src/core/scene-resolver';
import { makeRng } from '../src/core/seeded-rng';

const clip = (start: number, duration: number, sourceIn = 0, speed?: number): TimelineClip => ({
  id: `c${start}`,
  start,
  duration,
  sourceIn,
  ...(speed ? { speed } : {}),
});

const P0: Placement = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 };

const node = (extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'n',
  assetId: 'a',
  kind: 'asset',
  z: 1,
  placement: { ...P0 },
  crop: null,
  look: {},
  motion: null,
  opacity: 100,
  ...extra,
});

/** A recorded move on node `n`: at loop frame k the layer sits at x = k (frames 0..L-1). */
const path = (L: number): ObjectPathEvent => ({
  id: 'op-1',
  kind: 'object-path',
  nodeId: 'n',
  pass: 1,
  layer: 1,
  startFrame: 0,
  endFrame: L - 1,
  interp: 'hold',
  samples: Array.from({ length: L }, (_, k) => ({ ...P0, x: k })),
});

const F = 10; // the canvas loop
/** The evaluated x of node `n` at SONG frame `abs` (null when it's off). */
const xAt = (
  n: SceneNode,
  events: ObjectPathEvent[],
  abs: number,
  layerLoops?: Record<string, LayerLoop>,
): number | null => {
  const ev = evaluateScene(
    [n],
    SCENE_LOOK_DEFAULT,
    events,
    abs % F,
    F,
    null,
    makeRng(1),
    new Set(),
    { absFrame: abs, layerLoops },
  );
  return ev.nodes[0]?.placement.x ?? null;
};

describe('layerClock', () => {
  it('an untimed layer runs from the song start, wrapped by the project loop', () => {
    expect(layerClock({}, 0, F)).toEqual({ frame: 0, frames: F, pos: 0 });
    expect(layerClock({}, 23, F)).toEqual({ frame: 3, frames: F, pos: 23 });
  });

  it("a layer's OWN loop length wins over the project's", () => {
    expect(layerClock({}, 23, F, { frames: 6 })?.frame).toBe(5);
    expect(layerClock({}, 23, F, { frames: 6 })?.frames).toBe(6);
  });

  it("inside a clip it runs from the clip's in-point, at the clip's speed; null in a gap", () => {
    const clips = [clip(40, 30, 0), clip(80, 10, 3)];
    expect(layerClock({ clips }, 39, F)).toBeNull();
    expect(layerClock({ clips }, 40, F)?.frame).toBe(0); // a bar starts its loop from the top
    expect(layerClock({ clips }, 57, F)?.frame).toBe(7);
    expect(layerClock({ clips }, 75, F)).toBeNull();
    expect(layerClock({ clips }, 80, F)?.frame).toBe(3); // a split piece carries on
    expect(layerClock({ clips: [clip(0, 40, 0, 2)] }, 7, F)?.frame).toBe(4); // 2× speed
  });
});

describe('evaluateScene on the song clock', () => {
  it('a clip shows only where it sits on the song — not again every canvas loop', () => {
    const n = node({ clips: [clip(25, 5)] });
    expect(xAt(n, [], 24)).toBeNull();
    expect(xAt(n, [], 25)).toBe(0);
    expect(xAt(n, [], 29)).toBe(0);
    expect(xAt(n, [], 30)).toBeNull();
    expect(xAt(n, [], 5)).toBeNull(); // the old loop-time rule would have shown it here (25 % 10)
  });

  it("a recorded move replays from the start of the layer's bar and repeats while the bar lasts", () => {
    const n = node({ clips: [clip(25, 30)] });
    const ev = [path(F)];
    expect(xAt(n, ev, 25)).toBe(0); // the bar starts → loop frame 0
    expect(xAt(n, ev, 31)).toBe(6);
    expect(xAt(n, ev, 35)).toBe(0); // one loop in → repeats from the top
    expect(xAt(n, ev, 54)).toBe(9);
  });

  it("a layer's own loop length sets how often its recording repeats", () => {
    const ev = [path(4)];
    const loops = { n: { frames: 4 } };
    expect([0, 1, 2, 3, 4, 5, 9].map((f) => xAt(node(), ev, f, loops))).toEqual([
      0, 1, 2, 3, 0, 1, 1,
    ]);
  });

  it("a loop's offset starts it where its take began (a Free take mid-song)", () => {
    const ev = [path(4)];
    const loops = { n: { frames: 4, free: true, offset: 6 } };
    expect([6, 7, 9, 10, 13].map((f) => xAt(node(), ev, f, loops))).toEqual([0, 1, 3, 0, 3]);
  });

  it('an untimed layer with no own loop is unchanged (byte-identical loop-frame replay)', () => {
    const n = node();
    const ev = [path(F)];
    for (const f of [0, 3, 9, 13, 27]) expect(xAt(n, ev, f)).toBe(f % F);
  });

  it('returns each on-screen layer clock', () => {
    const n = node({ clips: [clip(25, 30)] });
    const ev = evaluateScene([n], SCENE_LOOK_DEFAULT, [], 1, F, null, makeRng(1), new Set(), {
      absFrame: 31,
      layerLoops: { n: { frames: 4 } },
    });
    expect(ev.clocks.get('n')).toEqual({ frame: 2, frames: 4, pos: 6 });
  });
});

describe("applyPaintReveal on a layer's clock", () => {
  it("draws a stroke in on its layer's own clock when one is given", () => {
    const base: CachedAsset = {
      w: 4,
      h: 1,
      tones: new Uint8Array(4),
      covered: new Uint8Array(4),
    };
    const stroke: PaintRevealEvent = {
      id: 'pr-1',
      kind: 'paint-reveal',
      nodeId: 'n',
      assetId: 'paint:1',
      pass: 1,
      layer: 1,
      startFrame: 0,
      endFrame: 3,
      stamps: [0, 1, 2, 3].map((k) => ({
        frame: k,
        x: k,
        y: 0,
        r: 0.4,
        shade: 255,
        erase: false,
      })),
    };
    const assets = new Map([['paint:1', base]]);
    const covered = (frame: number, clock?: { frame: number; frames: number }) =>
      applyPaintReveal(assets, [stroke], frame, F, new Set(), null, clock ? () => clock : undefined)
        .get('paint:1')!
        .covered.reduce((a, v) => a + (v ? 1 : 0), 0);
    expect(covered(9)).toBe(4); // the canvas clock: all four dabs by frame 9
    expect(covered(9, { frame: 1, frames: 4 })).toBe(2); // the layer's own clock: frame 1
  });
});

describe('Free recording + the loop store', () => {
  it('a Free take rounds to the NEAREST beat (Shift = exact), never shorter than a beat', async () => {
    const { roundToBeat } = await import('../src/core/tempo');
    // 120 BPM at 30 fps: one beat = 15 frames
    expect(roundToBeat(339, 120, 30)).toBe(345); // 11.3 s → 11.5 s (23 beats)
    expect(roundToBeat(336, 120, 30)).toBe(330); // nearer 22 beats
    expect(roundToBeat(339, 120, 30, true)).toBe(339); // Shift: as recorded
    expect(roundToBeat(3, 120, 30)).toBe(15); // a tap is still one beat
  });

  it('layer loops live beside the takes: set, drop, and cleared with the takes', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const lp = useLoopStore.getState();
    lp.setLayerLoops({ a: { frames: 60, bars: 2 }, b: { frames: 33, free: true, offset: 9 } });
    expect(useLoopStore.getState().layerLoops).toEqual({
      a: { frames: 60, bars: 2 },
      b: { frames: 33, free: true, offset: 9 },
    });
    lp.setLayerLoops({ a: null });
    expect(Object.keys(useLoopStore.getState().layerLoops)).toEqual(['b']);
    lp.clearLoop();
    expect(useLoopStore.getState().layerLoops).toEqual({});
  });
});

describe('the timeline strip', () => {
  it("draws a layer's loop restarts + each take inside its bar, per pass", async () => {
    const { loopMarks } = await import('../src/core/timeline-edit');
    // a bar at song frames 100..160, loop of 20 frames, one take over loop frames 5..9
    const bar = [{ id: 'c', start: 100, duration: 60, sourceIn: 0 }];
    const m = loopMarks(bar, { frames: 20 }, 10, [[1, { layer: 1, a: 5, b: 9 }]]);
    expect(m.reps).toEqual([120, 140]);
    expect(m.takes.map((t) => [t.a, t.b])).toEqual([
      [105, 110],
      [125, 130],
      [145, 150],
    ]);
  });

  it('a loop offset (a take that began mid-bar) shifts the restarts', async () => {
    const { loopMarks } = await import('../src/core/timeline-edit');
    const m = loopMarks(
      [{ id: 'c', start: 0, duration: 50, sourceIn: 0 }],
      { frames: 20, offset: 7 },
      10,
      [],
    );
    expect(m.reps).toEqual([7, 27, 47]);
  });

  it("lists every loop pass for the ruler's bracket, the one the loop began on marked", async () => {
    const { loopMarks } = await import('../src/core/timeline-edit');
    // a loop of 20 that began at position 47 on a bar from song frame 100 (positions 0..60)
    const m = loopMarks(
      [{ id: 'c', start: 100, duration: 60, sourceIn: 0 }],
      { frames: 20, offset: 47 },
      10,
      [],
    );
    expect(m.passes.map((p) => [p.at, p.len, p.first])).toEqual([
      [107, 20, false],
      [127, 20, false],
      [147, 20, true],
    ]);
  });

  it('a layer with no loop and no takes draws nothing', async () => {
    const { loopMarks } = await import('../src/core/timeline-edit');
    expect(
      loopMarks([{ id: 'c', start: 0, duration: 50, sourceIn: 0 }], undefined, 10, []),
    ).toEqual({
      reps: [],
      takes: [],
      passes: [],
    });
  });

  it('the marked part is kept in whole song frames, and a too-short part clears it', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const lp = useLoopStore.getState();
    lp.setPart({ start: 12.4, end: 80.6 });
    expect(useLoopStore.getState().part).toEqual({ start: 12, end: 81 });
    lp.setPart({ start: 30, end: 30 });
    expect(useLoopStore.getState().part).toBeNull();
  });
});
