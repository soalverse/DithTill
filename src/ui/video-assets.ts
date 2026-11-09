// =============================================================================
// Video scene assets. A video element is, to the renderer, an ordinary
// CachedAsset whose TONES change per loop frame — the resolver stays time-blind
// and 0 lines change. This module owns the per-video machinery behind that:
//
//  - an offscreen HTMLVideoElement per placed video (object URL over the Library
//    blob), confined to the record's trim window [inSeconds, outSeconds);
//  - LIVE loop (play/record): the element plays at the transport speed and is
//    grabbed each rAF into the raster — a NON-AUTHORITATIVE PREVIEWER of the pure
//    frame→PNG function (it may sit ±1 frame under
//    load). Drift self-corrects against the canonical tick time each render.
//  - STOPPED: an exact seek to tick 0's canonical time, so the static view, the
//    still-PNG export, and frame 0 of the loop export all agree.
//  - the AUTHORITATIVE frames come from the codec in the export (P8), selected by the
//    same pure rules (core/video-frames) + the same RGBA→tone conversion
//    (gridToBase at neutral contrast — per-node Look does the treating).
// =============================================================================
import { useLoopStore } from '../state/loop-store';
import {
  useSceneStore,
  sceneLongFromPixel,
  detailFactor,
  sceneDims,
  registerResolutionTracking,
  type SceneNode,
} from '../state/scene-store';
import { gridToBase } from '../state/stage-store';
import { quantizeContrast } from '../core/dither-constants';
import { layerTick, tickTimeSeconds, videoRasterDims } from '../core/video-frames';
import { clipAt } from '../core/timeline-edit';
import { videoRasterLongForCoverage } from './image-to-grid';
import type { CachedAsset } from '../core/scene-resolver';
import type { VideoAssetRecord } from '../core/library';

/** Live drift tolerance (seconds) before re-seeking the previewer element. */
const DRIFT_SEC = 0.2;

interface VideoEntry {
  rec: VideoAssetRecord;
  video: HTMLVideoElement;
  url: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** THE live raster — registered in the scene asset cache; tones are rewritten
   *  in place per grabbed frame (never a new object, so the cache stays stable). */
  asset: CachedAsset;
  /** Guards stale async static-seek grabs (only the latest wins). */
  seq: number;
}

const entries = new Map<string, VideoEntry>();

// A video node's raster tracks the scene lattice (rebuilt on a resolution change), so
// setScenePixel must NOT rescale its placement scale — the raster rebuild carries the
// footprint (and its element-local crop scales with the raster). See scene-store.
registerResolutionTracking((n) => entries.has(n.assetId));

/** The current scene lattice long edge — the base video raster long edge (scene-resolution
 *  pass): a video on a Pixel-2 (240) scene rasterizes at 240-long so its detail matches
 *  the lattice. Default Pixel → 192 == the historic VIDEO_RASTER_LONG. */
const sceneRasterLong = (): number =>
  sceneLongFromPixel(useSceneStore.getState().pixel) * detailFactor();

/** The crop-aware video raster long for a record at a given scene lattice long (S2): a
 *  REFRAMED (zoom-cropped) clip's window fills the scene, so the raster must be big enough
 *  that the cropped sub-rect still lands >= 1 texel/scene-cell (else it reads blockier than
 *  Burn). A full-frame clip returns `long` unchanged (byte-identical to before). Uses the
 *  record's saved source dims so the LIVE previewer + the EXPORT decoder derive the SAME
 *  raster from one formula (videoRasterLongForCoverage). */
function coverageRasterDims(rec: VideoAssetRecord, long: number, vw: number, vh: number) {
  const d = sceneDims(rec.aspect, long);
  const cvLong = videoRasterLongForCoverage(vw, vh, rec.aspect, rec.reframe, d.w, d.h, long);
  return videoRasterDims(vw, vh, cvLong);
}

/** Is this scene assetId a placed video element? */
export function isVideoAsset(id: string): boolean {
  return entries.has(id);
}

const onceEvent = (el: HTMLVideoElement, ev: string): Promise<void> =>
  new Promise((resolve) => el.addEventListener(ev, () => resolve(), { once: true }));

async function seekExact(entry: VideoEntry, t: number): Promise<void> {
  const v = entry.video;
  const clamped = Math.min(Math.max(t, 0), Math.max(0, v.duration - 1e-3));
  if (v.readyState >= 2 && Math.abs(v.currentTime - clamped) < 1 / 240) return;
  const seeked = onceEvent(v, 'seeked');
  v.currentTime = clamped;
  await seeked;
}

/** Grab the element's CURRENT frame into the live raster (in place). The one
 *  conversion truth: gridToBase at NEUTRAL contrast/invert — treating is the
 *  node/scene Look's job at resolve time, exactly like every other element. */
function grab(entry: VideoEntry): void {
  const { ctx, canvas, video, asset } = entry;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const { tones, covered } = gridToBase(rgba, asset.w, asset.h, quantizeContrast(1), false);
  asset.tones.set(tones);
  asset.covered.set(covered);
}

/** The timing clips of the layer showing this video, if timed. */
const clipsFor = (assetId: string) =>
  useSceneStore.getState().nodes.find((n) => n.assetId === assetId)?.clips;

/** Async exact landing on the RESTING frame (loop frame 0 — a timed layer's clip media
 *  there, else tick 0), then re-render. */
function refreshStatic(entry: VideoEntry): void {
  const mySeq = ++entry.seq;
  const tick0 = layerTick(clipsFor(entry.rec.id), 0, entry.rec.frameCount) ?? 0;
  const t0 = tickTimeSeconds(tick0, entry.rec.fps, entry.rec.inSeconds);
  void seekExact(entry, t0).then(() => {
    if (entry.seq !== mySeq) return; // superseded (transport changed again)
    grab(entry);
    useSceneStore.getState().bump(); // re-render the static scene with the exact frame
  });
}

/** STOPPED scrub: land every placed video exactly on the tick for
 *  absolute frame `frame` (the same clipTickForFrame the export uses), then re-render.
 *  `frame` null = back to rest (tick 0). Seq-guarded so a fast scrub keeps only the
 *  latest landing. */
export function scrubVideos(frame: number | null): void {
  if (frame === null) {
    entries.forEach((e) => refreshStatic(e));
    return;
  }
  entries.forEach((entry) => {
    const mySeq = ++entry.seq;
    const tick = layerTick(clipsFor(entry.rec.id), frame, entry.rec.frameCount);
    if (tick === null) return; // off at this frame (a gap in its timing)
    void seekExact(entry, tickTimeSeconds(tick, entry.rec.fps, entry.rec.inSeconds)).then(() => {
      if (entry.seq !== mySeq) return;
      grab(entry);
      useSceneStore.getState().bump();
    });
  });
}

// One transport subscription drives every placed video: play/pause follows the
// loop transport, playbackRate follows the live speed knob (preview-only), and
// Stop lands every element exactly on tick 0.
let transportSynced = false;
function initTransportSync(): void {
  if (transportSynced) return;
  transportSynced = true;
  useLoopStore.subscribe((s, prev) => {
    if (s.speed !== prev.speed)
      entries.forEach((e) => {
        e.video.playbackRate = s.speed;
      });
    if (s.transport === prev.transport) return;
    if (s.transport === 'stopped') {
      entries.forEach((e) => e.video.pause());
      // A PAUSE holds the playhead: land on that frame, not the resting one.
      if (s.scrub !== null) scrubVideos(s.scrub);
      else entries.forEach((e) => refreshStatic(e));
    } else if (prev.transport === 'stopped') {
      entries.forEach((e) => {
        e.seq++; // cancel any in-flight static grab
        e.video.playbackRate = s.speed;
        // Start where Play resumes (the paused / scrubbed playhead), not always tick 0.
        const tick = layerTick(clipsFor(e.rec.id), s.resumeFrame ?? 0, e.rec.frameCount) ?? 0;
        e.video.currentTime = tickTimeSeconds(tick, e.rec.fps, e.rec.inSeconds);
        void e.video.play().catch(() => {});
      });
    }
  });
}

/**
 * Create (or return) the live machinery for a video record and hand back its
 * CachedAsset for the scene asset cache. Resolves once the first frame (tick 0,
 * exact) is in the raster.
 */
export async function ensureVideoAsset(
  rec: VideoAssetRecord,
  bytes: Uint8Array,
): Promise<CachedAsset> {
  const existing = entries.get(rec.id);
  if (existing) return existing.asset;

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: rec.mime }));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const ready = onceEvent(video, 'loadeddata');
  video.src = url;
  await ready;

  // The ONE raster-dims rule (core/video-frames) at the CROP-AWARE long (S2): the scene
  // lattice long, grown so a reframed clip's cropped-to-fill window lands >= 1 texel/cell
  // (== Burn's detail). The export decoder derives the same shape from rec.w/h via the same
  // videoRasterLongForCoverage formula, so live and exported rasters align cell-for-cell.
  const { w, h } = coverageRasterDims(
    rec,
    sceneRasterLong(),
    video.videoWidth || rec.w,
    video.videoHeight || rec.h,
  );
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('video raster canvas unavailable');

  const entry: VideoEntry = {
    rec,
    video,
    url,
    canvas,
    ctx,
    asset: {
      w,
      h,
      tones: new Uint8Array(w * h),
      covered: new Uint8Array(w * h),
      per: detailFactor(),
    },
    seq: 0,
  };
  await seekExact(entry, tickTimeSeconds(0, rec.fps, rec.inSeconds));
  grab(entry);
  entries.set(rec.id, entry);
  initTransportSync();
  return entry.asset;
}

/**
 * LIVE loop hook — called by the scene render before resolveSceneGrid while the
 * transport runs. `frame` is the ABSOLUTE export frame: a clip that
 * OUTLASTS the loop advances absolutely (each loop pass shows the next stretch,
 * live == export), a shorter clip tiles per loop cycle exactly as before — both via
 * the SAME clipTickForFrame the export decoder uses (F from the loop store). For any
 * clip <= the loop the mapping collapses to today's per-cycle tick, byte-identical.
 * For each placed video: drift-correct the previewer element against the canonical
 * tick time (handles the wrap + a paused/ended element) and grab its current frame.
 */
export function updateVideoFrames(nodes: SceneNode[], frame: number): void {
  if (entries.size === 0) return;
  const F = Math.max(1, useLoopStore.getState().meta.frames);
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.assetId)) continue;
    const entry = entries.get(n.assetId);
    if (!entry) continue;
    seen.add(n.assetId);
    const { rec, video } = entry;
    const tick = layerTick(n.clips, frame, rec.frameCount);
    if (tick === null) continue; // the layer is off here (a gap in its timing)
    const t = tickTimeSeconds(tick, rec.fps, rec.inSeconds);
    // The previewer runs at the clip's own speed (3c) × the live knob, so it keeps pace
    // instead of drift-seeking every frame.
    const L = Math.max(1, F);
    const clipRate = n.clips ? (clipAt(n.clips, ((frame % L) + L) % L)?.speed ?? 1) : 1;
    const rate = useLoopStore.getState().speed * clipRate;
    if (video.playbackRate !== rate) video.playbackRate = rate;
    if (Math.abs(video.currentTime - t) > DRIFT_SEC) video.currentTime = t;
    if (video.paused) void video.play().catch(() => {}); // e.g. the source hit its end
    grab(entry);
  }
}

/**
 * Rebuild every live previewer raster at a NEW lattice long edge (a manual scene-
 * resolution change while videos exist — the auto-adopt path runs before placement, so
 * only this case needs a re-init). Cheapest correct path: keep the video element +
 * decoder, resize the grab canvas, allocate a new raster at the new dims, and re-grab
 * the current frame. Returns [assetId, newAsset] pairs for the scene asset cache (the
 * raster OBJECT changes because its byte length changes — the caller must re-register).
 */
export function rebuildVideoRasters(long: number, per = 1): Array<[string, CachedAsset]> {
  const out: Array<[string, CachedAsset]> = [];
  entries.forEach((e, id) => {
    // Crop-aware (S2): the target long is the new scene lattice grown for this record's
    // reframe crop, so a reframed clip re-rasterizes big enough to stay >= 1 texel/cell.
    const { w, h } = coverageRasterDims(
      e.rec,
      long,
      e.video.videoWidth || e.rec.w,
      e.video.videoHeight || e.rec.h,
    );
    if (w === e.asset.w && h === e.asset.h && (e.asset.per ?? 1) === per) return;
    e.canvas.width = w;
    e.canvas.height = h;
    e.asset = { w, h, tones: new Uint8Array(w * h), covered: new Uint8Array(w * h), per };
    if (e.video.readyState >= 2) grab(e); // repaint at the new dims from the current frame
    out.push([id, e.asset]);
  });
  return out;
}

/** Release a video's machinery (Library element deleted OR swept unreachable, W6).
 *  Pauses the offscreen element, drops its blob URL + decoder, and removes the entry
 *  so a long Record session doesn't accumulate video previewers. Safe on non-videos. */
export function releaseVideoAsset(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.video.pause();
  entry.video.removeAttribute('src');
  entry.video.load(); // force the media element to drop its decoded buffers
  URL.revokeObjectURL(entry.url);
  entries.delete(id);
}

// ---- GC accessors (W6 / P9) --------------------------------------------------

/** Ids of the live video previewer entries. */
export function videoAssetIds(): string[] {
  return [...entries.keys()];
}
