// =============================================================================
// Modulators (J2, FL Studio's way): a slider moves on
// its own between two values, FROM → TO — on the beat (FL's LFO: a shape + a speed in
// beats) or with the sound (FL's Peak Controller: quiet = FROM, loud = TO), always inside
// the slider's range. Pinned here: the shapes, the clamping, the beat clock
// (seamless loops, long waves stretch the clock, Random repeats), every slider kind, the
// export's own frame walk == a still render at the moved value (preview == export), the
// fast-path rule, and one undo step per change.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  MOD_SHAPES,
  hasSoundMod,
  moveRange,
  modSpan,
  modulate,
  waveShape,
  type ModContext,
  type ModMap,
  type Modulator,
} from '../src/core/modulators';
import { evaluateScene, motionPeriodFrames } from '../src/core/loop-events';
import { applyModRasters, renderLoopFrameGrid } from '../src/core/loop-render';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { fastPathEligible } from '../src/core/loop-export-plan';
import { renderTextRaster, TEXT_DEFAULT } from '../src/core/dot-font';
import { makeRng } from '../src/core/seeded-rng';
import type { BeatClock } from '../src/core/tempo';
import { ZERO_FEATURE, type FeatureArray } from '../src/core/audio-features';
import { SCENE_LOOK_DEFAULT, useSceneStore, type SceneNode } from '../src/state/scene-store';
import { beginGesture, endGesture } from '../src/state/gesture';

const F = 60; // 1 bar at 120 BPM, 30 fps
const CLOCK: BeatClock = { bpm: 120, fps: 30, offsetSec: 0, frames: F, loopBeats: 4, song: false };
const RNG = makeRng(7);
const NO_MUTE: ReadonlySet<number> = new Set();
const wave = (patch: Partial<Extract<Modulator, { kind: 'wave' }>> = {}): Modulator => ({
  kind: 'wave',
  shape: 'smooth',
  beats: 4,
  from: 30,
  to: 70,
  ...patch,
});

function node(patch: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'n1',
    assetId: 'a1',
    kind: 'asset',
    z: 1,
    placement: { x: 20, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: null,
    opacity: 50,
    ...patch,
  };
}

/** The evaluated frame at absolute frame `abs` (loop frame abs mod F). */
function evalAt(
  nodes: SceneNode[],
  abs: number,
  extra: { canvasMods?: ModMap } = {},
  features: FeatureArray | null = null,
) {
  return evaluateScene(nodes, SCENE_LOOK_DEFAULT, [], abs % F, F, features, RNG, NO_MUTE, {
    absFrame: abs,
    beat: CLOCK,
    dotDensity: 8,
    ...extra,
  });
}

describe('wave shapes', () => {
  it('each shape at the quarter points, 0 = FROM … 1 = TO (Smooth + Zigzag start at FROM)', () => {
    const at = (s: (typeof MOD_SHAPES)[number]) =>
      [0, 0.25, 0.5, 0.75].map((u) => waveShape(s, u, 'k', 0));
    const r = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000 + 0);
    expect(r(at('smooth'))).toEqual([0, 0.5, 1, 0.5]);
    expect(r(at('zigzag'))).toEqual([0, 0.5, 1, 0.5]);
    expect(r(at('rampUp'))).toEqual([0, 0.25, 0.5, 0.75]);
    expect(r(at('rampDown'))).toEqual([1, 0.75, 0.5, 0.25]);
    expect(r(at('onoff'))).toEqual([1, 1, 0, 0]);
  });
  it('Random holds one value per cycle, the same every time, different between cycles', () => {
    const a = waveShape('random', 0.1, 'k', 3);
    expect(waveShape('random', 0.9, 'k', 3)).toBe(a);
    expect(waveShape('random', 0.1, 'k', 4)).not.toBe(a);
    expect(waveShape('random', 0.1, 'other', 3)).not.toBe(a);
    for (let c = 0; c < 50; c++) {
      const v = waveShape('random', 0, 'k', c);
      expect(v >= 0 && v <= 1).toBe(true);
    }
  });
});

describe('the moved value stays inside the slider', () => {
  const ctx = (abs: number, features: FeatureArray | null = null): ModContext => ({
    absFrame: abs,
    frames: F,
    beat: CLOCK,
    features,
  });
  it('a beat move travels FROM → TO and back; clamped; whole numbers rounded', () => {
    // Smooth, 1 bar (60 frames): FROM at the bar line, TO halfway, back at the next bar.
    expect(modulate('opacity', 50, wave(), 'k', ctx(0))).toBe(30);
    expect(modulate('opacity', 50, wave(), 'k', ctx(15))).toBe(50);
    expect(modulate('opacity', 50, wave(), 'k', ctx(30))).toBe(70);
    expect(modulate('opacity', 50, wave({ from: 100, to: 40 }), 'k', ctx(30))).toBe(40);
    expect(modulate('opacity', 50, wave({ to: 400 }), 'k', ctx(30))).toBe(100); // clamped
    const ds = modulate('dotSize', 7, wave({ from: 3, to: 9 }), 'k', ctx(10));
    expect(Number.isInteger(ds)).toBe(true);
    const c = modulate('photo.contrast', 1, wave({ from: 1, to: 2 }), 'k', ctx(15)); // continuous
    expect(c).toBeCloseTo(1.5, 9);
    // A move without two values (the first cut's format) starts at the slider: 50 → 90.
    const old = { ...wave(), from: undefined, to: undefined } as unknown as Modulator;
    expect(modulate('opacity', 50, old, 'k', ctx(0))).toBe(50);
    expect(modulate('opacity', 50, old, 'k', ctx(30))).toBe(90);
    expect(modulate('opacity', 100, old, 'k', ctx(30))).toBe(60); // from the top it heads down
  });
  it('a sound move sits at FROM when quiet, reaches TO when loud, rests without sound', () => {
    const loud: FeatureArray = Array.from({ length: F }, () => ({ ...ZERO_FEATURE, low: 1 }));
    const sound: Modulator = { kind: 'sound', band: 'low', from: 40, to: 100, smooth: 0 };
    expect(modulate('opacity', 50, sound, 'k', ctx(5, loud))).toBe(100);
    expect(modulate('opacity', 50, { ...sound, from: 100, to: 20 }, 'k', ctx(5, loud))).toBe(20);
    expect(modulate('opacity', 50, sound, 'k', ctx(5, null))).toBe(40);
    expect(modulate('opacity', 50, { ...sound, band: 'high' }, 'k', ctx(5, loud))).toBe(40);
  });
  it('a new move starts where the slider sits and heads up — or down when it is at the top', () => {
    expect(moveRange('opacity', 50)).toEqual({ from: 50, to: 90 });
    // At the top it heads down (why "Follow sound did nothing" on a 100% Opacity).
    expect(moveRange('opacity', 100)).toEqual({ from: 100, to: 60 });
    expect(moveRange('photo.contrast', 1)).toEqual({ from: 1, to: 1.8 });
  });
});

describe('on the beat clock', () => {
  const op = (mods: ModMap, abs: number) => evalAt([node({ mods })], abs).nodes[0].opacity;
  it('a 1-bar Wave on a 1-bar loop closes at the wrap (seamless)', () => {
    const mods = { opacity: wave() };
    expect(op(mods, F)).toBe(op(mods, 0));
    expect(op(mods, 15)).not.toBe(op(mods, 0));
  });
  it('a 2-bar Wave spans two loops: the clock stretches, and it closes after both', () => {
    const mods = { opacity: wave({ beats: 8 }) };
    expect(modSpan([mods], CLOCK)).toBe(2);
    expect(motionPeriodFrames(F, [node({ mods })], [], CLOCK)).toBe(2 * F);
    expect(motionPeriodFrames(F, [node()], [], CLOCK, { density: wave({ beats: 16 }) })).toBe(
      4 * F,
    );
    expect(op(mods, 2 * F)).toBe(op(mods, 0));
    expect(op(mods, F + 15)).not.toBe(op(mods, 15)); // the second loop is the other half
  });
  it('Random repeats with the (stretched) loop, so the live clock and the export agree', () => {
    const mods = { opacity: wave({ shape: 'random', beats: 1 }) };
    for (const f of [0, 14, 31, 59]) expect(op(mods, f + F)).toBe(op(mods, f));
    const vals = new Set([0, 15, 30, 45].map((f) => op(mods, f)));
    expect(vals.size).toBeGreaterThan(1);
  });
  it('a song sets the time: a Wave follows the song, no wrap', () => {
    const song = { ...CLOCK, song: true };
    const at = (abs: number) =>
      evaluateScene(
        [node({ mods: { opacity: wave({ beats: 8 }) } })],
        SCENE_LOOK_DEFAULT,
        [],
        abs % F,
        F,
        null,
        RNG,
        NO_MUTE,
        {
          absFrame: abs,
          beat: song,
        },
      ).nodes[0].opacity;
    expect(at(30)).toBe(50); // a quarter of 2 bars in (halfway up)
    expect(at(60)).toBe(70); // halfway through: TO
    expect(at(120)).toBe(30); // back at FROM after 2 bars of song
  });
});

describe('every slider kind', () => {
  it("opacity, photo dials, text, visualizer and a jitter motion's Intensity move; others untouched", () => {
    const w = (from: number, to: number) => wave({ from, to });
    const all: ModMap = {
      opacity: w(50, 70),
      'photo.contrast': w(1, 1.4),
      'photo.gamma': w(1, 1.42),
      'photo.black': w(0, 24),
      'photo.white': w(255, 300),
      'text.size': w(3, 5),
      'text.spacing': w(1, 2),
      'viz.gain': w(0.5, 0.7),
      'viz.smooth': w(0.3, 0.1),
      'viz.amount': w(0.5, 0.9),
      'motion.amp': w(10, 16),
    };
    const base = node({
      mods: all,
      image: {
        contrast: 1,
        gamma: 1,
        black: 0,
        white: 255,
        invert: false,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
        matte: null,
      },
      text: { ...TEXT_DEFAULT },
      viz: { style: 'bars', band: 'low', gain: 0.5, smooth: 0.3 },
      motion: { type: 'shake', cycles: 1, amp: 10, ax: 1, ay: 1, phase0: 0 },
    });
    const ev = evalAt([base], 30); // halfway through the bar: every move is at TO
    const n = ev.nodes[0];
    expect(n.opacity).toBe(70);
    expect(n.image).toMatchObject({ contrast: 1.4, black: 24, white: 255, invert: false, zoom: 1 });
    expect(n.image!.gamma).toBeCloseTo(1.42, 9);
    expect(n.text).toMatchObject({ size: 5, spacing: 2, text: TEXT_DEFAULT.text });
    expect(n.viz).toMatchObject({ style: 'bars', amount: 0.9 });
    expect(n.viz!.gain).toBeCloseTo(0.7, 9);
    expect(n.viz!.smooth).toBeCloseTo(0.1, 9);
    expect(ev.modValues.get('n1|motion.amp')).toBe(16);
    expect(ev.modValues.size).toBe(11);
    // The store's node is never touched.
    expect(base.opacity).toBe(50);
    expect(base.text!.size).toBe(TEXT_DEFAULT.size);
  });
  it('a spin keeps its Intensity mod idle (only the jitter motions have one)', () => {
    const n = node({
      mods: { 'motion.amp': wave() },
      motion: { type: 'spin', cycles: 1, amp: 10, ax: 1, ay: 1, phase0: 0 },
    });
    expect(evalAt([n], 15).modValues.size).toBe(0);
  });
  it('the canvas: Dot size moves the scene look, Density comes back for the dot screen', () => {
    const ev = evalAt([node()], 30, {
      canvasMods: { dotSize: wave({ from: 4, to: 12 }), density: wave({ from: 8, to: 14 }) },
    });
    expect(ev.scene.dotSize).toBe(12);
    expect(ev.dotDensity).toBe(14);
    expect(evalAt([node()], 30).dotDensity).toBeUndefined();
  });
});

describe('preview == export', () => {
  it('the export frame walk of a moving text Size == a still render at that Size', () => {
    const text = { ...TEXT_DEFAULT, text: 'HI', size: 2 };
    const n = node({
      id: 't',
      assetId: 'text:1',
      kind: 'text',
      opacity: 100,
      text,
      mods: { 'text.size': wave({ from: 1, to: 6 }) },
    });
    const assets = new Map<string, CachedAsset>([['text:1', renderTextRaster(text)]]);
    const dims = { w: 48, h: 40 };
    for (const f of [0, 9, 15, 37]) {
      const ev = evalAt([n], f);
      const size = ev.nodes[0].text!.size;
      const still = resolveSceneGrid({
        nodes: [{ ...n, mods: undefined, assetId: 'still', text: { ...text, size } }],
        scene: SCENE_LOOK_DEFAULT,
        dims,
        assets: new Map([['still', renderTextRaster({ ...text, size })]]),
      });
      const exported = renderLoopFrameGrid(
        {
          nodes: [n],
          scene: SCENE_LOOK_DEFAULT,
          events: [],
          frames: F,
          seed: 7,
          dims,
          assets,
          mutedLayers: NO_MUTE,
          features: null,
          beat: CLOCK,
        },
        f,
      );
      expect(exported.covered).toEqual(still.covered);
      expect(exported.idx).toEqual(still.idx);
    }
  });
  it('a moved photo dial asks the SAME re-treatment the live canvas uses, under its own id', () => {
    const seen: number[] = [];
    const r: CachedAsset = { w: 1, h: 1, tones: new Uint8Array([9]), covered: new Uint8Array([1]) };
    const ph = node({
      kind: 'image',
      image: {
        contrast: 1.4,
        gamma: 1,
        black: 0,
        white: 255,
        invert: false,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
        matte: null,
      },
      mods: { 'photo.contrast': wave() },
    });
    const out = applyModRasters(
      [ph, node({ id: 'n2' })],
      new Map(),
      (x) => (seen.push(x.image!.contrast), r),
    );
    expect(seen).toEqual([1.4]);
    expect(out.nodes[0].assetId).toBe('a1#n1');
    expect(out.assets.get('a1#n1')).toBe(r);
    expect(out.nodes[1].assetId).toBe('a1'); // an unmodulated layer keeps its cached raster
  });
});

describe('the long-export shortcut steps aside', () => {
  const base = { totalFrames: 4 * F, frames: F, events: [], videoFrameCounts: [], beat: CLOCK };
  it('for Follow sound with a song, a long Wave, or a Wave on a song beat', () => {
    const feats: FeatureArray = Array.from({ length: 4 * F }, () => ({ ...ZERO_FEATURE }));
    const sound: ModMap = { opacity: { kind: 'sound', band: 'low', from: 40, to: 100, smooth: 0 } };
    expect(hasSoundMod([sound])).toBe(true);
    expect(fastPathEligible({ ...base, nodes: [node({ mods: sound })], features: feats })).toBe(
      false,
    );
    expect(fastPathEligible({ ...base, nodes: [node()], features: feats, canvasMods: sound })).toBe(
      false,
    );
    expect(
      fastPathEligible({
        ...base,
        nodes: [node({ mods: { opacity: wave({ beats: 8 }) } })],
        features: null,
      }),
    ).toBe(false);
    expect(
      fastPathEligible({
        ...base,
        nodes: [node({ mods: { opacity: wave() } })],
        features: null,
        beat: { ...CLOCK, song: true },
      }),
    ).toBe(false);
    // A 1-bar Wave on a 1-bar loop repeats every loop — the shortcut still applies.
    expect(
      fastPathEligible({ ...base, nodes: [node({ mods: { opacity: wave() } })], features: null }),
    ).toBe(true);
  });
});

describe('one undo per change', () => {
  it("setMod adds, edits (a drag is one step) and removes; the canvas's undo too", () => {
    const st = useSceneStore.getState();
    st.clear();
    st.addNodes([{ assetId: 'x', w: 4, h: 4, cx: 10, cy: 10 }]);
    const id = useSceneStore.getState().nodes[0].id;
    const mods = () => useSceneStore.getState().nodes[0].mods;
    const t = useSceneStore.temporal.getState();

    st.setMod(id, 'opacity', wave());
    expect(mods()).toEqual({ opacity: wave() });
    beginGesture();
    for (const to of [80, 90, 100]) useSceneStore.getState().setMod(id, 'opacity', wave({ to }));
    endGesture();
    expect(mods()?.opacity).toMatchObject({ to: 100 });
    useSceneStore.temporal.getState().undo();
    expect(mods()?.opacity).toMatchObject({ to: 70 });

    useSceneStore.getState().setMod(id, 'opacity', null);
    expect('mods' in useSceneStore.getState().nodes[0]).toBe(false); // no empty leftovers
    t.undo();
    expect(mods()?.opacity).toBeTruthy();

    useSceneStore.getState().setMod('', 'density', wave());
    expect(useSceneStore.getState().canvasMods).toEqual({ density: wave() });
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().canvasMods).toEqual({});
  });
});
