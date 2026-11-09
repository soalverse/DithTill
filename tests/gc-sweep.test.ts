// W6 / P9 — the scene GC reachability sweep. Proves
// the three long-Record memory leaks are collected, and — the WHOLE point — that the
// sweep is undo-safe: it never frees a raster any zundo state could resurrect.
//
//   1. delete-layer → sweep frees the raster ONLY once history no longer reaches it.
//   2. delete + undo → the raster is still alive AND functional (paint again works).
//   3. a paint asset kept alive by a loop paint-reveal event; Clear Loop frees it.
//   4. audio PCM: a removed source's decoded PCM evicts, an in-scene one is kept.
//   5. bounded growth: 20 add/delete/settle cycles keep the managed caches bounded;
//      reports approximate bytes reclaimed.
//
// Env is node (no DOM), so the video PREVIEWER lifecycle (HTMLVideoElement teardown)
// isn't exercised here — it rides the SAME reachability path as paint:/viz: and its
// eviction (releaseVideoAsset) is now wired in ui/scene-gc. The audio-PCM cache is
// seeded via a documented test seam (decode needs the codec).
import { describe, it, expect, beforeEach } from 'vitest';
import { useSceneStore } from '../src/state/scene-store';
import { useLoopStore } from '../src/state/loop-store';
import { useLibraryStore } from '../src/state/library-store';
import { getAssetCache } from '../src/ui/scene-assets';
import {
  createPaintLayer,
  paintStroke,
  commitPaint,
  paintHistoryIds,
  evictPaintHistory,
} from '../src/ui/paint-node';
import { audioPcmKeys, evictAudioPcm, _seedAudioPcmForTest } from '../src/ui/audio-engine';
import { sweepSceneAssets } from '../src/ui/scene-gc';
import { audioSourceKey, type StereoPcm } from '../src/core/loop-audio';
import type { PaintRevealEvent } from '../src/core/loop-events';
import type { VideoAssetRecord } from '../src/core/library';

function assetIdOf(nodeId: string): string {
  const n = useSceneStore.getState().nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`node ${nodeId} missing`);
  return n.assetId;
}

/** A minimal Library video record for the audio-reachability tests. */
function videoRec(id: string, videoHash: string): VideoAssetRecord {
  return {
    id,
    schemaVersion: 2,
    kind: 'video',
    source: 'burn',
    w: 640,
    h: 480,
    aspect: 'landscape',
    palette: 'two',
    matrix: 8,
    videoHash,
    mime: 'video/mp4',
    inSeconds: 0,
    outSeconds: 2,
    fps: 30,
    frameCount: 60,
    thumbnail: '',
    createdAt: 0,
  };
}

function stereo(samples: number): StereoPcm {
  return { left: new Float32Array(samples), right: new Float32Array(samples) };
}

/** Count managed (paint:/viz:) rasters still in the scene-asset cache. */
function managedCacheCount(): number {
  let n = 0;
  for (const id of getAssetCache().keys())
    if (id.startsWith('paint:') || id.startsWith('viz:')) n++;
  return n;
}

beforeEach(() => {
  // Fresh stores + histories + caches so each test starts from empty.
  useSceneStore.setState({ nodes: [], selected: [], cropId: null });
  useSceneStore.temporal.getState().clear();
  useLoopStore.setState({ events: [], reactions: [] });
  useLoopStore.temporal.getState().clear();
  useLibraryStore.setState({ elements: [] });
  getAssetCache().clear();
  for (const id of paintHistoryIds()) evictPaintHistory(id);
  evictAudioPcm(new Set()); // drop all seeded PCM
});

describe('scene GC — reachability sweep (W6 / P9)', () => {
  it('frees a deleted layer ONLY once zundo history no longer reaches it', () => {
    const nodeId = createPaintLayer();
    const assetId = assetIdOf(nodeId);
    expect(getAssetCache().has(assetId)).toBe(true);

    useSceneStore.getState().remove([nodeId]);

    // The delete pushed the pre-delete state (with the node) into pastStates, so the
    // raster is still reachable → the sweep MUST NOT free it (an Undo could resurrect it).
    const first = sweepSceneAssets();
    expect(first.freedAssets).not.toContain(assetId);
    expect(getAssetCache().has(assetId)).toBe(true);

    // Once history can no longer reach it, the sweep reclaims the raster + its history.
    useSceneStore.temporal.getState().clear();
    const second = sweepSceneAssets();
    expect(second.freedAssets).toContain(assetId);
    expect(second.freedBytes).toBeGreaterThan(0);
    expect(getAssetCache().has(assetId)).toBe(false);
    expect(paintHistoryIds()).not.toContain(assetId);
  });

  it('delete + undo restores a fully working layer (raster intact)', () => {
    const nodeId = createPaintLayer();
    const assetId = assetIdOf(nodeId);

    useSceneStore.getState().remove([nodeId]);
    sweepSceneAssets(); // reachable via pastStates → untouched
    expect(getAssetCache().has(assetId)).toBe(true);

    useSceneStore.temporal.getState().undo();
    const back = useSceneStore.getState().nodes.find((n) => n.assetId === assetId);
    expect(back).toBeTruthy();

    // The raster is intact and still paintable (functional layer, not a husk).
    const node = back!;
    const before = getAssetCache().get(assetId)!;
    const painted = before.covered.reduce((a, b) => a + b, 0);
    paintStroke(node, before.w / 2, before.h / 2, before.w / 2, before.h / 2, {
      tool: 'brush',
      size: 4,
      shade: 0.9,
    });
    commitPaint(node);
    const after = getAssetCache().get(assetId)!;
    expect(after.covered.reduce((a, b) => a + b, 0)).toBeGreaterThan(painted);
  });

  it('a loop paint-reveal event keeps a deleted layer alive; Clear Loop frees it', () => {
    const nodeId = createPaintLayer();
    const assetId = assetIdOf(nodeId);

    // Author a paint-reveal event that references the layer, then delete the node and
    // drop the scene history — the ONLY reference left is the loop event.
    const reveal: PaintRevealEvent = {
      id: 'pr-1',
      kind: 'paint-reveal',
      nodeId,
      assetId,
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 0,
      stamps: [{ frame: 0, x: 1, y: 1, r: 2, shade: 0.8, erase: false }],
    };
    useLoopStore.getState().commitEvents([reveal]);
    useSceneStore.getState().remove([nodeId]);
    useSceneStore.temporal.getState().clear();

    // Loop event (rule c) still reaches the asset → NOT freed.
    expect(sweepSceneAssets().freedAssets).not.toContain(assetId);
    expect(getAssetCache().has(assetId)).toBe(true);

    // Clear Loop + drop the loop history → nothing references it → freed.
    useLoopStore.getState().clearLoop();
    useLoopStore.temporal.getState().clear();
    expect(sweepSceneAssets().freedAssets).toContain(assetId);
    expect(getAssetCache().has(assetId)).toBe(false);
  });

  it('evicts a removed audio source PCM but keeps an in-scene one', () => {
    const recA = videoRec('vidA', 'hashA'); // stays in the scene
    const recB = videoRec('vidB', 'hashB'); // removed
    useLibraryStore.setState({ elements: [recA, recB] });

    // Place A only; keep no history reaching B.
    useSceneStore.getState().addNodes([{ assetId: recA.id, w: 64, h: 48, cx: 10, cy: 10 }]);
    useSceneStore.temporal.getState().clear();

    const keyA = audioSourceKey(recA.videoHash, recA.inSeconds, recA.outSeconds);
    const keyB = audioSourceKey(recB.videoHash, recB.inSeconds, recB.outSeconds);
    _seedAudioPcmForTest(keyA, stereo(48000));
    _seedAudioPcmForTest(keyB, stereo(48000));

    const res = sweepSceneAssets();
    expect(res.freedPcmKeys).toEqual([keyB]);
    expect(res.freedPcmBytes).toBeGreaterThan(0);
    expect(audioPcmKeys()).toContain(keyA);
    expect(audioPcmKeys()).not.toContain(keyB);
  });

  it('keeps decoded PCM for a source still reachable via zundo history', () => {
    const rec = videoRec('vidC', 'hashC');
    useLibraryStore.setState({ elements: [rec] });
    // Place then remove — the node lives on in pastStates, so its PCM must survive.
    useSceneStore.getState().addNodes([{ assetId: rec.id, w: 64, h: 48, cx: 5, cy: 5 }]);
    const nodeId = useSceneStore.getState().nodes[0].id;
    useSceneStore.getState().remove([nodeId]);

    const key = audioSourceKey(rec.videoHash, rec.inSeconds, rec.outSeconds);
    _seedAudioPcmForTest(key, stereo(1000));

    expect(sweepSceneAssets().freedPcmKeys).not.toContain(key);
    expect(audioPcmKeys()).toContain(key);
  });

  it('bounds the managed caches across 20 add/delete cycles + reports bytes reclaimed', () => {
    let totalFreed = 0;
    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      const nodeId = createPaintLayer();
      // ... a couple of strokes so the history stack has real bytes ...
      const node = useSceneStore.getState().nodes.find((n) => n.id === nodeId)!;
      paintStroke(node, 10, 10, 40, 40, { tool: 'brush', size: 5, shade: 0.8 });
      commitPaint(node);
      useSceneStore.getState().remove([nodeId]);
      // Settle: history scrolls off (simulated by clearing), then sweep reclaims.
      useSceneStore.temporal.getState().clear();
      totalFreed += sweepSceneAssets().freedBytes;
    }

    // After every cycle settles, no managed raster should be stranded.
    expect(managedCacheCount()).toBe(0);
    expect(paintHistoryIds().length).toBe(0);
    expect(totalFreed).toBeGreaterThan(0);
    // Report (visible in the test run) — the synthetic 20-cycle reclaim.
    console.log(
      `[W6 GC] 20-cycle session reclaimed ~${(totalFreed / 1024).toFixed(1)} KiB ` +
        `(~${(totalFreed / CYCLES / 1024).toFixed(1)} KiB per layer, raster + history).`,
    );
  });
});

// The LAYERS door "Clear all". The button wires straight to
// the existing scene-store clear(); these prove the semantics the owner cares about:
// one undo restores everything, the sweep frees only after history drops, and takes
// are filtered non-destructively (the same live-node rule single-delete uses, so undo
// brings the takes back). Mirrors the delete+undo proofs above, but for the whole scene.
describe('LAYERS door — Clear all layers', () => {
  // The exact filter LoopTransport applies (a take = a distinct live pass; a scene-
  // global reaction has nodeId ''). Kept here so the take-filtering proof is honest.
  const liveTakes = (): number[] => {
    const live = new Set(useSceneStore.getState().nodes.map((n) => n.id));
    const passes = useLoopStore
      .getState()
      .events.filter((e) => e.nodeId === '' || live.has(e.nodeId))
      .map((e) => e.pass);
    return [...new Set(passes)].sort((a, b) => a - b);
  };

  it('clears every layer in ONE undoable step; undo restores them all', () => {
    const ids = [createPaintLayer(), createPaintLayer(), createPaintLayer()];
    expect(
      useSceneStore
        .getState()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual([...ids].sort());

    const before = useSceneStore.temporal.getState().pastStates.length;
    useSceneStore.getState().clear();
    expect(useSceneStore.getState().nodes).toHaveLength(0);
    expect(useSceneStore.getState().selected).toHaveLength(0);
    expect(useSceneStore.getState().cropId).toBeNull();

    // clear() adds exactly ONE zundo entry, so a single undo brings the whole scene back.
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(before + 1);
    useSceneStore.temporal.getState().undo();
    expect(
      useSceneStore
        .getState()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('drops node takes non-destructively (like single delete) — undo restores the takes', () => {
    const nodeId = createPaintLayer();
    const assetId = assetIdOf(nodeId);
    // A recorded pass referencing the layer + a scene-global reaction (nodeId '').
    const reveal: PaintRevealEvent = {
      id: 'pr-clr',
      kind: 'paint-reveal',
      nodeId,
      assetId,
      pass: 0,
      layer: 0,
      startFrame: 0,
      endFrame: 0,
      stamps: [{ frame: 0, x: 1, y: 1, r: 2, shade: 0.8, erase: false }],
    };
    const globalReveal: PaintRevealEvent = { ...reveal, id: 'pr-glob', nodeId: '', pass: 1 };
    useLoopStore.getState().commitEvents([reveal, globalReveal]);
    expect(liveTakes()).toEqual([0, 1]);

    useSceneStore.getState().clear();
    // The node's take (pass 0) drops; the scene-global pass (1) stays. The event log
    // itself is untouched (non-destructive) — clear() never edits loop-store.
    expect(liveTakes()).toEqual([1]);
    expect(useLoopStore.getState().events).toHaveLength(2);

    // Undo brings the node — and therefore its take — back.
    useSceneStore.temporal.getState().undo();
    expect(liveTakes()).toEqual([0, 1]);
  });

  it('sweep frees the cleared rasters only once history can no longer reach them', () => {
    const a = assetIdOf(createPaintLayer());
    const b = assetIdOf(createPaintLayer());

    useSceneStore.getState().clear();
    // Pre-clear state (with both nodes) sits in pastStates → an undo could resurrect
    // them, so the sweep must free nothing yet.
    const guarded = sweepSceneAssets();
    expect(guarded.freedAssets).not.toContain(a);
    expect(guarded.freedAssets).not.toContain(b);
    expect(getAssetCache().has(a)).toBe(true);
    expect(getAssetCache().has(b)).toBe(true);

    // Once history scrolls off, both rasters are reclaimed.
    useSceneStore.temporal.getState().clear();
    const freed = sweepSceneAssets();
    expect(freed.freedAssets).toEqual(expect.arrayContaining([a, b]));
    expect(getAssetCache().has(a)).toBe(false);
    expect(getAssetCache().has(b)).toBe(false);
  });
});
