// =============================================================================
// IMAGE layers. An imported picture is a full-frame scene layer
// whose raster is REGENERATED from its source through the one `sourceToGrid` seam
// (imageToGrid) at the canvas Pixel grid, with its own treatment (tone dials +
// reframe) — exactly Make's base / Burn's glass, per layer. So:
//   - the canvas shows Burn's pixels bit-for-bit (exact luma: gridToBase tone + fine),
//   - panning / zooming the picture re-samples the SOURCE (never warps a dithered
//     bitmap), and a Pixel or aspect change simply regenerates it at the new grid.
// The source objects live here (out of zundo — like paint rasters); the node holds only
// the serializable params, so undo/redo of a dial just re-renders.
//
// CUTOUTS: a photo may carry an editable MASK (Remove BG fills it; the
// Erase / Restore brush paints it). Masks are alpha planes at a capped working size,
// stored by version key (node.image.matte) so every edit is one step on the ONE undo
// stack; the picture is composed (source RGB × mask) before it is sampled, so a cutout
// is still re-sampled from the source — never a warped dithered bitmap.
// =============================================================================
import { useEffect } from 'react';
import {
  useSceneStore,
  sceneDimsAt,
  detailFactor,
  type ImageLayerParams,
  type SceneNode,
} from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { gridToBase } from '../state/stage-store';
import { quantizeContrast } from '../core/dither-constants';
import { applyToneLut, isNeutralTone, toneLut } from '../core/tone';
import type { CachedAsset } from '../core/scene-resolver';
import { imageToGrid, sourceSize, targetFrame, type BurnSource } from './image-to-grid';
import { getAssetCache, setAsset } from './scene-assets';
import { notifyBanner, notifyConfirm, useNotifyStore } from '../state/notify-store';
import { removeBackground } from '../ml/bg-remove';
import { importVideoLayer } from './video-layers';
import { imageFileOf } from './load-image';

const sources = new Map<string, BurnSource>();
/** Each picture's original file / bytes — what a project stores. */
const sourceFiles = new Map<string, File | { bytes: Uint8Array; mime: string }>();
let seq = 0;

/** Free a picture nothing references any more (called by the GC sweep). */
export function evictImageSource(assetId: string): void {
  sources.delete(assetId);
  sourceFiles.delete(assetId);
  work.delete(assetId);
  for (const [id, g] of untreated)
    if (g.key.includes(JSON.stringify(assetId))) untreated.delete(id);
}

// ---- cutout masks ------------------------------------------------------------------

/** Working long edge for a cut-out photo (its mask + composed picture). The canvas frame
 *  is 480 px long, so this keeps detail well past 3× zoom while a mask stays ~2 MB. */
const MATTE_LONG = 1600;

interface PhotoWork {
  cw: number;
  ch: number;
  /** The source at working size (RGBA), read once. */
  srcData: Uint8ClampedArray;
  /** The composed picture (source × mask) handed to the sampler. */
  comp: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Which mask `comp` currently shows (undefined = not composed yet). */
  shows: string | null | undefined;
  /** The mask being painted by an in-progress stroke (null when idle). */
  live: Uint8Array | null;
}
const work = new Map<string, PhotoWork>();
/** Mask versions by key (alpha 0..255 at the photo's working size). */
const masks = new Map<string, Uint8Array>();
let maskSeq = 0;

function workFor(assetId: string): PhotoWork | null {
  const have = work.get(assetId);
  if (have) return have;
  const src = sources.get(assetId);
  if (!src || src instanceof HTMLVideoElement) return null;
  const { w, h } = sourceSize(src);
  const k = Math.min(1, MATTE_LONG / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const comp = document.createElement('canvas');
  comp.width = cw;
  comp.height = ch;
  const ctx = comp.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, cw, ch);
  const srcData = ctx.getImageData(0, 0, cw, ch).data.slice();
  const pw: PhotoWork = { cw, ch, srcData, comp, ctx, shows: undefined, live: null };
  work.set(assetId, pw);
  return pw;
}

/** Recompose `comp` = source × mask over a pixel box (the whole picture by default). */
function compose(pw: PhotoWork, mask: Uint8Array, x0 = 0, y0 = 0, x1 = pw.cw, y1 = pw.ch): void {
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;
  const img = pw.ctx.createImageData(bw, bh);
  const d = img.data;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const si = (y0 + y) * pw.cw + (x0 + x);
      const o = (y * bw + x) * 4;
      const s4 = si * 4;
      d[o] = pw.srcData[s4];
      d[o + 1] = pw.srcData[s4 + 1];
      d[o + 2] = pw.srcData[s4 + 2];
      d[o + 3] = (pw.srcData[s4 + 3] * mask[si] + 127) / 255;
    }
  }
  pw.ctx.putImageData(img, x0, y0);
}

/** What the sampler reads for a photo: the source, or its composed cutout. */
function pictureFor(node: SceneNode): BurnSource | undefined {
  const src = sources.get(node.assetId);
  const key = node.image?.matte ?? null;
  const pw = work.get(node.assetId);
  if (pw?.live) return pw.comp; // a stroke is painting it right now
  if (!src || key === null) return src;
  const mask = masks.get(key);
  const w = mask ? workFor(node.assetId) : null;
  if (!mask || !w) return src;
  if (w.shows !== key) {
    compose(w, mask);
    w.shows = key;
  }
  return w.comp;
}

/** Does this photo have a cutout? */
export const hasCutout = (node: SceneNode): boolean => !!node.image?.matte;

/** Scene cell (as displayed) → the photo's working-mask pixel, and the mask px per cell. */
function sceneToMask(
  node: SceneNode,
  pw: PhotoWork,
  dims: { w: number; h: number },
  sx: number,
  sy: number,
): { x: number; y: number; perCell: number } | null {
  const src = sources.get(node.assetId);
  const p = node.image;
  if (!src || !p) return null;
  const { w: sw, h: sh } = sourceSize(src);
  const { targetW, targetH } = targetFrame(useBurnStore.getState().aspect);
  const base = Math.min(targetW / sw, targetH / sh);
  const s = base * p.zoom; // frame px per source px
  const kx = dims.w / targetW;
  const ky = dims.h / targetH;
  // A flipped layer shows its raster mirrored — undo that first.
  const ux = node.placement.scaleX < 0 ? dims.w - sx : sx;
  const uy = node.placement.scaleY < 0 ? dims.h - sy : sy;
  const dx = ux / kx - (targetW / 2 + p.offsetX * targetW);
  const dy = uy / ky - (targetH / 2 + p.offsetY * targetH);
  const t = ((p.rotation ?? 0) * Math.PI) / 180;
  const lx = dx * Math.cos(t) + dy * Math.sin(t);
  const ly = -dx * Math.sin(t) + dy * Math.cos(t);
  const m = pw.cw / sw; // mask px per source px
  return {
    x: (lx / s + sw / 2) * m,
    y: (ly / s + sh / 2) * m,
    perCell: m / s / kx,
  };
}

export type MatteMode = 'erase' | 'restore';

/** Start an Erase/Restore stroke on a photo: paint a private copy of its current mask. */
export function beginMatteStroke(node: SceneNode): boolean {
  const pw = workFor(node.assetId);
  if (!pw) return false;
  const key = node.image?.matte ?? null;
  const cur = key !== null ? masks.get(key) : undefined;
  pw.live = cur ? cur.slice() : new Uint8Array(pw.cw * pw.ch).fill(255);
  compose(pw, pw.live);
  pw.shows = undefined;
  return true;
}

/** Paint one stroke segment (scene cells) into the photo's live mask and re-render it.
 *  `radius` is in scene cells (the brush ring). */
export function matteStroke(
  node: SceneNode,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  mode: MatteMode,
  radius: number,
): void {
  const pw = work.get(node.assetId);
  if (!pw?.live) return;
  const s = useSceneStore.getState();
  const dims = sceneDimsAt(useBurnStore.getState().aspect, s.pixel);
  const a = sceneToMask(node, pw, dims, sx0, sy0);
  const b = sceneToMask(node, pw, dims, sx1, sy1);
  if (!a || !b) return;
  const r = Math.max(0.75, radius * a.perCell);
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, r / 3)));
  const v = mode === 'erase' ? 0 : 255;
  const live = pw.live;
  let bx0 = pw.cw;
  let by0 = pw.ch;
  let bx1 = 0;
  let by1 = 0;
  for (let i = 0; i <= steps; i++) {
    const cx = a.x + ((b.x - a.x) * i) / steps;
    const cy = a.y + ((b.y - a.y) * i) / steps;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(pw.cw, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(pw.ch, Math.ceil(cy + r));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const ddx = x + 0.5 - cx;
        const ddy = y + 0.5 - cy;
        if (ddx * ddx + ddy * ddy <= r * r) live[y * pw.cw + x] = v;
      }
    }
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1);
    by1 = Math.max(by1, y1);
  }
  compose(pw, live, bx0, by0, bx1, by1);
  renderImageLayer(node);
}

/** Finish a stroke: the painted mask becomes a new version — ONE undo step. */
export function endMatteStroke(node: SceneNode): void {
  const pw = work.get(node.assetId);
  if (!pw?.live) return;
  const key = `m${++maskSeq}`;
  masks.set(key, pw.live);
  pw.live = null;
  pw.shows = key; // comp already shows exactly this mask
  useSceneStore.getState().setImageParams(node.id, { matte: key });
}

/** Remove BG on a photo (offline matte) → its cutout mask, one undo step. */
export async function removePhotoBackground(nodeId: string): Promise<void> {
  const node = useSceneStore.getState().nodes.find((n) => n.id === nodeId);
  const src = node ? sources.get(node.assetId) : undefined;
  if (!node || !src || src instanceof HTMLVideoElement) return;
  const pw = workFor(node.assetId);
  if (!pw) return;
  const setProgress = useNotifyStore.getState().setProgress;
  setProgress('Removing background…');
  try {
    const cut = await removeBackground(src);
    const c = document.createElement('canvas');
    c.width = pw.cw;
    c.height = pw.ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.drawImage(cut, 0, 0, pw.cw, pw.ch);
    const d = ctx.getImageData(0, 0, pw.cw, pw.ch).data;
    const mask = new Uint8Array(pw.cw * pw.ch);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3];
    const key = `m${++maskSeq}`;
    masks.set(key, mask);
    useSceneStore.getState().setImageParams(nodeId, { matte: key });
    notifyBanner('Background removed — Erase / Restore to tidy it');
  } catch (e) {
    console.error('Remove BG failed:', e);
    void notifyConfirm("Couldn't remove the background", 'Remove BG failed');
  } finally {
    setProgress(null);
  }
}

/** Regenerate one image layer's raster at the current canvas grid. */
export function renderImageLayer(node: SceneNode): void {
  const src = pictureFor(node);
  if (!src || !node.image) return;
  const p = node.image;
  const scene = useSceneStore.getState();
  const aspect = useBurnStore.getState().aspect;
  // At the project's Detail: Fine samples the picture 4× finer each way.
  const f = detailFactor();
  const g = imageToGrid(
    src,
    scene.pixel / f,
    aspect,
    { zoom: p.zoom, offsetX: p.offsetX, offsetY: p.offsetY, rotation: p.rotation ?? 0 },
    { gamma: p.gamma, black: p.black, white: p.white, brightness: p.brightness ?? 0 },
  );
  const base = gridToBase(g.rgba, g.LW, g.LH, quantizeContrast(p.contrast), p.invert);
  setAsset(node.assetId, {
    w: g.LW,
    h: g.LH,
    tones: base.tones,
    covered: base.covered,
    fine: base.fine,
    per: g.LW / sceneDimsAt(aspect, scene.pixel).w,
  });
}

/** A photo's untreated grid (its framing at the canvas grid, before the tone dials), kept
 *  per layer so a modulated tone dial (J2) only re-treats the cells each frame. */
const untreated = new Map<
  string,
  { key: string; rgba: Uint8ClampedArray; LW: number; LH: number }
>();

/** A photo layer's raster at its CURRENT (modulated) tone dials — the exact treatment
 *  renderImageLayer applies (the tone LUT on the downscaled grid, then contrast/invert), so
 *  the live canvas and the export (both call this) match a still render at those dials. */
export function modulatedPhotoRaster(node: SceneNode): CachedAsset | null {
  const src = pictureFor(node);
  const p = node.image;
  if (!src || !p) return null;
  const scenePixel = useSceneStore.getState().pixel;
  const pixel = scenePixel / detailFactor();
  const aspect = useBurnStore.getState().aspect;
  const key = JSON.stringify([
    node.assetId,
    p.matte,
    p.zoom,
    p.offsetX,
    p.offsetY,
    p.rotation ?? 0,
    pixel,
    aspect,
  ]);
  let g = untreated.get(node.id);
  if (!g || g.key !== key) {
    const r = imageToGrid(src, pixel, aspect, {
      zoom: p.zoom,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
      rotation: p.rotation ?? 0,
    });
    g = { key, rgba: r.rgba, LW: r.LW, LH: r.LH };
    untreated.set(node.id, g);
  }
  const rgba = g.rgba.slice();
  const tone = { gamma: p.gamma, black: p.black, white: p.white, brightness: p.brightness ?? 0 };
  if (!isNeutralTone(tone)) applyToneLut(rgba, toneLut(tone));
  const base = gridToBase(rgba, g.LW, g.LH, quantizeContrast(p.contrast), p.invert);
  return {
    w: g.LW,
    h: g.LH,
    tones: base.tones,
    covered: base.covered,
    fine: base.fine,
    per: g.LW / sceneDimsAt(aspect, scenePixel).w,
  };
}

/** Where the PICTURE sits on the canvas (scene cells, as displayed — a layer flip mirrors
 *  it): centre, size and rotation. The photo outline handles edit this; see
 *  pictureToParams for the inverse. Null while the source is not loaded. */
export interface PictureRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}
export function pictureRect(node: SceneNode, dims: { w: number; h: number }): PictureRect | null {
  const src = sources.get(node.assetId);
  const p = node.image;
  if (!src || !p) return null;
  const { w: sw, h: sh } = sourceSize(src);
  const { targetW, targetH } = targetFrame(useBurnStore.getState().aspect);
  const base = Math.min(targetW / sw, targetH / sh);
  const kx = dims.w / targetW;
  const ky = dims.h / targetH;
  const fx = node.placement.scaleX < 0;
  const fy = node.placement.scaleY < 0;
  const cx = (targetW / 2 + p.offsetX * targetW) * kx;
  const cy = (targetH / 2 + p.offsetY * targetH) * ky;
  const rot = p.rotation ?? 0;
  return {
    cx: fx ? dims.w - cx : cx,
    cy: fy ? dims.h - cy : cy,
    w: sw * base * p.zoom * kx,
    h: sh * base * p.zoom * ky,
    rot: fx !== fy ? -rot : rot,
  };
}

/** The image params that put the picture at a displayed rect (inverse of pictureRect). */
export function pictureToParams(
  node: SceneNode,
  dims: { w: number; h: number },
  r: { cx: number; cy: number; w: number; rot: number },
): Partial<ImageLayerParams> | null {
  const src = sources.get(node.assetId);
  if (!src) return null;
  const { w: sw, h: sh } = sourceSize(src);
  const { targetW, targetH } = targetFrame(useBurnStore.getState().aspect);
  const base = Math.min(targetW / sw, targetH / sh);
  const kx = dims.w / targetW;
  const ky = dims.h / targetH;
  const fx = node.placement.scaleX < 0;
  const fy = node.placement.scaleY < 0;
  const cx = fx ? dims.w - r.cx : r.cx;
  const cy = fy ? dims.h - r.cy : r.cy;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let rot = fx !== fy ? -r.rot : r.rot;
  rot = ((((rot + 180) % 360) + 360) % 360) - 180;
  return {
    offsetX: clamp(cx / kx / targetW - 0.5, -2, 2),
    offsetY: clamp(cy / ky / targetH - 0.5, -2, 2),
    zoom: clamp(r.w / kx / (sw * base), 0.1, 8),
    rotation: Math.round(rot * 100) / 100,
  };
}

/** A Duplicate's own asset id sharing the same picture (its raster renders separately). */
export function cloneImageAsset(assetId: string): string | undefined {
  const src = sources.get(assetId);
  if (!src) return undefined;
  const id = `img:${++seq}`;
  sources.set(id, src);
  const file = sourceFiles.get(assetId);
  if (file) sourceFiles.set(id, file);
  return id;
}

/** Import a still picture as a new full-frame image layer on top; returns the node id. */
export function addImageLayer(src: BurnSource): string {
  const assetId = `img:${++seq}`;
  sources.set(assetId, src);
  const file = imageFileOf(src);
  if (file) sourceFiles.set(assetId, file);
  const scene = useSceneStore.getState();
  const d = sceneDimsAt(useBurnStore.getState().aspect, scene.pixel);
  const id = scene.addImageNode(assetId, d.w / 2, d.h / 2);
  const node = useSceneStore.getState().nodes.find((n) => n.id === id);
  if (node) renderImageLayer(node);
  useSceneStore.getState().bump();
  return id;
}

/** Keep every image layer's raster in step with its params, the Pixel and the aspect —
 *  and keep it exactly full-frame-centred (so its cells sit 1:1 on the canvas grid). */
function syncAll(force: boolean, prevNodes?: SceneNode[]): void {
  const s = useSceneStore.getState();
  const d = sceneDimsAt(useBurnStore.getState().aspect, s.pixel);
  const prevById = new Map((prevNodes ?? []).map((n) => [n.id, n]));
  let changed = false;
  for (const n of s.nodes) {
    if (n.kind !== 'image') continue;
    const prev = prevById.get(n.id);
    const missing = !getAssetCache().has(n.assetId);
    if (force || missing || !prev || prev.image !== n.image) {
      renderImageLayer(n);
      changed = true;
    }
    const p = n.placement;
    // A flip (negative scale) is the user's — keep its sign; only the magnitude is pinned.
    const fx = p.scaleX < 0 ? -1 : 1;
    const fy = p.scaleY < 0 ? -1 : 1;
    if (p.x !== d.w / 2 || p.y !== d.h / 2 || p.scaleX !== fx || p.scaleY !== fy || p.rotationDeg) {
      // Re-centre OUTSIDE undo history: this is derived state, not a user edit.
      const t = useSceneStore.temporal.getState();
      t.pause();
      s.setPlacement(n.id, { x: d.w / 2, y: d.h / 2, scaleX: fx, scaleY: fy, rotationDeg: 0 });
      t.resume();
    }
  }
  if (changed) useSceneStore.getState().bump();
}

export function useImageLayerSync(): void {
  useEffect(() => {
    syncAll(true);
    const unScene = useSceneStore.subscribe((s, prev) => {
      if (s.pixel !== prev.pixel || s.detail !== prev.detail) syncAll(true);
      else if (s.nodes !== prev.nodes) syncAll(false, prev.nodes);
    });
    const unBurn = useBurnStore.subscribe((s, prev) => {
      if (s.aspect !== prev.aspect) syncAll(true);
    });
    return () => {
      unScene();
      unBurn();
    };
  }, []);
}

/** Import into the canvas: a still picture becomes a full-frame image layer, a video a
 *  video layer (Move tool armed so either can be framed straight away). */
export function importToCanvas(src: BurnSource): void {
  if (src instanceof HTMLVideoElement) {
    void importVideoLayer(src); // a video becomes a video layer
    return;
  }
  useSceneStore.getState().setTool('arrange');
  addImageLayer(src);
}

// ---- projects ---------------------------------------------------------------

/** A photo layer's source as bytes: the original file when we have it, else the decoded
 *  picture re-encoded losslessly as PNG. Null when the source isn't loaded. */
export async function photoSourceBytes(
  assetId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const have = sourceFiles.get(assetId);
  if (have instanceof File) {
    const v = { bytes: new Uint8Array(await have.arrayBuffer()), mime: have.type || 'image/png' };
    sourceFiles.set(assetId, v);
    return v;
  }
  if (have) return have;
  const src = sources.get(assetId);
  if (!src || src instanceof HTMLVideoElement) return null;
  const { w, h } = sourceSize(src);
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) return null;
  const v = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
  sourceFiles.set(assetId, v);
  return v;
}

/** A cut-out mask plane by key (ImageLayerParams.matte). */
export const photoMask = (key: string): Uint8Array | undefined => masks.get(key);

/** Reopen a photo layer's source (+ its masks) under the SAVED asset id; skips the id
 *  counters past it. The raster renders when the node arrives (useImageLayerSync). */
export async function restorePhoto(
  assetId: string,
  media: { bytes: Uint8Array; mime: string },
  maskPlanes: { key: string; alpha: Uint8Array }[],
): Promise<void> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(media.bytes)], { type: media.mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    sources.set(assetId, img);
  } finally {
    URL.revokeObjectURL(url);
  }
  sourceFiles.set(assetId, media);
  work.delete(assetId);
  const n = Number(assetId.slice(4));
  if (Number.isInteger(n) && n > seq) seq = n;
  for (const m of maskPlanes) {
    masks.set(m.key, m.alpha);
    const k = Number(m.key.slice(1));
    if (Number.isInteger(k) && k > maskSeq) maskSeq = k;
  }
}
