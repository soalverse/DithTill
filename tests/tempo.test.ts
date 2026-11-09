// =============================================================================
// Tempo (Group J1, FL Studio style): the beat clock (song time vs exact loop bars),
// bars → frames, beat lengths, tap tempo, the beat grid, tempo-synced motion, and
// detecting a song's tempo + bar 1 from synthesised beats with known answers.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  BPM_DEFAULT,
  barsToFrames,
  beatAt,
  beatFrames,
  beatLengthLabel,
  beatSpanLoops,
  tapTempo,
  type BeatClock,
} from '../src/core/tempo';
import { detectTempo } from '../src/core/tempo-detect';
import { evaluateScene, motionPeriodFrames } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import {
  SCENE_LOOK_DEFAULT,
  type MotionDescriptor,
  type SceneNode,
} from '../src/state/scene-store';
import { LOOP_META_DEFAULT, useLoopStore } from '../src/state/loop-store';

const clock = (patch: Partial<BeatClock> = {}): BeatClock => ({
  bpm: 130,
  fps: 30,
  offsetSec: 0,
  frames: barsToFrames(4, 130, 30),
  loopBeats: 16,
  song: false,
  ...patch,
});

describe('tempo basics', () => {
  it('a new loop is 1 bar at 130 BPM (FL Studio defaults)', () => {
    expect(BPM_DEFAULT).toBe(130);
    expect(LOOP_META_DEFAULT).toMatchObject({ bpm: 130, bars: 1, lengthMode: 'bars' });
    expect(LOOP_META_DEFAULT.frames).toBe(55); // 1 bar = 55.38 frames at 30 fps
  });

  it('bars → whole frames; the loop length follows the tempo in bars mode', () => {
    expect(barsToFrames(4, 120, 30)).toBe(240);
    expect(barsToFrames(4, 130, 30)).toBe(222); // 221.5 → 222
    useLoopStore.setState({ meta: { ...LOOP_META_DEFAULT } });
    useLoopStore.getState().setLength({ bars: 4 });
    expect(useLoopStore.getState().meta.frames).toBe(222);
    useLoopStore.getState().setLength({ bpm: 120 });
    expect(useLoopStore.getState().meta.frames).toBe(240);
    // A bare frame count (a song length) makes the loop fixed.
    useLoopStore.getState().setLength({ frames: 300 });
    expect(useLoopStore.getState().meta).toMatchObject({ frames: 300, lengthMode: 'fixed' });
    useLoopStore.setState({ meta: { ...LOOP_META_DEFAULT } });
  });

  it('labels beat lengths the way FL shows tempo sync', () => {
    expect([0.25, 0.5, 1, 2, 4, 8, 32].map(beatLengthLabel)).toEqual([
      '¼ beat',
      '½ beat',
      '1 beat',
      '2 beats',
      '1 bar',
      '2 bars',
      '8 bars',
    ]);
  });

  it('tap tempo averages the taps and starts over after a pause', () => {
    expect(tapTempo([0])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 400, 5000, 5500, 6000])).toBe(120); // the 4.6 s gap restarts
  });

  it('the beat grid: whole-frame beats from bar 1 on', () => {
    const g = beatFrames(120, 30, 0.5, 60);
    expect(g.map((b) => b.frame)).toEqual([0, 15, 30, 45, 60]);
    expect(g.map((b) => b.beat)).toEqual([-1, 0, 1, 2, 3]);
  });
});

describe('the beat clock', () => {
  it('without a song each loop holds exactly its bars (closes perfectly)', () => {
    const c = clock();
    expect(beatAt(c, 0)).toBe(0);
    expect(beatAt(c, c.frames)).toBe(16);
    expect(beatAt(c, 3 * c.frames)).toBe(48);
  });

  it('with a song it follows the song time (no drift over many loops)', () => {
    const c = clock({ song: true, offsetSec: 0.5 });
    // 3 minutes in: exactly 130·3 beats after bar 1 (minus the half-second offset).
    expect(beatAt(c, 180 * 30)).toBeCloseTo((180 - 0.5) * (130 / 60), 9);
  });

  it('a cycle longer than the loop spans whole loops', () => {
    expect(beatSpanLoops(clock(), 4)).toBe(1);
    expect(beatSpanLoops(clock(), 32)).toBe(2);
  });
});

describe('tempo-synced motion', () => {
  const node = (m: MotionDescriptor): SceneNode => ({
    id: 'a',
    assetId: 'asset-a',
    kind: 'asset',
    z: 1,
    placement: { x: 96, y: 64, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: m,
    opacity: 100,
  });
  const spin = (beats: number): MotionDescriptor => ({
    type: 'spin',
    cycles: 1,
    beats,
    amp: 1,
    ax: 1,
    ay: 1,
    phase0: 0,
  });
  const rot = (m: MotionDescriptor, abs: number, c: BeatClock) =>
    evaluateScene(
      [node(m)],
      SCENE_LOOK_DEFAULT,
      [],
      abs % c.frames,
      c.frames,
      null,
      makeRng(1),
      new Set(),
      { absFrame: abs, beat: c },
    ).nodes[0].placement.rotationDeg;

  it('"1 bar" spins once per bar and closes at the loop wrap (no song)', () => {
    const c = clock(); // a 4-bar loop
    const quarter = c.frames / 16; // one beat
    expect(rot(spin(4), 0, c)).toBeCloseTo(0, 9);
    expect(rot(spin(4), quarter * 2, c)).toBeCloseTo(180, 6); // half a bar
    expect(rot(spin(4), c.frames, c) % 360).toBeCloseTo(0, 6); // seamless
  });

  it('with a song it lands on the song beats wherever you are in it', () => {
    const c = clock({ song: true, offsetSec: 0 });
    const fpb = (30 * 60) / 130;
    const r = rot(spin(4), Math.round(fpb * 400), c) % 360; // bar 101
    expect(Math.min(r, 360 - r)).toBeLessThan(5); // bar 101
  });

  it('cycles longer than the loop stretch the loop period to fit them', () => {
    const c = clock();
    expect(motionPeriodFrames(c.frames, [node(spin(32))], [], c)).toBe(2 * c.frames);
    expect(motionPeriodFrames(c.frames, [node(spin(4))], [], c)).toBe(c.frames);
  });
});

/** A synthetic song: a kick on every bar's first beat, a click on every beat. */
function song(bpm: number, firstBarSec: number, seconds: number, rate = 48000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const beatSec = 60 / bpm;
  for (let k = 0; ; k++) {
    const t = firstBarSec + k * beatSec;
    if (t >= seconds) break;
    const i0 = Math.round(t * rate);
    const kick = k % 4 === 0;
    for (let j = 0; j < rate * 0.12 && i0 + j < out.length; j++) {
      const tt = j / rate;
      const env = Math.exp(-tt * (kick ? 25 : 60));
      const v = kick
        ? 0.9 * Math.sin(2 * Math.PI * 55 * tt) * env
        : 0.4 * Math.sin(2 * Math.PI * 3000 * tt) * env;
      out[i0 + j] += v;
    }
  }
  return out;
}

describe('detect tempo (FL "Detect tempo")', () => {
  it('finds 128 BPM and bar 1', () => {
    const est = detectTempo(song(128, 0.3, 40), null, 48000)!;
    expect(est.bpm).toBeCloseTo(128, 1);
    const bar = (4 * 60) / 128;
    const err = Math.abs(((est.offsetSec - 0.3 + bar / 2) % bar) - bar / 2);
    expect(err).toBeLessThan(0.02);
  }, 30_000);

  it('finds a tempo that is not a whole number (97.5 BPM)', () => {
    const est = detectTempo(song(97.5, 1.1, 60), null, 48000)!;
    expect(Math.abs(est.bpm - 97.5)).toBeLessThan(0.05);
    const bar = (4 * 60) / 97.5;
    const want = 1.1 % bar;
    const err = Math.abs(((est.offsetSec - want + bar / 2) % bar) - bar / 2);
    expect(err).toBeLessThan(0.02);
  }, 30_000);

  it('gives up on too-short or silent audio', () => {
    expect(detectTempo(new Float32Array(48000), null, 48000)).toBeNull();
    expect(detectTempo(new Float32Array(48000 * 10), null, 48000)).toBeNull();
  });
});
