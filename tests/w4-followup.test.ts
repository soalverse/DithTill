// follow-up fixes. Node env, no DOM — the
// pieces under test are pure store/cache/math:
//   F1 — placing a video NEVER re-times the loop, and never refuses when takes exist.
//   F3 — liveTakes: a log holding only dead-layer events reads as take-free.
//   F6 — analyzeLoopAudio (worker client) == the pure buildLoopAudioMix + preAnalyze
//        inline path (the vitest node env has no Worker, so it exercises the fallback).
import { describe, it, expect, beforeEach } from 'vitest';
import { liveTakes, type TimedEvent } from '../src/core/loop-events';
import {
  buildVideoElement,
  type BuildVideoInput,
  type VideoAssetRecord,
} from '../src/core/library';
import { VIDEO_FPS } from '../src/core/video-frames';
import { useLibraryStore } from '../src/state/library-store';
import { useSceneStore, SCENE_LOOK_DEFAULT } from '../src/state/scene-store';
import { useLoopStore, LOOP_META_DEFAULT } from '../src/state/loop-store';
import { setAsset, getAssetCache } from '../src/ui/scene-assets';
import { dropFromLibrary } from '../src/ui/record-actions';
import { analyzeLoopAudio } from '../src/engine-cpu/loop-audio-client';
import { buildLoopAudioMix, monoMix, AUDIO_RATE, type StereoPcm } from '../src/core/loop-audio';
import { preAnalyze } from '../src/core/audio-features';

const staticEvent = (nodeId: string, pass: number, id: string): TimedEvent => ({
  id,
  kind: 'object-static',
  nodeId,
  pass,
  layer: pass,
  startFrame: 0,
  endFrame: 0,
  placement: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 },
});

describe('F3 — liveTakes (the one shared take-count truth)', () => {
  it('counts only passes whose owning node is still live', () => {
    const events = [staticEvent('n1', 0, 'a'), staticEvent('n2', 1, 'b')];
    expect(liveTakes(events, new Set(['n1', 'n2']))).toEqual([0, 1]);
    expect(liveTakes(events, new Set(['n1']))).toEqual([0]); // n2 deleted → its take clears
  });

  it('a log holding ONLY dead-layer events reads as take-free (F3 delete-all)', () => {
    const events = [staticEvent('gone1', 0, 'a'), staticEvent('gone2', 1, 'b')];
    // Every layer deleted → no live node ids → no takes → guards/locks treat it empty.
    expect(liveTakes(events, new Set<string>())).toEqual([]);
    expect(liveTakes(events, new Set<string>()).length > 0).toBe(false);
  });

  it("a scene-global event (nodeId '') always counts", () => {
    expect(liveTakes([staticEvent('', 2, 'a')], new Set<string>())).toEqual([2]);
  });
});

const videoInput = (over: Partial<BuildVideoInput> = {}): BuildVideoInput => ({
  bytes: new Uint8Array([9, 1, 1, 4, 2, 6, 5, 3, 5]),
  mime: 'video/mp4',
  w: 640,
  h: 360,
  inSeconds: 0,
  outSeconds: 3, // 3s * VIDEO_FPS frames — distinct from the default 60-frame loop
  fps: VIDEO_FPS,
  thumbnail: '',
  source: 'burn',
  aspect: 'landscape',
  palette: 'two',
  matrix: 8,
  createdAt: 0,
  ...over,
});

describe('F1 — placing a video never re-times the loop', () => {
  beforeEach(() => {
    useSceneStore.setState({
      nodes: [],
      selected: [],
      background: null,
      dotInk: null,
      scene: { ...SCENE_LOOK_DEFAULT },
      cropId: null,
    });
    useLibraryStore.setState({ elements: [], selected: [], ready: true });
    useLoopStore.setState({ meta: { ...LOOP_META_DEFAULT }, events: [], reactions: [] });
    getAssetCache().clear();
  });

  it('leaves the loop length UNCHANGED and still places the video (takes present)', async () => {
    const rec = (await buildVideoElement(videoInput())).record as VideoAssetRecord;
    expect(rec.frameCount).not.toBe(LOOP_META_DEFAULT.frames); // 90 vs 60 — a real diff
    useLibraryStore.setState((s) => ({ elements: [rec, ...s.elements], ready: true }));
    setAsset(rec.id, {
      w: rec.w,
      h: rec.h,
      tones: new Uint8Array(rec.w * rec.h),
      covered: new Uint8Array(rec.w * rec.h).fill(1),
    });
    // A recorded take exists at the current (default) length — the OLD rule would have
    // refused the drop with 'Loop has takes'; the new rule ignores it.
    useLoopStore.setState({ events: [staticEvent('paint:1', 0, 't0')] });

    await dropFromLibrary([rec.id]);

    // Length untouched, and the video landed on the scene (not refused/filtered out).
    expect(useLoopStore.getState().meta.frames).toBe(LOOP_META_DEFAULT.frames);
    expect(useSceneStore.getState().nodes.some((n) => n.assetId === rec.id)).toBe(true);
  });
});

describe('F6 — analyzeLoopAudio == the pure inline mix + features', () => {
  it('the worker client (fallback path) matches buildLoopAudioMix + preAnalyze exactly', async () => {
    const clip: StereoPcm = {
      left: Float32Array.from({ length: 400 }, (_, i) => Math.sin(i * 0.1) * 0.5),
      right: Float32Array.from({ length: 400 }, (_, i) => Math.cos(i * 0.07) * 0.5),
    };
    const sources = [{ pcm: clip, clipSamples: 400 }];
    const F = 60;
    const fps = 30;
    const T = 120; // outlasting-ish so both clocks exercise
    const expectedMix = buildLoopAudioMix(sources, F, fps, true, AUDIO_RATE, T);
    const expectedFeatures = preAnalyze({
      pcm: monoMix(expectedMix),
      sampleRate: AUDIO_RATE,
      frames: T,
      fps,
    });

    const got = await analyzeLoopAudio({
      sources,
      frames: F,
      fps,
      seamFade: true,
      rate: AUDIO_RATE,
      totalFrames: T,
    });

    expect(Array.from(got.mix.left)).toEqual(Array.from(expectedMix.left));
    expect(Array.from(got.mix.right)).toEqual(Array.from(expectedMix.right));
    expect(got.features.length).toBe(expectedFeatures.length);
    expect(got.features[10]).toEqual(expectedFeatures[10]);
  });
});
