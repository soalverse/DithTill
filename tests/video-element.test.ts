// Video Library elements + canonical frame addressing:
//   1. buildVideoElement content-addresses by (bytes + trim window) — the same
//      segment dedupes, two segments of one source are distinct records SHARING
//      one blob (referencedHashes/orphanHashes stay GC-safe).
//   2. frameCount is the canonical integer round((out-in)*fps).
//   3. selectFrameForTicks: pure last-pts<=tick-time selection, stable at frame
//      boundaries (mid-tick probe), clamped to the last frame.
//   4. loopFrameToClipTick: shorter clips repeat inside the loop (modulo).
import { describe, it, expect } from 'vitest';
import {
  buildVideoElement,
  orphanHashes,
  referencedHashes,
  type BuildVideoInput,
  type VideoAssetRecord,
} from '../src/core/library';
import {
  VIDEO_FPS,
  loopFrameToClipTick,
  clipTickForFrame,
  selectFrameForTicks,
  tickTimeSeconds,
} from '../src/core/video-frames';

const bytes = new Uint8Array([9, 1, 1, 4, 2, 6, 5, 3, 5]);

function input(over: Partial<BuildVideoInput> = {}): BuildVideoInput {
  return {
    bytes,
    mime: 'video/mp4',
    w: 640,
    h: 360,
    inSeconds: 0,
    outSeconds: 3,
    fps: VIDEO_FPS,
    thumbnail: '',
    source: 'burn',
    aspect: 'landscape',
    palette: 'two',
    matrix: 8,
    createdAt: 0,
    ...over,
  };
}

describe('buildVideoElement (content addressing)', () => {
  it('same bytes + same window => same id (dedupe)', async () => {
    const a = await buildVideoElement(input());
    const b = await buildVideoElement(input());
    expect(a.record.id).toBe(b.record.id);
  });

  it('same window under a DIFFERENT look is its own element sharing the blob (save variants)', async () => {
    const mono = await buildVideoElement(input({ palette: 'two' }));
    const dusk = await buildVideoElement(input({ palette: 'dusk' }));
    const coarse = await buildVideoElement(input({ matrix: 2 }));
    expect(dusk.record.id).not.toBe(mono.record.id);
    expect(coarse.record.id).not.toBe(mono.record.id);
    // All variants reference the ONE source blob — no byte duplication.
    expect((dusk.record as VideoAssetRecord).videoHash).toBe(
      (mono.record as VideoAssetRecord).videoHash,
    );
    expect(orphanHashes(dusk.record, [mono.record])).toEqual([]);
  });

  it('two windows of one source are distinct records sharing ONE blob', async () => {
    const whole = await buildVideoElement(input({ inSeconds: 0, outSeconds: 180 }));
    const seg = await buildVideoElement(input({ inSeconds: 42, outSeconds: 72 }));
    expect(whole.record.id).not.toBe(seg.record.id);
    const wRec = whole.record as VideoAssetRecord;
    const sRec = seg.record as VideoAssetRecord;
    expect(wRec.videoHash).toBe(sRec.videoHash);
    // GC safety: deleting the segment record while the whole survives keeps the blob.
    expect(orphanHashes(seg.record, [whole.record])).toEqual([]);
    expect(orphanHashes(seg.record, [])).toEqual([sRec.videoHash]);
    expect(referencedHashes(seg.record)).toEqual([sRec.videoHash]);
  });

  it('frameCount = round((out-in)*fps), min 1', async () => {
    const r = (await buildVideoElement(input({ inSeconds: 42, outSeconds: 72 })))
      .record as VideoAssetRecord;
    expect(r.frameCount).toBe(30 * VIDEO_FPS);
    const tiny = (await buildVideoElement(input({ inSeconds: 1, outSeconds: 1.001 })))
      .record as VideoAssetRecord;
    expect(tiny.frameCount).toBe(1);
  });
});

describe('selectFrameForTicks (the one canonical selection rule)', () => {
  it('picks the frame displayed at each mid-tick time', () => {
    // A perfect 10fps source sampled at 30fps: each source frame covers 3 ticks.
    const pts = [0, 0.1, 0.2, 0.3];
    const sel = selectFrameForTicks(pts, 12, 30);
    expect([...sel]).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('is exact at frame boundaries (mid-tick probe beats float jitter)', () => {
    // Frame starts exactly ON a tick boundary: the tick's mid-time (k+0.5)/fps
    // is strictly inside the frame, so the pick can't flip on float noise.
    const pts = [0, 1 / 30, 2 / 30];
    const sel = selectFrameForTicks(pts, 3, 30);
    expect([...sel]).toEqual([0, 1, 2]);
  });

  it('clamps past the last frame and honours a trim offset', () => {
    const pts = [0, 0.5]; // a 2-frame, 1-second source at 2fps
    // Ticks probe 0.25/0.75/1.25/1.75s — the last two are past the clip and
    // clamp to the final frame instead of running off the array.
    expect([...selectFrameForTicks(pts, 4, 2)]).toEqual([0, 1, 1, 1]);
    // Trimmed window starting at 0.5s: every tick lands in the second frame.
    expect([...selectFrameForTicks(pts, 2, 2, 0.5)]).toEqual([1, 1]);
    expect(tickTimeSeconds(0, 2, 0.5)).toBeCloseTo(0.75);
  });
});

describe('loopFrameToClipTick (shorter clips repeat inside the loop)', () => {
  it('wraps by modulo and maps 1:1 at equal length', () => {
    expect(loopFrameToClipTick(0, 60)).toBe(0);
    expect(loopFrameToClipTick(59, 60)).toBe(59);
    expect(loopFrameToClipTick(60, 60)).toBe(0);
    expect(loopFrameToClipTick(150, 60)).toBe(30);
    expect(loopFrameToClipTick(0, 0)).toBe(0); // degenerate guard
  });
});

describe('clipTickForFrame', () => {
  const F = 60; // loop length

  it('a SHORTER clip (< loop) restarts its tiling every loop cycle', () => {
    const clip = 20; // 3 tiles per loop cycle
    // Within cycle 0 it matches loopFrameToClipTick exactly.
    expect(clipTickForFrame(0, F, clip)).toBe(0);
    expect(clipTickForFrame(25, F, clip)).toBe(5);
    expect(clipTickForFrame(59, F, clip)).toBe(loopFrameToClipTick(59, clip)); // 19
    // The next loop cycle RESTARTS: frame F behaves like frame 0, not frame 60 absolute.
    expect(clipTickForFrame(F, F, clip)).toBe(0);
    expect(clipTickForFrame(F + 25, F, clip)).toBe(5);
    // Absolute frame 65 would be 65%20=5 under an absolute rule; per-cycle gives the
    // same 5 here, so probe a frame where they DIFFER: absolute 70%20=10, per-cycle
    // (70%60=10)%20=10 — pick 80: absolute 80%20=0 vs per-cycle (80%60=20)%20=0.
    // Use clip=7 to force divergence: absolute 63%7=0, per-cycle (63%60=3)%7=3.
    expect(clipTickForFrame(63, F, 7)).toBe(3);
    expect(63 % 7).toBe(0); // proves the per-cycle rule is NOT the absolute one
  });

  it('a clip EQUAL to the loop maps 1:1 within a cycle then restarts', () => {
    expect(clipTickForFrame(59, F, F)).toBe(59);
    expect(clipTickForFrame(60, F, F)).toBe(0); // not 60 — clip==loop is the tiled branch
  });

  it('an OUTLASTING clip (> loop) advances ABSOLUTELY across the whole export', () => {
    const clip = 150; // outlasts the 60-frame loop
    expect(clipTickForFrame(0, F, clip)).toBe(0);
    expect(clipTickForFrame(60, F, clip)).toBe(60); // absolute — the next stretch, not 0
    expect(clipTickForFrame(149, F, clip)).toBe(149);
    expect(clipTickForFrame(150, F, clip)).toBe(0); // wraps only at the clip's own length
    expect(clipTickForFrame(175, F, clip)).toBe(25);
  });

  it('agrees with loopFrameToClipTick for every frame < loopFrames (back-compat)', () => {
    for (const clip of [7, 20, 60, 150]) {
      for (let frame = 0; frame < F; frame++) {
        expect(clipTickForFrame(frame, F, clip)).toBe(loopFrameToClipTick(frame, clip));
      }
    }
  });

  it('negative-safe and degenerate-safe like loopFrameToClipTick', () => {
    expect(clipTickForFrame(-1, F, 20)).toBe(19); // (-1 mod 60=59)%20 = 19
    expect(clipTickForFrame(-1, F, 150)).toBe(149); // absolute branch, negative-safe
    expect(clipTickForFrame(10, F, 0)).toBe(0); // degenerate clip guard
    expect(clipTickForFrame(10, F, -5)).toBe(0);
  });
});
