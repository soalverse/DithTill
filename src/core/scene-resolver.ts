// =============================================================================
// Scene resolver (Record / increment 3) — THE single source of truth
// for rendering a multi-element scene, used by BOTH the live preview and the
// export (so preview == export by construction). It is the N-element, per-node-
// look generalization of draw-store.resolveCell + composite.encodeCompositePng.
//
// THE LOAD-BEARING RULE: every cell is quantized
// exactly ONCE, with its TOPMOST covering element's look, at that element's LOCAL
// dither coordinates — its own raster cell (ex, ey) when the element is unrotated at
// an integer scale (so a saved element keeps its exact pixels wherever it is dropped,
// dragged or animated; an integer upscale is a clean pixel zoom), otherwise the scene
// grid TRANSLATED with the element (x − ax, y − ay) so rotation / non-integer scale
// still re-dither fresh (the pre-dithered bitmap is never warped). The Bayer
// threshold is a pure function of those coordinates (dither-constants.ts). A layer
// that fills the scene from origin 0 (paint layers) gets exactly the scene cell, as
// before. Per-element palette is honoured via the topmost element; export builds a
// union palette over the (few) palettes actually used.
//
// Elements are sampled from their PRE-dither tone raster (the renderable
// tones/covered we store per element) — never a baked bitmap — via an inverse
// affine (rotate/scale/crop). Invariant: never warp a pre-dithered bitmap.
// =============================================================================
import {
  floorDiv,
  FRAME_LONG,
  paletteLength,
  paletteRgbAt,
  PALETTE_IDS,
  quantizeContrast,
  orderedPattern,
  quantizeLum,
} from './dither-constants';
import { PackedIndexBuffer } from './packed-index-buffer';
import { applyLayerFx } from './layer-fx';
import type { PaletteId } from './dither-constants';
import { clampRgb, rgbTone, type Rgb, type Swatch } from './color';
import type { Composite } from './composite';
import type { Look, SceneNode } from '../state/scene-store';

/** A Library element's pre-dither raster, cached by assetId (NOT undo state). */
export interface CachedAsset {
  w: number;
  h: number;
  tones: Uint8Array;
  covered: Uint8Array;
  /** v5: the exact-luma low byte (`lum = tones·256 + fine`); absent = 0. */
  fine?: Uint8Array;
  /** v6: per-cell halftone dot-INK slot into `inks` (0 = inherit the
   *  canvas dot colour). A saved canvas whose layers overrode their dot colour carries
   *  this so it reopens with the same dots. Absent = every cell inherits. */
  ink?: Uint8Array;
  inks?: Swatch[];
  /** Picture values per canvas square: 1 = one per square (Normal,
   *  every stored element); 4 = Fine. A layer's footprint in squares is w / per. */
  per?: number;
}

/** The resolved scene at cell resolution: per cell, which palette + index won,
 *  plus the composited pre-dither tone (for save-as-element). */
export interface SceneGrid {
  w: number;
  h: number;
  covered: Uint8Array; // 0/1
  pal: Uint8Array; // index into PALETTE_IDS of the winning element's palette
  idx: Uint8Array; // palette-local dither index
  tones: Uint8Array; // composited tone (brightness applied), first-covered-wins
  /** Per-cell Halftone dot SIZE (diameter px) + Tonal-grow flag (0/1), from the
   *  winning element's look — so the round/block screen sizes each dot per the
   *  element it falls on (PER-ELEMENT Size + Tonal). The square/dither
   *  render ignores both. */
  dSize: Uint8Array;
  dGrow: Uint8Array; // 0/1
  /** The exact-luma LOW byte where ONE opaque neutral element owns the
   *  cell (`tones·256 + fine` = its exact luma); 0 elsewhere. Lets a saved canvas
   *  re-dither bit-for-bit. Optional so adapters (burn/composite grids) can omit it. */
  fine?: Uint8Array;
  /** Per-cell dot-INK slot (0 = the canvas dot colour) into `inks` — from the winning
   *  layer's dot-colour override or its saved per-cell inks. Present only
   *  when some cell overrides (else the grid keeps the old shape, byte-identical). */
  ink?: Uint8Array;
  inks?: Swatch[];
  /** Picture values per canvas square: 1 = one per square (Normal,
   *  every stored element); 4 = Fine. A layer's footprint in squares is w / per. */
  per?: number;
}

export interface SceneResolveInput {
  nodes: SceneNode[];
  scene: Look;
  dims: { w: number; h: number };
  assets: Map<string, CachedAsset>;
  /** The scene background's TONE (integer luma of the flat colour) —
   *  used ONLY to complete the "over" blend under semi-transparent elements.
   *  Cells no element touches stay uncovered here; the flat colour itself is
   *  painted at the render/encode layer (it is chrome, never dithered). */
  backgroundTone?: number;
}

/** Output px per canvas square the dot sizes are measured in (a Look's Dot size / Bit size
 *  are in these units; print screens scale them to the render). */
export const CELL_RENDER_SCALE = 10;

const clampTone = (t: number): number => (t < 0 ? 0 : t > 255 ? 255 : t);
const effective = (scene: Look, node: SceneNode): Look => ({ ...scene, ...node.look });

interface Prepared {
  asset: CachedAsset;
  cx: number;
  cy: number;
  cos: number; // cos(-rot)
  sin: number; // sin(-rot)
  isx: number; // 1/scaleX
  isy: number; // 1/scaleY
  cropX0: number;
  cropY0: number;
  cropX1: number;
  cropY1: number;
  brightness: number;
  N: number;
  CT: number;
  matrix: Look['matrix'];
  invert: boolean;
  palIndex: number;
  /** Per-element Halftone dot size (diameter px) + Tonal-grow flag. */
  dotSize: number;
  dotGrow: boolean;
  /** Node opacity as 0..256 fixed-point (256 = opaque). */
  O: number;
  /** PER-ELEMENT Pixel coarsen factor (US-R2/W5): integer ≥ 1. 1 = read the raster as-is
   *  (byte-identical). > 1 → sample from `pool`, a block-averaged (f×f) copy of the
   *  element's PRE-dither tones, so the element reads coarser under the ONE shared lattice
   *  (source-side downsample — the single quantize + scene-global Bayer are untouched). */
  pf: number;
  pool: CachedAsset | null;
  /** unrotated at an integer scale → dither at the element's own raster cell
   *  (pixel-exact). Otherwise dither at the scene cell translated by (ax, ay). */
  pixelExact: boolean;
  ax: number;
  ay: number;
  /** The layer's dot-ink override slot (0 = none) and its saved per-cell slot remap. */
  inkSlot: number;
  inkMap: Uint8Array | null;
}

/** Block-average an element's covered PRE-dither tones by an integer factor f (≥ 2) into
 *  a coarser raster: each output cell = round(mean tone of the covered source cells in its
 *  f×f block), covered iff any source cell in the block is covered. Pure integer math
 *  (deterministic — the scene-resolver determinism lint covers this). */
function poolAsset(asset: CachedAsset, f: number): CachedAsset {
  const pw = Math.ceil(asset.w / f);
  const ph = Math.ceil(asset.h / f);
  const tones = new Uint8Array(pw * ph);
  const covered = new Uint8Array(pw * ph);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      let sum = 0;
      let cnt = 0;
      const x0 = px * f;
      const y0 = py * f;
      for (let dy = 0; dy < f && y0 + dy < asset.h; dy++) {
        for (let dx = 0; dx < f && x0 + dx < asset.w; dx++) {
          const ai = (y0 + dy) * asset.w + (x0 + dx);
          if (asset.covered[ai]) {
            sum += asset.tones[ai];
            cnt++;
          }
        }
      }
      if (cnt > 0) {
        const pi = py * pw + px;
        covered[pi] = 1;
        tones[pi] = Math.round(sum / cnt);
      }
    }
  }
  return { w: pw, h: ph, tones, covered };
}

/** Opacity percent (0..100 int) → 0..256 fixed-point, exact round-half-up in
 *  pure integer math (no float division — deterministic everywhere). */
export const opacityFixed = (percent: number): number => {
  const p = percent < 0 ? 0 : percent > 100 ? 100 : Math.round(percent);
  return Math.floor((p * 256 + 50) / 100);
};

/** What the "over" stack bottoms out on when no background is set: PAPER
 *  (tone 255 — the lightest shade of any palette, pre-quantize). Opacity is
 *  INK DENSITY (owner-locked v10): a faded element washes toward paper inside
 *  its own silhouette while cells it never touched stay fully transparent —
 *  the faded art-style survives on a transparent background. */
const PAPER_TONE = 255;

/**
 * Resolve the scene to a cell grid. Walks nodes TOP-DOWN; the first covering node
 * wins each cell. Dithers with that node's effective look at the SCENE-global cell.
 */
export function resolveSceneGrid(input: SceneResolveInput): SceneGrid {
  const { nodes, scene, dims, assets, backgroundTone } = input;
  const { w: SW, h: SH } = dims;
  const covered = new Uint8Array(SW * SH);
  const pal = new Uint8Array(SW * SH);
  const idx = new Uint8Array(SW * SH);
  const tones = new Uint8Array(SW * SH);
  const dSize = new Uint8Array(SW * SH);
  const dGrow = new Uint8Array(SW * SH);
  const fine = new Uint8Array(SW * SH);
  const ink = new Uint8Array(SW * SH);
  // Dot-ink slots: 0 = the canvas dot colour; each distinct override Swatch gets one.
  const inks: Swatch[] = [null];
  const inkSlots = new Map<string, number>();
  const slotOf = (s: Swatch): number => {
    const key = JSON.stringify(s);
    let k = inkSlots.get(key);
    if (k === undefined) {
      k = inks.length;
      inks.push(s);
      inkSlots.set(key, k);
    }
    return k;
  };

  // The scene's effective Pixel is implied by the lattice long edge (Burn's rule), so a
  // node's absolute Pixel → an integer coarsen factor relative to the scene cell. This
  // derivation is EXACT for the default (Pixel 2.5 → long 192 → 480/192 = 2.5).
  const scenePixel = FRAME_LONG / Math.max(SW, SH);

  // Top of the z-order first (highest z drawn on top → wins).
  const prepared: Prepared[] = [];
  for (const node of [...nodes].sort((a, b) => b.z - a.z)) {
    if (node.hidden) continue; // a hidden layer is neither drawn, saved nor exported
    const raw = assets.get(node.assetId);
    if (!raw) continue;
    // Its effects (J5) first, as the print screens draw it.
    const asset = applyLayerFx(raw, node.fx);
    const look = effective(scene, node);
    // PER-ELEMENT Pixel (coarser-only): 0/absent = inherit (factor 1). A value ≤ the
    // scene's effective cell clamps to 1 (can only coarsen); above it block-downsamples.
    const pf = look.pixel && look.pixel > 0 ? Math.max(1, Math.round(look.pixel / scenePixel)) : 1;
    const rad = (-node.placement.rotationDeg * Math.PI) / 180; // inverse rotation
    // A finer picture (Detail) maps through its density: per raster cells per square.
    const per = asset.per ?? 1;
    const sx = (node.placement.scaleX || 1e-6) / per;
    const sy = (node.placement.scaleY || 1e-6) / per;
    const crop = node.crop;
    const ks = Math.round(sx);
    const pixelExact =
      per === 1 &&
      node.placement.rotationDeg % 360 === 0 &&
      ks >= 1 &&
      Math.abs(sx - ks) < 1e-9 &&
      Math.abs(sy - ks) < 1e-9;
    prepared.push({
      asset,
      cx: node.placement.x,
      cy: node.placement.y,
      cos: Math.cos(rad),
      sin: Math.sin(rad),
      isx: 1 / sx,
      isy: 1 / sy,
      cropX0: crop ? crop.x : 0,
      cropY0: crop ? crop.y : 0,
      cropX1: crop ? crop.x + crop.w : asset.w,
      cropY1: crop ? crop.y + crop.h : asset.h,
      brightness: look.brightness,
      N: paletteLength(look.palette),
      CT: quantizeContrast(look.contrast),
      matrix: look.matrix,
      invert: look.invert,
      palIndex: PALETTE_IDS.indexOf(look.palette),
      dotSize: look.dotSize,
      dotGrow: look.dotGrow,
      O: opacityFixed(node.opacity ?? 100),
      pf,
      pool: pf > 1 ? poolAsset(asset, pf) : null,
      pixelExact,
      // The integer scene cell where the element's raster origin sits at scale 1 — the
      // translation that makes (x − ax) == ex for an unrotated, unscaled element.
      ax: -Math.floor(asset.w / 2 + 0.5 - node.placement.x),
      ay: -Math.floor(asset.h / 2 + 0.5 - node.placement.y),
      inkSlot: look.dotInk !== undefined ? slotOf(look.dotInk) : 0,
      inkMap:
        asset.ink && asset.inks
          ? Uint8Array.from(asset.inks, (s, j) => (j === 0 ? 0 : slotOf(s)))
          : null,
    });
  }

  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      // "Over" compositing of PRE-dither tones, top-down: each
      // covering node contributes its opacity share of what's left; the TOPMOST
      // covering node's look still dithers the cell (one quantize per cell).
      // A fully-opaque top node contributes 256/256 — bit-identical to the old
      // first-covered-wins walk, so pre-opacity scenes are untouched.
      let accA = 0;
      let toneAcc = 0;
      let top = -1;
      let topEx = 0;
      let topEy = 0;
      let topAi = 0;
      // The exact pre-dither luma when ONE fully-opaque element at neutral brightness
      // owns the cell (the "shown as saved" case); -1 = use the blended tone.
      let exactLum = -1;
      for (let k = 0; k < prepared.length; k++) {
        const p = prepared[k];
        if (p.O === 0) continue;
        // Scene-cell centre → element coords via the inverse affine (about centre).
        const dx = x + 0.5 - p.cx;
        const dy = y + 0.5 - p.cy;
        const ex = Math.floor(p.asset.w / 2 + (dx * p.cos - dy * p.sin) * p.isx);
        const ey = Math.floor(p.asset.h / 2 + (dx * p.sin + dy * p.cos) * p.isy);
        if (ex < p.cropX0 || ex >= p.cropX1 || ey < p.cropY0 || ey >= p.cropY1) continue;
        if (ex < 0 || ex >= p.asset.w || ey < 0 || ey >= p.asset.h) continue;
        // Read the (optionally block-pooled) PRE-dither tone: coarser Pixel maps ex,ey to
        // its f×f block cell in the pool; crop + bounds are always in full element cells.
        let srcCovered: number;
        let srcTone: number;
        let srcFine = 0;
        if (p.pf > 1 && p.pool) {
          const pi = ((ey / p.pf) | 0) * p.pool.w + ((ex / p.pf) | 0);
          srcCovered = p.pool.covered[pi];
          srcTone = p.pool.tones[pi];
        } else {
          const ai = ey * p.asset.w + ex;
          srcCovered = p.asset.covered[ai];
          srcTone = p.asset.tones[ai];
          if (p.asset.fine) srcFine = p.asset.fine[ai];
        }
        if (!srcCovered) continue;
        if (top < 0) {
          top = k;
          topEx = ex;
          topEy = ey;
          topAi = ey * p.asset.w + ex;
          if (p.O === 256 && p.brightness === 0) exactLum = srcTone * 256 + srcFine;
        }
        const a = floorDiv(p.O * (256 - accA), 256);
        toneAcc += clampTone(srcTone + p.brightness) * a;
        accA += a;
        if (accA >= 256) break;
      }
      // The "over" stack bottoms out on the canvas background's tone, or PAPER
      // when the background is transparent — opacity is ink density: the fade
      // is identical either way; only what fills the untouched cells differs.
      if (top < 0) continue;
      if (accA < 256) {
        toneAcc += (backgroundTone ?? PAPER_TONE) * (256 - accA);
        accA = 256;
      }
      const t = prepared[top];
      const tone = clampTone(floorDiv(toneAcc + (accA >> 1), accA));
      const i = y * SW + x;
      covered[i] = 1;
      tones[i] = tone;
      pal[i] = t.palIndex;
      dSize[i] = t.dotSize;
      dGrow[i] = t.dotGrow ? 1 : 0;
      ink[i] = t.inkSlot || (t.inkMap ? t.inkMap[t.asset.ink![topAi]] : 0);
      // Element-local dither coordinates — the load-bearing rule.
      const qx = t.pixelExact ? topEx : x - t.ax;
      const qy = t.pixelExact ? topEy : y - t.ay;
      // A fine-less, opaque, neutral cell gives exactLum == 256·tone, so it quantizes
      // exactly as the old grey-RGB call did; blends/brightness use the blended tone.
      const lumI = exactLum >= 0 ? exactLum : tone * 256;
      if (exactLum >= 0) fine[i] = exactLum & 255;
      idx[i] = quantizeLum(lumI, qx, qy, t.N, t.CT, orderedPattern(t.matrix), t.invert);
    }
  }

  return {
    w: SW,
    h: SH,
    covered,
    pal,
    idx,
    tones,
    dSize,
    dGrow,
    fine,
    ...(inks.length > 1 ? { ink, inks } : {}),
  };
}

/** A flat scene background: EITHER a preset
 *  palette shade (`{palette, index}`, tracks the palette / clamps on shorter ramps)
 *  OR a custom RGB (`{rgb}`, pinned). Chrome, not content — painted at the
 *  render/encode layer, never dithered. */
export type SceneBackground = { palette: PaletteId; index: number } | { rgb: Rgb };

/** The resolved RGB of a scene background (preset shade or custom RGB). */
export function sceneBackgroundRgb(bg: SceneBackground): Rgb {
  return 'rgb' in bg ? clampRgb(bg.rgb) : paletteRgbAt(bg.palette, bg.index);
}

/** The integer luma TONE of a scene background — what the opacity "over" stack
 *  bottoms out on. */
export function sceneBackgroundTone(bg: SceneBackground): number {
  return rgbTone(sceneBackgroundRgb(bg));
}

/** The composited pre-dither tone raster of a scene — for "save scene as a new
 *  Library element" (re-rendered under the scene's default palette/matrix).
 *  `backgroundTone` bakes the flat background in as content (uncovered cells
 *  become covered at that tone) so the saved element carries its canvas. */
export function sceneToneComposite(grid: SceneGrid, backgroundTone?: number): Composite {
  // The fine plane rides along only when it carries something (else the composite keeps
  // the old 8-bit shape → byte-identical saves/ids for scenes with no exact cells).
  const anyFine = !!grid.fine && grid.fine.some((v) => v !== 0);
  // Per-layer dot colours ride along the same way.
  const inkPart = grid.ink && grid.inks ? { ink: grid.ink, inks: grid.inks } : {};
  if (backgroundTone === undefined) {
    return anyFine
      ? {
          w: grid.w,
          h: grid.h,
          tones: grid.tones,
          covered: grid.covered,
          fine: grid.fine,
          ...inkPart,
        }
      : { w: grid.w, h: grid.h, tones: grid.tones, covered: grid.covered, ...inkPart };
  }
  const tones = grid.tones.slice();
  const covered = grid.covered.slice();
  const fine = anyFine ? grid.fine!.slice() : undefined;
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) {
      covered[i] = 1;
      tones[i] = backgroundTone;
      if (fine) fine[i] = 0;
    }
  }
  // Background cells keep ink slot 0 (they were uncovered → already 0).
  return fine
    ? { w: grid.w, h: grid.h, tones, covered, fine, ...inkPart }
    : { w: grid.w, h: grid.h, tones, covered, ...inkPart };
}

/** A rendered frame before PNG compression: the packed index pixels, the palette and
 *  per-entry alpha (tRNS). The PNG export compresses it; the video encoder (platform/codec)
 *  takes it as-is — the same pixels either way. Print screens make it
 *  (core/scene-screen printFrameToRaster). */
export interface SceneRaster {
  buf: PackedIndexBuffer;
  palette: Uint8Array;
  trns: Uint8Array;
}
