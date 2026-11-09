// P1 looper foundations — the pure deterministic core, TDD'd before any
// transport/render/audio wiring:
//   1. evaluateScene at frame 0 with no events/motion == today's static nodes.
//   2. seeded PRNG: keyed, stateless, reproducible, iteration-order-independent.
//   3. procedural motion is seamless (frame 0 == frame F for integer cycles).
//   4. recorded object paths sample per integer frame; static holds.
//   5. paint-reveal count = #stamps laid by this frame.
//   6. audio-react folds a synthetic feature into the scene/node look.
//   7. loop-store partialize excludes the transient speed/transport/rev (speed can
//      never reach the export).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateScene,
  applyPaintReveal,
  paintWindowVisible,
  BLINK_HOLD_FRAMES,
  type AudioReactEvent,
  type DabStamp,
  type MotionEvent,
  type ObjectPathEvent,
  type ObjectStaticEvent,
  type PaintRevealEvent,
  type TimedEvent,
} from '../src/core/loop-events';
import type { CachedAsset } from '../src/core/scene-resolver';
import { makeRng } from '../src/core/seeded-rng';
import {
  SCENE_LOOK_DEFAULT,
  type MotionDescriptor,
  type Placement,
  type SceneNode,
} from '../src/state/scene-store';
import { useLoopStore } from '../src/state/loop-store';
import type { FeatureArray, FrameFeature } from '../src/core/audio-features';

const NO_MUTE: ReadonlySet<number> = new Set();
const RNG = makeRng(0x1337beef);

function place(x: number, y: number, rot = 0): Placement {
  return { x, y, scaleX: 1, scaleY: 1, rotationDeg: rot };
}
function node(id: string, x: number, y: number, motion: MotionDescriptor | null = null): SceneNode {
  return {
    id,
    assetId: `asset-${id}`,
    kind: 'asset',
    z: 1,
    placement: place(x, y),
    crop: null,
    look: {},
    motion,
    opacity: 100,
  };
}

describe('evaluateScene — static identity at t=0', () => {
  it('no events, no motion → placements byte-equal to the base nodes', () => {
    const base = [node('a', 10, 12), node('b', 30, 8)];
    const ev = evaluateScene(base, SCENE_LOOK_DEFAULT, [], 0, 60, null, RNG, NO_MUTE);
    expect(ev.nodes.map((n) => n.placement)).toEqual(base.map((n) => n.placement));
    expect(ev.scene).toEqual(SCENE_LOOK_DEFAULT);
    expect(ev.paintReveal.size).toBe(0);
    // It must NOT mutate the base nodes.
    expect(base[0].placement).toEqual(place(10, 12));
  });
});

describe('seeded PRNG — keyed, stateless, reproducible', () => {
  it('same key → same value; different key → (almost surely) different', () => {
    const rng = makeRng(42);
    expect(rng.value('e', 5, 0)).toBe(rng.value('e', 5, 0));
    expect(rng.value('e', 5, 0)).not.toBe(rng.value('e', 6, 0));
    expect(rng.value('e', 5, 0)).not.toBe(rng.value('e', 5, 1));
    expect(rng.value('e', 5, 0)).not.toBe(rng.value('f', 5, 0));
  });
  it('a different seed gives a different stream', () => {
    expect(makeRng(1).value('e', 0, 0)).not.toBe(makeRng(2).value('e', 0, 0));
  });
  it('values are in [0,1)', () => {
    for (let f = 0; f < 50; f++) {
      const v = makeRng(7).value('x', f, 0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('order of access does not change any value (stateless)', () => {
    const rng = makeRng(99);
    const forward = [0, 1, 2, 3].map((f) => rng.value('e', f, 0));
    const backward = [3, 2, 1, 0].map((f) => rng.value('e', f, 0)).reverse();
    expect(forward).toEqual(backward);
  });
});

describe('procedural motion — seamless wrap', () => {
  const F = 60;
  for (const type of ['drift', 'bob', 'parallax', 'marquee'] as const) {
    it(`${type} with integer cycles: frame 0 placement == frame F placement`, () => {
      const m: MotionDescriptor = { type, cycles: 2, amp: 5, ax: 1, ay: 1, phase0: 0.1 };
      const base = [node('a', 50, 50, m)];
      const at0 = evaluateScene(base, SCENE_LOOK_DEFAULT, [], 0, F, null, RNG, NO_MUTE);
      const atF = evaluateScene(base, SCENE_LOOK_DEFAULT, [], F, F, null, RNG, NO_MUTE);
      expect(atF.nodes[0].placement.x).toBeCloseTo(at0.nodes[0].placement.x, 9);
      expect(atF.nodes[0].placement.y).toBeCloseTo(at0.nodes[0].placement.y, 9);
    });
  }
  it('a mid-loop frame actually moves the node', () => {
    const m: MotionDescriptor = { type: 'bob', cycles: 1, amp: 8, ax: 0, ay: 1, phase0: 0 };
    const base = [node('a', 50, 50, m)];
    const mid = evaluateScene(base, SCENE_LOOK_DEFAULT, [], 15, 60, null, RNG, NO_MUTE);
    expect(mid.nodes[0].placement.y).not.toBeCloseTo(50, 3);
  });
  it('motion via a MotionEvent matches the node.motion mirror', () => {
    const m: MotionDescriptor = { type: 'drift', cycles: 1, amp: 6, ax: 1, ay: 0, phase0: 0 };
    const viaNode = evaluateScene(
      [node('a', 50, 50, m)],
      SCENE_LOOK_DEFAULT,
      [],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    const evt: MotionEvent = {
      id: 'a', // same key so the (rare) randomized draws would match too
      kind: 'motion',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 60,
      motion: m,
    };
    const viaEvent = evaluateScene(
      [node('a', 50, 50)],
      SCENE_LOOK_DEFAULT,
      [evt],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    expect(viaEvent.nodes[0].placement.x).toBeCloseTo(viaNode.nodes[0].placement.x, 9);
  });
});

describe('recorded object events', () => {
  it('object-path samples by integer index (hold; linear interp is reserved for P5)', () => {
    const samples = [place(0, 0), place(5, 5), place(9, 1)];
    const evt: ObjectPathEvent = {
      id: 'p',
      kind: 'object-path',
      nodeId: 'a',
      pass: 1,
      layer: 1,
      startFrame: 2,
      endFrame: 4,
      samples,
      interp: 'hold', // P1 ignores interp (frame-quantized capture); 'linear' lands in P5
    };
    const base = [node('a', 99, 99)];
    const at = (f: number) =>
      evaluateScene(base, SCENE_LOOK_DEFAULT, [evt], f, 60, null, RNG, NO_MUTE).nodes[0].placement;
    expect(at(1)).toEqual(place(99, 99)); // before the window → unchanged
    expect(at(2)).toEqual(samples[0]);
    expect(at(3)).toEqual(samples[1]);
    expect(at(4)).toEqual(samples[2]);
  });
  it('object-static holds its placement within the window', () => {
    const evt: ObjectStaticEvent = {
      id: 's',
      kind: 'object-static',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 3,
      endFrame: 60,
      placement: place(40, 20),
    };
    const base = [node('a', 0, 0)];
    const at = (f: number) =>
      evaluateScene(base, SCENE_LOOK_DEFAULT, [evt], f, 60, null, RNG, NO_MUTE).nodes[0].placement;
    expect(at(2)).toEqual(place(0, 0));
    expect(at(3)).toEqual(place(40, 20));
    expect(at(30)).toEqual(place(40, 20));
  });
  it('a higher pass overrides a lower pass for the same node+frame (overdub on top)', () => {
    const lo: ObjectStaticEvent = {
      id: 'lo',
      kind: 'object-static',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 60,
      placement: place(1, 1),
    };
    const hi: ObjectStaticEvent = {
      id: 'hi',
      kind: 'object-static',
      nodeId: 'a',
      pass: 3,
      layer: 3,
      startFrame: 0,
      endFrame: 60,
      placement: place(9, 9),
    };
    const r = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [hi, lo],
      10,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    expect(r.nodes[0].placement).toEqual(place(9, 9));
  });
});

describe('paint-reveal — true stamp count by frame', () => {
  it('counts stamps laid at or before the current frame', () => {
    const evt: PaintRevealEvent = {
      id: 'pr',
      kind: 'paint-reveal',
      nodeId: 'a',
      assetId: 'paint:1',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 10,
      stamps: [
        { frame: 0, x: 0, y: 0, r: 2, shade: 1, erase: false },
        { frame: 2, x: 1, y: 1, r: 2, shade: 1, erase: false },
        { frame: 5, x: 2, y: 2, r: 2, shade: 1, erase: false },
      ],
    };
    const reveal = (f: number) =>
      evaluateScene(
        [node('a', 0, 0)],
        SCENE_LOOK_DEFAULT,
        [evt],
        f,
        60,
        null,
        RNG,
        NO_MUTE,
      ).paintReveal.get('paint:1');
    expect(reveal(0)).toBe(1);
    expect(reveal(2)).toBe(2);
    expect(reveal(4)).toBe(2);
    expect(reveal(5)).toBe(3);
  });
});

describe('audio-react — folds a synthetic feature into the look', () => {
  function feat(rms: number, onset: number): FrameFeature {
    return { rms, low: 0, mid: 0, high: 0, onset };
  }
  const features: FeatureArray = [feat(0, 0), feat(1, 0), feat(0, 1)];

  it('scene-global contrast reaction adds to the scene contrast', () => {
    const evt: AudioReactEvent = {
      id: 'ar',
      kind: 'audio-react',
      nodeId: '',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 2,
      band: 'rms',
      target: { kind: 'look', key: 'contrast' },
      depth: 1,
    };
    const r = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      1,
      3,
      features,
      RNG,
      NO_MUTE,
    );
    expect(r.scene.contrast).toBeCloseTo(SCENE_LOOK_DEFAULT.contrast + 1, 6);
    expect(r.sceneLookDelta.contrast).toBeDefined();
  });
  it('a beat-gated invert flips the scene invert on a strong onset', () => {
    const evt: AudioReactEvent = {
      id: 'ai',
      kind: 'audio-react',
      nodeId: '',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 2,
      band: 'onset',
      target: { kind: 'invert' },
      depth: 1,
    };
    const off = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      1,
      3,
      features,
      RNG,
      NO_MUTE,
    );
    const on = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      2,
      3,
      features,
      RNG,
      NO_MUTE,
    );
    expect(off.scene.invert).toBe(SCENE_LOOK_DEFAULT.invert); // onset 0 → no flip
    expect(on.scene.invert).toBe(!SCENE_LOOK_DEFAULT.invert); // onset 1 → flip
  });
  it('a muted layer contributes nothing', () => {
    const evt: AudioReactEvent = {
      id: 'am',
      kind: 'audio-react',
      nodeId: '',
      pass: 0,
      layer: 7,
      startFrame: 0,
      endFrame: 2,
      band: 'rms',
      target: { kind: 'look', key: 'contrast' },
      depth: 1,
    };
    const muted = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      1,
      3,
      features,
      RNG,
      new Set([7]),
    );
    expect(muted.scene.contrast).toBe(SCENE_LOOK_DEFAULT.contrast);
  });
});

describe('loop-store — transient state is excluded from undo history', () => {
  beforeEach(() => {
    useLoopStore.temporal.getState().clear();
    useLoopStore.getState().clearLoop();
    useLoopStore.temporal.getState().clear();
  });

  it('changing speed/transport records NO undo entry; committing events does', () => {
    const temporal = useLoopStore.temporal.getState();
    expect(temporal.pastStates.length).toBe(0);
    useLoopStore.getState().setSpeed(0.5);
    useLoopStore.getState().setTransport('playing');
    expect(useLoopStore.temporal.getState().pastStates.length).toBe(0);

    const e: TimedEvent = {
      id: 'x',
      kind: 'object-static',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 60,
      placement: place(1, 1),
    };
    useLoopStore.getState().commitEvents([e]);
    expect(useLoopStore.temporal.getState().pastStates.length).toBe(1);
  });

  it('the partialized snapshot has only { meta, events, reactions, layerLoops } — never speed/transport/rev', () => {
    useLoopStore.getState().setLength({ frames: 90 }); // mutate meta → snapshot taken
    const past = useLoopStore.temporal.getState().pastStates;
    expect(past.length).toBeGreaterThan(0);
    const keys = Object.keys(past[past.length - 1]).sort();
    expect(keys).toEqual(['events', 'layerLoops', 'meta', 'reactions']);
  });

  it('reactions (v14): authored separate from the take log; always-on; Clear Loop keeps them', () => {
    const s = () => useLoopStore.getState();
    s().clearLoop();
    const id = s().addReaction({ nodeId: '', band: 'low', target: { kind: 'invert' }, depth: 0.7 });
    expect(s().reactions).toHaveLength(1);
    const r = s().reactions[0];
    expect(r.id).toBe(id);
    expect(r.kind).toBe('audio-react');
    expect(r.pass).toBeLessThan(0); // never a take, never muted
    expect(r.startFrame).toBe(0);
    expect(r.endFrame).toBeGreaterThan(1e6); // always-on across any loop length
    expect(s().events).toHaveLength(0); // NOT in the overdub take log
    // Patch band/effect/depth/target.
    s().updateReaction(id, { band: 'onset', depth: 0.3 });
    expect(s().reactions[0].band).toBe('onset');
    expect(s().reactions[0].depth).toBeCloseTo(0.3);
    // Clear Loop wipes takes but PRESERVES reactions (they're config, not a take).
    s().commitEvents([
      {
        id: 'x',
        kind: 'object-static',
        nodeId: 'n',
        pass: 0,
        layer: 0,
        startFrame: 0,
        endFrame: 1,
        placement: place(0, 0),
      },
    ]);
    s().clearLoop();
    expect(s().events).toHaveLength(0);
    expect(s().reactions).toHaveLength(1);
    // Remove.
    s().removeReaction(id);
    expect(s().reactions).toHaveLength(0);
  });

  it('setLength derives loopMs from frames/fps', () => {
    useLoopStore.getState().setLength({ frames: 90, fps: 30 });
    expect(useLoopStore.getState().meta.loopMs).toBeCloseTo(3000, 6);
  });

  it('max-take cap blocks arming past MAX_TAKES passes', () => {
    const events: TimedEvent[] = [];
    for (let p = 0; p < 12; p++) {
      events.push({
        id: `e${p}`,
        kind: 'object-static',
        nodeId: 'a',
        pass: p,
        layer: p,
        startFrame: 0,
        endFrame: 60,
        placement: place(0, 0),
      });
    }
    useLoopStore.getState().commitEvents(events);
    expect(useLoopStore.getState().beginOverdub()).toBeNull();
  });
});

describe('P1 review regressions', () => {
  const drift: MotionDescriptor = { type: 'drift', cycles: 1, amp: 6, ax: 1, ay: 0, phase0: 0 };

  it('a MotionEvent suppresses the node.motion mirror (no double-apply)', () => {
    const evt: MotionEvent = {
      id: 'm1',
      kind: 'motion',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 60,
      motion: drift,
    };
    // Node carries BOTH the convenience mirror AND a canonical MotionEvent.
    const both = evaluateScene(
      [node('a', 50, 50, drift)],
      SCENE_LOOK_DEFAULT,
      [evt],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    // Reference: the same motion applied exactly ONCE (mirror only).
    const once = evaluateScene(
      [node('a', 50, 50, drift)],
      SCENE_LOOK_DEFAULT,
      [],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    expect(both.nodes[0].placement.x).toBeCloseTo(once.nodes[0].placement.x, 9);
    expect(both.nodes[0].placement.x).not.toBeCloseTo(50, 6); // it moved (once, not zero, not twice)
  });

  it('position is the base, motion folds ON TOP — order in the log does not matter', () => {
    const stat: ObjectStaticEvent = {
      id: 's',
      kind: 'object-static',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 60,
      placement: place(40, 20),
    };
    const evt: MotionEvent = {
      id: 'm',
      kind: 'motion',
      nodeId: 'a',
      pass: 1,
      layer: 1,
      startFrame: 0,
      endFrame: 60,
      motion: drift,
    };
    const dx = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    ).nodes[0].placement.x; // 0 + drift dx at frame 20
    // motion listed BEFORE the position event — must still compose (not be wiped).
    const r = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt, stat],
      20,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    expect(r.nodes[0].placement.x).toBeCloseTo(40 + dx, 9); // base 40 + wobble
    expect(r.nodes[0].placement.y).toBeCloseTo(20, 9); // drift ay=0 → y unchanged from base
  });

  it('blink brightness is seamless at the wrap (frame 0 == frame F)', () => {
    const blink: MotionDescriptor = { type: 'blink', cycles: 2, amp: 1, ax: 0, ay: 0, phase0: 0.6 };
    const at0 = evaluateScene(
      [node('a', 50, 50, blink)],
      SCENE_LOOK_DEFAULT,
      [],
      0,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    const atF = evaluateScene(
      [node('a', 50, 50, blink)],
      SCENE_LOOK_DEFAULT,
      [],
      60,
      60,
      null,
      RNG,
      NO_MUTE,
    );
    expect(atF.nodes[0].look.brightness).toBe(at0.nodes[0].look.brightness);
    expect(at0.nodes[0].look.brightness).toBe(-255); // phase0 0.6 ≥ 0.5 → blinked dark
  });

  it('paint-reveal draws in over frames; base raster never mutated; deterministic', () => {
    const blank = (): CachedAsset => ({
      w: 16,
      h: 16,
      tones: new Uint8Array(16 * 16),
      covered: new Uint8Array(16 * 16),
    });
    const base = blank();
    const cache = new Map<string, CachedAsset>([['paint:1', base]]);
    const stamp = (frame: number, x: number, y: number): DabStamp => ({
      frame,
      x,
      y,
      r: 1,
      shade: 1,
      erase: false,
    });
    const evt: PaintRevealEvent = {
      id: 'pr1',
      kind: 'paint-reveal',
      nodeId: 'n',
      assetId: 'paint:1',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 2,
      stamps: [stamp(0, 3, 3), stamp(1, 9, 3), stamp(2, 3, 9)], // spread so dabs don't overlap
    };
    const coveredAt = (frame: number) => {
      const m = applyPaintReveal(cache, [evt], frame, 60, new Set());
      const a = m.get('paint:1')!;
      return a.covered.reduce((s, c) => s + c, 0);
    };
    const c0 = coveredAt(0);
    const c2 = coveredAt(2);
    expect(c0).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c0); // more stamps revealed by frame 2
    expect(coveredAt(2)).toBe(c2); // deterministic
    // The BASE raster in the cache must be untouched (the stroke is a scratch overlay).
    expect(base.covered.reduce((s, c) => s + c, 0)).toBe(0);
    // A muted layer reveals nothing (returns the base map ref).
    expect(applyPaintReveal(cache, [evt], 2, 60, new Set([0]))).toBe(cache);
    // A live in-progress stroke shows in full regardless of frame.
    const live = { assetId: 'paint:1', stamps: [stamp(99, 12, 12)] };
    const withLive = applyPaintReveal(cache, [], 0, 60, new Set(), live).get('paint:1')!;
    expect(withLive.covered.reduce((s, c) => s + c, 0)).toBeGreaterThan(0);
  });

  it('paint-reveal keeps a Fine raster’s density, so its strokes draw where and as big as drawn', () => {
    const fine: CachedAsset = {
      w: 32,
      h: 32,
      tones: new Uint8Array(32 * 32),
      covered: new Uint8Array(32 * 32),
      per: 2,
    };
    const cache = new Map<string, CachedAsset>([['paint:1', fine]]);
    const evt: PaintRevealEvent = {
      id: 'pr1',
      kind: 'paint-reveal',
      nodeId: 'n',
      assetId: 'paint:1',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 0,
      stamps: [{ frame: 0, x: 8, y: 8, r: 2, shade: 1, erase: false }],
    };
    expect(applyPaintReveal(cache, [evt], 0, 60, new Set()).get('paint:1')!.per).toBe(2);
    const live = { assetId: 'paint:1', stamps: [evt.stamps[0]] };
    expect(applyPaintReveal(cache, [], 0, 60, new Set(), live).get('paint:1')!.per).toBe(2);
  });

  it('audio-react matrixStep COARSENS the dither (8 → none) on a strong beat', () => {
    const features: FeatureArray = [
      { rms: 0, low: 0, mid: 0, high: 0, onset: 0 },
      { rms: 1, low: 0, mid: 0, high: 0, onset: 0 },
      { rms: 0, low: 0, mid: 0, high: 0, onset: 0 },
    ];
    const evt: AudioReactEvent = {
      id: 'ms',
      kind: 'audio-react',
      nodeId: '',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 2,
      band: 'rms',
      target: { kind: 'matrixStep' },
      depth: 1,
    };
    const r = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [evt],
      1,
      3,
      features,
      RNG,
      NO_MUTE,
    );
    expect(SCENE_LOOK_DEFAULT.matrix).toBe(8); // sanity: default is the finest
    expect(r.scene.matrix).toBe('none'); // idx 3 - step 3 → idx 0 (chunkiest)
  });

  it('matrixStep leaves a diffusion pattern alone (it has no coarser step)', () => {
    const features: FeatureArray = [{ rms: 1, low: 0, mid: 0, high: 0, onset: 0 }];
    const evt: AudioReactEvent = {
      id: 'ms',
      kind: 'audio-react',
      nodeId: '',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 1,
      band: 'rms',
      target: { kind: 'matrixStep' },
      depth: 1,
    };
    const scene = { ...SCENE_LOOK_DEFAULT, matrix: 'floyd' as const };
    const r = evaluateScene([node('a', 0, 0)], scene, [evt], 0, 1, features, RNG, NO_MUTE);
    expect(r.scene.matrix).toBe('floyd');
  });
});

// ---------------------------------------------------------------------------
// BLINK-STAMP (the loop-flow pass): a LEFT-button PaintRevealEvent carries
// holdFrames — visible only inside the wrap-aware window [start, end+hold),
// every loop (the flash FOLLOWS the gesture: tap = beat blip; drag = draw-in
// then vanish shortly after the stroke ends).
// ---------------------------------------------------------------------------
describe('blink-stamp — holdFrames visibility window', () => {
  it('persistent events (no holdFrames) are always visible', () => {
    expect(paintWindowVisible(10, 10, undefined, 0, 60)).toBe(true);
    expect(paintWindowVisible(10, 10, undefined, 59, 60)).toBe(true);
  });

  it('tap window [start, end+hold) is in/out at the exact edges', () => {
    expect(paintWindowVisible(10, 10, 4, 9, 60)).toBe(false);
    expect(paintWindowVisible(10, 10, 4, 10, 60)).toBe(true);
    expect(paintWindowVisible(10, 10, 4, 13, 60)).toBe(true);
    expect(paintWindowVisible(10, 10, 4, 14, 60)).toBe(false);
  });

  it('a DRAG flash spans its whole stroke then lingers hold frames', () => {
    // stroke frames 10..20, hold 4 → visible 10..23, hidden at 9 and 24
    expect(paintWindowVisible(10, 20, 4, 9, 60)).toBe(false);
    expect(paintWindowVisible(10, 20, 4, 15, 60)).toBe(true);
    expect(paintWindowVisible(10, 20, 4, 23, 60)).toBe(true);
    expect(paintWindowVisible(10, 20, 4, 24, 60)).toBe(false);
  });

  it('the window wraps the loop end (58+4 @F=60 → 58,59,0,1 visible; 2,57 hidden)', () => {
    expect(paintWindowVisible(58, 58, 4, 58, 60)).toBe(true);
    expect(paintWindowVisible(58, 58, 4, 59, 60)).toBe(true);
    expect(paintWindowVisible(58, 58, 4, 0, 60)).toBe(true);
    expect(paintWindowVisible(58, 58, 4, 1, 60)).toBe(true);
    expect(paintWindowVisible(58, 58, 4, 2, 60)).toBe(false);
    expect(paintWindowVisible(58, 58, 4, 57, 60)).toBe(false);
  });

  it('frame >= frames is the at-rest sentinel: everything shows while stopped', () => {
    expect(paintWindowVisible(10, 10, 4, 60, 60)).toBe(true);
  });

  function blankAsset(): CachedAsset {
    return { w: 16, h: 16, tones: new Uint8Array(16 * 16), covered: new Uint8Array(16 * 16) };
  }
  const dab = (frame: number, x: number, y: number): DabStamp => ({
    frame,
    x,
    y,
    r: 1,
    shade: 1,
    erase: false,
  });
  function reveal(id: string, stamps: DabStamp[], holdFrames?: number): PaintRevealEvent {
    const frames = stamps.map((s) => s.frame);
    return {
      id,
      kind: 'paint-reveal',
      nodeId: 'n',
      assetId: 'paint:1',
      pass: 0,
      layer: 0,
      startFrame: Math.min(...frames),
      endFrame: Math.max(...frames),
      stamps,
      ...(holdFrames != null ? { holdFrames } : {}),
    };
  }

  it('applyPaintReveal: a blink stamp shows in-window, is gone after, and returns next loop', () => {
    const base = blankAsset();
    const cache = new Map<string, CachedAsset>([['paint:1', base]]);
    const evt = reveal('blink', [dab(10, 8, 8)], BLINK_HOLD_FRAMES);
    const coveredAt = (frame: number) =>
      applyPaintReveal(cache, [evt], frame, 60, NO_MUTE)
        .get('paint:1')!
        .covered.reduce((s, c) => s + c, 0);
    expect(coveredAt(9)).toBe(0); // not yet
    expect(coveredAt(10)).toBeGreaterThan(0); // flashes on its beat
    expect(coveredAt(10 + BLINK_HOLD_FRAMES)).toBe(0); // expired (scratch rebuilt from base)
    expect(coveredAt(10)).toBeGreaterThan(0); // deterministic every loop
    expect(coveredAt(60)).toBeGreaterThan(0); // at-rest sentinel shows it
  });

  it('a hidden blink event cannot zero a persistent event on the same asset', () => {
    const base = blankAsset();
    const cache = new Map<string, CachedAsset>([['paint:1', base]]);
    const persistent = reveal('keep', [dab(0, 3, 3)]);
    const blink = reveal('flash', [dab(5, 12, 12)], BLINK_HOLD_FRAMES);
    // Frame 30: blink long expired, persistent still covers.
    const covered = applyPaintReveal(cache, [persistent, blink], 30, 60, NO_MUTE)
      .get('paint:1')!
      .covered.reduce((s, c) => s + c, 0);
    expect(covered).toBeGreaterThan(0);
    // evaluateScene counts ACCUMULATE per asset: persistent's 1 stamp survives the
    // hidden blink (was a Map.set overwrite before the fix).
    const counts = evaluateScene(
      [node('a', 0, 0)],
      SCENE_LOOK_DEFAULT,
      [persistent, blink],
      30,
      60,
      null,
      RNG,
      NO_MUTE,
    ).paintReveal;
    expect(counts.get('paint:1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H-A0 — the SEAMLESS-LOOP GUARANTEE + the new coded-motion set. For every motion
// type, evaluating frames 0..F-1 must have NO spike at the wrap (F-1 → 0). The metric
// is circular-aware: rotation compares mod 360 (spin does whole turns), and marquee is
// a wrap-around scroll that is fully OFF-GLASS at the seam (so its raw teleport is
// invisible) + uniform in toroidal distance. Twinkle/shake are keyed noise → pinned to
// repeat identically every loop instead. Object-paths get the opt-in loop-close blend.
// ---------------------------------------------------------------------------
describe('H-A0 wrap-smoothness — no snap between loops', () => {
  const F = 60;
  const DIMS = { w: 192, h: 128 };
  const NATIVE = { w: 40, h: 30 };
  const LAYOUT = { dims: DIMS, assetDims: () => NATIVE };

  // Shortest angular distance (deg), mod 360 — spin wraps through whole turns.
  const angDiff = (a: number, b: number): number => {
    const d = (((b - a) % 360) + 360) % 360;
    return Math.min(d, 360 - d);
  };
  const stepMag = (a: Placement & { bright: number }, b: Placement & { bright: number }): number =>
    Math.max(
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
      Math.abs(b.scaleX - a.scaleX),
      Math.abs(b.scaleY - a.scaleY),
      angDiff(a.rotationDeg, b.rotationDeg),
      Math.abs(b.bright - a.bright),
    );
  const statesOf = (m: MotionDescriptor) => {
    const base = [node('a', 96, 64, m)];
    const out: (Placement & { bright: number })[] = [];
    for (let f = 0; f < F; f++) {
      const n = evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, RNG, NO_MUTE, LAYOUT)
        .nodes[0];
      out.push({ ...n.placement, bright: n.look.brightness ?? 0 });
    }
    return out;
  };

  // Smooth-periodic (and square-wave / whole-turn) types: the wrap step must not exceed
  // the largest intra-loop step. A real "snap" would be orders of magnitude larger.
  // SPEED rework: `cycles` is the motion speed (integer 1..8) — ANY whole number of
  // cycles must still close seamlessly, so the whole block runs at 1×, 2×, and 3×.
  const PERIODIC: MotionDescriptor[] = [
    { type: 'drift', cycles: 1, amp: 8, ax: 1, ay: 1, phase0: 0 },
    { type: 'bob', cycles: 1, amp: 8, ax: 0, ay: 1, phase0: 0 },
    { type: 'parallax', cycles: 1, amp: 8, ax: 1, ay: 1, phase0: 0 },
    { type: 'blink', cycles: 1, amp: 1, ax: 0, ay: 0, phase0: 0 },
    { type: 'spin', cycles: 1, amp: 2, ax: 1, ay: 1, phase0: 0 },
    { type: 'pendulum', cycles: 1, amp: 20, ax: 1, ay: 1, phase0: 0 },
    { type: 'bounce', cycles: 1, amp: 8, ax: 0, ay: 1, phase0: 0 },
    { type: 'pulse', cycles: 1, amp: 15, ax: 1, ay: 1, phase0: 0 },
  ];
  for (const cyc of [1, 2, 3]) {
    for (const m of PERIODIC) {
      it(`${m.type} @${cyc}×: wrap step ≤ max intra-loop step (no seam spike)`, () => {
        const s = statesOf({ ...m, cycles: cyc });
        let maxIntra = 0;
        for (let i = 0; i < F - 1; i++) maxIntra = Math.max(maxIntra, stepMag(s[i], s[i + 1]));
        const wrap = stepMag(s[F - 1], s[0]);
        expect(maxIntra).toBeGreaterThan(0); // it actually animates
        expect(wrap).toBeLessThanOrEqual(maxIntra * 1.5 + 1e-6);
      });
    }
  }

  it('spin SPEED = cycles (revolutions per loop): 2× does two whole turns', () => {
    const m: MotionDescriptor = { type: 'spin', cycles: 2, amp: 1, ax: 1, ay: 1, phase0: 0 };
    const rotAt = (f: number) =>
      evaluateScene([node('a', 96, 64, m)], SCENE_LOOK_DEFAULT, [], f, 60, null, RNG, NO_MUTE)
        .nodes[0].placement.rotationDeg;
    expect(rotAt(15)).toBeCloseTo(180, 9); // p=0.25 of 720°
    expect(rotAt(30) % 360).toBeCloseTo(0, 9); // one full turn done at the half loop
  });

  it('marquee: fully off-glass at the seam + uniform toroidal scroll (true wrap-around)', () => {
    const m: MotionDescriptor = { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 };
    const base = [node('a', 96, 64, m)];
    const xs: number[] = [];
    for (let f = 0; f < F; f++)
      xs.push(
        evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, RNG, NO_MUTE, LAYOUT).nodes[0]
          .placement.x,
      );
    const half = NATIVE.w / 2; // scale 1 × native width
    const offGlass = (x: number): boolean => x + half <= 0 || x - half >= DIMS.w;
    // The teleport at the wrap is invisible because the element is off-glass at BOTH ends.
    expect(offGlass(xs[0])).toBe(true);
    expect(offGlass(xs[F - 1])).toBe(true);
    // The scroll speed is uniform: the toroidal wrap step equals a normal intra step.
    // Span = (stage + footprint + amp) stretched by F/(F−1) (the last frame lands a
    // full amp/2 past the exit edge — the seam clearance).
    const span = ((DIMS.w + NATIVE.w + m.amp) * F) / (F - 1);
    const tStep = (a: number, b: number): number => {
      const d = Math.abs(b - a) % span;
      return Math.min(d, span - d);
    };
    let maxIntra = 0;
    for (let i = 0; i < F - 1; i++) maxIntra = Math.max(maxIntra, tStep(xs[i], xs[i + 1]));
    expect(tStep(xs[F - 1], xs[0])).toBeLessThanOrEqual(maxIntra * 1.5 + 1e-6);
  });

  it('marquee is ANCHORED to the base placement (owner bug: it sailed bottom-right)', () => {
    // Element based TOP-LEFT with the default horizontal direction: the travel line
    // must pass THROUGH the base — the perpendicular axis NEVER leaves it.
    const m: MotionDescriptor = { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 };
    const base = [node('a', 40, 30, m)];
    const pos: Placement[] = [];
    for (let f = 0; f < F; f++)
      pos.push(
        evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, RNG, NO_MUTE, LAYOUT).nodes[0]
          .placement,
      );
    // Perpendicular axis keeps the base on EVERY frame (horizontal travel → y pinned).
    for (const p of pos) expect(p.y).toBeCloseTo(30, 9);
    // Some frame passes (frame-quantized) through the base x — the anchor.
    const span = ((DIMS.w + NATIVE.w + m.amp) * F) / (F - 1);
    const minDx = Math.min(...pos.map((p) => Math.abs(p.x - 40)));
    expect(minDx).toBeLessThanOrEqual(span / F);
    // And the seam stays fully off-glass from this anchor too.
    const half = NATIVE.w / 2;
    const offGlass = (x: number): boolean => x + half <= 0 || x - half >= DIMS.w;
    expect(offGlass(pos[0].x)).toBe(true);
    expect(offGlass(pos[F - 1].x)).toBe(true);
  });

  it('marquee at a DIAGONAL angle: off-glass seam + the line still passes the base', () => {
    // Direction 45° (the on-glass arrow can set any angle): the span must cover
    // |W·cos| + |H·sin| + footprint so the wrap is invisible diagonally too.
    const c = Math.SQRT1_2; // cos 45° = sin 45°
    const m: MotionDescriptor = { type: 'marquee', cycles: 1, amp: 8, ax: c, ay: c, phase0: 0 };
    const base = [node('a', 40, 30, m)];
    const pos: Placement[] = [];
    for (let f = 0; f < F; f++)
      pos.push(
        evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, RNG, NO_MUTE, LAYOUT).nodes[0]
          .placement,
      );
    const halfW = NATIVE.w / 2;
    const halfH = NATIVE.h / 2;
    const offGlass = (p: Placement): boolean =>
      p.x + halfW <= 0 || p.x - halfW >= DIMS.w || p.y + halfH <= 0 || p.y - halfH >= DIMS.h;
    expect(offGlass(pos[0])).toBe(true);
    expect(offGlass(pos[F - 1])).toBe(true);
    // Every frame sits ON the 45° line through the base (perpendicular offset 0)…
    for (const p of pos) expect((p.x - 40) * -c + (p.y - 30) * c).toBeCloseTo(0, 9);
    // …and some frame passes (frame-quantized) through the base itself.
    const proj = (DIMS.w + NATIVE.w) * c + (DIMS.h + NATIVE.h) * c;
    const span = ((proj + m.amp) * F) / (F - 1);
    const minD = Math.min(...pos.map((p) => Math.hypot(p.x - 40, p.y - 30)));
    expect(minD).toBeLessThanOrEqual(span / F);
    // Uniform toroidal travel along the direction (no seam spike).
    const t = pos.map((p) => (p.x - 40) * c + (p.y - 30) * c);
    const tStep = (a: number, b: number): number => {
      const d = Math.abs(b - a) % span;
      return Math.min(d, span - d);
    };
    let maxIntra = 0;
    for (let i = 0; i < F - 1; i++) maxIntra = Math.max(maxIntra, tStep(t[i], t[i + 1]));
    expect(tStep(t[F - 1], t[0])).toBeLessThanOrEqual(maxIntra * 1.5 + 1e-6);
  });

  it('marquee at 3× SPEED: three traversals, EVERY teleport (interior + wrap) off-glass', () => {
    // cycles = the speed stepper. With span·F/(F−c), the s-grid point nearest below any
    // wrap sits ≥ amp/2 past the exit edge, so all c teleports are invisible.
    const m: MotionDescriptor = { type: 'marquee', cycles: 3, amp: 8, ax: 1, ay: 0, phase0: 0 };
    const base = [node('a', 40, 30, m)];
    const xs: number[] = [];
    for (let f = 0; f < F; f++)
      xs.push(
        evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, RNG, NO_MUTE, LAYOUT).nodes[0]
          .placement.x,
      );
    const half = NATIVE.w / 2;
    const offGlass = (x: number): boolean => x + half <= 0 || x - half >= DIMS.w;
    // Detect the teleports (a jump far larger than the per-frame travel) around the
    // ring INCLUDING the loop wrap — each must land off-glass on BOTH sides.
    let teleports = 0;
    for (let i = 0; i < F; i++) {
      const j = (i + 1) % F;
      if (Math.abs(xs[j] - xs[i]) > DIMS.w / 2) {
        teleports++;
        expect(offGlass(xs[i])).toBe(true);
        expect(offGlass(xs[j])).toBe(true);
      }
    }
    expect(teleports).toBe(3); // 3 traversals per loop = 2 interior + the loop wrap
    // Anchoring still holds at speed: x passes near the base once per traversal
    // (per-frame travel is c·span/F, so "near" = within one frame-step of the base).
    const span = ((DIMS.w + NATIVE.w + m.amp) * F) / (F - 3);
    const near = xs.filter((x) => Math.abs(x - 40) <= (3 * span) / F).length;
    expect(near).toBeGreaterThanOrEqual(3);
  });

  it('bounce is DIRECTIONAL: (ax, ay) is the floor axis, displacement along −direction', () => {
    // Sideways floor (ax:1, ay:0): at the quarter phase |sin| = 1 → dx = −amp, dy = 0.
    const m: MotionDescriptor = { type: 'bounce', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 };
    const at = evaluateScene(
      [node('a', 96, 64, m)],
      SCENE_LOOK_DEFAULT,
      [],
      15,
      60,
      null,
      RNG,
      NO_MUTE,
    ).nodes[0].placement;
    expect(at.x).toBeCloseTo(96 - 8, 9);
    expect(at.y).toBeCloseTo(64, 9);
  });

  it('twinkle/shake are keyed noise: identical every loop (frame k == frame k+F)', () => {
    for (const type of ['twinkle', 'shake'] as const) {
      const m: MotionDescriptor = { type, cycles: 1, amp: 8, ax: 1, ay: 1, phase0: 0 };
      const base = [node('a', 96, 64, m)];
      let moved = false;
      for (const k of [0, 7, 22, 44]) {
        // The live clock evaluates loop-2 frame k at integer frame k again (phase ∈ [0,1)),
        // so "frame k+F" reduces to "frame k" and the keyed PRNG draw is identical.
        const a = evaluateScene(base, SCENE_LOOK_DEFAULT, [], k, 45, null, makeRng(1), NO_MUTE)
          .nodes[0];
        const b = evaluateScene(base, SCENE_LOOK_DEFAULT, [], k, 45, null, makeRng(1), NO_MUTE)
          .nodes[0];
        expect(b.placement).toEqual(a.placement);
        expect(b.look.brightness ?? 0).toBe(a.look.brightness ?? 0);
        if (Math.abs(a.placement.x - 96) > 1e-9 || (a.look.brightness ?? 0) !== 0) moved = true;
      }
      expect(moved).toBe(true); // the noise actually perturbs the node
    }
  });

  it('every new coded motion is deterministic (two full-loop evaluations byte-identical)', () => {
    const cases: MotionDescriptor[] = [
      { type: 'spin', cycles: 1, amp: 2, ax: 1, ay: 1, phase0: 0.2 },
      { type: 'pendulum', cycles: 1, amp: 20, ax: 1, ay: 1, phase0: 0.2 },
      { type: 'bounce', cycles: 1, amp: 8, ax: 0, ay: 1, phase0: 0.2 },
      { type: 'shake', cycles: 1, amp: 8, ax: 1, ay: 1, phase0: 0.2 },
      { type: 'pulse', cycles: 1, amp: 15, ax: 1, ay: 1, phase0: 0.2 },
      { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 1, phase0: 0.2 },
      // SPEED (integer cycles) variants — the new param must pin deterministically too.
      { type: 'drift', cycles: 3, amp: 8, ax: 1, ay: 0, phase0: 0.2 },
      { type: 'spin', cycles: 2, amp: 1, ax: 1, ay: 1, phase0: 0.2 },
      { type: 'marquee', cycles: 2, amp: 8, ax: 1, ay: 0, phase0: 0.2 },
      { type: 'pulse', cycles: 2, amp: 15, ax: 1, ay: 1, phase0: 0.2 },
    ];
    const run = (m: MotionDescriptor) => {
      const base = [node('a', 96, 64, m)];
      const out: Placement[] = [];
      for (let f = 0; f < F; f++)
        out.push({
          ...evaluateScene(base, SCENE_LOOK_DEFAULT, [], f, F, null, makeRng(9), NO_MUTE, LAYOUT)
            .nodes[0].placement,
        });
      return out;
    };
    for (const m of cases) expect(run(m)).toEqual(run(m));
  });

  it('marquee composes with a position event (base holds the perpendicular axis)', () => {
    const m: MotionDescriptor = { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0.3 };
    const stat: ObjectStaticEvent = {
      id: 's',
      kind: 'object-static',
      nodeId: 'a',
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: F,
      placement: place(30, 77),
    };
    const at = evaluateScene(
      [node('a', 0, 0, m)],
      SCENE_LOOK_DEFAULT,
      [stat],
      20,
      F,
      null,
      RNG,
      NO_MUTE,
      LAYOUT,
    ).nodes[0].placement;
    expect(at.y).toBeCloseTo(77, 9); // ay=0 → perpendicular axis keeps the position event's y
    expect(at.x).not.toBeCloseTo(30, 3); // marquee sweeps x across the stage (overrides base x)
  });
});

describe('H-A0 object-path loop-close blend (pathClose toggle)', () => {
  const F = 60;
  // A path that spans the whole loop and ends far from where it started (x 10 → 69).
  const samples: Placement[] = Array.from({ length: F }, (_, i) => place(10 + i, 10, i));
  const evt: ObjectPathEvent = {
    id: 'p',
    kind: 'object-path',
    nodeId: 'a',
    pass: 0,
    layer: 0,
    startFrame: 0,
    endFrame: F,
    samples,
    interp: 'hold',
  };
  const walk = (pathClose: boolean): Placement[] => {
    const base = [node('a', 0, 0)];
    const out: Placement[] = [];
    for (let f = 0; f < F; f++)
      out.push(
        evaluateScene(base, SCENE_LOOK_DEFAULT, [evt], f, F, null, RNG, NO_MUTE, { pathClose })
          .nodes[0].placement,
      );
    return out;
  };
  const dist = (a: Placement, b: Placement): number => Math.hypot(b.x - a.x, b.y - a.y);

  it('OFF (default): the recorded end holds → a big wrap teleport', () => {
    const s = walk(false);
    expect(s[F - 1]).toEqual(samples[F - 1]); // exact recorded sample, no blend
    expect(dist(s[F - 1], s[0])).toBeGreaterThan(50); // ~59-cell teleport at the wrap
  });

  it('ON: eased back to the first sample → wrap step ≤ max intra step, samples untouched', () => {
    const s = walk(true);
    let maxIntra = 0;
    for (let i = 0; i < F - 1; i++) maxIntra = Math.max(maxIntra, dist(s[i], s[i + 1]));
    expect(dist(s[F - 1], s[0])).toBeLessThanOrEqual(maxIntra + 1e-6);
    // Non-destructive: the recorded event samples are never rewritten (mute/undo intact).
    expect(samples[F - 1]).toEqual(place(10 + F - 1, 10, F - 1));
    // The blend only touches the final ~0.5s (min(15, ceil(F·0.1)) = 6 frames): earlier
    // frames are the raw path.
    expect(s[0]).toEqual(samples[0]);
    expect(s[F - 7]).toEqual(samples[F - 7]);
  });
});

// MOVE reactions — the art itself moves to the music, per layer or the
// whole canvas together. Pure (evaluateScene), so the export moves exactly like playback.
describe('move reactions (Pulse · Bounce · Shake · Flash · Dots)', () => {
  const loud: FeatureArray = [{ rms: 1, low: 1, mid: 1, high: 1, onset: 1 }];
  const quiet: FeatureArray = [{ rms: 0, low: 0, mid: 0, high: 0, onset: 0 }];
  const react = (target: AudioReactEvent['target'], nodeId = 'a'): AudioReactEvent => ({
    id: `mv-${target.kind}-${nodeId}`,
    kind: 'audio-react',
    nodeId,
    pass: 0,
    layer: 0,
    startFrame: 0,
    endFrame: 10,
    band: 'low',
    target,
    depth: 1,
  });
  const dims = { w: 100, h: 80 };
  const run = (evts: AudioReactEvent[], feats: FeatureArray, nodes = [node('a', 20, 30)]) =>
    evaluateScene(nodes, SCENE_LOOK_DEFAULT, evts, 0, 60, feats, RNG, NO_MUTE, { dims });

  it('Pulse swells the layer; silence leaves it alone', () => {
    const a = run([react({ kind: 'pulse' })], loud).nodes[0].placement;
    expect(a.scaleX).toBeCloseTo(1.3);
    expect([a.x, a.y]).toEqual([20, 30]); // its own centre
    expect(run([react({ kind: 'pulse' })], quiet).nodes[0].placement).toEqual(place(20, 30));
  });

  it('Bounce lifts it; Shake jitters it the same way every time (deterministic)', () => {
    expect(run([react({ kind: 'bounce' })], loud).nodes[0].placement.y).toBeCloseTo(20);
    const s1 = run([react({ kind: 'shake' })], loud).nodes[0].placement;
    const s2 = run([react({ kind: 'shake' })], loud).nodes[0].placement;
    expect(s1).toEqual(s2);
    expect(Math.hypot(s1.x - 20, s1.y - 30)).toBeGreaterThan(0);
    expect(Math.abs(s1.x - 20)).toBeLessThanOrEqual(4);
  });

  it('Flash brightens on the hit; Dots swell the halftone dots', () => {
    const f = run([react({ kind: 'flash' })], loud).nodes[0].look;
    expect(f.brightness).toBeGreaterThan(SCENE_LOOK_DEFAULT.brightness);
    const d = run([react({ kind: 'dotSize' })], loud).nodes[0].look;
    expect(d.dotSize).toBe(SCENE_LOOK_DEFAULT.dotSize + 8);
  });

  it('the whole canvas pulses TOGETHER, about the canvas centre (layers spread with it)', () => {
    const nodes = [node('a', 20, 30), node('b', 80, 50)];
    const r = run([react({ kind: 'pulse' }, '')], loud, nodes).nodes;
    // Centre (50,40): a moves out to (50 + (20−50)·1.3, 40 + (30−40)·1.3).
    expect(r[0].placement.x).toBeCloseTo(11);
    expect(r[0].placement.y).toBeCloseTo(27);
    expect(r[1].placement.x).toBeCloseTo(89);
    expect(r[0].placement.scaleX).toBeCloseTo(1.3);
    expect(r[1].placement.scaleX).toBeCloseTo(1.3);
  });
});
