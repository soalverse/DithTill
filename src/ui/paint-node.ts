// =============================================================================
// Record paint layers — the static core of draw-in-Record (Group E / E4).
//
// A PAINT layer is a SceneNode(kind:'paint') backed by a MUTABLE in-memory
// CachedAsset in the scene-assets cache (like the synced Draw node `stage:draw`,
// but the brush keeps writing into it). The brush mutates the layer's PRE-dither
// TONES; resolveSceneGrid then dithers every cell at its SCENE-GLOBAL (x,y) via the
// one quantizeCell — so preview == export and the Bayer screen never crawls (the
// one dither truth is untouched; a stroke is just a new tone source).
//
// Strokes get their OWN bounded snapshot history here (the big rasters never go
// into zundo — that's load-bearing for memory). Undo is MODAL: in Paint mode the
// deck's Undo/Redo drive THIS history; in Arrange mode they drive zundo (node
// transforms). createPaintLayer/rasterizeNode add the node through the store (so
// add/remove of a layer IS a zundo step), but the pixels live only in the cache.
// =============================================================================
import { recordPaintStep } from './history';
import { copyRecordingTakes } from './recording-edit';
import {
  useSceneStore,
  sceneDimsAt,
  detailFactor,
  hasDrawnRaster,
  DETAIL_FACTOR,
  type Placement,
  type Detail,
  type SceneNode,
} from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { getAssetCache, setAsset } from './scene-assets';
import { registerVisualizerClone } from './visualizer-node';
import { newTextAssetId } from './text-node';
import { cloneImageAsset } from './image-layers';
import { stampLine, type BrushOpts } from '../core/raster-brush';
import { sceneToElementCell } from '../core/scene-affine';
import type { CachedAsset } from '../core/scene-resolver';

const PAINT_PREFIX = 'paint:';
let paintSeq = 0;

// ---- per-paint-layer snapshot history (modal undo; NOT zundo) ----------------
interface Snap {
  tones: Uint8Array;
  covered: Uint8Array;
}
interface PaintHistory {
  undo: Snap[];
  index: number;
}
const histories = new Map<string, PaintHistory>();
const MAX_PAINT_HISTORY = 24;

const snap = (a: CachedAsset): Snap => ({ tones: a.tones.slice(), covered: a.covered.slice() });

function blankAsset(w: number, h: number, per = 1): CachedAsset {
  return { w, h, tones: new Uint8Array(w * h), covered: new Uint8Array(w * h), per };
}
function copyAsset(src: CachedAsset): CachedAsset {
  return {
    w: src.w,
    h: src.h,
    tones: src.tones.slice(),
    covered: src.covered.slice(),
    ...(src.per && src.per !== 1 ? { per: src.per } : {}),
  };
}

/** Register a fresh mutable raster + seed its history; returns the new `paint:` id. */
function registerPaintAsset(asset: CachedAsset): string {
  const id = `${PAINT_PREFIX}${++paintSeq}`;
  setAsset(id, asset);
  histories.set(id, { undo: [snap(asset)], index: 0 });
  return id;
}

/** Create a blank full-frame paint layer (scene-sized, scale 1, centred) and add it
 *  as the selected node, just above `aboveId` (absent = on top). Returns the new node id. */
export function createPaintLayer(aboveId?: string | null): string {
  const dims = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
  // Drawn at the project's Detail (Fine keeps 4× the picture per square).
  const f = detailFactor();
  const id = registerPaintAsset(blankAsset(dims.w * f, dims.h * f, f));
  return useSceneStore.getState().addPaintNode(id, dims.w / 2, dims.h / 2, aboveId);
}

/** A new still drawing holding a finished picture (Keep as drawing), just above
 *  `aboveId`, selected. Returns the new node id. */
export function createBakedLayer(asset: CachedAsset, aboveId: string): string {
  const dims = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
  const id = registerPaintAsset(asset);
  return useSceneStore.getState().addPaintNode(id, dims.w / 2, dims.h / 2, aboveId);
}

/** Create a RECORDING: a layer with its own blank full-frame raster, just above
 *  `aboveId` (absent = on top), selected. Its strokes are timed events, never baked in. */
export function createRecordingLayer(aboveId?: string | null): string {
  const dims = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
  const f = detailFactor();
  const id = registerPaintAsset(blankAsset(dims.w * f, dims.h * f, f));
  return useSceneStore.getState().addRecordingNode(id, dims.w / 2, dims.h / 2, aboveId);
}

/** A blank recording raster of a saved size, on top, at a saved placement (a recording from
 *  the Library). Returns the new node id. */
export function createRecordingFromRaster(
  w: number,
  h: number,
  per: number,
  placement: Placement,
): string {
  const id = registerPaintAsset(blankAsset(w, h, per));
  const s = useSceneStore.getState();
  const nodeId = s.addRecordingNode(id, placement.x, placement.y);
  s.setPlacement(nodeId, placement);
  return nodeId;
}

/** Rasterize a frozen node (Library/synced asset) into an editable paint layer by
 *  deep-copying its current raster, then swapping the node in place (keeping its
 *  placement / crop / look). Returns the (same) node id, or null if it has no raster. */
export function rasterizeNode(node: SceneNode): string | null {
  const src = getAssetCache().get(node.assetId);
  if (!src) return null;
  const id = registerPaintAsset(copyAsset(src));
  useSceneStore.getState().replaceWithPaint(node.id, id);
  return node.id;
}

/** Duplicate the current selection; paint layers get their own copied raster so the
 *  clone never shares pixels with the original (asset clones share the immutable
 *  asset). One zundo entry; the clones become the selection. */
export function duplicateSelection(): void {
  const s = useSceneStore.getState();
  const remap = new Map<string, string>();
  for (const n of s.nodes) {
    if (!s.selected.includes(n.id)) continue;
    if (hasDrawnRaster(n)) {
      const src = getAssetCache().get(n.assetId);
      if (src) remap.set(n.id, registerPaintAsset(copyAsset(src)));
    } else if (n.kind === 'visualizer' && n.viz) {
      // A visualizer clone needs its OWN viz: raster (its assetId is its PRNG key
      // and its cache slot), else both nodes render from the source's config.
      remap.set(n.id, registerVisualizerClone(n.viz));
    } else if (n.kind === 'text') {
      // A text clone gets its own `text:` slot (redrawn from its own config), so editing
      // one never rewrites the other's dots.
      remap.set(n.id, newTextAssetId());
    } else if (n.kind === 'image') {
      // A photo clone gets its own raster slot over the SAME picture (re-rendered by sync).
      const id = cloneImageAsset(n.assetId);
      if (id) remap.set(n.id, id);
    }
  }
  const before = new Set(s.nodes.map((n) => n.id));
  const sources = s.nodes.filter((n) => s.selected.includes(n.id));
  s.duplicate(remap);
  // A recording IS its strokes: its copy gets them too, as takes of its own.
  const clones = useSceneStore.getState().nodes.filter((n) => !before.has(n.id));
  sources.forEach((src, i) => {
    if (src.kind === 'recording' && clones[i]) copyRecordingTakes(src.id, clones[i]);
  });
}

// ---- the brush stroke --------------------------------------------------------

/** Paint a segment on a paint layer. (sx0,sy0)->(sx1,sy1) are SCENE-cell floats
 *  (a click is the two endpoints equal). Maps each endpoint to the layer's element
 *  cell via the shared inverse affine (so painting lands correctly on a moved /
 *  scaled / rotated layer), then mutates the cached raster in place; the caller
 *  re-renders (schedule()). Brush size is given in SCENE cells and divided by the
 *  layer's scale so the on-glass footprint matches the displayed ring. */
export function paintStroke(
  node: SceneNode,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  opts: BrushOpts,
): void {
  const asset = getAssetCache().get(node.assetId);
  if (!asset) return;
  const per = asset.per ?? 1;
  const e0 = sceneToElementCell(node.placement, asset.w, asset.h, sx0, sy0, per);
  const e1 = sceneToElementCell(node.placement, asset.w, asset.h, sx1, sy1, per);
  const sc = (Math.abs(node.placement.scaleX) + Math.abs(node.placement.scaleY)) / 2 || 1;
  // Brush size is in canvas squares, so a Fine drawing's brush covers the same area.
  stampLine(asset, e0.x, e0.y, e1.x, e1.y, { ...opts, size: (opts.size * per) / sc });
}

/** Push a snapshot of the layer's raster (call once on stroke END → one undo step).
 *  Bumps the store (no zundo entry — nodes/scene are unchanged) so the deck's modal
 *  Undo/Redo availability re-evaluates after each stroke. */
export function commitPaint(node: SceneNode): void {
  const asset = getAssetCache().get(node.assetId);
  if (!asset) return;
  const h = histories.get(node.assetId);
  if (h) {
    h.undo = h.undo.slice(0, h.index + 1);
    h.undo.push(snap(asset));
    while (h.undo.length > MAX_PAINT_HISTORY + 1) h.undo.shift();
    h.index = h.undo.length - 1;
  } else {
    histories.set(node.assetId, { undo: [snap(asset)], index: 0 });
  }
  recordPaintStep(node.assetId);
  useSceneStore.getState().bump();
}

function restore(assetId: string, s: Snap): void {
  const a = getAssetCache().get(assetId);
  if (!a) return;
  a.tones.set(s.tones);
  a.covered.set(s.covered);
  useSceneStore.getState().bump(); // re-render via the store subscription
}

export function canPaintUndo(assetId: string | undefined): boolean {
  const h = assetId ? histories.get(assetId) : undefined;
  return !!h && h.index > 0;
}
export function canPaintRedo(assetId: string | undefined): boolean {
  const h = assetId ? histories.get(assetId) : undefined;
  return !!h && h.index < h.undo.length - 1;
}
export function paintUndo(assetId: string): void {
  const h = histories.get(assetId);
  if (!h || h.index <= 0) return;
  h.index -= 1;
  restore(assetId, h.undo[h.index]);
}
export function paintRedo(assetId: string): void {
  const h = histories.get(assetId);
  if (!h || h.index >= h.undo.length - 1) return;
  h.index += 1;
  restore(assetId, h.undo[h.index]);
}

/** Clear a paint layer's pixels (undoable via its own history). */
export function clearPaintLayer(node: SceneNode): void {
  const asset = getAssetCache().get(node.assetId);
  if (!asset) return;
  asset.tones.fill(0);
  asset.covered.fill(0);
  commitPaint(node); // already snapshots + bumps the store (re-render)
}

/**
 * Resolve which paint layer a brush-down should target:
 *   - a selected PAINT layer → paint it;
 *   - a picture (any non-paint layer) selected → null = a NEW drawing layer on top, so
 *     drawing over a picture never needs a "+ layer" button; a recording selected
 *     → null too, a new drawing just above it (it holds only what was recorded); a recording selected
 *     → null too, a new drawing just above it (it holds only what was recorded);
 *   - nothing selected → the TOPMOST layer if it is a drawing (so strokes are never
 *     hidden under a picture), else null = auto-create on top.
 *  ('frozen' is kept in the type for the retiring Record deck; the canvas never gets it.)
 */
export function paintTarget(): SceneNode | 'frozen' | null {
  const s = useSceneStore.getState();
  const selected = s.nodes.filter((n) => s.selected.includes(n.id));
  const selPaint = selected.find((n) => n.kind === 'paint');
  if (selPaint) return selPaint;
  if (selected.length > 0) return null;
  const top = [...s.nodes].sort((a, b) => b.z - a.z)[0];
  return top && top.kind === 'paint' ? top : null;
}

/** Re-grid every drawing layer for a Detail switch into a NEW raster under a
 *  new id — the old one stays cached, so the one undo step that swaps the ids (setDetail)
 *  can swap them back. Normal → Fine copies each square into 4×4 (nothing lost); Fine →
 *  Normal averages each 4×4 block (its fine edges are lost). Returns old id → new id. */
export function regridPaintForDetail(to: Detail): Map<string, string> {
  const remap = new Map<string, string>();
  const fTo = DETAIL_FACTOR[to];
  for (const n of useSceneStore.getState().nodes) {
    if (!hasDrawnRaster(n) || remap.has(n.assetId)) continue;
    const a = getAssetCache().get(n.assetId);
    const per = a?.per ?? 1;
    if (!a || per === fTo) continue;
    const w = Math.max(1, Math.round((a.w / per) * fTo));
    const h = Math.max(1, Math.round((a.h / per) * fTo));
    remap.set(n.assetId, registerPaintAsset(resampleRaster(a, w, h, fTo)));
  }
  return remap;
}

/** A raster at new dims: nearest when growing, the mean of each source block when
 *  shrinking (covered where most of the block is). */
function resampleRaster(a: CachedAsset, w: number, h: number, per: number): CachedAsset {
  const out = blankAsset(w, h, per);
  if (w >= a.w) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const si = Math.floor((y * a.h) / h) * a.w + Math.floor((x * a.w) / w);
        out.tones[y * w + x] = a.tones[si];
        out.covered[y * w + x] = a.covered[si];
      }
    return out;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cov = 0;
      let n = 0;
      for (let sy = Math.floor((y * a.h) / h); sy < Math.floor(((y + 1) * a.h) / h); sy++)
        for (let sx = Math.floor((x * a.w) / w); sx < Math.floor(((x + 1) * a.w) / w); sx++) {
          n++;
          if (a.covered[sy * a.w + sx]) {
            cov++;
            sum += a.tones[sy * a.w + sx];
          }
        }
      if (cov * 2 >= n && cov > 0) {
        out.covered[y * w + x] = 1;
        out.tones[y * w + x] = Math.round(sum / cov);
      }
    }
  return out;
}

// ---- GC accessors (W6 / P9,+0024 backlog) ---------------------------
// The paint snapshot histories live only here (out of zundo, load-bearing for
// memory). The reachability sweep (ui/scene-gc) frees a layer's history the same
// moment it frees the raster — once no current node AND no zundo state references
// its `paint:` id.

/** Every `paint:` id that still holds a snapshot history. */
export function paintHistoryIds(): string[] {
  return [...histories.keys()];
}

/** Approx bytes held by a paint layer's snapshot history (the undo stack of rasters). */
export function paintHistoryBytes(assetId: string): number {
  const h = histories.get(assetId);
  if (!h) return 0;
  let bytes = 0;
  for (const s of h.undo) bytes += s.tones.length + s.covered.length;
  return bytes;
}

/** Drop a paint layer's snapshot history; returns the bytes reclaimed. Called by
 *  the sweep once the layer is unreachable from current nodes ∪ all zundo history. */
export function evictPaintHistory(assetId: string): number {
  const bytes = paintHistoryBytes(assetId);
  histories.delete(assetId);
  return bytes;
}

/** Projects: register a reopened drawing's raster under its SAVED id, seed its
 *  stroke history, and skip the id counter past it. */
export function restorePaintAsset(id: string, asset: CachedAsset): void {
  setAsset(id, asset);
  histories.set(id, { undo: [snap(asset)], index: 0 });
  const n = Number(id.slice(PAINT_PREFIX.length));
  if (Number.isInteger(n) && n > paintSeq) paintSeq = n;
}
