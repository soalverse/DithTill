// =============================================================================
// The DETERMINISTIC loop export (P8). Walks INTEGER
// frames 0..T−1 through the pure renderLoopFrameRaster pipe (evaluateScene →
// resolveSceneGrid → the indexed raster the PNG export compresses) and streams each
// frame straight into the codec — native in the desktop app, wasm on the web. No temp
// PNGs, no chunk files, no stitching: the encoder holds only its compressed packets.
//
// Formats: MP4 (H.264 + the canonical Loop-Sound mix as AAC) and looping GIF (silent).
// Long exports (T > F) are MP4-only: a cycle-identical scene renders ONE cycle
// and the encoder repeats it (D4); otherwise every absolute frame is rendered (D3).
//
// Video elements: exact frames are decoded by the codec in BOUNDED tiles, selected by the
// SAME pure rules (core/video-frames) and converted by the SAME RGBA→tone function
// (gridToBase at neutral treatment) as the live previewer. The golden parity suite
// (tests/loop-export-parity.test.ts) enforces that edge cell-for-cell.
// =============================================================================
import { save } from '@tauri-apps/plugin-dialog';
import {
  loopTrailReach,
  primeLoopTrail,
  renderLoopFrameRaster,
  trailPastFrame,
  type LoopRenderInput,
} from '../core/loop-render';
import { planFrameTiles, type DecodeTile } from '../core/video-decode';
import {
  AUDIO_RATE,
  buildLoopAudioMix,
  loopSampleCount,
  type LoopAudioSource,
} from '../core/loop-audio';
import { GIF_MAX_SECONDS } from '../core/export-length';
import { fastPathEligible } from '../core/loop-export-plan';
import { layerTick, selectFrameForTicks, videoRasterDims } from '../core/video-frames';
import type { TimelineClip } from '../core/timeline-edit';
import { quantizeContrast } from '../core/dither-constants';
import { gridToBase } from '../state/stage-store';
import type { CachedAsset } from '../core/scene-resolver';
import type { VideoAssetRecord } from '../core/library';
import { getCodec, type Codec, type CodecEncoder, type CodecVideo } from './codec';
import { codecFrame } from './codec-wasm';
import { saveBytesToDisk } from './save-png';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type LoopExportFormat = 'mp4' | 'gif';

/** Source frames decoded per codec call — bounds peak decoded-frame memory. */
export const LOOP_DECODE_TILE_FRAMES = 64;

export interface LoopExportInput {
  /** The pure render input MINUS videoRasterAt (wired up here from `videos`). */
  render: Omit<LoopRenderInput, 'videoRasterAt'>;
  /** Loop clock rate (meta.fps) — the output frame rate. */
  fps: number;
  /** Placed video elements: the Library record + its full source bytes + the CROP-AWARE
   *  tone-raster long edge (S2). The ui builder computes `rasterLong` from the scene lattice
   *  dims + the clip's reframe via videoRasterLongForCoverage — the SAME formula the live
   *  previewer uses (ui/video-assets), so live == export cell-for-cell. Passed as plain data
   *  so this deterministic module stays ui-free (the determinism lint). A full-frame clip's
   *  value == the scene lattice long (byte-identical golden parity). */
  videos: {
    assetId: string;
    rec: VideoAssetRecord;
    bytes: Uint8Array;
    rasterLong: number;
    /** Picture values per canvas square (the project's Detail; absent = 1). */
    per?: number;
    /** The layer's timing clips; absent = untimed. */
    clips?: readonly TimelineClip[];
  }[];
  /** v15: the Loop-Sound inputs for the MP4 (audio-engine.exportAudioInputs). */
  audio: LoopExportAudio | null;
  /** F5: the container the on-glass panel chose. Omitted → MP4. A GIF is at most
   *  GIF_MAX_SECONDS long; longer is MP4 only. */
  format?: LoopExportFormat;
  /** The song frame the export starts at — the MARKED PART's start; its length
   *  is `render.totalFrames`. Absent = 0 (the whole video from the top). */
  startFrame?: number;
  /** The file name without extension (the project's name). Default dithtill-loop. */
  fileName?: string;
}

export interface LoopExportCallbacks {
  onStatus?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** The canonical Loop-Sound inputs (P6 / v15): the UNMUTED sources' decoded PCM
 *  + the stored seam-fade flag, passed as PLAIN DATA by the ui builder — this
 *  deterministic module never touches the live audio engine (the lint). null =
 *  without-audio (or all muted) → a silent MP4. */
export interface LoopExportAudio {
  sources: LoopAudioSource[];
  seamFade: boolean;
}

/** How many decoded tiles' rasters stay resident (a bounded LRU). The single-pass
 *  walk visits tiles monotonically (each once), but a long export's loop-cycling
 *  re-visits a SHORT clip's early tiles every cycle (clipTickForFrame restarts at
 *  the loop boundary) — keeping the last few tiles stops that thrash from
 *  re-decoding. Bounds memory to ~4 tiles; caching only affects SPEED (decode is
 *  deterministic), so the output is byte-identical whatever the eviction. */
const TILE_LRU = 4;

/**
 * One placed video's exact-frame source for the export walk. Reads the trim window's
 * frame times once, maps every ABSOLUTE export frame to its clip tick (the ONE layer
 * tick rule — an OUTLASTING clip advances absolutely, a shorter clip tiles per loop
 * cycle), then decodes BOUNDED tiles on demand as the walk advances. A
 * small LRU of recent tiles is resident so a short clip's per-cycle re-visits don't
 * re-decode.
 */
class VideoTickSource {
  private selection!: Int32Array;
  private tiles!: DecodeTile[];
  private pts!: number[];
  private video!: CodecVideo;
  private dims: { w: number; h: number };
  // tileIndex → (sourceFrameIdx → tone raster). A Map keeps insertion order, so it
  // doubles as the LRU list (touch = delete+re-set; evict = the first key).
  private tileCache = new Map<number, Map<number, CachedAsset>>();
  private empty: CachedAsset;

  constructor(
    private readonly rec: VideoAssetRecord,
    private readonly bytes: Uint8Array,
    rasterLong: number,
    /** The layer's timing clips in song frames — absent = untimed. */
    private readonly clips?: readonly TimelineClip[],
  ) {
    // Scene-resolution pass + S2 crop-aware sizing: `rasterLong` is the scene lattice long
    // GROWN for this clip's reframe crop (computed by the ui builder via the SAME
    // videoRasterLongForCoverage formula the live previewer uses), so live == export
    // cell-for-cell. A raster-sized source decodes scale-free (the golden fixture).
    this.dims = videoRasterDims(rec.w, rec.h, rasterLong);
    this.empty = {
      w: this.dims.w,
      h: this.dims.h,
      tones: new Uint8Array(this.dims.w * this.dims.h),
      covered: new Uint8Array(this.dims.w * this.dims.h),
    };
  }

  async init(codec: Codec): Promise<void> {
    this.video = await codec.openVideo(this.bytes);
    this.pts = await this.video.frameTimes(this.rec.inSeconds, this.rec.outSeconds);
    this.selection = selectFrameForTicks(
      this.pts,
      this.rec.frameCount,
      this.rec.fps,
      this.rec.inSeconds,
    );
    this.tiles = planFrameTiles(
      this.pts,
      LOOP_DECODE_TILE_FRAMES,
      this.rec.inSeconds,
      this.rec.outSeconds,
    );
  }

  close(): Promise<void> {
    return this.video?.close() ?? Promise.resolve();
  }

  /** The source-frame index + owning tile for an ABSOLUTE export frame, under the
   *  two-clock rule. Pure lookup — no decode. Returns null when the clip is empty. */
  private locate(frame: number): { idx: number; tile: number } | null {
    if (this.pts.length === 0) return null;
    // The ONE layer tick rule (live == export): untimed → two-clock; timed → its clip.
    const tick = layerTick(this.clips, frame, this.rec.frameCount);
    if (tick === null) return null; // the layer is off at this frame
    const idx = this.selection[tick];
    const tile = this.tiles.findIndex((tl) => idx >= tl.start && idx < tl.end);
    if (tile < 0) throw new Error(`video decode: no tile for source frame ${idx}`);
    return { idx, tile };
  }

  /** Ensure this ABSOLUTE frame's tick raster is decoded (advances/touches the LRU). */
  async prepare(frame: number): Promise<void> {
    const at = this.locate(frame);
    if (!at) return;
    const cached = this.tileCache.get(at.tile);
    if (cached) {
      this.tileCache.delete(at.tile); // touch: move to the LRU tail
      this.tileCache.set(at.tile, cached);
      return;
    }
    await this.decodeTile(at.tile);
  }

  /** The raster for this ABSOLUTE frame — sync; call prepare() first. */
  rasterAt(frame: number): CachedAsset {
    const at = this.locate(frame);
    if (!at) return this.empty;
    return this.tileCache.get(at.tile)?.get(at.idx) ?? this.empty;
  }

  private async decodeTile(t: number): Promise<void> {
    const tile = this.tiles[t];
    const n = tile.end - tile.start;
    const { w, h } = this.dims;
    const rgba = await this.video.decode(
      this.rec.inSeconds,
      this.rec.outSeconds,
      tile.start,
      n,
      w,
      h,
    );
    const size = w * h * 4;
    if (rgba.length !== n * size)
      throw new Error(`video decode: tile ${t} returned ${rgba.length / size} of ${n} frames`);
    const tileRasters = new Map<number, CachedAsset>();
    for (let i = 0; i < n; i++) {
      // THE one conversion truth: gridToBase at NEUTRAL contrast/invert — the
      // node/scene Look does the treating at resolve time (same as live).
      const { tones, covered } = gridToBase(
        rgba.subarray(i * size, (i + 1) * size),
        w,
        h,
        quantizeContrast(1),
        false,
      );
      tileRasters.set(tile.start + i, { w, h, tones, covered });
    }
    this.tileCache.set(t, tileRasters); // newest at the LRU tail
    while (this.tileCache.size > TILE_LRU) {
      const oldest = this.tileCache.keys().next().value as number;
      this.tileCache.delete(oldest); // drop the least-recently-used tile's rasters
    }
  }
}

const FORMAT_SPECS: Record<LoopExportFormat, { name: string; ext: string; mime: string }> = {
  mp4: { name: 'MP4 video', ext: 'mp4', mime: 'video/mp4' },
  gif: { name: 'Animated GIF', ext: 'gif', mime: 'image/gif' },
};

/** Hand the browser a turn. The web codec's calls are synchronous inside resolved promises, so
 *  without this an export never lets the page repaint or take a click (progress + Cancel).
 *  A message, not a timer: timers crawl in a background tab. Output is unaffected. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Pick the format from a saved path's extension (the dialog's filter). */
export function formatForPath(path: string): LoopExportFormat | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  const ext = m ? m[1].toLowerCase() : '';
  return (
    (Object.keys(FORMAT_SPECS) as LoopExportFormat[]).find((f) => FORMAT_SPECS[f].ext === ext) ??
    null
  );
}

/**
 * Export the loop as MP4 / GIF. Returns the saved path (the downloaded file name on the
 * web), or null if the user cancels the save dialog. Throws on a codec failure or a
 * mid-render cancel (`signal`). Deterministic by construction: integer frames, the
 * stored seed, no wall clock, no live speed.
 *
 * F = the canvas loop length (render.frames); T = the EXPORT length (render.totalFrames,
 * default F), starting at song frame `startFrame` (the marked part; else 0). A
 * GIF is at most GIF_MAX_SECONDS. From the top, a cycle-identical long scene renders one
 * cycle the encoder repeats (D4); otherwise every frame renders (D3).
 */
export async function exportLoop(
  input: LoopExportInput,
  cb: LoopExportCallbacks = {},
): Promise<string | null> {
  const F = Math.max(1, input.render.frames);
  const T = Math.max(1, input.render.totalFrames ?? input.render.frames);
  const start = Math.max(0, Math.round(input.startFrame ?? 0));
  const isLong = T > F;
  const format: LoopExportFormat = input.format ?? 'mp4';
  if (format === 'gif' && T / Math.max(1, input.fps) > GIF_MAX_SECONDS)
    throw new Error(`A GIF can be up to ${GIF_MAX_SECONDS} seconds — export MP4 for longer.`);
  const spec = FORMAT_SPECS[format];

  // Desktop: choose the destination first (the native codec writes it directly).
  let outPath: string | null = null;
  if (isTauri()) {
    outPath = await save({
      defaultPath: `${input.fileName ?? 'dithtill-loop'}.${spec.ext}`,
      filters: [{ name: spec.name, extensions: [spec.ext] }],
    });
    if (!outPath) return null;
    if (formatForPath(outPath) !== format)
      throw new Error(`Save the file as .${spec.ext} — ${spec.name} was selected.`);
  }

  cb.onStatus?.('Starting the encoder…');
  await yieldToPage();
  const codec = await getCodec();
  const sources = new Map<string, VideoTickSource>();
  let enc: CodecEncoder | null = null;
  try {
    // 1. Video elements: frame times + tick selection (decode happens per tile).
    if (input.videos.length > 0) cb.onStatus?.('Reading video elements…');
    for (const v of input.videos) {
      if (sources.has(v.assetId)) continue;
      const src = new VideoTickSource(v.rec, v.bytes, v.rasterLong, v.clips);
      sources.set(v.assetId, src);
      await src.init(codec);
    }
    const render: LoopRenderInput = {
      ...input.render,
      // Called with the ABSOLUTE export frame — the source owns the clip-tick rule.
      videoRasterAt: (assetId, frame) => {
        const r = sources.get(assetId)?.rasterAt(frame) ?? null;
        const per = input.videos.find((v) => v.assetId === assetId)?.per;
        return r && per && per !== 1 ? { ...r, per } : r;
      },
      // Trails (J5): each frame renders once; the walk keeps the recent ones.
      trailMemory: new Map(),
    };

    // 2. D4: a cycle-identical long scene renders ONE cycle; the encoder repeats it.
    const cycle =
      isLong &&
      start === 0 &&
      fastPathEligible({
        totalFrames: T,
        frames: F,
        events: input.render.events,
        nodes: input.render.nodes,
        features: input.render.features,
        videoFrameCounts: input.videos.map((v) => v.rec.frameCount),
        beat: input.render.beat,
        canvasMods: input.render.canvasMods,
        canvasMotion: input.render.canvasMotion,
        layerLoops: input.render.layerLoops,
      });
    const walk = cycle ? F : T;

    // 3. Trails read the frames before the first: pre-roll them (a loop's first frames
    //    trail its last), so a marked part starts with the same trail it plays with.
    const reach = loopTrailReach(render);
    for (let a = reach; a >= 1; a--) {
      if (cb.signal?.aborted) throw new Error('cancelled');
      const k = start - a;
      for (const src of sources.values()) await src.prepare(trailPastFrame(render, k));
      primeLoopTrail(render, render.trailMemory!, k);
      await yieldToPage();
    }

    // 4. Walk INTEGER frames through the pure pipe, straight into the encoder.
    cb.onStatus?.(cycle ? 'Rendering cycle…' : 'Rendering frames…');
    for (let f = 0; f < walk; f++) {
      if (cb.signal?.aborted) throw new Error('cancelled');
      for (const src of sources.values()) await src.prepare(start + f);
      const frame = codecFrame(renderLoopFrameRaster(render, start + f));
      enc ??= await codec.createEncoder({
        container: format,
        width: frame.width,
        height: frame.height,
        fps: input.fps,
        ...(cycle ? { cycle: { frames: F, total: T } } : {}),
      });
      await enc.pushFrame(frame);
      cb.onProgress?.(f + 1, walk);
      await yieldToPage();
    }

    // 5. MP4: the canonical Loop-Sound mix, rebuilt from the PURE inputs (never the live
    //    engine — the lint) over the whole export length; the encoder trims it to the
    //    picture. The same buildLoopAudioMix the live engine plays → hear == export.
    if (format === 'mp4' && input.audio && input.audio.sources.length > 0) {
      cb.onStatus?.('Rendering audio…');
      await yieldToPage();
      const full = buildLoopAudioMix(
        input.audio.sources,
        F,
        input.fps,
        input.audio.seamFade,
        AUDIO_RATE,
        start + T,
      );
      // A marked part: the same song-time mix, cut to the part.
      const a = start > 0 ? loopSampleCount(start, input.fps, AUDIO_RATE) : 0;
      const mix = a > 0 ? { left: full.left.subarray(a), right: full.right.subarray(a) } : full;
      await enc!.setAudio(mix, AUDIO_RATE);
    }

    cb.onStatus?.('Encoding…');
    await yieldToPage();
    const bytes = await enc!.finish(outPath ?? undefined);
    enc = null;
    if (outPath) return outPath;
    return await saveBytesToDisk(
      bytes!,
      `${input.fileName ?? 'dithtill-loop'}.${spec.ext}`,
      spec.mime,
    );
  } finally {
    await enc?.abort();
    for (const src of sources.values()) await src.close().catch(() => {});
  }
}
