// The ported FilmCraft edit algebra. The first cases mirror FilmCraft's own
// `crates/edit/src/tests.rs` (same numbers, so the port is held to the original's behaviour);
// the last runs random edit sequences like their `never_overlaps` property test.
import { describe, expect, it } from 'vitest';
import {
  checkClips,
  clipAt,
  deleteClip,
  duplicateClip,
  mediaFrameAt,
  moveClip,
  rateStretch,
  roll,
  setFades,
  setSpeed,
  fadeGainAt,
  sourceOut,
  slide,
  slip,
  snapFrame,
  splitAt,
  trim,
  type TimelineClip,
} from '../src/core/timeline-edit';
import { makeRng } from '../src/core/seeded-rng';

const c = (id: string, start: number, duration: number, sourceIn = 0): TimelineClip => ({
  id,
  start,
  duration,
  sourceIn,
});
const spans = (clips: TimelineClip[]) => clips.map((x) => [x.start, x.duration]);
const MEDIA = 1000;

describe('FilmCraft cases', () => {
  it('razor keeps content continuous', () => {
    const clips = [c('a', 10, 100, 200)];
    const before = mediaFrameAt(clips, 70);
    const r = splitAt(clips, 50, 'b')!;
    expect(spans(r.clips)).toEqual([
      [10, 40],
      [50, 60],
    ]);
    expect(mediaFrameAt(r.clips, 70)).toBe(before);
    expect(checkClips(r.clips, MEDIA)).toBeNull();
  });

  it('regular trim respects neighbours and handles', () => {
    let clips = [c('a', 0, 10, 5), c('n', 12, 10, 0)];
    // out: only 2 frames of space before the neighbour
    let r = trim(clips, 'a', 'out', 5, MEDIA);
    expect(r.applied).toBe(2);
    clips = r.clips;
    // in: 5 frames of head handle, but the clip starts at 0 so no space to the left
    r = trim(clips, 'a', 'in', -3, MEDIA);
    expect(r.applied).toBe(0);
    r = trim(clips, 'a', 'in', 3, MEDIA);
    expect(r.applied).toBe(3);
    expect(r.clips.find((x) => x.id === 'a')!.sourceIn).toBe(8);
    expect(checkClips(r.clips, MEDIA)).toBeNull();
  });

  it('roll, slip, slide', () => {
    let clips = [c('a', 0, 10, 10), c('b', 10, 10, 10), c('c', 20, 10, 10)];
    let r = roll(clips, 'a', 'b', 3, MEDIA);
    clips = r.clips;
    expect(spans(clips)).toEqual([
      [0, 13],
      [13, 7],
      [20, 10],
    ]);
    expect(clips.find((x) => x.id === 'b')!.sourceIn).toBe(13);
    r = slip(clips, 'c', -50, MEDIA);
    expect(r.applied).toBe(-10); // slip clamps at media start
    clips = r.clips;
    clips = slide(clips, 'b', 2, MEDIA).clips;
    expect(spans(clips)).toEqual([
      [0, 15],
      [15, 7],
      [22, 8],
    ]);
    expect(checkClips(clips, MEDIA)).toBeNull();
  });
});

describe('DithTill-specific edits', () => {
  it('a still has unlimited head and tail; trims only stop at neighbours and the timeline', () => {
    const clips = [c('s', 10, 20)];
    expect(trim(clips, 's', 'in', -50, null).applied).toBe(-10); // frame 0
    expect(trim(clips, 's', 'out', 500, null, 60).applied).toBe(30); // the timeline end
    expect(slip(clips, 's', 5, null).applied).toBe(0); // nothing to slip
  });

  it('a video can be dragged past its media — the footage repeats — but never starts before it', () => {
    const clips = [c('v', 0, 30, 0)];
    const r = trim(clips, 'v', 'out', 100, 40);
    expect(r.applied).toBe(100);
    expect(checkClips(r.clips, 40)).toBeNull();
    // The in-edge still stops at the footage start (sourceIn 0).
    expect(trim(clips, 'v', 'in', -5, 40).applied).toBe(0);
  });

  it('move stops at neighbours, never overwrites', () => {
    const clips = [c('a', 0, 10), c('b', 30, 10)];
    let r = moveClip(clips, 'a', 25, 100);
    expect(r.start).toBe(20); // b starts at 30
    r = moveClip(clips, 'b', 2, 100);
    expect(r.start).toBe(10); // a ends at 10
    expect(checkClips(r.clips, null)).toBeNull();
  });

  it('delete leaves a gap; duplicate goes into the gap after, or refuses', () => {
    const clips = [c('a', 0, 10), c('b', 15, 10)];
    expect(spans(deleteClip(clips, 'a'))).toEqual([[15, 10]]);
    expect(duplicateClip(clips, 'a', 'x', 100)).toBeNull(); // only 5 free, needs 10
    const dup = duplicateClip(clips, 'b', 'x', 100)!;
    expect(spans(dup)).toEqual([
      [0, 10],
      [15, 10],
      [25, 10],
    ]);
  });

  it('snaps to the nearest target within the threshold', () => {
    expect(snapFrame(31, [0, 30, 60], 3)).toBe(30);
    expect(snapFrame(35, [0, 30, 60], 3)).toBe(35);
  });

  it('clipAt / mediaFrameAt report gaps as nothing', () => {
    const clips = [c('a', 0, 10, 100), c('b', 20, 10, 0)];
    expect(clipAt(clips, 15)).toBeUndefined();
    expect(mediaFrameAt(clips, 15)).toBeNull();
    expect(mediaFrameAt(clips, 5)).toBe(105);
  });
});

describe('never overlaps (random edit sequences)', () => {
  it('every edit keeps the track valid', () => {
    const seeded = makeRng(0xd17411);
    let k = 0;
    const rng = { next: () => seeded.value('edits', k++, 0) };
    for (let run = 0; run < 200; run++) {
      const media = rng.next() < 0.3 ? null : 200;
      const hi = 240;
      let clips: TimelineClip[] = [c('c0', 0, 120, 0)];
      let seq = 1;
      for (let step = 0; step < 40; step++) {
        const pick = clips[Math.floor(rng.next() * clips.length)];
        const r = rng.next();
        const n = Math.floor(rng.next() * 60) - 30;
        if (!pick) {
          clips = [c(`c${seq++}`, 0, 10, 0)];
        } else if (r < 0.2) {
          const s = splitAt(
            clips,
            pick.start + Math.floor(rng.next() * pick.duration),
            `c${seq++}`,
          );
          if (s) clips = s.clips;
        } else if (r < 0.35) clips = trim(clips, pick.id, 'in', n, media, hi).clips;
        else if (r < 0.5) clips = trim(clips, pick.id, 'out', n, media, hi).clips;
        else if (r < 0.6) clips = slip(clips, pick.id, n, media).clips;
        else if (r < 0.7) clips = slide(clips, pick.id, n, media, hi).clips;
        else if (r < 0.8) clips = moveClip(clips, pick.id, pick.start + n, hi).clips;
        else if (r < 0.88) clips = deleteClip(clips, pick.id);
        else if (r < 0.93) clips = duplicateClip(clips, pick.id, `c${seq++}`, hi) ?? clips;
        else if (r < 0.96) clips = setSpeed(clips, pick.id, [0.5, 2, 1.5, 0.25][step % 4], hi);
        else if (r < 0.98)
          clips = rateStretch(clips, pick.id, step % 2 ? 'in' : 'out', n, hi).clips;
        else clips = setFades(clips, pick.id, Math.abs(n), Math.abs(n) >> 1);
        expect(checkClips(clips, media)).toBeNull();
        for (const x of clips) expect(x.start + x.duration).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe('timing reaches playback, export and sound', () => {
  it('layerTick on song time: untimed plays from the song start, timed shows its clip media, null in gaps, repeats past the footage', async () => {
    const { layerTick } = await import('../src/core/video-frames');
    // untimed: the footage from frame 0 of the song, repeating every 90 frames
    for (const fr of [0, 10, 59, 61, 200]) expect(layerTick(undefined, fr, 90)).toBe(fr % 90);
    const clips = [c('a', 30, 60, 0), c('b', 90, 30, 60)];
    expect(layerTick(clips, 10, 300)).toBeNull(); // before the first clip
    expect(layerTick(clips, 45, 300)).toBe(15);
    expect(layerTick(clips, 100, 300)).toBe(70);
    expect(layerTick(clips, 120 + 45, 300)).toBeNull(); // song time: no second pass
    // a clip longer than its 40-frame footage repeats it
    expect(layerTick([c('r', 0, 100, 0)], 45, 40)).toBe(5);
  });

  it('evaluateScene drops a timed layer outside its clips', async () => {
    const { evaluateScene } = await import('../src/core/loop-events');
    const { SCENE_LOOK_DEFAULT } = await import('../src/state/scene-store');
    const node = {
      id: 'n',
      assetId: 'a',
      kind: 'asset' as const,
      z: 1,
      placement: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: {},
      motion: null,
      opacity: 100,
      clips: [c('k', 10, 5, 0)],
    };
    const at = (f: number) =>
      evaluateScene([node], SCENE_LOOK_DEFAULT, [], f, 60, null, makeRng(1), new Set()).nodes
        .length;
    expect(at(9)).toBe(0);
    expect(at(10)).toBe(1);
    expect(at(14)).toBe(1);
    expect(at(15)).toBe(0);
  });

  it('a timed source sounds only inside its clips, from its sourceIn', async () => {
    const { buildLoopAudioMix, frameClipsToSamples } = await import('../src/core/loop-audio');
    const rate = 100; // tiny rate keeps the arrays small
    const pcm = { left: new Float32Array(400), right: new Float32Array(400) };
    for (let i = 0; i < 400; i++) pcm.left[i] = pcm.right[i] = i / 1000; // a ramp: value = index
    const clips = frameClipsToSamples([c('a', 10, 10, 5)], 10, rate); // frames @10fps
    const mix = buildLoopAudioMix([{ pcm, clipSamples: 400, clips }], 40, 10, false, rate);
    // loop = 40 frames @10fps = 400 samples; the clip covers samples 100..199 from pcm 50
    expect(mix.left[99]).toBe(0);
    expect(mix.left[100]).toBeCloseTo(50 / 1000, 6);
    expect(mix.left[150]).toBeCloseTo(100 / 1000, 6);
    expect(mix.left[200]).toBe(0);
  });
});

describe('3c · speed and fades', () => {
  it('FilmCraft rate_stretch_and_speed: stretch to half speed, then Speed 2× → 5 frames', () => {
    let clips = [c('a', 0, 10, 0)];
    const r = rateStretch(clips, 'a', 'out', 10);
    expect(r.speed).toBeCloseTo(0.5, 9);
    clips = setSpeed(r.clips, 'a', 2);
    expect(spans(clips)).toEqual([[0, 5]]);
    expect(sourceOut(clips[0])).toBe(10); // still the same 10 frames of media
  });

  it('at 2× a split stays continuous and trims respect the media at that speed', () => {
    const clips = [{ ...c('a', 0, 20, 0), speed: 2 }];
    const before = mediaFrameAt(clips, 13);
    const s = splitAt(clips, 7, 'b')!;
    expect(mediaFrameAt(s.clips, 13)).toBe(before);
    expect(s.clips[1].sourceIn).toBe(14);
    // Past the media the footage repeats, so the tail is free at any speed.
    expect(trim(clips, 'a', 'out', 99, 50).applied).toBe(99);
    expect(checkClips(s.clips, 50)).toBeNull();
  });

  it('Speed stops at the next clip instead of overlapping it', () => {
    const clips = [c('a', 0, 10, 0), c('b', 12, 5, 0)];
    expect(spans(setSpeed(clips, 'a', 0.5))).toEqual([
      [0, 12],
      [12, 5],
    ]);
  });

  it('fades ramp the gain at the ends; a split keeps each fade on its own side', () => {
    const clips = setFades([c('a', 0, 10, 0)], 'a', 4, 2);
    expect(fadeGainAt(clips, 0)).toBeCloseTo(1 / 5, 9);
    expect(fadeGainAt(clips, 3)).toBeCloseTo(4 / 5, 9);
    expect(fadeGainAt(clips, 5)).toBe(1);
    expect(fadeGainAt(clips, 9)).toBeCloseTo(1 / 3, 9);
    const s = splitAt(clips, 5, 'b')!;
    expect(s.clips[0].fadeIn).toBe(4);
    expect(s.clips[0].fadeOut).toBeUndefined();
    expect(s.clips[1].fadeIn).toBeUndefined();
    expect(s.clips[1].fadeOut).toBe(2);
    // shrinking a clip keeps its fades inside it
    const t = trim(clips, 'a', 'out', -7, null).clips[0];
    expect((t.fadeIn ?? 0) + (t.fadeOut ?? 0)).toBeLessThanOrEqual(t.duration);
  });
});

describe('3c · speed and fades reach the picture and the sound', () => {
  it('a fade scales the layer opacity in evaluateScene', async () => {
    const { evaluateScene } = await import('../src/core/loop-events');
    const { SCENE_LOOK_DEFAULT } = await import('../src/state/scene-store');
    const node = {
      id: 'n',
      assetId: 'a',
      kind: 'asset' as const,
      z: 1,
      placement: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: {},
      motion: null,
      opacity: 100,
      clips: [{ ...c('k', 0, 10, 0), fadeIn: 4 }],
    };
    const op = (f: number) =>
      evaluateScene([node], SCENE_LOOK_DEFAULT, [], f, 60, null, makeRng(1), new Set()).nodes[0]
        .opacity;
    expect(op(0)).toBe(20);
    expect(op(3)).toBe(80);
    expect(op(5)).toBe(100);
  });

  it('sound follows clip speed and fades', async () => {
    const { buildLoopAudioMix, frameClipsToSamples } = await import('../src/core/loop-audio');
    const rate = 100;
    const pcm = { left: new Float32Array(800), right: new Float32Array(800) };
    for (let i = 0; i < 800; i++) pcm.left[i] = pcm.right[i] = i / 1000;
    const clips = frameClipsToSamples([{ ...c('a', 10, 10, 0), speed: 2, fadeOut: 5 }], 10, rate);
    const mix = buildLoopAudioMix([{ pcm, clipSamples: 800, clips }], 40, 10, false, rate);
    // samples 100..199 play pcm at 2× from 0: sample 140 → pcm 80 (before the fade)
    expect(mix.left[140]).toBeCloseTo(80 / 1000, 6);
    // the last sample of the clip is faded to 1/(50+1) of its value
    expect(mix.left[199]).toBeCloseTo((198 / 1000) * (1 / 51), 6);
  });
});
