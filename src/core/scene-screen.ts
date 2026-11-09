// =============================================================================
// The canvas → print screens adapter. ONE function turns an evaluated
// frame's layers (the nodes `evaluateScene` returns, their rasters, the canvas look and
// dot colour) into `print-screen` layers, so the live canvas, the PNG still and every
// exported video frame draw through the same seam (preview == export). Plus the step
// that turns a rendered frame into the indexed raster the PNG / video encoders take.
// Pure and deterministic.
// =============================================================================
import { resolveInk, type Swatch } from './color';
import { bitDepthForCount } from './dither-constants';
import { PackedIndexBuffer } from './packed-index-buffer';
import type { PrintFrame, ScreenLayer, ScreenLook } from './print-screen';
import { applyLayerFx } from './layer-fx';
import { smearRaster, trailSamples, type TrailSource } from './layer-trail';
import type { CachedAsset, SceneRaster } from './scene-resolver';
import type { Look, SceneNode } from '../state/scene-store';

/** A layer's effective look → its print-screen look. The ink is the layer's own dot
 *  colour, else the canvas's, else the palette's brightest shade (dots-on-dark). */
export function screenLookOf(look: Look, canvasInk: Swatch): ScreenLook {
  return {
    style: look.style,
    colour:
      look.colourMode === 'palette'
        ? { mode: 'palette', palette: look.palette }
        : {
            mode: 'ink',
            ink: resolveInk(look.dotInk !== undefined ? look.dotInk : canvasInk, look.palette),
          },
    pattern: look.matrix,
    bitSize: look.bitSize,
    shape: look.shape,
    dotSize: look.dotSize,
    density: look.density,
    tonal: look.dotGrow,
    angle: look.angle,
    dotsTurn: look.dotsTurn,
    contrast: look.contrast,
    brightness: look.brightness,
    invert: look.invert,
  };
}

/** The frame's layers, bottom → top, ready for `renderPrintScreen`. Hidden layers and
 *  layers whose raster isn't loaded are left out; text layers keep their LED dots. Each
 *  layer's picture goes through its effects first (J5,: pre-dither, fixed order),
 *  its Trail last — when `trail` hands it the layer's recent past (playing / exporting). */
export function sceneScreenLayers(
  nodes: readonly SceneNode[],
  scene: Look,
  assets: ReadonlyMap<string, CachedAsset>,
  canvasInk: Swatch,
  trail?: TrailSource,
): ScreenLayer[] {
  const out: ScreenLayer[] = [];
  const layer = (n: SceneNode, raster: CachedAsset, opacity: number, solid: boolean) =>
    out.push({
      raster,
      placement: n.placement,
      crop: n.crop,
      look: {
        ...screenLookOf({ ...scene, ...n.look }, canvasInk),
        ...(n.grain ? { grain: n.grain } : {}),
      },
      opacity,
      ...(solid ? { solid: true } : {}),
      ...(n.kind === 'text' ? { led: true } : {}),
      ...(n.window ? { window: n.window } : {}),
    });
  for (const n of [...nodes].sort((a, b) => a.z - b.z)) {
    if (n.hidden) continue;
    const base = assets.get(n.assetId);
    if (!base) continue;
    let raster = applyLayerFx(base, n.fx);
    const t = n.fx?.trail;
    if (t && trail) {
      const samples = trailSamples(t.kind, t.length, t.fade, trail.framesPerBeat);
      if (t.kind === 'echo') {
        // The copies, oldest first, under the layer.
        for (let k = samples.length - 1; k >= 0; k--) {
          const s = trail.past(samples[k].age)?.get(n.id);
          if (!s) continue;
          const op = Math.round(((s.node.opacity ?? 100) * samples[k].weight) / 256);
          if (op > 0) layer(s.node, s.raster, op, false);
        }
      } else {
        const past = [];
        for (const { age, weight } of samples) {
          const s = trail.past(age)?.get(n.id);
          if (s) past.push({ raster: s.raster, weight });
        }
        if (past.length) raster = smearRaster(raster, past);
      }
    }
    layer(n, raster, n.opacity ?? 100, !!n.solid);
  }
  return out;
}

/** A rendered frame → the indexed raster the PNG / video encoders take: one palette entry
 *  per distinct colour + alpha (index 0 = fully transparent). Over 256 colours (many inks
 *  overprinting at once) the colours are posterized step by step until they fit — the
 *  same every time for the same frame. */
export function printFrameToRaster(frame: PrintFrame): SceneRaster {
  const { w, h, rgba } = frame;
  for (let bits = 8; bits >= 1; bits--) {
    const drop = 8 - bits;
    const index = new Map<number, number>([[0, 0]]);
    const keys = new Uint32Array(w * h);
    let ok = true;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const a = rgba[o + 3];
      let key = 0;
      if (a !== 0) {
        const q = (v: number) => (drop ? ((v >> drop) << drop) | ((1 << drop) >> 1) : v);
        key = ((q(rgba[o]) << 24) | (q(rgba[o + 1]) << 16) | (q(rgba[o + 2]) << 8) | q(a)) >>> 0;
        if (key === 0) key = 1; // a non-transparent pure black-at-alpha-0 can't collide with 0
      }
      keys[i] = key;
      if (!index.has(key)) {
        if (index.size >= 256) {
          ok = false;
          break;
        }
        index.set(key, index.size);
      }
    }
    if (!ok) continue;
    const palette = new Uint8Array(index.size * 3);
    const trns = new Uint8Array(index.size);
    for (const [key, k] of index) {
      if (k === 0) continue;
      palette[k * 3] = key >>> 24;
      palette[k * 3 + 1] = (key >>> 16) & 255;
      palette[k * 3 + 2] = (key >>> 8) & 255;
      trns[k] = key & 255;
    }
    const buf = new PackedIndexBuffer(w, h, bitDepthForCount(index.size));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) buf.set(x, y, index.get(keys[y * w + x])!);
    return { buf, palette, trns };
  }
  throw new Error('frame has too many colours to index'); // unreachable: 1 bit → ≤ 16
}
