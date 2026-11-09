// =============================================================================
// Scene GC — the zundo-reachability sweep (W6 / P9, backlog).
//
// Record's managed rasters (paint layers, generative visualizers, video previewers)
// and the decoded-audio PCM cache live OUTSIDE the zundo history (load-bearing for
// memory — the undo stack must stay lightweight). So deleting a layer or clearing
// the loop leaves their big buffers stranded: a long Record session slowly eats
// memory (the owner's report). This is the sweep the ADRs deferred.
//
// THE REACHABILITY RULE (undo-safe by construction): a managed asset is LIVE if it
// is referenced by ANY of —
//   (a) a current scene node (`node.assetId`),
//   (b) any scene-store zundo PAST or FUTURE state's nodes,
//   (c) any loop event's asset reference (`paint-reveal`.assetId) — current, and in
//       every loop-store zundo past/future state.
// Only an asset unreachable from ALL of those is freed. Because zundo pushes the
// pre-delete state into `pastStates` synchronously during the delete's `set`, an
// asset a Redo/Undo could resurrect is ALWAYS still reachable → never freed. The
// buffer is reclaimed only once history can no longer reach it (the branch was cut
// on a new edit, or the 50-entry limit scrolled the state off the stack).
//
// Audio: `videoPcm` (decoded PCM per source+trim) is evicted the same way — a source
// key is kept iff a reachable node resolves to that Library video. The AudioContext /
// source node / imported track are single reused refs (audio-engine), so they don't
// accumulate; only the per-source PCM map needs bounding.
//
// Runtime-only: nothing here touches the deterministic export path or any stored
// state (the caches are all rebuilt on demand from the Library / decode). Triggered
// on the cheap settle points (layer delete · Clear Loop · scene clear · leaving
// Record) via a microtask-debounced schedule — never inside a zundo step, never on
// a per-frame hot path.
// =============================================================================
import { useSceneStore, type SceneNode } from '../state/scene-store';
import { findRecord } from './session-assets';
import { useLoopStore } from '../state/loop-store';
import { useModeStore } from '../state/mode-store';
import { audioSourceKey } from '../core/loop-audio';
import type { TimedEvent } from '../core/loop-events';
import { getAssetCache } from './scene-assets';
import { evictPaintHistory, paintHistoryIds } from './paint-node';
import { isVideoAsset, releaseVideoAsset, videoAssetIds } from './video-assets';
import { evictAudioPcm } from './audio-engine';
import { evictImageSource } from './image-layers';

/** Managed in-memory raster prefixes (never Library/BlobStore ids). Reveal/rec
 *  "scratch" rasters are ephemeral per-frame COPIES built in
 *  applyPaintReveal and never stored, so they need no sweeping — the persistent
 *  thing a reveal references is its `paint:` base, covered by rule (c). */
const MANAGED_PREFIXES = ['paint:', 'viz:', 'img:', 'text:'];

const isManaged = (id: string): boolean =>
  isVideoAsset(id) || MANAGED_PREFIXES.some((p) => id.startsWith(p));

export interface SweepResult {
  /** Managed raster ids freed (paint:/viz:/video). */
  freedAssets: string[];
  /** Approx raster + paint-history bytes reclaimed. */
  freedBytes: number;
  /** Decoded-PCM cache keys evicted. */
  freedPcmKeys: string[];
  /** Approx decoded-PCM bytes reclaimed. */
  freedPcmBytes: number;
}

/** Every assetId reachable from the scene (current ∪ zundo past ∪ future) plus every
 *  `paint:` id a loop paint-reveal event references (current ∪ loop zundo history). */
function reachableAssetIds(): Set<string> {
  const ids = new Set<string>();

  const addNodes = (nodes: SceneNode[] | undefined): void => {
    if (nodes) for (const n of nodes) ids.add(n.assetId);
  };
  addNodes(useSceneStore.getState().nodes);
  const scenePast = useSceneStore.temporal.getState().pastStates as Array<{ nodes?: SceneNode[] }>;
  const sceneFut = useSceneStore.temporal.getState().futureStates as Array<{ nodes?: SceneNode[] }>;
  for (const st of scenePast) addNodes(st.nodes);
  for (const st of sceneFut) addNodes(st.nodes);

  const addEvents = (events: TimedEvent[] | undefined): void => {
    if (events) for (const e of events) if (e.kind === 'paint-reveal') ids.add(e.assetId);
  };
  addEvents(useLoopStore.getState().events);
  const loopPast = useLoopStore.temporal.getState().pastStates as Array<{ events?: TimedEvent[] }>;
  const loopFut = useLoopStore.temporal.getState().futureStates as Array<{ events?: TimedEvent[] }>;
  for (const st of loopPast) addEvents(st.events);
  for (const st of loopFut) addEvents(st.events);

  return ids;
}

/** The decoded-PCM keys still reachable: one per in-scene / in-history video source
 *  (keyed by hash + trim, exactly as the engine decodes it). A reachable assetId that
 *  no longer resolves to a Library video (element deleted) simply yields no key → its
 *  stale PCM becomes evictable. */
function reachablePcmKeys(reachable: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const id of reachable) {
    const rec = findRecord(id);
    if (rec && rec.kind === 'video') {
      keys.add(audioSourceKey(rec.videoHash, rec.inSeconds, rec.outSeconds));
    }
  }
  return keys;
}

/**
 * Run one reachability sweep. Synchronous + side-effecting on the runtime caches;
 * pure w.r.t. any stored/undoable state. Safe to call directly (tests do) or via the
 * debounced `scheduleSweep`. Idempotent — a second call with the same reachability
 * frees nothing.
 */
export function sweepSceneAssets(): SweepResult {
  const reachable = reachableAssetIds();
  const result: SweepResult = {
    freedAssets: [],
    freedBytes: 0,
    freedPcmKeys: [],
    freedPcmBytes: 0,
  };

  // 1. Managed rasters in the scene-asset cache (a video previewer's raster IS its
  //    cache entry — the same object — so bytes are counted once here).
  const cache = getAssetCache();
  for (const id of [...cache.keys()]) {
    if (!isManaged(id) || reachable.has(id)) continue;
    const a = cache.get(id);
    let bytes = a ? a.tones.length + a.covered.length : 0;
    bytes += evictPaintHistory(id); // a paint layer also carries a snapshot stack
    if (isVideoAsset(id)) releaseVideoAsset(id); // pause element + revoke blob URL + decoder
    if (id.startsWith('img:')) evictImageSource(id); // the imported picture itself
    cache.delete(id);
    result.freedBytes += bytes;
    result.freedAssets.push(id);
  }

  // 2. Stragglers: a paint history or a video previewer whose cache raster was already
  //    dropped elsewhere but whose side buffer lingers.
  for (const id of paintHistoryIds()) {
    if (reachable.has(id)) continue;
    const bytes = evictPaintHistory(id);
    if (bytes > 0) {
      result.freedBytes += bytes;
      if (!result.freedAssets.includes(id)) result.freedAssets.push(id);
    }
  }
  for (const id of videoAssetIds()) {
    if (reachable.has(id)) continue;
    releaseVideoAsset(id);
    if (!result.freedAssets.includes(id)) result.freedAssets.push(id);
  }

  // 3. Decoded-audio PCM for unreachable sources.
  const audio = evictAudioPcm(reachablePcmKeys(reachable));
  result.freedPcmKeys = audio.keys;
  result.freedPcmBytes = audio.bytes;

  return result;
}

// ---- debounced scheduling (app-side) ----------------------------------------

let scheduled = false;
let inited = false;

/** Coalesce a burst of shrink events into one microtask sweep (runs AFTER the zundo
 *  `set` settles, so the pre-delete state is already in `pastStates` — undo-safe). */
export function scheduleSweep(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    sweepSceneAssets();
  });
}

/** Wire the sweep to the cheap settle points. Idempotent; call once from mount. */
export function initSceneGc(): void {
  if (inited) return;
  inited = true;

  // A layer deleted / the scene cleared: the node array shrank.
  useSceneStore.subscribe((s, prev) => {
    if (s.nodes !== prev.nodes && s.nodes.length < prev.nodes.length) scheduleSweep();
  });
  // Clear Loop / undo-take: the event log shrank (a paint-reveal reference may drop).
  useLoopStore.subscribe((s, prev) => {
    if (s.events !== prev.events && s.events.length < prev.events.length) scheduleSweep();
  });
  // Leaving Record — a natural settle point to reclaim whatever history has scrolled off.
  useModeStore.subscribe((s, prev) => {
    if (prev.mode === 'canvas' && s.mode !== 'canvas') scheduleSweep();
  });
}
