import { ASPECT_RATIO, computeGrid, FRAME_LONG, type AspectId } from '../core/dither-constants';
import { downscale } from '../core/downscale';
import { applyToneLut, isNeutralTone, toneLut, type Tone } from '../core/tone';

// Long-edge resolution of the preview "screen" before the chunky upscale — the ONE shared
// aspect-frame long (core/dither-constants), the same number the scene "Pixel" lattice uses.
const PREVIEW_MAX = FRAME_LONG;

export interface SourceGrid {
  rgba: Uint8ClampedArray;
  LW: number;
  LH: number;
}

/** A burn source: a still image, a mutable canvas (the B9 cutout), or a video
 *  (Group B video burn — the current frame is dithered through the same path). */
export type BurnSource = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

/** Intrinsic pixel size of a burn source. */
export function sourceSize(src: BurnSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLCanvasElement) return { w: src.width, h: src.height };
  return { w: src.naturalWidth, h: src.naturalHeight };
}

/** The target aspect-frame size (px) a source is placed into before downscaling —
 *  the same frame sourceToGrid + frameToSource use. Exposed so the B9 brush cursor
 *  can convert a source-pixel radius into on-screen pixels. */
export function targetFrame(aspect: AspectId): { targetW: number; targetH: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  return {
    targetW: rw >= rh ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rw) / rh),
    targetH: rh >= rw ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rh) / rw),
  };
}

/** Reframe within the aspect frame (Stage 8). zoom 1 = fit (contain); >1 crops
 *  in. offsetX/Y pan as a fraction of the frame. */
export interface Reframe {
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Degrees about the picture centre (canvas photo layers). 0/absent = the
   *  unrotated draw, byte-identical to before. */
  rotation?: number;
}

/**
 * Any canvas-drawable source (a still image OR a decoded video frame on a canvas)
 * -> downscaled cell-grid RGBA, via the one shared downscale rule. This
 * is the single seam so the live preview, the still export, AND video frames (F3,
 * Group B) all dither byte-identical grids — `preview == export` holds under motion
 * too.
 *
 * `aspect` shapes the output frame (square / landscape / portrait); `reframe`
 * zooms/pans the source inside it (default = fit-contain). The frame starts fully
 * transparent, so off-frame areas AND any source transparency carry alpha 0 through
 * the downscale and on to the export (Stage 9).
 */
export function sourceToGrid(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  cellSize: number,
  aspect: AspectId,
  reframe?: Reframe,
  tone?: Tone,
): SourceGrid {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];

  // Fixed target-aspect frame at PREVIEW_MAX on the long edge → grid cells.
  const targetW = rw >= rh ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rw) / rh);
  const targetH = rh >= rw ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rh) / rw);
  const { LW, LH } = computeGrid(targetW, targetH, cellSize);

  // Place the source in the frame: zoom 1 = contain (whole frame fits); the pan
  // offset shifts it. Anything outside the frame is cropped by the canvas bounds;
  // empty space is left transparent.
  const baseScale = Math.min(targetW / srcW, targetH / srcH);
  const zoom = reframe?.zoom ?? 1;
  const drawW = srcW * baseScale * zoom;
  const drawH = srcH * baseScale * zoom;
  const drawX = (targetW - drawW) / 2 + (reframe?.offsetX ?? 0) * targetW;
  const drawY = (targetH - drawH) / 2 + (reframe?.offsetY ?? 0) * targetH;

  const tmp = document.createElement('canvas');
  tmp.width = targetW;
  tmp.height = targetH;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  // No fill — the canvas starts fully transparent.
  const rot = reframe?.rotation ?? 0;
  if (rot) {
    // Rotate the SOURCE as it is sampled into the frame (never a dithered bitmap).
    ctx.translate(drawX + drawW / 2, drawY + drawH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(src, drawX, drawY, drawW, drawH);
  }
  const px = ctx.getImageData(0, 0, targetW, targetH).data;

  const rgba = downscale(px, targetW, targetH, LW, LH);
  // G3 pre-dither tone (gamma/levels): treat the grid bytes HERE, at the one
  // seam every consumer shares — GPU preview, CPU export, video frames all see
  // identical treated bytes, so preview == export is structural.
  if (!isNeutralTone(tone)) applyToneLut(rgba, toneLut(tone!));
  return { rgba, LW, LH };
}

/** Still-image OR canvas source (the Burn mode; the canvas is the B9 cutout). */
export function imageToGrid(
  image: BurnSource,
  cellSize: number,
  aspect: AspectId,
  reframe?: Reframe,
  tone?: Tone,
): SourceGrid {
  const { w, h } = sourceSize(image);
  return sourceToGrid(image, w, h, cellSize, aspect, reframe, tone);
}

/** Downscale a source straight to the Draw-doc grid (long edge = `docLong`) at the
 *  given aspect/reframe — used to seed the shared stage base so the base
 *  lines up cell-for-cell with the Draw doc. The cellSize is chosen so the grid's
 *  long edge lands on `docLong` (PREVIEW_MAX is the long edge of the source frame). */
export function sourceToDocGrid(
  src: BurnSource,
  aspect: AspectId,
  docLong: number,
  reframe?: Reframe,
  tone?: Tone,
): SourceGrid {
  return imageToGrid(src, PREVIEW_MAX / docLong, aspect, reframe, tone);
}

/**
 * INVERSE of `sourceToGrid`'s placement (B9 brush): a point given as a fraction
 * [0,1] of the displayed aspect frame -> the source pixel under it. Mirrors the
 * exact `drawX/drawY/baseScale/zoom` math above so the cleanup brush lands on the
 * right source pixel even when the image is reframed (zoomed/panned).
 */
export function frameToSource(
  nx: number,
  ny: number,
  srcW: number,
  srcH: number,
  aspect: AspectId,
  reframe?: Reframe,
): { x: number; y: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  const targetW = rw >= rh ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rw) / rh);
  const targetH = rh >= rw ? PREVIEW_MAX : Math.round((PREVIEW_MAX * rh) / rw);
  const baseScale = Math.min(targetW / srcW, targetH / srcH);
  const zoom = reframe?.zoom ?? 1;
  const drawW = srcW * baseScale * zoom;
  const drawH = srcH * baseScale * zoom;
  const drawX = (targetW - drawW) / 2 + (reframe?.offsetX ?? 0) * targetW;
  const drawY = (targetH - drawH) / 2 + (reframe?.offsetY ?? 0) * targetH;
  const s = baseScale * zoom;
  return { x: (nx * targetW - drawX) / s, y: (ny * targetH - drawY) / s };
}

/**
 * A saved Burn reframe → the equivalent CROP on a Record video node, in the
 * element's raster-cell coords (the same units node.crop uses). The visible
 * source rect is the inverse mapping of the aspect frame's corners (the exact
 * frameToSource math), clamped to the source and scaled to the raster. Returns
 * null when nothing is actually cropped (neutral reframe, or the whole source
 * stays visible) so the node drops uncropped exactly like before.
 */
export function reframeCropCells(
  srcW: number,
  srcH: number,
  aspect: AspectId,
  reframe: Reframe | undefined,
  rasterW: number,
  rasterH: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!reframe || (reframe.zoom === 1 && reframe.offsetX === 0 && reframe.offsetY === 0))
    return null;
  if (srcW <= 0 || srcH <= 0 || rasterW <= 0 || rasterH <= 0) return null;
  const a = frameToSource(0, 0, srcW, srcH, aspect, reframe);
  const b = frameToSource(1, 1, srcW, srcH, aspect, reframe);
  const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
  // Source-pixel window visible in the frame → raster cells (round to the lattice).
  const x = Math.round((clamp(a.x, srcW) * rasterW) / srcW);
  const y = Math.round((clamp(a.y, srcH) * rasterH) / srcH);
  const x1 = Math.round((clamp(b.x, srcW) * rasterW) / srcW);
  const y1 = Math.round((clamp(b.y, srcH) * rasterH) / srcH);
  const w = Math.max(1, x1 - x);
  const h = Math.max(1, y1 - y);
  if (x === 0 && y === 0 && w === rasterW && h === rasterH) return null; // full frame
  return { x, y, w, h };
}

/**
 * The video tone-raster LONG edge that keeps a REFRAMED (zoom-cropped) video from
 * reading blockier in Record than it did in Burn.
 *
 * The video previewer raster is sized to the scene long edge, but the node is scaled to
 * FILL the scene by its saved reframe CROP (a sub-rect of the raster). Sampling a cropped
 * sub-rect of a scene-long raster stretched over the full scene means < 1 raster texel per
 * scene cell (a zoom-1.4 reframe leaves ~0.7 texel/cell → visibly coarse). To land >= 1
 * texel/cell the raster must be big enough that, after the crop is filled to the scene, the
 * node's placement scale is <= 1 (no magnification) — i.e. the crop spans at least as many
 * raster texels as the scene cells it covers, on BOTH axes.
 *
 * Formula: with crop fractions (fw, fh) = the visible source rect / the source (constant
 * across raster sizes), and the scene lattice dims (sceneW, sceneH), the required raster
 * long edge is the smallest L such that `videoRasterDims(srcW, srcH, L)` gives crop.w >=
 * sceneW AND crop.h >= sceneH. CAP at the source's native long edge (never upsample past
 * the source — beyond it the detail simply isn't there, an inherent, bounded floor) and
 * FLOOR at the scene long edge (a full-frame video already fills 1:1, so it stays exactly
 * `sceneLong` — byte-identical to the pre-fix behaviour, the golden-parity shape). Neutral
 * / full-frame reframe returns `sceneLong` unchanged.
 *
 * Shared by the LIVE previewer (ui/video-assets) and the EXPORT decoder (platform/
 * loop-export) so live == export by one formula.
 */
export function videoRasterLongForCoverage(
  srcW: number,
  srcH: number,
  aspect: AspectId,
  reframe: Reframe | undefined,
  sceneW: number,
  sceneH: number,
  sceneLong: number,
): number {
  // Crop fractions at NATIVE (raster == source) so fw/fh are the true visible fractions,
  // reusing the exact reframeCropCells clamp/round so live == export == the drop crop.
  const nativeCrop = reframeCropCells(srcW, srcH, aspect, reframe, srcW, srcH);
  if (!nativeCrop || srcW <= 0 || srcH <= 0) return sceneLong; // full-frame → plain lattice
  const fw = nativeCrop.w / srcW;
  const fh = nativeCrop.h / srcH;
  if (fw <= 0 || fh <= 0) return sceneLong; // degenerate guard
  const sourceLong = Math.max(srcW, srcH);
  // videoRasterDims maps L → the raster; invert per axis for the crop >= scene requirement.
  // Landscape source: rw = L, rh = L*srcH/srcW → L >= sceneW/fw and L >= sceneH*srcW/(srcH*fh).
  // Portrait source: rh = L, rw = L*srcW/srcH → L >= sceneH/fh and L >= sceneW*srcH/(srcW*fw).
  const needed =
    srcW >= srcH
      ? Math.max(sceneW / fw, (sceneH * srcW) / (srcH * fh))
      : Math.max(sceneH / fh, (sceneW * srcH) / (srcW * fw));
  return Math.min(sourceLong, Math.max(sceneLong, Math.ceil(needed)));
}

/**
 * Decoded-video-frame source (F3, Group B). A raw RGBA frame buffer is put onto a
 * canvas and run through the EXACT same path as `imageToGrid`, so a burned video
 * matches the live preview frame-for-frame.
 */
export function frameToGrid(
  rgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  cellSize: number,
  aspect: AspectId,
  reframe?: Reframe,
  tone?: Tone,
): SourceGrid {
  const frame = document.createElement('canvas');
  frame.width = srcW;
  frame.height = srcH;
  const fctx = frame.getContext('2d');
  if (!fctx) throw new Error('2D canvas context unavailable');
  // Copy into a fresh ArrayBuffer-backed clamped array (ImageData requires one).
  const data = new Uint8ClampedArray(rgba);
  fctx.putImageData(new ImageData(data, srcW, srcH), 0, 0);
  return sourceToGrid(frame, srcW, srcH, cellSize, aspect, reframe, tone);
}
