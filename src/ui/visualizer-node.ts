// =============================================================================
// Generative-visualizer scene nodes (the visible half of the fleet). A visualizer
// node is a SceneNode(kind:'visualizer') whose CachedAsset is REGENERATED every
// loop frame from the audio by the pure core/visualizer — then it renders through
// the ONE resolveSceneGrid dither like any element (so it's 1-bit, obeys the node's
// look, and preview == export). The live regen lives here; the deterministic export
// regenerates the SAME rasters itself in core/loop-render (both call the one pure
// generator, so they agree cell-for-cell). Mirrors ui/video-assets (per-frame
// raster) and ui/paint-node (a `viz:`-prefixed in-memory asset, never the Library).
// =============================================================================
import { useSceneStore, sceneDimsAt, type SceneNode } from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { useLoopStore } from '../state/loop-store';
import { notifyBanner } from '../state/notify-store';
import { getAssetCache, setAsset } from './scene-assets';
import {
  renderVisualizerRaster,
  vizFeature,
  vizRasterDims,
  VISUALIZER_DEFAULT,
  VIZ_RASTER,
  type VisualizerBand,
  type VisualizerConfig,
  type VisualizerStyle,
} from '../core/visualizer';
import { makeRng } from '../core/seeded-rng';

const VIZ_PREFIX = 'viz:';

/** Plain names for the gallery + panel. */
export const VIZ_STYLE_LABEL: Record<VisualizerStyle, string> = {
  orb: 'Orb',
  speaker: 'Speaker',
  lava: 'Lava',
  sunburst: 'Sunburst',
  ridgeline: 'Ridgeline',
  waterfall: 'Waterfall',
  leds: 'LEDs',
  warp: 'Warp',
  bars: 'Bars',
  waveform: 'Wave',
  particles: 'Bubbles',
  dust: 'Dust',
  stars: 'Stars',
  vinyl: 'Vinyl',
  radial: 'Burst',
  rings: 'Rings',
  tunnel: 'Tunnel',
};

/** "Listens to" — which part of the sound a pulsing style follows. */
export const VIZ_BANDS: { value: VisualizerBand; label: string }[] = [
  { value: 'low', label: 'Bass' },
  { value: 'mid', label: 'Mid' },
  { value: 'high', label: 'Treble' },
  { value: 'onset', label: 'Beat' },
  { value: 'rms', label: 'Everything' },
];
let vizSeq = 0;

/** Add a visualizer element of `style`, shaped like the canvas and filling it.
 *  Returns the new node id (selected). Its `viz:` raster starts at a resting
 *  frame; the loop regen animates it. */
export function createVisualizer(style: VisualizerStyle): string {
  const dims = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
  // Shaped like the canvas and scaled to cover it exactly (fill).
  const cfg = { ...VISUALIZER_DEFAULT, style, aspect: dims.w / dims.h };
  const assetId = `${VIZ_PREFIX}${++vizSeq}`;
  const loop = useLoopStore.getState();
  const F = Math.max(1, loop.meta.frames);
  const initial = renderVisualizerRaster(cfg, null, 0, F, makeRng(loop.meta.seed), assetId);
  setAsset(assetId, initial);
  const scale = dims.w / vizRasterDims(cfg).w;
  return useSceneStore.getState().addVisualizerNode(assetId, dims.w / 2, dims.h / 2, scale, cfg);
}

/** Add a visualizer layer and say so (the rail's + Visualizer and the Layers + menu). */
export function addVisualizer(style: VisualizerStyle): void {
  createVisualizer(style);
  notifyBanner(`${VIZ_STYLE_LABEL[style]} visualizer added — drag to place it`);
}

/** Mint a FRESH `viz:` asset for a DUPLICATED visualizer, seeded from its own config,
 *  so each clone drives its own raster (and its own PRNG key) instead of sharing the
 *  source's `viz:` cache slot — else the render seen-set collapses the two nodes and
 *  the duplicate's style/band/gain is ignored. Returns the new assetId. */
export function registerVisualizerClone(viz: VisualizerConfig): string {
  const assetId = `${VIZ_PREFIX}${++vizSeq}`;
  const loop = useLoopStore.getState();
  const F = Math.max(1, loop.meta.frames);
  setAsset(assetId, renderVisualizerRaster(viz, null, 0, F, makeRng(loop.meta.seed), assetId));
  return assetId;
}

/**
 * LIVE regen: rewrite each visualizer node's raster into the asset cache before the
 * resolve (mirrors updateVideoFrames). TWO CLOCKS: the authored PHASE
 * cycles at `loopFrame` while the audio FEATURE indexes the ABSOLUTE frame
 * (features[absFrame], length T_live) — the exact split core/loop-render makes, so
 * preview == export. `loopFrame >= F` (at rest) → the resting frame 0 (phase AND
 * feature), so a stopped visualizer shows a still pose. When T_live == F, absFrame ==
 * loopFrame and this is byte-identical to before. The keyed PRNG uses the node's
 * assetId so the export (regenerating with the same key) agrees.
 */
export function updateVisualizerFrames(
  nodes: SceneNode[],
  loopFrame: number,
  absFrame: number = loopFrame,
): void {
  const loop = useLoopStore.getState();
  const F = Math.max(1, loop.meta.frames);
  const rng = makeRng(loop.meta.seed);
  const resting = loopFrame >= F;
  const phaseF = resting ? 0 : Math.max(0, loopFrame); // authored phase (loop clock)
  const featF = resting ? 0 : Math.max(0, absFrame); // feature index (absolute clock)
  const features = loop.features;
  const cache = getAssetCache();
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.kind !== 'visualizer' || !n.viz || seen.has(n.assetId)) continue;
    seen.add(n.assetId);
    cache.set(
      n.assetId,
      renderVisualizerRaster(
        n.viz,
        vizFeature(features, featF, n.viz.smooth),
        phaseF,
        F,
        rng,
        n.assetId,
        VIZ_RASTER,
        { features, at: featF },
      ),
    );
  }
}

/** Projects: give a reopened visualizer its resting raster under its SAVED
 *  asset id (the loop regen animates it from there) and skip the id counter past it. */
export function restoreVisualizerAsset(node: SceneNode): void {
  if (!node.viz) return;
  const loop = useLoopStore.getState();
  const F = Math.max(1, loop.meta.frames);
  setAsset(
    node.assetId,
    renderVisualizerRaster(node.viz, null, 0, F, makeRng(loop.meta.seed), node.assetId),
  );
  const n = Number(node.assetId.slice(VIZ_PREFIX.length));
  if (Number.isInteger(n) && n > vizSeq) vizSeq = n;
}
