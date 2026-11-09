// =============================================================================
// Record scene store (v1 ecosystem increment 3). The multi-element
// composer: a list of placed nodes that each reference a Library element (by id)
// + a transform + a crop + a per-node LOOK OVERRIDE. The "stage" model:
//
//   - Nothing selected → the look knobs edit the SCENE defaults (every node that
//     doesn't override inherits them).
//   - One/more selected → the look knobs edit just those nodes (overrides).
//
// Effective look = { ...scene, ...node.look }. The render is a pure function of
// (nodes, scene, asset rasters) → see core/scene-resolver. The big tone/covered
// rasters live in a separate asset cache (NOT here, NOT in undo). zundo wraps the
// lightweight model (nodes + scene defaults) for undo/redo; selection + rev are
// excluded so selecting never creates a history entry and a gesture commits once.
// =============================================================================
import { create } from 'zustand';
import { temporal } from 'zundo';
import { gesture } from './gesture';
import { useBurnStore } from './burn-store';
import {
  ASPECT_RATIO,
  computeGrid,
  FRAME_LONG,
  MIN_GRID_CELLS,
  type AspectId,
  type PaletteId,
  type PatternId,
} from '../core/dither-constants';
import type { BrushTool } from '../core/raster-brush';
import type { VisualizerConfig } from '../core/visualizer';
import type { TextLayerConfig } from '../core/dot-font';
import type { Swatch } from '../core/color';
import type { FxKind, LayerFx } from '../core/layer-fx';
import type { TimelineClip } from '../core/timeline-edit';
import { HALFTONE_SIZE_DEFAULT } from '../core/cell-style';
import { LAYER_LOOK_KEYS, LOOK_SCREEN_DEFAULT } from '../core/print-screen';
export { LAYER_LOOK_KEYS };
import type { ModMap, ModParam, Modulator } from '../core/modulators';

/** Scene cells on the long edge — the DEFAULT scene lattice long edge (== Pixel 2.5,
 *  see below). Kept as the `sceneDims` fallback so every call that doesn't thread the
 *  live scene resolution stays byte-identical to the historic fixed-192 behaviour. */
export const SCENE_LONG = 192;

/** The scene "Pixel" resolution shares Burn's units EXACTLY. Burn downscales the source
 *  into an aspect frame whose long edge is `FRAME_LONG` px (core/dither-constants, ==
 *  image-to-grid's PREVIEW_MAX) then divides by `cellSize` (the "Pixel" dial), so Burn's
 *  grid long edge = round(FRAME_LONG / cellSize) (core/computeGrid). The scene lattice uses
 *  the SAME mapping: scene long edge = round(480 / Pixel). Default Pixel 2.5 → round(192) =
 *  192, reproducing today's fixed lattice EXACTLY. Dropping a Burn element that was made
 *  at cellSize C onto an EMPTY scene adopts Pixel = C, so the scene lattice matches the
 *  lattice the element was burned at (closes the "fine burn resamples to 192" regression). */
export const SCENE_PIXEL_DEFAULT = 2.5;
/** Scene lattice long edge (cells) for a Pixel value — Burn's exact grid rule, floored
 *  at MIN_GRID_CELLS so an extreme Pixel can't degenerate the lattice. */
export function sceneLongFromPixel(pixel: number): number {
  return Math.max(MIN_GRID_CELLS, Math.round(FRAME_LONG / pixel));
}
/** Guard a Pixel into the supported range (1 = very fine … 20 = very coarse). */
export function clampScenePixel(pixel: number): number {
  return Math.max(1, Math.min(20, pixel));
}

/** Scene grid dims for an aspect at a Pixel — Burn's EXACT grid rule (the aspect frame,
 *  FRAME_LONG on its long edge, divided by the Pixel via computeGrid), so the scene, a
 *  paint layer, an image layer and Make's canvas are one grid. At the default
 *  Pixel 2.5 this is 192×144 — identical to the long-edge rule below. */
export function sceneDimsAt(aspect: AspectId, pixel: number): { w: number; h: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  const targetW = rw >= rh ? FRAME_LONG : Math.round((FRAME_LONG * rw) / rh);
  const targetH = rh >= rw ? FRAME_LONG : Math.round((FRAME_LONG * rh) / rw);
  const { LW, LH } = computeGrid(targetW, targetH, pixel);
  return { w: LW, h: LH };
}

/** Scene grid dims for an aspect at a lattice long edge (default = SCENE_LONG so historic
 *  callers stay byte-identical) — the shared shape source. Short edge derives
 *  from the aspect. Mirrors draw-store docDims. */
export function sceneDims(aspect: AspectId, long: number = SCENE_LONG): { w: number; h: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  return rw >= rh
    ? { w: long, h: Math.round((long * rh) / rw) }
    : { w: Math.round((long * rw) / rh), h: long };
}

/** The full per-cell "look". Scene holds the defaults; a node overrides a subset. */
export interface Look {
  palette: PaletteId;
  /** The Pattern: a threshold table or an error-diffusion recipe. */
  matrix: PatternId;
  invert: boolean;
  /** Tone offset added before dithering, -255..255 (0 = none). */
  brightness: number;
  /** Contrast multiplier about mid-grey, 0.25..4 (1 = none). */
  contrast: number;
  /** Halftone dot SIZE (diameter px) for THIS element — PER-ELEMENT:
   *  select an element to size just its dots; with nothing selected the Size knob
   *  edits the scene default. Only the Halftone modes read it; the classic dither
   *  ignores it. (Density stays scene-wide in the burn store — one shared lattice.) */
  dotSize: number;
  /** Tonal (per-element): true → this element's dots grow in its brighter areas;
   *  false → every dot the same size (density alone carries the tone). */
  dotGrow: boolean;
  /** PER-ELEMENT Pixel (US-R2/W5, coarser-only). An absolute cell size in the SAME
   *  "Pixel" units as the scene resolution + Burn; 0 = inherit (render at the scene's
   *  effective cell, byte-identical to before). A value ABOVE the scene's effective
   *  Pixel block-downsamples this element's PRE-dither tones by round(pixel/scenePixel)
   *  before the lattice, so the element reads coarser while the ONE shared lattice +
   *  single quantize stay untouched (one dither truth). Values ≤ scene are clamped to
   *  the scene (can only coarsen) by the resolver. Rehydrated per-element on every drop
   *  from the v4 look blob (like dotSize/dotGrow). */
  pixel: number;
  /** Halftone dot COLOUR override for THIS layer: absent /
   *  undefined = the canvas dot colour (sceneStore.dotInk). Only set as a layer override
   *  (the canvas-wide colour lives in dotInk, not in the scene Look). */
  dotInk?: Swatch;
  // ---- Print screens: each layer's own screen. Read by core/print-screen once
  // the render path moves to it (P3); until then the canvas still draws from the burn
  // store's scene-wide cell style + density.
  /** Dither bits or a halftone dot screen. */
  style: 'dither' | 'halftone';
  /** The halftone dot shape. */
  shape: 'circle' | 'square';
  /** How close the halftone dots sit (the Density knob, now per layer). */
  density: number;
  /** The halftone screen's angle in degrees (Look ▸ More). */
  angle: number;
  /** The screen turns + grows with the layer (off = stays upright at its set size). */
  dotsTurn: boolean;
  /** A dither bit's side in px at the live render scale (replaces the canvas Pixel). */
  bitSize: number;
  /** Grain Drift (J6): how fast the bits / dots slide over the still picture, in
   *  canvas squares per beat. Absent / 0 = still. */
  drift?: number;
  /** Which way the grain drifts, degrees (0 = right, 90 = up). Absent = 0. */
  driftDir?: number;
  /** One ink (the dot colour) or dither between the palette's shades. */
  colourMode: 'ink' | 'palette';
}
export type LookOverride = Partial<Look>;

export const SCENE_LOOK_DEFAULT: Look = {
  palette: 'two',
  matrix: 8,
  invert: false,
  brightness: 0,
  contrast: 1,
  dotSize: HALFTONE_SIZE_DEFAULT,
  dotGrow: true,
  pixel: 0, // 0 = inherit the scene resolution (no per-element coarsening)
  ...LOOK_SCREEN_DEFAULT, // each layer's own screen: today's Dither to start
};

/** How finely every layer keeps its picture: Normal = one value per canvas
 *  square (today), Fine = 4× finer each way. Project-wide. */
export type Detail = 'normal' | 'fine';
/** Picture values per canvas square, each way. */
export const DETAIL_FACTOR: Record<Detail, number> = { normal: 1, fine: 4 };

/** A new layer's own look: the canvas look's layer fields. */
export function layerLookFrom(scene: Look): LookOverride {
  const out: LookOverride = {};
  for (const k of LAYER_LOOK_KEYS) (out as Record<string, unknown>)[k] = scene[k];
  return out;
}

/** Node placement in SCENE-CELL units. x/y = the element CENTRE; scale + rotation
 *  about that centre. An element's native footprint is its tone raster w×h cells. */
export interface Placement {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
}

/** A box moved by (dx, dy). */
const shiftRect = (r: CropRect, dx: number, dy: number): CropRect => ({
  ...r,
  x: r.x + dx,
  y: r.y + dy,
});

/** Crop rect in the element's own tone-cell coords (null = the whole element). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Procedural per-node motion (D8 / looper; the coded-motion set H-A0). The
 *  output is a pure function of the loop phase p = frame/F, applied by `evaluateScene`
 *  BEFORE the resolver (so `resolveSceneGrid` stays time-blind). Periodic motions use
 *  2*PI*cycles*p with an INTEGER `cycles` so the motion closes seamlessly at p = 1
 *  (frame 0 == frame F). Two families are seam-exempt because they are NOISE, not smooth
 *  periodics (twinkle = keyed-PRNG brightness, shake = keyed-PRNG dx/dy) — they repeat
 *  identically every loop by construction. `marquee` is a true WRAP-AROUND scroll
 *  resolved at the apply step (it needs the node footprint + scene dims to place the
 *  element fully off-glass at the wrap). null = static (today's behaviour, byte-identical).
 *  The canonical storage of an animation is a `MotionEvent` in the loop-store;
 *  `SceneNode.motion` is a convenience mirror `evaluateScene` folds in first. */
export interface MotionDescriptor {
  type:
    | 'drift'
    | 'bob'
    | 'parallax'
    | 'blink'
    | 'marquee'
    | 'twinkle'
    | 'spin'
    | 'pendulum'
    | 'bounce'
    | 'shake'
    | 'pulse';
  /** INTEGER cycles per loop → seamless wrap (ANY whole number closes at p = 1), so
   *  this IS the motion SPEED: the deck ± stepper sets it, 1..8, for every periodic
   *  type (marquee = traversals/loop; spin = revolutions/loop; blink = flashes/loop).
   *  The noise types (twinkle/shake) ignore it — their stepper adjusts `amp` instead. */
  cycles: number;
  /** TEMPO-SYNCED speed (Group J1, FL Studio style): one cycle lasts this many BEATS
   *  (¼ beat … 8 bars = 32). When set it replaces `cycles` — the motion follows the
   *  project's beat clock (core/tempo); absent on motions made before tempo existed,
   *  which keep their per-loop `cycles`. */
  beats?: number;
  /** Amplitude — units are PER-TYPE (documented in `foldMotion`): translation types
   *  (drift/bob/bounce/shake + orbit radius) = scene cells; marquee = extra off-glass
   *  clearance in cells; blink/twinkle = normalised intensity; pendulum = swing degrees;
   *  pulse = % scale swing; spin = UNUSED (speed comes from `cycles`). For the
   *  DIRECTIONAL types (marquee/drift/bounce) the on-glass arrow's dragged LENGTH sets
   *  it (1 cell of amp per scene cell of arrow); twinkle/shake set it via the ± stepper. */
  amp: number;
  /** Per-axis amplitude weights (drift/parallax/marquee/shake direction). For the
   *  directional types the on-glass arrow writes a normalized (cosθ, sinθ). */
  ax: number;
  ay: number;
  /** Static phase offset in turns (0..1). */
  phase0: number;
}

/** A frozen Library/synced asset (the brush is greyed) vs a mutable PAINT layer
 *  the Record brush writes into (draw-in-Record / E4). Both render through the one
 *  resolver — a paint layer is just a node whose tone raster keeps changing. */
export type NodeKind = 'asset' | 'paint' | 'visualizer' | 'image' | 'text' | 'recording';

/** How a recording plays past + through its drawn part. Absent = Repeat, forwards. */
export interface RecordingPlay {
  /** Past its drawn part it holds the finished picture instead of repeating. */
  hold?: boolean;
  /** It plays backwards (it un-draws itself). */
  backwards?: boolean;
  /** After a merge its own loop is longer: the clock its Motion keeps running on, so a Motion
   *  moves as it did before (`at` = where that clock starts on the merged one). */
  motionLoop?: { frames: number; at: number };
}

/** An IMAGE layer's treatment: the imported picture's tone dials + its reframe
 *  within the canvas frame — Burn's exact params, per layer. The layer's raster is
 *  REGENERATED from its source through the one `sourceToGrid` seam at the canvas Pixel
 *  grid whenever these (or the Pixel/aspect) change, so moving/zooming re-samples the
 *  picture (never warps a dithered bitmap) and the canvas shows Burn's pixels exactly. */
export interface ImageLayerParams {
  /** -100..100, 0 = none. Absent on photos added before it = 0. */
  brightness?: number;
  contrast: number;
  gamma: number;
  black: number;
  white: number;
  invert: boolean;
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** Picture rotation in degrees (the source is re-sampled rotated). */
  rotation: number;
  /** The photo's CUTOUT mask version (Remove BG + Erase/Restore) — a key into
   *  image-layers' mask store (the pixels live out of zundo, like paint rasters); null =
   *  no cutout. Each Remove BG / Erase / Restore stroke mints a new key, so the ONE undo
   *  stack steps the cutout back and forth. */
  matte: string | null;
}
export const IMAGE_PARAMS_DEFAULT: ImageLayerParams = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  black: 0,
  white: 255,
  invert: false,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  matte: null,
};

export interface SceneNode {
  id: string;
  /** Library element id (AssetRecord.id) — its tones/covered come from the cache.
   *  For a paint node this is an in-memory `paint:<n>` id (never the BlobStore). */
  assetId: string;
  kind: NodeKind;
  z: number;
  placement: Placement;
  crop: CropRect | null;
  /** The animation window: a box fixed on the canvas, in scene cells, the layer
   *  is seen through as it moves. Absent = none. */
  window?: CropRect | null;
  /** Only the keys the user changed for THIS node; the rest inherit the scene. */
  look: LookOverride;
  /** Procedural motion (drift/bob/parallax/…); null = static. Folded by `evaluateScene`
   *  before the resolver. Was reserved (`null`). */
  motion: MotionDescriptor | null;
  /** Per-node opacity, integer percent 0..100 (100 = opaque, the default — bit-
   *  identical to the pre-opacity render). Blended PRE-dither in the resolver
   *  (tones mix, never dithered pixels — one dither truth). */
  opacity: number;
  /** Hidden layer (owner: right-click ▸ Hide) — kept in the stack but not
   *  drawn, saved or exported. Absent = shown. */
  hidden?: boolean;
  /** TIMING: the layer's clips on its timeline
   *  row, in SONG frames — it shows only inside them (a video shows media frame
   *  sourceIn + (t − start) × speed, repeating past its footage). Absent = on for the whole
   *  video. Edited through core/timeline-edit (FilmCraft's algebra). */
  clips?: TimelineClip[];
  /** Generative-visualizer config (kind:'visualizer' only). Its tone raster is
   *  REGENERATED each loop frame from the audio by core/visualizer; the node is
   *  otherwise an ordinary element (placement/look/opacity/crop). */
  viz?: VisualizerConfig;
  /** Image-layer treatment (kind:'image' only). */
  image?: ImageLayerParams;
  /** How a recording plays (kind:'recording' only). */
  rec?: RecordingPlay;
  /** Dot-matrix text (kind:'text' only). Its `text:` raster is a pure function
   *  of this config (core/dot-font), redrawn whenever it changes (ui/text-node). */
  text?: TextLayerConfig;
  /** This layer's modulators (J2): sliders that move on their own (a Wave or
   *  Follow sound), folded per frame by `evaluateScene`. Absent = none. */
  mods?: ModMap;
  /** Solid: blocks what's under it inside its shape instead of overprinting.
   *  Absent = overprint. */
  solid?: boolean;
  /** Effects (J5): what its picture goes through before its dots. Absent = none. */
  fx?: LayerFx;
  /** This frame's grain Drift offset (J6), canvas squares — set by evaluateScene on the
   *  evaluated copy only, never stored. */
  grain?: { x: number; y: number };
}

/** A freshly-dropped node: a Library element placed at a scene-cell centre. */
export interface DropSpec {
  assetId: string;
  /** Native footprint in scene cells (the element's tone raster dims). */
  w: number;
  h: number;
  /** Centre in scene cells. */
  cx: number;
  cy: number;
  /** Initial scale (default 1) — e.g. the synced Draw stage fills the scene. */
  scaleX?: number;
  scaleY?: number;
  /** The element's saved look (palette/matrix), so it drops in looking exactly
   *  as it was burned/drawn rather than inheriting the scene defaults. */
  look?: LookOverride;
  /** Initial crop (element-local cells) — a video element's saved Burn reframe
   *  arrives as this crop, so it drops in framed as it was saved. */
  crop?: CropRect | null;
}

/** Record's interaction modes: ARRANGE (Konva transforms) · PAINT (the brush
 *  bypasses Konva and writes into the active paint layer's raster) · REACT (author
 *  audio reactions; the glass still selects, for element-targeted reactions).
 *  Transient. */
export type RecordTool = 'arrange' | 'paint' | 'react';

/** The Record brush params (its OWN slice — per-mode params; never Draw's). */
export interface RecordBrush {
  tool: BrushTool;
  size: number;
  shade: number;
}

interface SceneState {
  nodes: SceneNode[];
  scene: Look;
  /** Scene canvas background: a Swatch — a SCENE
   *  palette shade index | a custom `[r,g,b]` | null = transparent. Flat colour, never
   *  dithered. Undoable. */
  background: Swatch;
  /** Scene-wide Halftone DOT-COLOUR (custom-colour Phase 1; fixes STATUS gap G-1 for
   *  Record): a Swatch — a palette shade index | a custom `[r,g,b]` | null = the
   *  palette's brightest shade (dots-on-dark). Halftone-only. Undoable (mirrors the
   *  background). */
  dotInk: Swatch;
  /** Scene lattice resolution as a "Pixel" value (Burn's units; scene long edge =
   *  sceneLongFromPixel(pixel)). Default SCENE_PIXEL_DEFAULT reproduces today's 192.
   *  Undoable; the UI locks the control once the scene has paint layers or takes. */
  pixel: number;
  /** The canvas's modulators (J2): its Dot size + Density sliders. Undoable. */
  canvasMods: ModMap;
  /** The Whole canvas Motion: the whole picture moving as one. Undoable. */
  canvasMotion: MotionDescriptor | null;
  /** The Whole canvas effects (J5 step 3): on the whole picture, about the canvas
   *  middle. Undoable, saved. */
  canvasFx: LayerFx | null;
  /** How finely every layer keeps its picture. Undoable, saved. */
  detail: Detail;
  selected: string[];
  rev: number;
  /** The node currently in crop mode (transient UI state; not undo history). */
  cropId: string | null;
  /** The layer whose animation window is being edited on the canvas; transient. */
  windowId: string | null;
  /** Arrange (transform) vs Paint (brush). Transient — not undo history. */
  tool: RecordTool;
  /** The Record paint brush settings. Transient. */
  brush: RecordBrush;
  /** Erase on a selected PHOTO edits its cutout: rub out, or paint back. */
  matteMode: 'erase' | 'restore';

  /** Drop Library elements as new nodes (stacked above existing z), select them. */
  addNodes: (specs: DropSpec[]) => void;
  /** Add a mutable PAINT node referencing an in-memory `paint:` asset; select it.
   *  Returns the new node id (so the caller can target the brush at it). */
  addPaintNode: (assetId: string, cx: number, cy: number, aboveId?: string | null) => string;
  /** Add a RECORDING referencing its own blank `paint:` raster, just above
   *  `aboveId` (absent = on top); select it. Returns the new node id. */
  addRecordingNode: (assetId: string, cx: number, cy: number, aboveId?: string | null) => string;
  /** Change how a recording plays (Hold / Play backwards) — one undo step. */
  setRecordingPlay: (nodeId: string, patch: RecordingPlay) => void;
  /** A merge's new bar + play settings on the recording it went into. One step. */
  setMergedRecording: (nodeId: string, clip: TimelineClip, rec: RecordingPlay) => void;
  /** Add a generative-visualizer node (assetId = its regenerated `viz:` raster) at
   *  a centre + initial uniform scale. */
  addVisualizerNode: (
    assetId: string,
    cx: number,
    cy: number,
    scale: number,
    viz: VisualizerConfig,
  ) => string;
  /** Add a full-frame IMAGE layer at the canvas centre; select it. */
  addImageNode: (assetId: string, cx: number, cy: number, params?: ImageLayerParams) => string;
  /** Patch an image layer's treatment (tone dials / reframe) — one zundo step. */
  setImageParams: (nodeId: string, patch: Partial<ImageLayerParams>) => void;
  /** Patch a visualizer node's config (style/band/gain) — one zundo step. */
  setViz: (nodeId: string, patch: Partial<VisualizerConfig>) => void;
  /** Add a dot-matrix TEXT layer centred at (cx, cy) at scale 1 (one dot =
   *  one cell); select it. Returns the new node id. */
  addTextNode: (assetId: string, cx: number, cy: number, text: TextLayerConfig) => string;
  /** Patch a text layer's words / Size / Spacing / Align — one zundo step. */
  setText: (nodeId: string, patch: Partial<TextLayerConfig>) => void;
  /** Convert a frozen node into a paint node in place (rasterize-to-edit): swap to
   *  a fresh mutable asset id, keep placement/crop/look, select it. */
  replaceWithPaint: (nodeId: string, assetId: string) => void;
  /** Point a layer at a different asset (a video layer's re-trimmed clip) — one undo step. */
  setNodeAsset: (nodeId: string, assetId: string) => void;
  /** Hide / show a layer (one undo step). */
  setHidden: (nodeId: string, hidden: boolean) => void;
  /** Replace a layer's clips (one undo step); undefined = back to always-on. */
  setClips: (nodeId: string, clips: TimelineClip[] | undefined) => void;
  remove: (ids: string[]) => void;
  clear: () => void;

  setTool: (t: RecordTool) => void;
  setBrush: (patch: Partial<RecordBrush>) => void;
  setMatteMode: (m: 'erase' | 'restore') => void;

  /** Force a re-render (e.g. after a synced node's cached raster changed in place). */
  bump: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelect: (id: string, additive: boolean) => void;
  clearSelection: () => void;

  /** Commit a node's transform (one undo entry per gesture — call on drag/transform end). */
  setPlacement: (id: string, placement: Placement) => void;
  setCrop: (id: string, crop: CropRect | null) => void;
  /** Set / clear a layer's animation window, in canvas squares. One undo step. */
  setWindow: (id: string, window: CropRect | null) => void;
  /** Set/clear a node's procedural motion (looper / D8). One zundo step (it's part of
   *  the t=0 model); `evaluateScene` folds it per frame. `id` '' = the Whole canvas Motion. */
  setMotion: (id: string, motion: MotionDescriptor | null) => void;
  /** Make a slider move on its own (J2), change how, or stop it (null). `nodeId` '' = the
   *  canvas's sliders. One zundo step (a drag inside its settings is one step too). */
  setMod: (nodeId: string, param: ModParam, mod: Modulator | null) => void;
  /** Make the given layers Solid (block what's under them) or overprint again. One step. */
  setSolid: (ids: string[], solid: boolean) => void;
  /** Add, change or remove (null) one of a layer's effects (J5) — nodeId '' = the Whole
   *  canvas's. One zundo step. */
  setFx: <K extends FxKind>(nodeId: string, kind: K, value: LayerFx[K] | null) => void;
  /** Set the project's Detail (Normal / Fine) in ONE undo step: drawing layers swap to
   *  their re-gridded rasters (`paintRemap`: old asset id → new; the old ones stay cached so
   *  Undo brings them back), and every crop on a picture that follows the Detail (photos,
   *  drawings, videos) scales with its raster. */
  setDetail: (detail: Detail, paintRemap?: ReadonlyMap<string, string>) => void;
  /** Set the given nodes' opacity (integer percent 0..100). One zundo step. */
  setOpacity: (ids: string[], opacity: number) => void;
  /** Set the scene's flat canvas background Swatch. One zundo step. */
  setBackground: (b: Swatch) => void;
  /** Set the scene-wide Halftone dot-ink Swatch. One zundo step. */
  setDotInk: (i: Swatch) => void;
  /** Set the scene resolution Pixel (Burn's units). Rescales existing node placements
   *  proportionally so arrange elements stay visually in place (crops are element-local,
   *  so they are NOT scaled). A no-op if the scene has paint layers (their rasters are
   *  scene-sized — the UI locks the control before that). One zundo step. */
  setScenePixel: (pixel: number, regrid?: boolean) => void;
  /** The canvas look: the look NEW layers start with — existing layers keep
   *  their own. */
  setSceneLook: (patch: LookOverride) => void;
  /** Whole canvas ▸ Apply to all layers: every layer takes the canvas look's layer fields
   *  (its own dot colour stays). One undo step. */
  applyLookToAll: () => void;
  /** Enter/exit crop mode for a node (transient). */
  setCropId: (id: string | null) => void;
  setWindowId: (id: string | null) => void;
  /** Raise/lower/bring-to-front/send-to-back within the z-order. */
  reorder: (id: string, to: 'front' | 'back' | 'up' | 'down') => void;
  /** Drag-reorder: move a layer to position `index` in the bottom-up
   *  z-order (0 = bottom). One undo step. */
  moveLayer: (id: string, index: number) => void;
  /** A layer's own halftone dot colour; undefined = back to the canvas's. */
  setLayerInk: (id: string, ink: Swatch | undefined) => void;
  /** Mirror the selected nodes horizontally ('h') or vertically ('v'). */
  flip: (axis: 'h' | 'v') => void;
  /** Duplicate the selected node(s) — offset slightly, stacked on top, then selected.
   *  `assetRemap` swaps a source node's assetId for the clone (paint layers get a
   *  fresh copied raster so the clone doesn't share the original's pixels). */
  duplicate: (assetRemap?: Map<string, string>) => void;

  /** Apply a look change: to the selected nodes if any are selected, else the scene. */
  setLook: (patch: LookOverride) => void;
  /** Clear overrides on the selected nodes (re-inherit the scene). */
  resetLook: () => void;
}

/** Nodes whose RASTER tracks the scene lattice (video previewers — their tone raster is
 *  rebuilt at the new lattice long edge on a resolution change). For those, setScenePixel
 *  rescales the position but NOT the placement scale (the raster rebuild carries the
 *  on-glass footprint), and their element-local crop scales WITH the raster. Injected by
 *  ui/video-assets (state can't import ui); default = none (stills never track). */
let rasterTracksScene: (node: SceneNode) => boolean = () => false;
export function registerResolutionTracking(pred: (node: SceneNode) => boolean): void {
  rasterTracksScene = pred;
}

let seq = 0;
const nextId = (): string => `node-${++seq}`;

/** Skip the node-id counter past a reopened project's `node-N` ids. */
export function reserveNodeIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const n = id.startsWith('node-') ? Number(id.slice(5)) : NaN;
    if (Number.isInteger(n) && n > seq) seq = n;
  }
}

const sortByZ = (nodes: SceneNode[]): SceneNode[] => [...nodes].sort((a, b) => a.z - b.z);

/** A new blank full-frame drawing / recording, just above `aboveId` (absent = on top), picked. */
function addDrawnNode(
  s: Pick<SceneState, 'nodes' | 'scene' | 'rev'>,
  id: string,
  assetId: string,
  kind: 'paint' | 'recording',
  cx: number,
  cy: number,
  aboveId?: string | null,
): Pick<SceneState, 'nodes' | 'selected' | 'rev'> {
  const ordered = sortByZ(s.nodes);
  const below = aboveId ? ordered.findIndex((n) => n.id === aboveId) : -1;
  ordered.splice(below >= 0 ? below + 1 : ordered.length, 0, {
    id,
    assetId,
    kind,
    z: 0,
    placement: { x: cx, y: cy, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: layerLookFrom(s.scene),
    motion: null,
    opacity: 100,
  });
  return { nodes: ordered.map((n, k) => ({ ...n, z: k + 1 })), selected: [id], rev: s.rev + 1 };
}

export const useSceneStore = create<SceneState>()(
  temporal(
    (set) => ({
      nodes: [],
      scene: { ...SCENE_LOOK_DEFAULT },
      background: null,
      dotInk: null,
      pixel: SCENE_PIXEL_DEFAULT,
      canvasMods: {},
      canvasMotion: null,
      canvasFx: null,
      detail: 'normal',
      selected: [],
      rev: 0,
      cropId: null,
      windowId: null,
      tool: 'paint', // the canvas opens ready to draw
      brush: { tool: 'brush', size: 3, shade: 0.85 },
      matteMode: 'erase',

      addNodes: (specs) =>
        set((s) => {
          let z = s.nodes.reduce((m, n) => Math.max(m, n.z), 0);
          const added = specs.map(
            (d): SceneNode => ({
              id: nextId(),
              assetId: d.assetId,
              kind: 'asset',
              z: ++z,
              placement: {
                x: d.cx,
                y: d.cy,
                scaleX: d.scaleX ?? 1,
                scaleY: d.scaleY ?? 1,
                rotationDeg: 0,
              },
              crop: d.crop ?? null,
              look: { ...layerLookFrom(s.scene), ...(d.look ?? {}) },
              motion: null,
              opacity: 100,
            }),
          );
          return {
            nodes: [...s.nodes, ...added],
            selected: added.map((n) => n.id),
            rev: s.rev + 1,
          };
        }),

      addPaintNode: (assetId, cx, cy, aboveId) => {
        const id = nextId();
        set((s) => addDrawnNode(s, id, assetId, 'paint', cx, cy, aboveId));
        return id;
      },

      addRecordingNode: (assetId, cx, cy, aboveId) => {
        const id = nextId();
        set((s) => addDrawnNode(s, id, assetId, 'recording', cx, cy, aboveId));
        return id;
      },

      setRecordingPlay: (nodeId, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === nodeId && n.kind === 'recording' ? { ...n, rec: { ...n.rec, ...patch } } : n,
          ),
          rev: s.rev + 1,
        })),

      setMergedRecording: (nodeId, clip, rec) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, clips: [clip], rec } : n)),
          rev: s.rev + 1,
        })),

      addImageNode: (assetId, cx, cy, params = IMAGE_PARAMS_DEFAULT) => {
        const id = nextId();
        set((s) => {
          const z = s.nodes.reduce((m, n) => Math.max(m, n.z), 0) + 1;
          const node: SceneNode = {
            id,
            assetId,
            kind: 'image',
            z,
            placement: { x: cx, y: cy, scaleX: 1, scaleY: 1, rotationDeg: 0 },
            crop: null,
            look: layerLookFrom(s.scene),
            motion: null,
            opacity: 100,
            image: { ...params },
          };
          return { nodes: [...s.nodes, node], selected: [id], rev: s.rev + 1 };
        });
        return id;
      },

      setImageParams: (nodeId, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === nodeId && n.image ? { ...n, image: { ...n.image, ...patch } } : n,
          ),
          rev: s.rev + 1,
        })),

      addVisualizerNode: (assetId, cx, cy, scale, viz) => {
        const id = nextId();
        set((s) => {
          const z = s.nodes.reduce((m, n) => Math.max(m, n.z), 0) + 1;
          const node: SceneNode = {
            id,
            assetId,
            kind: 'visualizer',
            z,
            placement: { x: cx, y: cy, scaleX: scale, scaleY: scale, rotationDeg: 0 },
            crop: null,
            look: layerLookFrom(s.scene),
            motion: null,
            opacity: 100,
            viz,
          };
          return { nodes: [...s.nodes, node], selected: [id], rev: s.rev + 1 };
        });
        return id;
      },

      addTextNode: (assetId, cx, cy, text) => {
        const id = nextId();
        set((s) => {
          const z = s.nodes.reduce((m, n) => Math.max(m, n.z), 0) + 1;
          const node: SceneNode = {
            id,
            assetId,
            kind: 'text',
            z,
            placement: { x: cx, y: cy, scaleX: 1, scaleY: 1, rotationDeg: 0 },
            crop: null,
            look: layerLookFrom(s.scene),
            motion: null,
            opacity: 100,
            text,
          };
          return { nodes: [...s.nodes, node], selected: [id], rev: s.rev + 1 };
        });
        return id;
      },

      setText: (nodeId, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === nodeId && n.kind === 'text' && n.text
              ? { ...n, text: { ...n.text, ...patch } }
              : n,
          ),
          rev: s.rev + 1,
        })),

      setViz: (nodeId, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === nodeId && n.kind === 'visualizer' && n.viz
              ? { ...n, viz: { ...n.viz, ...patch } }
              : n,
          ),
          rev: s.rev + 1,
        })),

      setClips: (nodeId, clips) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const next = { ...n };
            if (clips) next.clips = clips;
            else delete next.clips;
            return next;
          }),
          rev: s.rev + 1,
        })),

      setHidden: (nodeId, hidden) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== nodeId) return n;
            const next = { ...n };
            if (hidden) next.hidden = true;
            else delete next.hidden;
            return next;
          }),
          rev: s.rev + 1,
        })),

      setNodeAsset: (nodeId, assetId) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, assetId } : n)),
          rev: s.rev + 1,
        })),

      replaceWithPaint: (nodeId, assetId) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            // Drop any `viz` config — the node is now a paint layer, not a visualizer
            // (else stale visualizer controls would show + do nothing).
            n.id === nodeId ? { ...n, assetId, kind: 'paint' as NodeKind, viz: undefined } : n,
          ),
          selected: [nodeId],
          rev: s.rev + 1,
        })),

      // Entering Paint clears any active crop so its inert dashed box (the Konva
      // stage is non-interactive in paint mode) doesn't linger over the brush glass.
      // Leaving Arrange drops any active crop (its inert dashed box shouldn't
      // linger over the brush glass or the React panel's selection).
      setTool: (tool) =>
        set(tool === 'arrange' ? { tool } : { tool, cropId: null, windowId: null }),
      setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
      setMatteMode: (matteMode) => set({ matteMode }),

      remove: (ids) =>
        set((s) => {
          const drop = new Set(ids);
          return {
            nodes: s.nodes.filter((n) => !drop.has(n.id)),
            selected: s.selected.filter((id) => !drop.has(id)),
            rev: s.rev + 1,
          };
        }),

      clear: () =>
        set((s) => ({ nodes: [], selected: [], cropId: null, windowId: null, rev: s.rev + 1 })),

      bump: () => set((s) => ({ rev: s.rev + 1 })),

      setSelection: (ids) => set({ selected: ids }),
      toggleSelect: (id, additive) =>
        set((s) => {
          if (!additive) return { selected: s.selected.includes(id) ? s.selected : [id] };
          return {
            selected: s.selected.includes(id)
              ? s.selected.filter((x) => x !== id)
              : [...s.selected, id],
          };
        }),
      clearSelection: () => set({ selected: [] }),

      setPlacement: (id, placement) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  placement,
                  // Moving a layer by hand brings its window along.
                  ...(n.window
                    ? {
                        window: shiftRect(
                          n.window,
                          placement.x - n.placement.x,
                          placement.y - n.placement.y,
                        ),
                      }
                    : {}),
                }
              : n,
          ),
          rev: s.rev + 1,
        })),

      setWindow: (id, window) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== id) return n;
            const out: SceneNode = { ...n, window };
            if (!window) delete out.window;
            return out;
          }),
          rev: s.rev + 1,
        })),

      setCrop: (id, crop) =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, crop } : n)),
          rev: s.rev + 1,
        })),

      setMotion: (id, motion) =>
        set((s) =>
          id === ''
            ? { canvasMotion: motion, rev: s.rev + 1 }
            : {
                nodes: s.nodes.map((n) => (n.id === id ? { ...n, motion } : n)),
                rev: s.rev + 1,
              },
        ),

      setMod: (nodeId, param, mod) =>
        set((s) => {
          const next = (m: ModMap | undefined): ModMap => {
            const out: ModMap = { ...m };
            if (mod) out[param] = mod;
            else delete out[param];
            return out;
          };
          if (nodeId === '') return { canvasMods: next(s.canvasMods), rev: s.rev + 1 };
          return {
            nodes: s.nodes.map((n) => {
              if (n.id !== nodeId) return n;
              const mods = next(n.mods);
              const out: SceneNode = { ...n, mods };
              if (Object.keys(mods).length === 0) delete out.mods;
              return out;
            }),
            rev: s.rev + 1,
          };
        }),

      setOpacity: (ids, opacity) =>
        set((s) => {
          const target = new Set(ids);
          const v = Math.max(0, Math.min(100, Math.round(opacity)));
          return {
            nodes: s.nodes.map((n) => (target.has(n.id) ? { ...n, opacity: v } : n)),
            rev: s.rev + 1,
          };
        }),

      setFx: (nodeId, kind, value) =>
        set((s) => {
          if (nodeId === '') {
            const fx: LayerFx = { ...s.canvasFx };
            if (value) fx[kind] = value;
            else delete fx[kind];
            const out: Partial<SceneState> = {
              canvasFx: Object.keys(fx).length ? fx : null,
              rev: s.rev + 1,
            };
            // An effect that goes takes its moving amounts with it.
            if (!value && Object.keys(s.canvasMods).some((k) => k.startsWith(`fx.${kind}`))) {
              const mods = { ...s.canvasMods };
              for (const k of Object.keys(mods) as ModParam[])
                if (k.startsWith(`fx.${kind}`)) delete mods[k];
              out.canvasMods = mods;
            }
            return out;
          }
          return {
            nodes: s.nodes.map((n) => {
              if (n.id !== nodeId) return n;
              const fx: LayerFx = { ...n.fx };
              if (value) fx[kind] = value;
              else delete fx[kind];
              const out: SceneNode = { ...n, fx };
              if (Object.keys(fx).length === 0) delete out.fx;
              // An effect that goes takes its moving amounts with it.
              if (!value && n.mods) {
                const mods = { ...n.mods };
                for (const k of Object.keys(mods) as ModParam[])
                  if (k.startsWith(`fx.${kind}`)) delete mods[k];
                if (Object.keys(mods).length) out.mods = mods;
                else delete out.mods;
              }
              return out;
            }),
            rev: s.rev + 1,
          };
        }),

      setSolid: (ids, solid) =>
        set((s) => {
          const target = new Set(ids);
          return {
            nodes: s.nodes.map((n) => {
              if (!target.has(n.id) || !!n.solid === solid) return n;
              const next = { ...n };
              if (solid) next.solid = true;
              else delete next.solid;
              return next;
            }),
            rev: s.rev + 1,
          };
        }),

      setDetail: (detail, paintRemap) =>
        set((s) => {
          if (s.detail === detail) return s;
          const r = DETAIL_FACTOR[detail] / DETAIL_FACTOR[s.detail];
          const nodes = s.nodes.map((n) => {
            const next = paintRemap?.get(n.assetId);
            const tracks = n.kind === 'image' || hasDrawnRaster(n) || rasterTracksScene(n);
            if (!next && !(tracks && n.crop)) return n;
            return {
              ...n,
              ...(next ? { assetId: next } : {}),
              crop:
                tracks && n.crop
                  ? { x: n.crop.x * r, y: n.crop.y * r, w: n.crop.w * r, h: n.crop.h * r }
                  : n.crop,
            };
          });
          return { detail, nodes, rev: s.rev + 1 };
        }),

      setBackground: (background) => set((s) => ({ background, rev: s.rev + 1 })),

      setDotInk: (dotInk) => set((s) => ({ dotInk, rev: s.rev + 1 })),

      setScenePixel: (pixel, regrid = false) =>
        set((s) => {
          // Paint rasters are allocated at the scene dims + takes reference them, so the
          // resolution is frozen once either exists — UNLESS the caller re-grids them
          // (the Canvas's confirm-armed Pixel change,: the UI re-grids every
          // drawing raster to the new dims right after this).
          if (!regrid && resolutionLockNodes(s.nodes)) return {};
          const clamped = clampScenePixel(pixel);
          if (clamped === s.pixel) return {};
          // Placements are in scene-cell units → rescale by the lattice long-edge ratio so
          // every element keeps the same fractional position + on-glass footprint. Crops
          // are element-local cells (independent of the scene lattice) → left untouched.
          const r = sceneLongFromPixel(clamped) / sceneLongFromPixel(s.pixel);
          const nodes =
            r === 1
              ? s.nodes
              : s.nodes.map((n) => {
                  // A raster that TRACKS the scene (video previewer) is itself rebuilt at
                  // the new lattice: its native footprint already scales by r, so keep the
                  // placement scale and scale its element-local crop with the raster.
                  // Image layers ALWAYS regenerate at the new grid; drawing layers do when
                  // the caller re-grids them.
                  const tracks =
                    n.kind === 'image' || (regrid && hasDrawnRaster(n)) || rasterTracksScene(n);
                  return {
                    ...n,
                    placement: {
                      ...n.placement,
                      x: n.placement.x * r,
                      y: n.placement.y * r,
                      scaleX: tracks ? n.placement.scaleX : n.placement.scaleX * r,
                      scaleY: tracks ? n.placement.scaleY : n.placement.scaleY * r,
                    },
                    ...(n.window
                      ? {
                          window: {
                            x: n.window.x * r,
                            y: n.window.y * r,
                            w: n.window.w * r,
                            h: n.window.h * r,
                          },
                        }
                      : {}),
                    crop:
                      tracks && n.crop
                        ? {
                            x: n.crop.x * r,
                            y: n.crop.y * r,
                            w: n.crop.w * r,
                            h: n.crop.h * r,
                          }
                        : n.crop,
                  };
                });
          return { pixel: clamped, nodes, rev: s.rev + 1 };
        }),

      setCropId: (id) => set({ cropId: id, windowId: null }),
      setWindowId: (id) => set({ windowId: id, cropId: null }),

      reorder: (id, to) =>
        set((s) => {
          const ordered = sortByZ(s.nodes);
          const i = ordered.findIndex((n) => n.id === id);
          if (i < 0) return {};
          if (to === 'front') ordered.push(...ordered.splice(i, 1));
          else if (to === 'back') ordered.unshift(...ordered.splice(i, 1));
          else if (to === 'up' && i < ordered.length - 1)
            [ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]];
          else if (to === 'down' && i > 0)
            [ordered[i], ordered[i - 1]] = [ordered[i - 1], ordered[i]];
          // Re-number z 1..N so the order is canonical.
          return { nodes: ordered.map((n, k) => ({ ...n, z: k + 1 })), rev: s.rev + 1 };
        }),

      moveLayer: (id, index) =>
        set((s) => {
          const ordered = sortByZ(s.nodes);
          const i = ordered.findIndex((n) => n.id === id);
          const to = Math.max(0, Math.min(ordered.length - 1, index));
          if (i < 0 || i === to) return {};
          ordered.splice(to, 0, ...ordered.splice(i, 1));
          return { nodes: ordered.map((n, k) => ({ ...n, z: k + 1 })), rev: s.rev + 1 };
        }),

      setLayerInk: (id, ink) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== id) return n;
            const look = { ...n.look };
            if (ink === undefined) delete look.dotInk;
            else look.dotInk = ink;
            return { ...n, look };
          }),
          rev: s.rev + 1,
        })),

      flip: (axis) =>
        set((s) => {
          if (s.selected.length === 0) return {};
          const sel = new Set(s.selected);
          return {
            nodes: s.nodes.map((n) =>
              sel.has(n.id)
                ? {
                    ...n,
                    placement: {
                      ...n.placement,
                      scaleX: axis === 'h' ? -n.placement.scaleX : n.placement.scaleX,
                      scaleY: axis === 'v' ? -n.placement.scaleY : n.placement.scaleY,
                    },
                  }
                : n,
            ),
            rev: s.rev + 1,
          };
        }),

      duplicate: (assetRemap) =>
        set((s) => {
          if (s.selected.length === 0) return {};
          const sel = new Set(s.selected);
          let z = s.nodes.reduce((m, n) => Math.max(m, n.z), 0);
          const clones = s.nodes
            .filter((n) => sel.has(n.id))
            .map((n) => ({
              ...n,
              id: nextId(),
              // A paint clone points at its own copied raster (assetRemap) so the two
              // layers don't share pixels; an asset clone shares the immutable asset.
              assetId: assetRemap?.get(n.id) ?? n.assetId,
              z: ++z,
              placement: { ...n.placement, x: n.placement.x + 4, y: n.placement.y + 4 },
              crop: n.crop ? { ...n.crop } : null,
              ...(n.window ? { window: shiftRect(n.window, 4, 4) } : {}),
              look: { ...n.look },
              viz: n.viz ? { ...n.viz } : undefined, // clone owns its own config
            }));
          return {
            nodes: [...s.nodes, ...clones],
            selected: clones.map((c) => c.id),
            rev: s.rev + 1,
          };
        }),

      setSceneLook: (patch) => set((s) => ({ scene: { ...s.scene, ...patch }, rev: s.rev + 1 })),

      applyLookToAll: () =>
        set((s) => {
          const own = layerLookFrom(s.scene);
          return {
            nodes: s.nodes.map((n) => ({ ...n, look: { ...n.look, ...own } })),
            rev: s.rev + 1,
          };
        }),

      setLook: (patch) =>
        set((s) => {
          // Nothing selected → the canvas look (the look new layers start with).
          if (s.selected.length === 0) return { scene: { ...s.scene, ...patch }, rev: s.rev + 1 };
          // Selection → override just those nodes.
          const sel = new Set(s.selected);
          return {
            nodes: s.nodes.map((n) =>
              sel.has(n.id) ? { ...n, look: { ...n.look, ...patch } } : n,
            ),
            rev: s.rev + 1,
          };
        }),

      resetLook: () =>
        set((s) => {
          if (s.selected.length === 0) return { scene: { ...SCENE_LOOK_DEFAULT }, rev: s.rev + 1 };
          const sel = new Set(s.selected);
          return {
            nodes: s.nodes.map((n) => (sel.has(n.id) ? { ...n, look: layerLookFrom(s.scene) } : n)),
            rev: s.rev + 1,
          };
        }),
    }),
    {
      // Undo history tracks ONLY the persistent model (nodes + scene defaults +
      // the canvas background). Selection + rev are excluded so selecting never
      // makes an entry and each gesture (committed on drag/transform end) is one
      // undo step.
      limit: 50,
      partialize: (s) => ({
        nodes: s.nodes,
        scene: s.scene,
        background: s.background,
        dotInk: s.dotInk,
        pixel: s.pixel,
        canvasMods: s.canvasMods,
        canvasMotion: s.canvasMotion,
        canvasFx: s.canvasFx,
        detail: s.detail,
      }),
      equality: (a, b) =>
        a.nodes === b.nodes &&
        a.scene === b.scene &&
        a.background === b.background &&
        a.dotInk === b.dotInk &&
        a.pixel === b.pixel &&
        a.canvasMods === b.canvasMods &&
        a.canvasMotion === b.canvasMotion &&
        a.canvasFx === b.canvasFx &&
        a.detail === b.detail,
      // ONE step per drag: while a slider is dragged, record only its
      // first change (the state before the drag) — the rest of the drag adds nothing.
      handleSet:
        (handleSet) =>
        (...args) => {
          if (gesture.active) {
            if (gesture.sceneRecorded) return;
            gesture.sceneRecorded = true;
          }
          (handleSet as unknown as (...a: typeof args) => void)(...args);
        },
    },
  ),
);

// The burn store's canvas-wide cell style + Density are a MIRROR of the canvas look:
// the look is the truth the canvas draws from; the mirror keeps their
// remaining readers (Library save, SVG export, the Animate list) in step until P5.
function mirrorCanvasLook(look: Look): void {
  const cellStyle =
    look.style === 'dither' ? 'square' : look.shape === 'square' ? 'block' : 'round';
  const b = useBurnStore.getState();
  if (b.cellStyle !== cellStyle || b.dotDensity !== look.density)
    useBurnStore.setState({ cellStyle, dotDensity: look.density });
}
mirrorCanvasLook(useSceneStore.getState().scene);
useSceneStore.subscribe((s, p) => {
  if (s.scene !== p.scene) mirrorCanvasLook(s.scene);
});

/** The current project's picture values per canvas square (Detail; Normal = 1). */
export function detailFactor(): number {
  return DETAIL_FACTOR[useSceneStore.getState().detail];
}

/** Effective look for a node = scene defaults with the node's overrides on top. */
export function effectiveLook(scene: Look, node: SceneNode): Look {
  return { ...scene, ...node.look };
}

/** True if the scene has content that pins the resolution (paint layers — their rasters
 *  are allocated at the scene dims). The scene-resolution control also locks when takes
 *  exist; that check lives in the UI (loop-store), combined with this. Mirrors how loop
 *  length locks once takes exist. */
export function resolutionLockNodes(nodes: SceneNode[]): boolean {
  return nodes.some(hasDrawnRaster);
}

/** A layer whose raster the brush made at the canvas grid: a drawing or a recording. */
export function hasDrawnRaster(n: Pick<SceneNode, 'kind'>): boolean {
  return n.kind === 'paint' || n.kind === 'recording';
}
