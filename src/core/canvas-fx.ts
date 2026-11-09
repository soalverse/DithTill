// =============================================================================
// Whole canvas effects (J5 step 3): the effects on the WHOLE picture, about the
// canvas middle. Each layer (after its own effects) is laid onto the canvas first — its tones
// in canvas squares at its own Detail — then the canvas effects run on that, so a whole-canvas
// Mirror reflects every layer across the canvas middle and a Kaleidoscope folds the whole
// picture. The layer still prints its own screen (its look, opacity, Solid, window), but its
// grain is pinned to the canvas while an effect is on (the effect moves the picture anyway).
// Trail stays a layer's own (it runs on the laid picture). Pure: rewrites the frame's nodes +
// rasters before the print screens, so every output (live, PNG / SVG, video, Library save)
// draws the same thing.
// =============================================================================
import { applyLayerFx, FX_ORDER, type LayerFx } from './layer-fx';
import type { CachedAsset } from './scene-resolver';
import type { SceneNode } from '../state/scene-store';

/** The effects the Whole canvas offers (every picture effect; Trail is a layer's own). */
export const CANVAS_FX_KINDS = FX_ORDER.filter((k) => k !== 'trail');

/** Does the canvas have an effect to apply? */
export const hasCanvasFx = (fx: LayerFx | undefined | null): fx is LayerFx =>
  !!fx && CANVAS_FX_KINDS.some((k) => fx[k] !== undefined);

/** A layer's picture laid onto the canvas: `dims` squares × `per` values each, sampled the
 *  way the print screens place it (centre, scale, turn, crop). Outside the layer = uncovered. */
export function layOnCanvas(
  r: CachedAsset,
  n: Pick<SceneNode, 'placement' | 'crop'>,
  dims: { w: number; h: number },
): CachedAsset {
  const per = r.per ?? 1;
  const W = Math.max(1, Math.round(dims.w * per));
  const H = Math.max(1, Math.round(dims.h * per));
  const tones = new Uint8Array(W * H);
  const covered = new Uint8Array(W * H);
  const p = n.placement;
  const crop = n.crop;
  const th = (-p.rotationDeg * Math.PI) / 180;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const isx = per / (p.scaleX || 1e-6);
  const isy = per / (p.scaleY || 1e-6);
  for (let y = 0; y < H; y++) {
    const dy = (y + 0.5) / per - p.y;
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5) / per - p.x;
      const ex = Math.floor(r.w / 2 + (dx * ct - dy * st) * isx);
      const ey = Math.floor(r.h / 2 + (dx * st + dy * ct) * isy);
      if (ex < 0 || ey < 0 || ex >= r.w || ey >= r.h) continue;
      if (crop && (ex < crop.x || ex >= crop.x + crop.w || ey < crop.y || ey >= crop.y + crop.h))
        continue;
      const j = ey * r.w + ex;
      if (!r.covered[j]) continue;
      const i = y * W + x;
      tones[i] = r.tones[j];
      covered[i] = 1;
    }
  }
  return { w: W, h: H, tones, covered, ...(per !== 1 ? { per } : {}) };
}

/** The frame's layers through the Whole canvas effects: each visible layer becomes its laid,
 *  effected canvas picture (under its own id), centred on the canvas, uncropped; its own
 *  picture effects are already in it (only a Trail stays). No effect = the same inputs. */
export function applyCanvasFx(
  nodes: SceneNode[],
  assets: Map<string, CachedAsset>,
  dims: { w: number; h: number },
  fx: LayerFx | undefined | null,
): { nodes: SceneNode[]; assets: Map<string, CachedAsset> } {
  if (!hasCanvasFx(fx)) return { nodes, assets };
  const canvas: LayerFx = { ...fx };
  delete canvas.trail;
  const out = new Map(assets);
  const centre = { x: dims.w / 2, y: dims.h / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 };
  const next = nodes.map((n): SceneNode => {
    if (n.hidden) return n;
    const r = assets.get(n.assetId);
    if (!r) return n;
    const id = `${n.assetId}#canvas#${n.id}`;
    out.set(id, applyLayerFx(layOnCanvas(applyLayerFx(r, n.fx), n, dims), canvas));
    const moved: SceneNode = { ...n, assetId: id, placement: centre, crop: null };
    if (n.fx?.trail) moved.fx = { trail: n.fx.trail };
    else delete moved.fx;
    return moved;
  });
  return { nodes: next, assets: out };
}
