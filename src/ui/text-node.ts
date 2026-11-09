// =============================================================================
// Dot-matrix TEXT layers. A text layer is a
// SceneNode(kind:'text') whose `text:` raster is a PURE function of its config
// (core/dot-font) — so instead of storing pixels, this module keeps the asset cache in
// step with the nodes: whenever the scene's nodes change (typing, a slider, undo/redo,
// a reopened project, a duplicate) any text layer whose config moved is redrawn before
// the next render. The raster then flows through the ONE resolveSceneGrid dither like
// any layer, so the live canvas, PNG/SVG and every video frame agree (preview == export),
// and projects need no media for it (the config in the node IS the layer).
// =============================================================================
import { useSceneStore, sceneDimsAt, type SceneNode } from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { notifyBanner } from '../state/notify-store';
import { getAssetCache, setAsset } from './scene-assets';
import { TEXT_DEFAULT, normalizeText, renderTextRaster } from '../core/dot-font';

const TEXT_PREFIX = 'text:';
let textSeq = 0;

/** A fresh `text:` asset id (a new layer, or a duplicate's own slot). */
export function newTextAssetId(): string {
  return `${TEXT_PREFIX}${++textSeq}`;
}

/** assetId → the config its cached raster was drawn from. */
const drawn = new Map<string, string>();

/** Redraw every text layer whose config changed (or whose raster isn't cached), and
 *  skip the id counter past loaded `text:` ids (reopened ids never collide). */
export function syncTextAssets(nodes: readonly SceneNode[]): void {
  const cache = getAssetCache();
  for (const n of nodes) {
    if (n.kind !== 'text' || !n.text) continue;
    const seq = Number(n.assetId.slice(TEXT_PREFIX.length));
    if (n.assetId.startsWith(TEXT_PREFIX) && Number.isInteger(seq) && seq > textSeq) textSeq = seq;
    const key = JSON.stringify(normalizeText(n.text));
    if (drawn.get(n.assetId) === key && cache.has(n.assetId)) continue;
    setAsset(n.assetId, renderTextRaster(n.text));
    drawn.set(n.assetId, key);
  }
}

// Keep the cache in step with the scene from the moment this module loads (the store's
// listeners run inside set(), before React re-renders the canvas).
syncTextAssets(useSceneStore.getState().nodes);
useSceneStore.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes) syncTextAssets(s.nodes);
});

/** The text layer whose type-in box should take the cursor when it next appears (a just-
 *  added layer: typing replaces "HELLO" straight away — "how do i type?"). */
export const textFocus: { id: string | null } = { id: null };

/** Add a text layer in the middle of the canvas, selected, ready to type into. */
export function addTextLayer(): string {
  const dims = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
  const st = useSceneStore.getState();
  st.setTool('arrange');
  const id = st.addTextNode(newTextAssetId(), dims.w / 2, dims.h / 2, { ...TEXT_DEFAULT });
  textFocus.id = id;
  notifyBanner('Text added — just type; drag it on the canvas to place it');
  return id;
}
