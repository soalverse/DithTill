// =============================================================================
// The animation WINDOW: a box fixed on the canvas a layer is
// seen through as it moves (a marquee scrolling across an LED sign). This module turns the
// Window button on: a new window starts as the box around where the layer sits now, snapped
// to whole canvas squares.
// =============================================================================
import { useSceneStore, type CropRect, type SceneNode } from '../state/scene-store';
import { getAssetCache } from './scene-assets';

/** The canvas-square box around a layer as it sits (its turn included), whole squares. */
export function layerBox(n: SceneNode): CropRect {
  const a = getAssetCache().get(n.assetId);
  const per = a?.per ?? 1;
  const w = ((n.crop ? n.crop.w : (a?.w ?? 16)) / per) * Math.abs(n.placement.scaleX);
  const h = ((n.crop ? n.crop.h : (a?.h ?? 16)) / per) * Math.abs(n.placement.scaleY);
  const th = (n.placement.rotationDeg * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(th)) + Math.abs(h * Math.sin(th));
  const bh = Math.abs(w * Math.sin(th)) + Math.abs(h * Math.cos(th));
  const x = Math.floor(n.placement.x - bw / 2);
  const y = Math.floor(n.placement.y - bh / 2);
  return {
    x,
    y,
    w: Math.max(1, Math.ceil(n.placement.x + bw / 2) - x),
    h: Math.max(1, Math.ceil(n.placement.y + bh / 2) - y),
  };
}

/** The Window button: edit the layer's window on the canvas (giving it one around the layer
 *  if it has none — one undo step), or finish editing. */
export function toggleWindowEdit(n: SceneNode): void {
  const st = useSceneStore.getState();
  if (st.windowId === n.id) return st.setWindowId(null);
  st.setTool('arrange'); // the window box needs the pointer, not the brush
  if (!n.window) st.setWindow(n.id, layerBox(n));
  st.setWindowId(n.id);
}
