// =============================================================================
// Library actions — the browser-side glue that flattens the current
// stage into a Library element, renders its thumbnail, loads an element back onto
// the Draw stage, and batch-exports selected elements. The pure content-address
// + store logic lives in core/library + state/library-store; this file holds the
// DOM/canvas parts (snapshot, thumbnail, save dialog).
// =============================================================================
import { useBurnStore } from '../state/burn-store';
import { snapshotComposite, DRAW_LONG } from '../state/draw-store';
import { useStageStore, gridToBase } from '../state/stage-store';
import { useLibraryStore } from '../state/library-store';
import {
  type Composite,
  compositeCellIndex,
  compositeHasContent,
  encodeCompositePng,
} from '../core/composite';
import {
  PALETTES,
  quantizeContrast,
  type AspectId,
  type MatrixId,
  type PaletteId,
} from '../core/dither-constants';
import { LOOK_CELL_SIZE_DEFAULT, type AssetRecord, type CompositeLook } from '../core/library';
import { VIDEO_FPS } from '../core/video-frames';
import { sourceToDocGrid } from './image-to-grid';
import { notifyBanner, notifyConfirm, folderName } from '../state/notify-store';
import { saveBytesToDisk, savePngToDisk } from '../platform/save-png';

/** NEAREST upscale for the baked PNG (matches the Draw export's crisp size). */
const BAKE_SCALE = 6;

interface CurrentComposite {
  composite: Composite;
  palette: PaletteId;
  matrix: MatrixId;
  aspect: AspectId;
}

/** Crisp integer upscale for the stored thumbnail so the (smaller) backpack tile
 *  always SMOOTH-downscales from a rich source — never nearest-decimates the
 *  1-bit dither (which moirés into "blocky" mush). */
const THUMB_SRC_SCALE = 2;

/** Render a composite to a PNG data URL for the backpack grid. The dither is
 *  rendered at cell resolution then upscaled crisply; the tile then downsamples
 *  it smoothly (CSS) into a clean miniature (the dither blends into its tones —
 *  the faithful small view of a dithered image). */
function compositeThumbnail(c: Composite, palette: PaletteId, matrix: MatrixId): string {
  const pal = PALETTES[palette];
  const N = pal.length / 3;
  const cell = document.createElement('canvas');
  cell.width = c.w;
  cell.height = c.h;
  const ctx = cell.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(c.w, c.h);
  const d = img.data;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const i = y * c.w + x;
      const o = i * 4;
      if (!c.covered[i]) {
        d[o + 3] = 0;
        continue;
      }
      const idx = compositeCellIndex(c.tones[i], x, y, N, matrix, c.fine ? c.fine[i] : 0);
      d[o] = pal[idx * 3];
      d[o + 1] = pal[idx * 3 + 1];
      d[o + 2] = pal[idx * 3 + 2];
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = c.w * THUMB_SRC_SCALE;
  out.height = c.h * THUMB_SRC_SCALE;
  const octx = out.getContext('2d');
  if (!octx) return cell.toDataURL('image/png');
  octx.imageSmoothingEnabled = false; // crisp block upscale (no fringe from the dither)
  octx.drawImage(cell, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Snapshot Burn's scene-wide look for the v4 `look` blob.
 *  These are the knobs that used to be lost Burn → Library → Record. cellStyle/dotDensity
 *  are DEVICE globals; dotSize/dotGrow are Burn's per-image globals (Record threads them
 *  onto the dropped node); dotInk/background are Burn's Swatches (background is NOT baked
 *  into Burn's square PNG, so it travels here). */
export function currentBurnLook(): CompositeLook {
  const b = useBurnStore.getState();
  return {
    cellStyle: b.cellStyle,
    dotDensity: b.dotDensity,
    dotSize: b.dotSize,
    dotGrow: b.dotGrow,
    dotInk: b.dotInk,
    background: b.background,
    // The producing "Pixel" so a fine burn's resolution can travel + be adopted in Record
    // (scene-resolution pass). This save site OMITS Burn's default (5) so a default save
    // stays neutral (undefined) + byte-identical; only a genuinely finer/coarser burn carries
    // a cellSize. (The id treats only `undefined` as neutral — see core/library.)
    ...(b.cellSize === LOOK_CELL_SIZE_DEFAULT ? {} : { cellSize: b.cellSize }),
  };
}

/** The look for a MAKE save: the device look incl. the flat BACKGROUND (kept
 *  as chrome in the look, never baked into content, so it reloads as the same exact
 *  colour). The producing Pixel travels as the record's `cell` (v5), not `look.cellSize`. */
export function currentMakeLook(): CompositeLook {
  const b = useBurnStore.getState();
  return {
    cellStyle: b.cellStyle,
    dotDensity: b.dotDensity,
    dotSize: b.dotSize,
    dotGrow: b.dotGrow,
    dotInk: b.dotInk,
    background: b.background,
  };
}

/** The Make canvas exactly as shown: base (the imported image at the Pixel grid, exact
 *  luma) + strokes — the same snapshot the canvas renders and Export writes. */
function currentComposite(): CurrentComposite {
  const b = useBurnStore.getState();
  return { composite: snapshotComposite(), palette: b.palette, matrix: b.matrix, aspect: b.aspect };
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 1 / 120) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

const fmtTime = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Save a loaded video to the Library: the whole clip, or — when the
 * timer-crop window is active — just that window, as its own standalone element.
 * The bytes are stored whole + content-addressed (segments of one source share
 * the blob); the trim is metadata. The thumbnail is a dithered grab of the
 * window's first frame (neutral treatment — the element is the RAW clip; look is
 * live at drop time like any element).
 */
export async function addVideoToLibrary(video: HTMLVideoElement): Promise<void> {
  const b = useBurnStore.getState();
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    notifyBanner('Video is still loading');
    return;
  }
  const trim = b.videoTrim;
  const inSeconds = trim ? Math.min(trim.startSec, duration) : 0;
  const outSeconds = trim ? Math.min(trim.startSec + trim.lenSeconds, duration) : duration;
  // The live spatial reframe is part of what's saved (v3): it carries to Record
  // as the dropped node's crop, and the thumbnail shows the clip as saved.
  const reframe = { zoom: b.zoom, offsetX: b.offsetX, offsetY: b.offsetY };
  try {
    const bytes = new Uint8Array(await (await fetch(video.src)).arrayBuffer());

    // Dithered thumbnail from the window's first frame (restore playback after).
    const wasPlaying = !video.paused;
    const prevTime = video.currentTime;
    video.pause();
    await seekTo(video, Math.min(inSeconds + 1 / VIDEO_FPS, duration));
    const g = sourceToDocGrid(video, b.aspect, DRAW_LONG, reframe);
    const { tones, covered } = gridToBase(g.rgba, g.LW, g.LH, quantizeContrast(1), false);
    const thumbnail = compositeThumbnail({ w: g.LW, h: g.LH, tones, covered }, b.palette, b.matrix);
    await seekTo(video, prevTime);
    if (wasPlaying) void video.play().catch(() => {});

    await useLibraryStore.getState().addVideo({
      bytes,
      mime: video.dataset.mime || 'video/mp4',
      w: video.videoWidth,
      h: video.videoHeight,
      inSeconds,
      outSeconds,
      fps: VIDEO_FPS,
      thumbnail,
      source: 'burn',
      aspect: b.aspect,
      palette: b.palette,
      matrix: b.matrix,
      reframe,
      // v4 (§8.B): persist the FULL Burn look so cellStyle/dotDensity/dotSize/dotGrow/
      // dotInk/background AND the producing Pixel (cellSize) travel to Record for a VIDEO
      // too — a fine-burned clip re-enters at its producing resolution + style (closes the
      // S1 gap: videos are the owner's primary medium). Neutral (default) look omits itself,
      // so an un-styled video save keeps its byte-identical pre-v4 id + dedupes.
      look: currentBurnLook(),
    });
    notifyBanner(
      trim ? `Saved ${fmtTime(outSeconds - inSeconds)} clip to Library` : 'Saved video to Library',
    );
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Could not save');
  }
}

/** Save the Make canvas to the library EXACTLY as shown: the
 *  native grid at its Pixel, exact luma (tones + fine), the producing `cell`, and the
 *  look. A video import saves as a video element. Deduped by content. */
export async function addCurrentToLibrary(): Promise<void> {
  const src = useBurnStore.getState().source;
  if (src instanceof HTMLVideoElement) {
    await addVideoToLibrary(src);
    return;
  }
  const cur = currentComposite();
  if (!compositeHasContent(cur.composite)) {
    notifyBanner('Nothing to add');
    return;
  }
  try {
    const png = encodeCompositePng(cur.composite, cur.palette, cur.matrix, BAKE_SCALE);
    const thumbnail = compositeThumbnail(cur.composite, cur.palette, cur.matrix);
    await useLibraryStore.getState().add({
      composite: cur.composite,
      png,
      thumbnail,
      // Provenance only: an imported image under the strokes reads as a burn.
      source: useStageStore.getState().hasBase() ? 'burn' : 'draw',
      aspect: cur.aspect,
      palette: cur.palette,
      matrix: cur.matrix,
      look: currentMakeLook(),
      cell: useBurnStore.getState().cellSize,
    });
    notifyBanner('Added to Library');
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Could not save');
  }
}

/** Export the baked PNG of each given element to disk (one save dialog per file). */
/** An element's export file name: its name (the project it came from), else
 *  a short id for older elements. */
const fileBase = (rec: AssetRecord): string =>
  rec.name?.replace(/[\\/:*?"<>|]+/g, '').trim() || `dithtill-${rec.id.slice(0, 8)}`;

export async function exportElements(recs: AssetRecord[]): Promise<void> {
  const lib = useLibraryStore.getState();
  let saved = 0;
  let lastPath: string | null = null;
  try {
    for (const rec of recs) {
      let path: string | null;
      if (rec.kind === 'video') {
        // A video element exports its source bytes (the RAW clip; the dithered
        // form is the Record loop export).
        const bytes = await lib.getBlob(rec.videoHash);
        if (!bytes) continue;
        const ext = rec.mime.includes('webm')
          ? 'webm'
          : rec.mime.includes('quicktime')
            ? 'mov'
            : 'mp4';
        path = await saveBytesToDisk(new Uint8Array(bytes), `${fileBase(rec)}.${ext}`, rec.mime);
      } else {
        const png = await lib.getBlob(rec.pngHash);
        if (!png) continue;
        path = await savePngToDisk(new Uint8Array(png), `${fileBase(rec)}.png`);
      }
      if (path) {
        saved++;
        lastPath = path;
      }
    }
    if (saved > 0 && lastPath) {
      void notifyConfirm(
        saved === 1 ? `to ${folderName(lastPath)}` : `${saved} elements to ${folderName(lastPath)}`,
        'Saved',
      );
    } else {
      notifyBanner('Export cancelled');
    }
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Export failed');
  }
}
