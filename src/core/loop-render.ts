// =============================================================================
// The pure loop-frame renderer (P8) — ONE function turns an
// integer loop frame into the frame's PNG bytes, shared by the export walk and
// the keystone determinism tests. It is exactly the live render's pipeline
// (evaluateScene → applyPaintReveal → sceneScreenLayers → renderPrintScreen)
// with the two live-only inputs removed: no in-progress capture, no wall clock.
//
// Video elements enter through the SAME overlay seam paint-reveal uses: the
// caller supplies `videoRasterAt` (assetId, frame) → the PRE-dither tone raster
// for that frame (the export's codec decoder; tests use synthetic rasters).
// The resolver stays time-blind — 0 lines change (the one dither truth).
//
// TWO CLOCKS. The `frame` arg is the ABSOLUTE export frame in [0, T)
// where T = totalFrames (default = frames = F, i.e. today). Everything AUTHORED
// evaluates at `loopFrame = frame mod F` — events, motion phase, paint reveals,
// the keyed PRNG, and the visualizer's phase — so every loop cycle repeats
// identically by construction. Sources with their OWN timeline read the ABSOLUTE
// frame: the audio-feature lookup (features[frame], length T, threaded to
// evaluateScene as absFrame and fed to the visualizer) and `videoRasterAt`, which
// is called with the absolute frame so the CALLER owns the clip-tick rule (W4b
// uses clipTickForFrame; a placed clip that outlasts the loop advances absolutely).
// When totalFrames is absent, loopFrame == frame for every frame < F and the whole
// function is BYTE-IDENTICAL to before (pinned by the loop-export tests).
// =============================================================================
import { applyPaintReveal, evaluateScene, type LayerLoop, type TimedEvent } from './loop-events';
import {
  CELL_RENDER_SCALE,
  resolveSceneGrid,
  sceneBackgroundRgb,
  sceneBackgroundTone,
  type CachedAsset,
  type SceneBackground,
  type SceneGrid,
  type SceneRaster,
} from './scene-resolver';
import { makeRng } from './seeded-rng';
import type { BeatClock } from './tempo';
import { renderVisualizerRaster, vizFeature, VIZ_RASTER } from './visualizer';
import type { FeatureArray } from './audio-features';
import type { Swatch } from './color';
import { encodeIndexedPng } from './png-indexed';
import { printScreenSvg, renderPrintScreen, type PrintFrame } from './print-screen';
import { printFrameToRaster, sceneScreenLayers } from './scene-screen';
import { renderTextRaster } from './dot-font';
import type { ModMap } from './modulators';
import {
  pruneTrail,
  snapTrails,
  trailReach,
  type TrailMemory,
  type TrailSource,
} from './layer-trail';
import { BPM_DEFAULT, framesPerBeat } from './tempo';
import { applyCanvasFx } from './canvas-fx';
import type { LayerFx } from './layer-fx';
import type { Look, MotionDescriptor, SceneNode } from '../state/scene-store';

export interface LoopRenderInput {
  nodes: SceneNode[];
  scene: Look;
  events: TimedEvent[];
  /** F — the integer loop length (loop meta.frames). */
  frames: number;
  /** T — the ABSOLUTE export length in frames. Absent = frames (F), i.e.
   *  today's byte-identical loop-length walk. When T > F the walk covers [0, T): the
   *  authored content cycles every F frames while absolute-timeline sources (audio
   *  features, an outlasting video clip) advance across the whole export. */
  totalFrames?: number;
  /** The stored master seed (loop meta.seed) — keyed-stateless PRNG. */
  seed: number;
  dims: { w: number; h: number };
  /** Base pre-dither rasters by assetId (the scene asset cache's shape). */
  assets: Map<string, CachedAsset>;
  /** Layers hidden from the render. What you see is what you export: the live
   *  mute set is passed EXPLICITLY (still deterministic — it is an input). */
  mutedLayers: ReadonlySet<number>;
  /** Frame-indexed audio features (P6); null in without-audio mode. */
  features: FeatureArray | null;
  /** Per-frame video raster overlay: return the assetId's PRE-dither tone
   *  raster for this loop frame, or null if the asset is not a video. */
  videoRasterAt?: (assetId: string, frame: number) => CachedAsset | null;
  /** The scene's flat canvas background; absent = transparent. An
   *  explicit input like the mutes — what you see is what you export. */
  background?: SceneBackground | null;
  /** Halftone dot INK Swatch (custom-colour Phase 1; scene-wide). Absent/null = the
   *  palette's brightest shade — byte-identical to before. An explicit export input so
   *  the exported dots match the live glass. */
  dotInk?: Swatch;
  /** Object-path loop-close blend (H-A0, meta.pathClose). Absent = off (unchanged).
   *  An explicit export input like the mutes — what you see is what you export. */
  pathClose?: boolean;
  /** The project's beat clock (J1) — tempo-synced motions read it. An explicit export
   *  input like the mutes; absent = they fall back to their per-loop speed. */
  beat?: BeatClock;
  /** The canvas's modulators (J2 — Dot size, Density); layers carry their own. An
   *  explicit export input like the mutes; absent = none. */
  canvasMods?: ModMap;
  /** The Whole canvas Motion (the whole picture moving as one). Absent = none. */
  canvasMotion?: MotionDescriptor | null;
  /** The Whole canvas effects (J5 step 3; their amounts move with canvasMods). Absent = none. */
  canvasFx?: LayerFx | null;
  /** Each layer's own loop by node id. Absent = every layer loops at `frames`. */
  layerLoops?: Readonly<Record<string, LayerLoop>>;
  /** A photo layer's raster at its (modulated) tone dials — the SAME treatment the live
   *  canvas regenerates with (ui/image-layers), so a moving Contrast exports as previewed.
   *  Absent = photos keep their cached raster. */
  photoRasterAt?: (node: SceneNode) => CachedAsset | null;
  /** Trails' past frames (J5 step 2), shared across an export walk so each frame renders
   *  once. Absent = each frame works out its own past (the same pixels, slower). */
  trailMemory?: TrailMemory;
}

/** Frames per beat for trails: the project's tempo (absent = the default tempo at 30 fps). */
const loopFramesPerBeat = (input: LoopRenderInput): number =>
  input.beat ? framesPerBeat(input.beat.bpm, input.beat.fps) : framesPerBeat(BPM_DEFAULT, 30);

/** How many frames before a frame its trails read (0 = no trails) — the export pre-rolls
 *  this many before its first frame. */
export const loopTrailReach = (input: LoopRenderInput): number =>
  trailReach(input.nodes, loopFramesPerBeat(input));

/** The frame a trail reads for absolute frame `k`: before the start of the video it wraps
 *  round from the end, so a loop's first frames trail its last (seamless). */
export function trailPastFrame(input: LoopRenderInput, k: number): number {
  if (k >= 0) return k;
  const T = Math.max(1, input.totalFrames ?? input.frames);
  return ((k % T) + T) % T;
}

/** Remember absolute frame `k`'s trailed layers in `mem` (once). */
export function primeLoopTrail(input: LoopRenderInput, mem: TrailMemory, k: number): void {
  if (mem.has(k)) return;
  const p = prepareLoopFrame(input, trailPastFrame(input, k));
  mem.set(k, snapTrails(p.nodes, p.assets));
}

/** Layers whose RASTER follows a modulated setting (J2): a text layer's Size / Spacing
 *  re-lay its dots (core/dot-font), a photo's tone dials re-treat its picture. Each gets
 *  its own raster for this frame under a per-layer id (two copies of one photo can move
 *  differently). Shared by the live canvas and the export (preview == export). */
export function applyModRasters(
  nodes: SceneNode[],
  assets: Map<string, CachedAsset>,
  photoRasterAt?: (node: SceneNode) => CachedAsset | null,
): { nodes: SceneNode[]; assets: Map<string, CachedAsset> } {
  let out: Map<string, CachedAsset> | null = null;
  const next = nodes.map((n) => {
    const m = n.mods;
    if (!m) return n;
    let raster: CachedAsset | null = null;
    if (n.kind === 'text' && n.text && (m['text.size'] || m['text.spacing']))
      raster = renderTextRaster(n.text);
    else if (
      n.kind === 'image' &&
      (m['photo.brightness'] ||
        m['photo.contrast'] ||
        m['photo.gamma'] ||
        m['photo.black'] ||
        m['photo.white'])
    )
      raster = photoRasterAt?.(n) ?? null;
    if (!raster) return n;
    out ??= new Map(assets);
    const id = `${n.assetId}#${n.id}`;
    out.set(id, raster);
    return { ...n, assetId: id };
  });
  return out ? { nodes: next, assets: out } : { nodes, assets };
}

/** Resolve ONE ABSOLUTE export frame to a SceneGrid (the pre-dither tone grid the
 *  Library save + tests read) — pure, no wall clock. The authored clock is
 *  `loopFrame = frame mod F`; the absolute `frame` reaches only the feature/video seams.
 *  Absent totalFrames → loopFrame == frame. */
export function renderLoopFrameGrid(input: LoopRenderInput, frame: number): SceneGrid {
  const f = prepareLoopFrame(input, frame);
  return resolveSceneGrid({
    nodes: f.nodes,
    scene: f.scene,
    dims: input.dims,
    assets: f.assets,
    backgroundTone: input.background ? sceneBackgroundTone(input.background) : undefined,
  });
}

/** One frame's layers after everything that moves them: the evaluated timeline, paint
 *  reveals, the frame's visualizer + video rasters and modulated rasters, and the canvas
 *  look with its (possibly moving) Dot size + Density. */
function prepareLoopFrame(
  input: LoopRenderInput,
  frame: number,
): { nodes: SceneNode[]; scene: Look; assets: Map<string, CachedAsset> } {
  const F = Math.max(1, input.frames);
  const loopFrame = ((frame % F) + F) % F; // authored clock (negative-safe)
  const ev = evaluateScene(
    input.nodes,
    input.scene,
    input.events,
    loopFrame,
    F,
    input.features,
    makeRng(input.seed),
    input.mutedLayers,
    {
      // Marquee wrap needs the stage dims + each node's native footprint; both come
      // from the render input, so preview == export (the same dims/footprints).
      dims: input.dims,
      assetDims: (assetId) => input.assets.get(assetId),
      pathClose: input.pathClose,
      // The absolute frame drives the audio-feature lookup (features[absFrame]) and the
      // slow / tempo-synced motion clocks.
      absFrame: frame,
      beat: input.beat,
      canvasMods: input.canvasMods,
      canvasMotion: input.canvasMotion,
      canvasFx: input.canvasFx,
      layerLoops: input.layerLoops,
      dotDensity: input.scene.density,
    },
  );
  // Paint-reveal first (scratch copies of paint layers), then the video overlay
  // (this frame's tick rasters) — the same two seams the live render uses. The
  // export never passes a live in-progress stroke, so determinism holds.
  let assets = applyPaintReveal(
    input.assets,
    input.events,
    loopFrame,
    F,
    input.mutedLayers,
    null,
    (id) => ev.clocks.get(id),
  );
  let overlaid: Map<string, CachedAsset> | null = null;
  const overlay = (assetId: string, raster: CachedAsset): void => {
    if (!overlaid) {
      overlaid = new Map(assets);
      assets = overlaid;
    }
    overlaid.set(assetId, raster);
  };
  const seen = new Set<string>();
  const rng = makeRng(input.seed);
  for (const n of ev.nodes) {
    if (seen.has(n.assetId)) continue;
    seen.add(n.assetId);
    // Visualizer nodes: regenerate this frame's raster via the ONE pure generator
    // (the SAME call the live render makes) — deterministic, so preview == export.
    if (n.kind === 'visualizer' && n.viz) {
      // Phase cycles at loopFrame (authored) but the feature reacts to the ABSOLUTE
      // frame (features[frame], length T) — the visualizer's two-clock split.
      overlay(
        n.assetId,
        renderVisualizerRaster(
          n.viz,
          vizFeature(input.features, frame, n.viz.smooth),
          loopFrame,
          F,
          rng,
          n.assetId,
          VIZ_RASTER,
          { features: input.features, at: frame },
        ),
      );
      continue;
    }
    // Video elements: this frame's exact-tick raster (the codec decoder). Called with
    // the ABSOLUTE frame — the caller owns the clip-tick rule (W4b: clipTickForFrame).
    const raster = input.videoRasterAt?.(n.assetId, frame);
    if (raster) overlay(n.assetId, raster);
  }
  const modded = applyModRasters(ev.nodes, assets, input.photoRasterAt);
  // The Whole canvas effects (J5) on every layer laid onto the canvas.
  const fxd = applyCanvasFx(modded.nodes, modded.assets, input.dims, ev.canvasFx);
  // A moving canvas Density (J2) is this frame's canvas look.
  const scene = ev.dotDensity !== undefined ? { ...ev.scene, density: ev.dotDensity } : ev.scene;
  return { nodes: fxd.nodes, scene, assets: fxd.assets };
}

/** ONE ABSOLUTE export frame drawn through print screens at `scale` output px
 *  per scene cell — every layer its own screen, inks overprinted. The live canvas draws
 *  the same layers through the same `sceneScreenLayers` → `renderPrintScreen`. */
export function renderLoopFrameImage(
  input: LoopRenderInput,
  frame: number,
  scale: number = CELL_RENDER_SCALE,
): PrintFrame {
  // Trails read the frames before this one (rendered once per walk via trailMemory).
  const fpb = loopFramesPerBeat(input);
  const reach = trailReach(input.nodes, fpb);
  let trail: TrailSource | undefined;
  let mem: TrailMemory | undefined;
  if (reach > 0) {
    const m: TrailMemory = input.trailMemory ?? new Map();
    for (let a = reach; a >= 1; a--) primeLoopTrail(input, m, frame - a);
    trail = { past: (a) => m.get(frame - a), framesPerBeat: fpb };
    mem = m;
  }
  const f = prepareLoopFrame(input, frame);
  if (mem) {
    mem.set(frame, snapTrails(f.nodes, f.assets));
    pruneTrail(mem, frame, reach);
  }
  return renderPrintScreen({
    layers: sceneScreenLayers(f.nodes, f.scene, f.assets, input.dotInk ?? null, trail),
    dims: input.dims,
    scale,
    background: input.background ? sceneBackgroundRgb(input.background) : null,
  });
}

/** One ABSOLUTE export frame → the frame's indexed PNG bytes (loopFrame = frame mod F
 *  drives the authored content). Frame 0 with no timeline events equals the
 *  still scene export. */
export function renderLoopFramePng(
  input: LoopRenderInput,
  frame: number,
  scale: number = CELL_RENDER_SCALE,
): Uint8Array {
  const r = renderLoopFrameRaster(input, frame, scale);
  return encodeIndexedPng(r.buf, r.palette, r.trns);
}

/** One ABSOLUTE export frame → its indexed raster (renderLoopFramePng before PNG
 *  compression) — what the video encoder takes: the same pixels either way. */
export function renderLoopFrameRaster(
  input: LoopRenderInput,
  frame: number,
  scale: number = CELL_RENDER_SCALE,
): SceneRaster {
  return printFrameToRaster(renderLoopFrameImage(input, frame, scale));
}

/** The still scene (no timeline) as the PNG export / thumbnail draws it: the base layers
 *  through the same print-screen seam, so frame 0 of an empty timeline equals it. */
export interface StillRenderInput {
  nodes: SceneNode[];
  scene: Look;
  dims: { w: number; h: number };
  assets: Map<string, CachedAsset>;
  background?: SceneBackground | null;
  dotInk?: Swatch;
  /** The Whole canvas effects (J5). Absent = none. */
  canvasFx?: LayerFx | null;
}

/** The still's layers through the Whole canvas effects. */
function stillLayers(input: StillRenderInput) {
  const f = applyCanvasFx(input.nodes, input.assets, input.dims, input.canvasFx);
  return sceneScreenLayers(f.nodes, input.scene, f.assets, input.dotInk ?? null);
}

export function renderStillPng(
  input: StillRenderInput,
  scale: number = CELL_RENDER_SCALE,
): Uint8Array {
  const r = printFrameToRaster(
    renderPrintScreen({
      layers: stillLayers(input),
      dims: input.dims,
      scale,
      background: input.background ? sceneBackgroundRgb(input.background) : null,
    }),
  );
  return encodeIndexedPng(r.buf, r.palette, r.trns);
}

/** The still scene as an SVG: the same layers through the same print screens, as vectors. */
export function renderStillSvg(input: StillRenderInput, scale: number = CELL_RENDER_SCALE): string {
  return printScreenSvg({
    layers: stillLayers(input),
    dims: input.dims,
    scale,
    background: input.background ? sceneBackgroundRgb(input.background) : null,
  });
}
