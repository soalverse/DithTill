import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { uiAccent } from './shell-theme';
import { Stage, Layer, Rect, Group, Transformer, Arrow, Circle } from 'react-konva';
import type Konva from 'konva';
import {
  useSceneStore,
  sceneDimsAt,
  hasDrawnRaster,
  type ImageLayerParams,
  type Placement,
  type SceneNode,
} from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { MAX_TAKES, nextEventId, takesOn, useLoopStore } from '../state/loop-store';
import { CELL_RENDER_SCALE } from '../core/scene-resolver';
import { renderPrintScreen } from '../core/print-screen';
import { sceneScreenLayers } from '../core/scene-screen';
import {
  evaluateScene,
  layerClock,
  applyPaintReveal,
  BLINK_HOLD_FRAMES,
  type DabStamp,
  type LayerClock,
  type PaintRevealEvent,
} from '../core/loop-events';
import { applyModRasters } from '../core/loop-render';
import {
  isTrailed,
  pruneTrail,
  snapTrails,
  trailReach,
  type TrailMemory,
  type TrailSource,
} from '../core/layer-trail';
import { framesPerBeat } from '../core/tempo';
import { applyCanvasFx } from '../core/canvas-fx';
import { sceneToElementCell } from '../core/scene-affine';
import { makeRng } from '../core/seeded-rng';
import { resolveSwatch } from '../core/color';
import type { BrushOpts } from '../core/raster-brush';
import { ensureAssets, getAssetCache } from './scene-assets';
import { scrubVideos, updateVideoFrames } from './video-assets';
import { updateVisualizerFrames } from './visualizer-node';
import {
  commitPaint,
  createPaintLayer,
  paintStroke,
  paintTarget,
  createRecordingLayer,
} from './paint-node';
import {
  claimLayer,
  initTake,
  isEmptyRecording,
  liveLayerLoops,
  liveNodes,
  markFreshLayer,
  noteTakeFrame,
  noteTakeStamp,
  strokeTarget,
} from './take';
import {
  beginRecordingErase,
  endRecordingErase,
  eraseRecordingDabs,
  mirroredForBackwards,
} from './recording-edit';
import {
  beatClock,
  engineAbsFrame,
  initAudioEngine,
  liveTotalFrames,
  playCueTick,
  publishLoopPhase,
} from './audio-engine';
import { initSceneGc } from './scene-gc';
import { visibleAt } from '../core/timeline-edit';
import {
  beginMatteStroke,
  endMatteStroke,
  matteStroke,
  modulatedPhotoRaster,
  pictureRect,
  pictureToParams,
  type PictureRect,
} from './image-layers';
import {
  beginPathCapture,
  samplePath,
  finishPathCapture,
  type PathCapture,
} from '../core/path-capture';
import { notifyBanner } from '../state/notify-store';
import { publishModValues } from './mod-live';

// ---- H-A0 DIRECTION HANDLE (owner-designed) ----
// The motion types whose (ax, ay) is a true DIRECTION the on-glass arrow can point
// anywhere: marquee = travel direction, drift = oscillation axis, bounce = the
// "floor" axis (the element bounces opposite the arrow). Orbit (parallax) is
// EXCLUDED: its ax/ay are ellipse semi-axes, not a direction — rotating the orbit
// needs new descriptor math, deferred. The rest keep their per-axis weights.
const DIRECTIONAL_MOTION = new Set<string>(['marquee', 'drift', 'bounce']);
/** Arrow LENGTH = the motion's amp, 1 scene cell of amp per cell of arrow (amp 1..30 —
 *  the same clamp the old deck stepper used). One gesture defines the whole motion:
 *  angle = direction, length = size. A small px floor keeps a tiny amp grabbable. */
const AMP_MIN = 1;
const AMP_MAX = 30;
const ARROW_MIN_PX = 12;
const ampToLen = (amp: number, cellPx: number): number =>
  Math.max(ARROW_MIN_PX, Math.max(AMP_MIN, Math.min(AMP_MAX, amp)) * cellPx);
const lenToAmp = (len: number, cellPx: number): number =>
  Math.max(AMP_MIN, Math.min(AMP_MAX, Math.round(len / Math.max(1e-6, cellPx))));
/** Gentle 45° magnet: snap only within ±3° of a compass point — free angle otherwise. */
const magnet45 = (deg: number): number => {
  const snap = Math.round(deg / 45) * 45;
  return Math.abs(deg - snap) <= 3 ? snap : deg;
};

/**
 * The Record glass (Record / increment 3). Two stacked layers that
 * occupy the same aspect-shaped box:
 *   - bottom: the AUTHORITATIVE dithered scene <canvas> — the ONLY source of
 *     output pixels, rendered by resolveSceneGrid (the one dither truth). During
 *     a drag/transform it re-renders live by reading the Konva nodes' current
 *     transforms (no React churn, no store writes), so the dither follows the
 *     gesture. preview == export holds because export runs the same resolver.
 *   - top: a transparent Konva Stage of proxy rects = the interaction CONTROLLER
 *     (drag / Transformer resize+rotate / select / snap). It never paints output
 *     and never warps a bitmap (invariant 3). The store is written only on
 *     gesture END → one undo entry per gesture.
 */
/** The in-progress OVERDUB stroke (recording): its timed stamps so far. */
interface StrokeCapture {
  node: SceneNode;
  assetId: string;
  stamps: DabStamp[];
  pass: number;
  lastX: number;
  lastY: number;
  lastFrame: number; // monotonic max so the stamps stay one ascending run
  // BLINK-STAMP: decided by the mouse BUTTON (owner-locked): LEFT = a flashing
  // dot/stroke (holdFrames window each loop), RIGHT-hold = the persistent draw-in.
  blink: boolean;
  // The button drawing it, as a PointerEvent.buttons bit: a browser's own right-drag gestures
  // can swallow the release, so the stroke also ends when a move shows this bit is off.
  held: number;
}

/** A captured overdub stroke becomes ONE PaintRevealEvent (a timeline layer that draws in
 *  each loop). BLINK-STAMP by BUTTON (owner-locked): a LEFT stroke flashes for
 *  BLINK_HOLD_FRAMES each loop; a RIGHT-hold stroke is the persistent draw-in. */
function commitCapture(cap: StrokeCapture): void {
  if (!cap.stamps.length) return;
  // Into a backwards recording: it lands where it would show as drawn.
  const L = useLoopStore.getState().layerLoops[cap.node.id]?.frames;
  const stamps = cap.node.rec?.backwards && L ? mirroredForBackwards(cap.stamps, L) : cap.stamps;
  // Not Math.min(...): a stroke on an endless tape can outgrow the argument limit.
  const startFrame = stamps.reduce((m, s) => Math.min(m, s.frame), Infinity);
  const endFrame = stamps.reduce((m, s) => Math.max(m, s.frame), -Infinity);
  const evt: PaintRevealEvent = {
    id: nextEventId('pr-'),
    kind: 'paint-reveal',
    nodeId: cap.node.id,
    assetId: cap.assetId,
    pass: cap.pass,
    layer: cap.pass,
    startFrame,
    endFrame,
    stamps,
    ...(cap.blink ? { holdFrames: BLINK_HOLD_FRAMES } : {}),
  };
  useLoopStore.getState().commitEvents([evt]);
}

export function SceneStage() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef(new Map<string, Konva.Rect>());
  const dirArrowRef = useRef<Konva.Arrow>(null); // H-A0 direction handle shaft
  const cropRectRef = useRef<Konva.Rect>(null);
  const cropTrRef = useRef<Konva.Transformer>(null);
  const winRectRef = useRef<Konva.Rect>(null);
  const winTrRef = useRef<Konva.Transformer>(null);
  const picRef = useRef<Konva.Rect>(null); // the selected photo's picture outline
  const picTrRef = useRef<Konva.Transformer>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<{ node: SceneNode; x: number; y: number } | null>(null);
  // An Erase/Restore stroke on a selected PHOTO's cutout.
  const matteRef = useRef<{ node: SceneNode; x: number; y: number } | null>(null);
  // An Erase stroke on a selected RECORDING's strokes while stopped.
  const rubRef = useRef<{ node: SceneNode; x: number; y: number } | null>(null);
  // The in-progress OVERDUB stroke (recording): captured as timed stamps, not baked
  // into the base raster (so it draws-in on replay). null unless recording a stroke.
  const captureRef = useRef<StrokeCapture | null>(null);
  // The in-progress OBJECT-PATH capture (E5): a drag while recording samples the
  // element's placement per integer loop frame. null unless recording a drag.
  const pathCapRef = useRef<PathCapture | null>(null);
  const liveIds = useRef<Set<string>>(new Set()); // nodes mid-gesture (read live from Konva)
  const altRef = useRef(false);
  const rafRef = useRef(0);
  // Trails (J5): the frames just shown while playing, by absolute frame.
  const trailMem = useRef<TrailMemory>(new Map());
  const trailLast = useRef(-1);
  // ---- live loop driver (P2/P3) ----
  const loopActive = useRef(false); // true while playing/recording: the loop rAF is the SOLE render owner
  const loopRaf = useRef(0);
  const phaseRef = useRef(0); // loop phase [0,1); loopFrame = floor(phase * F)
  // THE SONG CLOCK: absFloatRef / absFrameRef are the playhead's song frame over
  // the video [0, T_live) — or the marked part — which every layer's own clock reads;
  // phaseRef is the canvas loop's phase (the cue, scene-global events). When audio plays it
  // is the master (adopt engineAbsFrame); on Stop both reset.
  const absFloatRef = useRef(0);
  const absFrameRef = useRef(0);
  const lastTsRef = useRef(0);
  const renderRef = useRef<() => void>(() => {});
  // ---- loop cue (owner ask): a live start/wrap marker so you know when to draw.
  // On-glass only (never in the export) — a sweeping playhead + a downbeat flash.
  const cueRef = useRef<HTMLDivElement>(null);
  const cueBarRef = useRef<HTMLDivElement>(null);
  const cueFlashRef = useRef<HTMLDivElement>(null);
  const prevPhaseRef = useRef(0);
  const flashRef = useRef(0); // downbeat flash intensity [0,1], decays each frame

  const aspect = useBurnStore((s) => s.aspect);
  const cellStyle = useBurnStore((s) => s.cellStyle); // re-render when the render style flips
  const dotDensity = useBurnStore((s) => s.dotDensity); // …or Density (scene-wide) changes.
  // Size + Tonal are per-element (in the scene look) — the scene-store subscription
  // below repaints when setLook changes a node's (or the scene's) dotSize/dotGrow.
  const nodes = useSceneStore((s) => s.nodes);
  const selected = useSceneStore((s) => s.selected);
  const cropId = useSceneStore((s) => s.cropId);
  const tool = useSceneStore((s) => s.tool);
  const transport = useLoopStore((s) => s.transport);
  const scenePixel = useSceneStore((s) => s.pixel);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const dims = sceneDimsAt(aspect, scenePixel);
  const cellPx = box.w > 0 ? box.w / dims.w : 0;
  const cropNode = cropId ? nodes.find((n) => n.id === cropId) : undefined;
  const activeCrop = cropNode ? cropId : null;
  // The animation window being edited: a box fixed on the canvas.
  const windowId = useSceneStore((s) => s.windowId);
  const winNode = windowId ? nodes.find((n) => n.id === windowId && n.window) : undefined;
  const activeWin = winNode && transport === 'stopped' ? winNode : undefined;
  // The picked layer's window, shown faintly while it isn't being edited.
  const winShown =
    !activeWin && selected.length === 1
      ? nodes.find((n) => n.id === selected[0])?.window
      : undefined;
  // H-A0 direction handle: exactly one selected node whose motion is directional.
  const dirNode = selected.length === 1 ? nodes.find((n) => n.id === selected[0]) : undefined;
  const dirMotion =
    dirNode?.motion && DIRECTIONAL_MOTION.has(dirNode.motion.type) ? dirNode.motion : null;

  // ---- Authoritative dither render (imperative; reads live Konva transforms) ----
  const render = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const d = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
    // Print screens: every layer draws its own screen at the export's scale
    // (CELL_RENDER_SCALE px per cell), so the glass shows the exported pixels; the browser
    // smooths the downscale to the glass (free anti-aliasing on the dot edges).
    const S = CELL_RENDER_SCALE;
    if (cv.width !== d.w * S || cv.height !== d.h * S) {
      cv.width = d.w * S;
      cv.height = d.h * S;
    }
    cv.style.imageRendering = 'auto';
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const store = useSceneStore.getState();
    const loop = useLoopStore.getState();
    const cpx = box.w > 0 ? box.w / d.w : 0;

    const F = Math.max(1, loop.meta.frames);
    const muted = new Set(loop.mutedLayers);
    let nodesForRender: SceneNode[];
    let sceneForRender = store.scene;
    // The Whole canvas effects this frame (their amounts move while playing, J5).
    let canvasFxForRender = store.canvasFx;
    // The canvas Density this frame (a Density modulator moves it while playing, J2).
    let densityForRender = store.scene.density;
    let revealFrame: number;
    // Each layer's own loop clock this frame — null at rest.
    let layerClocks: Map<string, LayerClock> | null = null;
    // The ABSOLUTE feature/video clock: loopFrame drives authored content,
    // absReveal drives the audio-feature lookup + video ticks. Equal at rest (F) and
    // when T_live == F, so this is byte-identical without a track/outlasting clip.
    let absReveal: number;
    // Scrubbing while stopped evaluates the timeline at the playhead frame
    // through the same path as playback — what you scrub to is what plays/exports.
    const scrubbing = loop.transport === 'stopped' && loop.scrub !== null;
    if (loop.transport !== 'stopped' || scrubbing) {
      // LIVE LOOP: evaluate the timeline at the current integer frame, then resolve
      // through the SAME resolver as the static/export path (preview == export). The
      // speed knob only scales how fast `phaseRef` advances (the live clock) — it is
      // absent from the stored events, so the export is rate-independent.
      // A scrub past the loop end shows loop content at that point of the cycle (the same
      // modulo playback applies), while videos follow the absolute frame below.
      const frame = Math.min(
        F - 1,
        Math.max(0, scrubbing ? loop.scrub! % F : Math.floor(phaseRef.current * F)),
      );
      // absFrame = the ABSOLUTE export frame the tick maintained (cycle · F + loopFrame,
      // or the audio master's frame). Reaches ONLY the features lookup + video ticks —
      // the resolver/authoring stays loop-framed (the two-clock split).
      // A scrub past the loop end keeps loop content at its last frame while videos
      // follow the playhead absolutely (a clip that outlasts the loop).
      const absFrame = scrubbing ? loop.scrub! : absFrameRef.current;
      const ev = evaluateScene(
        liveNodes(store.nodes),
        store.scene,
        // Reactions ride alongside the overdub log; both fold through the ONE seam.
        [...loop.events, ...loop.reactions],
        frame,
        F,
        // The SAME pre-analyzed FeatureArray the export reads (preview == export at
        // any speed — features are frame-indexed, never a live FFT). Null = no audio.
        loop.features,
        makeRng(loop.meta.seed),
        muted,
        // Layout for the marquee wrap (stage dims + native footprints) + the object-path
        // loop-close toggle — the SAME inputs the export passes (preview == export). The
        // absolute frame drives the feature lookup (features[absFrame]) and the slow /
        // tempo-synced motion clocks, with the SAME beat clock the export reads (J1).
        {
          dims: d,
          assetDims: (id) => getAssetCache().get(id),
          pathClose: loop.meta.pathClose,
          absFrame,
          beat: beatClock(),
          // Modulators (J2) — the SAME canvas mods + Density base the export passes.
          canvasMods: store.canvasMods,
          canvasMotion: store.canvasMotion,
          canvasFx: store.canvasFx,
          // Each recorded layer's own loop, with this take's open Free loops.
          layerLoops: liveLayerLoops(),
          dotDensity: densityForRender,
        },
      );
      if (ev.dotDensity !== undefined) densityForRender = ev.dotDensity;
      publishModValues(ev.modValues, absFrame);
      // A node mid-DRAG while recording (E5 path capture) tracks the cursor: the
      // live Konva transform substitutes for the evaluated placement, same as the
      // static branch does for gestures (the committed path replays next loop).
      nodesForRender = ev.nodes.map((n): SceneNode => {
        if (!liveIds.current.has(n.id) || cpx === 0) return n;
        const kn = nodeRefs.current.get(n.id);
        if (!kn) return n;
        const placement: Placement = {
          x: kn.x() / cpx,
          y: kn.y() / cpx,
          scaleX: kn.scaleX(),
          scaleY: kn.scaleY(),
          rotationDeg: kn.rotation(),
        };
        return { ...n, placement };
      });
      sceneForRender = ev.scene;
      canvasFxForRender = ev.canvasFx ?? null;
      revealFrame = frame;
      layerClocks = ev.clocks;
      absReveal = absFrame;
      // Video elements: pull each placed video's CURRENT frame into its live raster
      // (a drift-corrected previewer of the pure tick mapping; the export decodes the
      // exact tick). Called with the ABSOLUTE frame — an outlasting clip advances
      // absolutely (clipTickForFrame), matching the export. Cache identity stays stable.
      if (!scrubbing) updateVideoFrames(nodesForRender, absFrame); // scrub seeks exactly instead
    } else {
      // STATIC / gesture: substitute the live Konva transform for nodes mid-gesture so
      // the dither tracks the drag without writing to the store. At rest the canvas shows
      // loop frame 0, so a TIMED layer (3b) whose clips start later is off here.
      nodesForRender = store.nodes
        .filter((n) => visibleAt(n.clips, 0))
        .map((n): SceneNode => {
          if (!liveIds.current.has(n.id) || cpx === 0) return n;
          const kn = nodeRefs.current.get(n.id);
          if (!kn) return n;
          const placement: Placement = {
            x: kn.x() / cpx,
            y: kn.y() / cpx,
            scaleX: kn.scaleX(),
            scaleY: kn.scaleY(),
            rotationDeg: kn.rotation(),
          };
          return { ...n, placement };
        });
      // At rest, show the COMPLETE recorded art (every reveal stamp, whatever a layer's
      // own loop length): a sentinel past every loop end.
      revealFrame = Number.MAX_SAFE_INTEGER;
      absReveal = F; // resting: phase AND feature index both at the resting pose
      publishModValues(null); // at rest every slider shows its own value
    }
    // Visualizer nodes: regenerate their raster before the resolve. Two clocks: the
    // authored PHASE uses revealFrame (>= F at rest → the resting pose); the audio
    // FEATURE indexes absReveal (features[absFrame], length T_live). The export
    // regenerates the SAME rasters via the one pure generator, so preview == export.
    updateVisualizerFrames(nodesForRender, revealFrame, absReveal);
    // Paint-reveal: overdub strokes draw-in via scratch rasters (base never mutated).
    // The live in-progress capture shows in full so the performer sees the brush.
    const cap = captureRef.current;
    const clocksNow = layerClocks;
    const revealed = applyPaintReveal(
      getAssetCache(),
      loop.events,
      revealFrame,
      F,
      muted,
      cap ? { assetId: cap.assetId, stamps: cap.stamps } : null,
      // Each layer's stroke replays on its own loop clock; at rest there is
      // none, so the at-rest sentinel (revealFrame past every loop) shows every stroke.
      clocksNow ? (id) => clocksNow.get(id) : undefined,
    );
    // A modulated text Size / photo tone dial re-lays that layer's raster (J2) — the SAME
    // helper the export calls per frame.
    const modded = applyModRasters(nodesForRender, revealed, modulatedPhotoRaster);
    // The Whole canvas effects (J5) on every layer laid onto the canvas — the SAME step the
    // export takes per frame.
    const fxd = applyCanvasFx(modded.nodes, modded.assets, d, canvasFxForRender);
    nodesForRender = fxd.nodes;
    const assets = fxd.assets;
    // The flat scene background: resolve the Swatch
    // through the ONE funnel — its tone completes the opacity blend in the resolver;
    // its exact colour paints where nothing covers. A custom RGB pins; a preset tracks.
    const bg = resolveSwatch(store.background, sceneForRender.palette);
    // The frame's layers through the ONE adapter + renderer the export walks
    // (sceneScreenLayers → renderPrintScreen); a moving canvas Density is this frame's look.
    const sceneFrame =
      densityForRender !== sceneForRender.density
        ? { ...sceneForRender, density: densityForRender }
        : sceneForRender;
    // Trails (J5) read the frames just shown (playing / scrubbing only); a jump back or
    // further than a trail reaches starts them afresh — the export pre-rolls the same past.
    let trail: TrailSource | undefined;
    const mem = trailMem.current;
    if (layerClocks && nodesForRender.some(isTrailed)) {
      const bc = beatClock();
      const fpb = framesPerBeat(bc.bpm, bc.fps);
      const reach = trailReach(nodesForRender, fpb);
      const last = trailLast.current;
      if (absReveal < last || absReveal - last > reach) mem.clear();
      pruneTrail(mem, absReveal, reach);
      const at = absReveal;
      trail = { past: (a) => mem.get(at - a), framesPerBeat: fpb };
      mem.set(at, snapTrails(nodesForRender, assets));
      trailLast.current = at;
    } else if (mem.size) {
      mem.clear();
      trailLast.current = -1;
    }
    const frame = renderPrintScreen({
      layers: sceneScreenLayers(nodesForRender, sceneFrame, assets, store.dotInk, trail),
      dims: d,
      scale: S,
      background: bg,
    });
    const img = new ImageData(frame.rgba, frame.w, frame.h);
    ctx.putImageData(img, 0, 0);
  }, [box.w]);

  const schedule = useCallback(() => {
    if (loopActive.current) return; // the continuous loop rAF owns rendering while playing
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      render();
    });
  }, [render]);

  // The take: Rec begins / ends it; each recorded layer gets its own loop.
  useEffect(initTake, []);

  // Keep a ref to the latest render() so the long-lived loop rAF always calls the
  // current closure (render identity changes with box.w).
  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  // ---- The live loop driver (P2/P3): the SOLE render owner while playing/recording.
  // Subscribes to transport imperatively so it survives re-renders. The phase advances
  // by dt * speed / loopMs (wall-clock here is fine — this is the PREVIEW; the export
  // walks an integer virtual clock instead). On Stop it tears down and restores the
  // static render exactly once. Frame-skipping is safe: the PRNG is keyed-stateless.
  useEffect(() => {
    const start = () => {
      if (loopActive.current) return;
      loopActive.current = true;
      lastTsRef.current = 0;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      // Resume from the paused / scrubbed playhead, else the top.
      // Fire the START downbeat and reveal the cue.
      const ls0 = useLoopStore.getState();
      const F0 = Math.max(1, ls0.meta.frames);
      const T0 = Math.max(1, liveTotalFrames());
      // The playhead (a song frame); a start outside the marked part begins at it.
      let rf = ls0.resumeFrame ?? 0;
      const part0 = ls0.part;
      if (part0 && (rf < part0.start || rf >= part0.end)) rf = part0.start;
      absFloatRef.current = rf;
      phaseRef.current = (rf % F0) / F0;
      prevPhaseRef.current = phaseRef.current;
      absFrameRef.current = rf;
      publishLoopPhase(phaseRef.current, rf / T0);
      flashRef.current = 1;
      if (useLoopStore.getState().cueSound) playCueTick(true);
      if (cueRef.current) cueRef.current.style.display = 'block';
      const tick = (ts: number) => {
        if (!loopActive.current) return;
        if (lastTsRef.current === 0) lastTsRef.current = ts;
        const loop = useLoopStore.getState();
        const dt = ts - lastTsRef.current;
        lastTsRef.current = ts;
        // The AUDIO CLOCK is master while the mix plays (P6): adopting its phase
        // keeps the ear and the eye glued at any knob speed. No audio → the rAF
        // integrates dt·speed exactly as before.
        const F = Math.max(1, loop.meta.frames);
        // THE SONG CLOCK: the playhead is a song frame over the whole video
        // [0, T) — or the MARKED PART, which Play repeats. Audio master → adopt the
        // engine's frame (its buffer repeats the same stretch); no audio → integrate
        // dt · speed. The canvas loop's phase (the cue, scene-global events) is its
        // place in the loop F.
        const T = Math.max(1, liveTotalFrames());
        const part = loop.part;
        const a = part ? Math.min(part.start, T - 1) : 0;
        const b = part ? Math.max(a + 1, Math.min(part.end, T)) : T;
        const af = engineAbsFrame();
        if (af != null) absFloatRef.current = af;
        else {
          let x = absFloatRef.current + (dt * loop.speed * loop.meta.fps) / 1000;
          if (x >= b || x < a) x = a + ((((x - a) % (b - a)) + (b - a)) % (b - a));
          absFloatRef.current = x;
        }
        const absNow = Math.floor(absFloatRef.current);
        phaseRef.current = (absNow % F) / F;
        // Loop cue: sweep the playhead; on a WRAP (phase dropped) fire the downbeat
        // flash + (if enabled) an audio tick. A live aid — nothing here touches the
        // dithered canvas or the export.
        const phase = phaseRef.current;
        const wrapped = phase < prevPhaseRef.current;
        if (wrapped) {
          flashRef.current = 1;
          if (loop.cueSound) playCueTick(true);
        }
        absFrameRef.current = absNow;
        // The take follows the song frame: an open Free loop measures its length
        // on it (and ends if the video wraps back to the start).
        noteTakeFrame(absFrameRef.current);
        // Publish the loop phase + the ABSOLUTE phase so the audio engine can resume
        // at the CURRENT absolute stretch when audio is enabled/un-muted mid-play.
        publishLoopPhase(phase, absNow / T);
        prevPhaseRef.current = phase;
        flashRef.current = flashRef.current < 0.02 ? 0 : flashRef.current * 0.82;
        if (cueBarRef.current) cueBarRef.current.style.transform = `scaleX(${phase})`;
        if (cueFlashRef.current) cueFlashRef.current.style.opacity = String(flashRef.current);
        renderRef.current();
        loopRaf.current = requestAnimationFrame(tick);
      };
      loopRaf.current = requestAnimationFrame(tick);
    };
    const stop = () => {
      loopActive.current = false;
      if (loopRaf.current) {
        cancelAnimationFrame(loopRaf.current);
        loopRaf.current = 0;
      }
      phaseRef.current = 0; // Stop returns to frame 0 (next Play restarts the loop)
      absFloatRef.current = 0;
      absFrameRef.current = 0;
      publishLoopPhase(0);
      // Hide + reset the loop cue.
      prevPhaseRef.current = 0;
      flashRef.current = 0;
      if (cueRef.current) cueRef.current.style.display = 'none';
      renderRef.current(); // restore the static render
    };
    // Reflect the current transport on mount, then track changes.
    if (useLoopStore.getState().transport !== 'stopped') start();
    const unsub = useLoopStore.subscribe((s, prev) => {
      if (s.transport === prev.transport) return;
      // A stroke held past the take's end ends with it: Play is view-only.
      if (prev.transport === 'recording' && captureRef.current) {
        commitCapture(captureRef.current);
        captureRef.current = null;
      }
      if (s.transport === 'stopped') stop();
      else start();
    });
    return () => {
      unsub();
      loopActive.current = false;
      if (loopRaf.current) cancelAnimationFrame(loopRaf.current);
    };
  }, []);

  // Measure the glass box (responsive); keep the Konva stage + cell scale in sync.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // LAYOUT px, not getBoundingClientRect: the auto-fit pass scales the whole
      // device with a CSS transform, and the Konva stage + cellPx math must stay
      // in the un-scaled coordinate space (Konva unscales pointer events itself).
      setBox({ w: el.offsetWidth, h: el.offsetHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The audio engine + GC wire up on mount (idempotent). (The old Draw→Record bridge is
  // gone: the canvas IS the scene,.)
  useEffect(() => {
    initAudioEngine();
    initSceneGc();
  }, []);

  // Load assets + re-render on any scene change (rAF-coalesced).
  useEffect(() => {
    void ensureAssets(useSceneStore.getState().nodes.map((n) => n.assetId)).then(() => schedule());
    const unsub = useSceneStore.subscribe((s) => {
      void ensureAssets(s.nodes.map((n) => n.assetId)).then(() => schedule());
    });
    return () => unsub();
  }, [schedule]);

  // Re-render the STATIC (stopped) scene when the loop timeline changes — an E7 edit
  // (undo take / clear loop / per-take mute) must update the glass even when not
  // playing. While playing the loop rAF owns rendering (schedule() is a no-op then).
  useEffect(() => {
    const unsub = useLoopStore.subscribe((s, prev) => {
      // …and when the song analysis lands or reactions change: a stopped visualizer shows
      // its resting pose FROM the features, so a late decode (a reopened project's song)
      // must redraw it — else the glass and Export PNG keep a stale pose.
      if (
        s.events !== prev.events ||
        s.mutedLayers !== prev.mutedLayers ||
        s.features !== prev.features ||
        s.reactions !== prev.reactions
      )
        schedule();
      // A STOPPED scrub (the timeline playhead): land videos on that exact frame, show it.
      if (s.scrub !== prev.scrub && s.transport === 'stopped') {
        scrubVideos(s.scrub);
        schedule();
      }
    });
    return () => unsub();
  }, [schedule]);

  // Re-render on resize / aspect / cell-style / Density change (scene-wide). Per-element
  // Size + Tonal ride the scene-store subscription above (setLook bumps the scene).
  useEffect(() => {
    schedule();
  }, [box.w, box.h, aspect, cellStyle, dotDensity, schedule]);

  // Hide the brush-ring cursor whenever we leave Paint mode (so it doesn't linger over
  // the Arrange glass / a playing loop after the last stroke).
  useEffect(() => {
    if (tool !== 'paint' && ringRef.current) ringRef.current.style.display = 'none';
  }, [tool]);

  // Track Alt for free (sub-cell) placement.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Keep the main Transformer attached to the selection (detached during crop and
  // while painting — its handles would be inert clutter over the brush surface).
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const sel =
      activeCrop || activeWin || tool === 'paint' || transport !== 'stopped'
        ? []
        : (selected
            .filter((id) => nodes.find((n) => n.id === id)?.kind !== 'image')
            .map((id) => nodeRefs.current.get(id))
            .filter(Boolean) as Konva.Rect[]);
    tr.nodes(sel);
    // Text layers move + rotate but don't stretch: a stretched layer would resample its
    // dots — the panel's Size spreads them instead.
    tr.resizeEnabled(!selected.some((id) => nodes.find((n) => n.id === id)?.kind === 'text'));
    tr.getLayer()?.batchDraw();
  }, [selected, nodes, box.w, activeCrop, activeWin, tool, transport]);

  // The selected PHOTO's outline: a box around the picture itself
  // inside its full frame — drag = move, corners = scale, top handle = rotate. Each edit
  // re-samples the source (pictureToParams → the photo's reframe), one undo step.
  const picNode =
    tool === 'arrange' &&
    transport === 'stopped' &&
    !activeCrop &&
    !activeWin &&
    selected.length === 1
      ? nodes.find((n) => n.id === selected[0] && n.kind === 'image')
      : undefined;
  const [picFrozen, setPicFrozen] = useState<PictureRect | null>(null);
  const picRect = picFrozen ?? (picNode ? pictureRect(picNode, dims) : null);
  useEffect(() => {
    const tr = picTrRef.current;
    if (!tr) return;
    tr.nodes(picNode && picRef.current ? [picRef.current] : []);
    tr.getLayer()?.batchDraw();
  }, [picNode, picRect, box.w]);
  const picApply = () => {
    const kn = picRef.current;
    if (!kn || !picNode || cellPx === 0) return;
    const patch = pictureToParams(picNode, dims, {
      cx: kn.x() / cellPx,
      cy: kn.y() / cellPx,
      w: (kn.width() * Math.abs(kn.scaleX())) / cellPx,
      rot: kn.rotation(),
    });
    if (patch) useSceneStore.getState().setImageParams(picNode.id, patch);
  };
  const picBegin = () => {
    if (!picNode || !picRect) return;
    setPicFrozen(picRect); // hold the box's props still while Konva drives it
    beginImageGesture(picNode);
  };
  const picEnd = () => {
    picApply();
    picRef.current?.scale({ x: 1, y: 1 });
    setPicFrozen(null);
    endImageGesture();
  };

  // Attach the crop Transformer to the crop rectangle while cropping.
  useEffect(() => {
    const tr = cropTrRef.current;
    if (!tr) return;
    const rect = cropRectRef.current;
    tr.nodes(activeCrop && rect ? [rect] : []);
    tr.getLayer()?.batchDraw();
  }, [activeCrop, nodes, box.w]);

  // Attach the window Transformer to the window box while editing it.
  useEffect(() => {
    const tr = winTrRef.current;
    if (!tr) return;
    const rect = winRectRef.current;
    tr.nodes(activeWin && rect ? [rect] : []);
    tr.getLayer()?.batchDraw();
  }, [activeWin, nodes, box.w]);

  // ---- Interaction handlers ----
  const beginGesture = (ids: string[]) => {
    ids.forEach((id) => liveIds.current.add(id));
  };
  const endGesture = () => {
    liveIds.current.clear();
    schedule();
  };

  const commitNode = (id: string, kn: Konva.Rect) => {
    const cpx = box.w / dims.w;
    if (cpx === 0) return;
    useSceneStore.getState().setPlacement(id, {
      x: kn.x() / cpx,
      y: kn.y() / cpx,
      scaleX: kn.scaleX(),
      scaleY: kn.scaleY(),
      rotationDeg: kn.rotation(),
    });
  };

  // ---- Image layers: Move pans the PICTURE inside its full frame (the source
  // is re-sampled — Burn's reframe), and the wheel zooms it. A whole gesture is ONE undo
  // step: history is paused while it runs, then the start→final change is recorded once.
  const imgGestureRef = useRef<{ id: string; start: ImageLayerParams } | null>(null);
  const beginImageGesture = (n: SceneNode) => {
    if (!n.image || imgGestureRef.current) return;
    useSceneStore.temporal.getState().pause();
    imgGestureRef.current = { id: n.id, start: { ...n.image } };
  };
  const endImageGesture = () => {
    const g = imgGestureRef.current;
    imgGestureRef.current = null;
    if (!g) return;
    const st = useSceneStore.getState();
    const final = st.nodes.find((x) => x.id === g.id)?.image;
    st.setImageParams(g.id, g.start); // back to the start, still paused…
    useSceneStore.temporal.getState().resume();
    if (final) useSceneStore.getState().setImageParams(g.id, final); // …then ONE recorded step
  };
  const clampOff = (o: number) => Math.min(2, Math.max(-2, o));
  const panImage = (n: SceneNode, kn: Konva.Rect) => {
    const g = imgGestureRef.current;
    if (!g || g.id !== n.id || cellPx === 0) return;
    const bx = n.placement.x * cellPx;
    const by = n.placement.y * cellPx;
    // Konva moved the proxy by the drag delta since its last reset; at release it has
    // not moved again, so there is nothing new to apply.
    if (kn.x() === bx && kn.y() === by) return;
    // A flipped layer's picture is mirrored, so its source offset runs the other way —
    // multiply by the flip sign so the picture still follows the pointer.
    const dx = ((kn.x() - bx) / (dims.w * cellPx)) * (n.placement.scaleX < 0 ? -1 : 1);
    const dy = ((kn.y() - by) / (dims.h * cellPx)) * (n.placement.scaleY < 0 ? -1 : 1);
    kn.position({ x: bx, y: by }); // the frame never moves — only the picture inside it
    useSceneStore.getState().setImageParams(n.id, {
      offsetX: clampOff(g.start.offsetX + dx),
      offsetY: clampOff(g.start.offsetY + dy),
    });
  };
  const wheelTimer = useRef(0);
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const st = useSceneStore.getState();
      if (st.tool !== 'arrange' || st.selected.length !== 1) return;
      const n = st.nodes.find((x) => x.id === st.selected[0]);
      if (!n || n.kind !== 'image' || !n.image) return;
      e.preventDefault();
      beginImageGesture(n);
      const z = Math.min(4, Math.max(0.5, n.image.zoom * Math.exp(-e.deltaY * 0.0002)));
      st.setImageParams(n.id, { zoom: z });
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(endImageGesture, 350);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Move acts on the SELECTED layer: full-frame photos
  // cover the whole canvas, so the top one is always under the pointer. With one layer
  // selected, a press anywhere on the canvas drags THAT layer (handed over once the
  // pointer actually moves); a click without moving still selects what's under it.
  const pendingRef = useRef<{ id: string; x: number; y: number; selId: string } | null>(null);
  const onStagePointerMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const p = pendingRef.current;
    if (!p) return;
    if ((e.evt.buttons & 1) === 0) {
      pendingRef.current = null; // released off the canvas — no hand-over
      return;
    }
    if (Math.hypot(e.evt.clientX - p.x, e.evt.clientY - p.y) < 4) return;
    pendingRef.current = null;
    nodeRefs.current.get(p.selId)?.startDrag();
  };
  const onStagePointerUp = () => {
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) selectNode(p.id, false); // a plain click: select the layer under the pointer
  };

  const selectNode = (id: string, additive: boolean) => {
    if (additive) useSceneStore.getState().toggleSelect(id, true);
    else useSceneStore.getState().setSelection([id]);
  };

  // ---- Paint mode (draw-in-Record / E4) ----
  // The brush BYPASSES Konva (the Konva stage is non-interactive in paint mode), so
  // no transform gesture runs and `liveIds` stays empty — the authoritative render
  // therefore reads the live asset cache, and the brush, which mutates that cache
  // and calls schedule(), owns the re-render. Paint-render and gesture-render never
  // fight (they are mutually exclusive by the modal Arrange/Paint toggle).
  const brushOpts = (): BrushOpts => {
    const b = useSceneStore.getState().brush;
    return { tool: b.tool, size: b.size, shade: b.shade };
  };
  /** The current INTEGER loop frame (for tagging captured overdub stamps). */
  const currentFrame = (): number => {
    const loop = useLoopStore.getState();
    const F = Math.max(1, loop.meta.frames);
    return Math.min(F - 1, Math.max(0, Math.floor(phaseRef.current * F)));
  };
  /** A layer's own loop clock right now — what a recorded stroke / move on it
   *  is stamped with, so it replays where it was performed. Off its clips (a gap) it falls
   *  back to the canvas loop. */
  const layerFrameNow = (node: Pick<SceneNode, 'id' | 'clips'>): LayerClock => {
    const F = Math.max(1, useLoopStore.getState().meta.frames);
    return (
      layerClock(liveNodes([node])[0], absFrameRef.current, F, liveLayerLoops()[node.id]) ?? {
        frame: currentFrame(),
        frames: F,
        pos: 0,
      }
    );
  };
  /** Append a captured segment's dabs (tagged with the current loop frame) to the
   *  in-progress overdub stroke — element-cell coords via the shared inverse affine,
   *  stepped like raster-brush.stampLine. Never writes the base raster. */
  const captureSeg = (
    cap: StrokeCapture,
    sx0: number,
    sy0: number,
    sx1: number,
    sy1: number,
  ): void => {
    const asset = getAssetCache().get(cap.assetId);
    if (!asset) return;
    const opts = brushOpts();
    // The stroke's layer's own loop clock. If the loop wrapped back to its start
    // mid-stroke, the part drawn so far is kept as its own stroke and the rest starts over
    // at the loop's start, so it replays where it was drawn. A small step back (the audio
    // clock taking over) is not a wrap: the frame just holds, so one stroke stays ascending.
    const clk = layerFrameNow(cap.node);
    if (clk.frame < cap.lastFrame - clk.frames / 2) {
      commitCapture(cap);
      cap.stamps = [];
      cap.lastFrame = clk.frame;
    }
    const frame = Math.max(cap.lastFrame, clk.frame);
    cap.lastFrame = frame;
    noteTakeStamp(cap.node.id, frame);
    // Invert through the node's EFFECTIVE placement at this frame (motion/path folded —
    // the SAME transform render uses), so a dab lands under the cursor even on a moving
    // paint layer. For a static full-frame layer this equals the base placement.
    const store = useSceneStore.getState();
    const loop = useLoopStore.getState();
    const ev = evaluateScene(
      liveNodes(store.nodes),
      store.scene,
      loop.events,
      currentFrame(),
      Math.max(1, loop.meta.frames),
      null,
      makeRng(loop.meta.seed),
      new Set(loop.mutedLayers),
      // Match the render's effective placement (marquee wrap + path loop-close) so a dab
      // lands under the cursor even on a moving layer.
      {
        dims: sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel),
        assetDims: (id) => getAssetCache().get(id),
        pathClose: loop.meta.pathClose,
        // Slow / tempo-synced motions sit where the render draws them.
        absFrame: absFrameRef.current,
        beat: beatClock(),
        canvasMotion: store.canvasMotion,
        layerLoops: liveLayerLoops(),
      },
    );
    const placement = (ev.nodes.find((n) => n.id === cap.node.id) ?? cap.node).placement;
    const sc = (Math.abs(placement.scaleX) + Math.abs(placement.scaleY)) / 2 || 1;
    const per = asset.per ?? 1; // a Fine drawing holds 4 values per square
    const r = (opts.size * per) / sc;
    const dist = Math.hypot(sx1 - sx0, sy1 - sy0);
    const steps = Math.max(1, Math.ceil(dist / Math.max(0.5, opts.size / 2)));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const e = sceneToElementCell(
        placement,
        asset.w,
        asset.h,
        sx0 + (sx1 - sx0) * u,
        sy0 + (sy1 - sy0) * u,
        per,
      );
      cap.stamps.push({
        frame,
        x: e.x,
        y: e.y,
        r,
        shade: opts.shade,
        erase: opts.tool === 'eraser',
      });
    }
    cap.lastX = sx1;
    cap.lastY = sy1;
  };
  /** Client pointer -> scene cell (canvas aspect == glass aspect, so it fills). */
  const toScene = (e: PointerEvent<HTMLDivElement>): { x: number; y: number } | null => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const d = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
    return {
      x: ((e.clientX - r.left) / r.width) * d.w,
      y: ((e.clientY - r.top) / r.height) * d.h,
    };
  };
  const updateRing = (e: PointerEvent<HTMLDivElement>) => {
    const ring = ringRef.current;
    const surf = surfaceRef.current;
    const cv = canvasRef.current;
    if (!ring || !surf || !cv) return;
    // No paintable target (a frozen node is selected) → no ring; the deck shows
    // "Frozen — rasterize" and the cursor flips to not-allowed (is-frozen class).
    // Likewise while merely PLAYING (not recording) painting is blocked — hide the ring
    // so it doesn't imply you can draw (hit Record to draw into the loop).
    if (paintTarget() === 'frozen' || useLoopStore.getState().transport === 'playing') {
      ring.style.display = 'none';
      return;
    }
    const r = cv.getBoundingClientRect();
    const d = sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
    const sr = surf.getBoundingClientRect();
    // The ring lives in LAYOUT px inside the (possibly auto-fit-scaled) device,
    // while client coords are VISUAL px — unscale by the surface's scale factor.
    const sf = surf.offsetWidth > 0 ? sr.width / surf.offsetWidth : 1;
    const cellPx = r.width / sf / d.w; // layout px per scene cell
    const diam = Math.max(4, 2 * useSceneStore.getState().brush.size * cellPx);
    ring.style.display = 'block';
    ring.style.left = `${(e.clientX - sr.left) / sf}px`;
    ring.style.top = `${(e.clientY - sr.top) / sf}px`;
    ring.style.width = `${diam}px`;
    ring.style.height = ring.style.width;
  };
  const hideRing = () => {
    if (ringRef.current) ringRef.current.style.display = 'none';
  };

  /** The ONE selected photo when the Erase brush is held (its cutout is the target). */
  const mattePhoto = (): SceneNode | null => {
    const st = useSceneStore.getState();
    if (st.tool !== 'paint' || st.brush.tool !== 'eraser' || st.selected.length !== 1) return null;
    const n = st.nodes.find((x) => x.id === st.selected[0]);
    return n && n.kind === 'image' ? n : null;
  };

  /** The ONE selected recording when the Erase brush is held. */
  const erasedRecording = (): SceneNode | null => {
    const st = useSceneStore.getState();
    if (st.tool !== 'paint' || st.brush.tool !== 'eraser' || st.selected.length !== 1) return null;
    const n = st.nodes.find((x) => x.id === st.selected[0]);
    return n && n.kind === 'recording' ? n : null;
  };

  const onPaintDown = (e: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'paint') return;
    if (e.button !== 0 && e.button !== 2) return; // left + right only (middle = ignore)
    if (captureRef.current) finishPaint(); // its release never came: keep it, don't overwrite it
    const tp = useLoopStore.getState().transport;
    if (tp === 'playing') return; // Play is view-only — hit Record to draw into the loop
    if (tp !== 'recording' && e.button !== 0) return; // static painting stays left-only
    // A stray text selection elsewhere on the page would let a LEFT drag start the
    // browser's own drag-and-drop, which cancels the stroke after a frame or two.
    window.getSelection()?.removeAllRanges();
    const p = toScene(e);
    if (!p) return;
    // Erase with ONE photo selected edits that photo's cutout (Erase rubs out, Restore
    // paints back) — an edit, so only while stopped.
    const photo = mattePhoto();
    if (photo) {
      if (tp !== 'stopped' || !beginMatteStroke(photo)) return;
      updateRing(e);
      const st = useSceneStore.getState();
      matteStroke(photo, p.x, p.y, p.x, p.y, st.matteMode, st.brush.size);
      matteRef.current = { node: photo, x: p.x, y: p.y };
      schedule();
      try {
        surfaceRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      return;
    }
    // Stopped, Erase on a picked recording rubs out its strokes at every moment.
    const rubbed = tp === 'stopped' ? erasedRecording() : null;
    if (rubbed) {
      updateRing(e);
      beginRecordingErase();
      eraseRecordingDabs(rubbed, p.x, p.y, p.x, p.y, useSceneStore.getState().brush.size);
      rubRef.current = { node: rubbed, x: p.x, y: p.y };
      schedule();
      try {
        surfaceRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      return;
    }
    // Recording: the stroke goes into the PICKED recording while the playhead is on
    // its bar; anything else makes a new recording just above the picked layer. Stopped, a
    // picked recording takes no brush: a new still drawing just above it.
    const dest = tp === 'recording' ? strokeTarget(absFrameRef.current) : null;
    const t = dest ? dest.node : paintTarget();
    if (t === 'frozen') return; // brush greyed on a frozen node (the deck offers Rasterize)
    if (dest && (!t || isEmptyRecording(t)) && brushOpts().tool === 'eraser') {
      notifyBanner(t ? 'Nothing recorded here to erase yet' : 'Pick a recording to erase in it');
      return;
    }
    if (t && dest && takesOn(useLoopStore.getState().events, t.id) >= MAX_TAKES) {
      const lp = useLoopStore.getState();
      const already = lp.events.some((ev) => ev.nodeId === t.id && ev.pass === lp.recordPass);
      if (!already) {
        notifyBanner('Max takes reached — undo a take or start a new recording');
        return;
      }
    }
    let node = t;
    if (!node) {
      const st = useSceneStore.getState();
      const rec = st.nodes.find((n) => st.selected.includes(n.id) && n.kind === 'recording');
      const id = dest ? createRecordingLayer(dest.above) : createPaintLayer(rec?.id);
      if (dest) markFreshLayer(id, absFrameRef.current);
      node = useSceneStore.getState().nodes.find((n) => n.id === id) ?? null;
    }
    // The drawing being drawn on is the picked layer, so the Layers
    // highlight always shows where the strokes land — even from Whole canvas.
    else if (!useSceneStore.getState().selected.includes(node.id))
      useSceneStore.getState().setSelection([node.id]);
    if (!node) return;
    updateRing(e);
    if (tp === 'recording') {
      // OVERDUB: capture the stroke as timed stamps (NOT baked into the base) so it
      // draws-in on replay each loop. Live feedback comes from the loop render reading
      // captureRef; the loop rAF is already running so the brush shows immediately.
      const pass = useLoopStore.getState().recordPass ?? 0;
      if (isEmptyRecording(node)) markFreshLayer(node.id, absFrameRef.current); // set up beforehand
      claimLayer(node, absFrameRef.current, true); // its own loop, if it has none yet
      const f0 = layerFrameNow(node).frame;
      const cap: StrokeCapture = {
        node,
        assetId: node.assetId,
        stamps: [],
        pass,
        lastX: p.x,
        lastY: p.y,
        lastFrame: f0,
        // LEFT = flashing dot/stroke; RIGHT-hold = draw-in. The ERASER never
        // blinks: a 4-frame flashing erase reads as "erase doesn't work" (owner
        // report) — an erase is an edit to the take, always persistent.
        blink: e.button === 0 && brushOpts().tool !== 'eraser',
        held: e.button === 0 ? 1 : 2,
      };
      captureRef.current = cap;
      captureSeg(cap, p.x, p.y, p.x, p.y);
    } else {
      // STATIC authoring (stopped): bake into the layer raster (existing behavior).
      paintStroke(node, p.x, p.y, p.x, p.y, brushOpts());
      paintRef.current = { node, x: p.x, y: p.y };
      schedule();
    }
    try {
      surfaceRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
  };
  const onPaintMove = (e: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'paint') return;
    updateRing(e);
    const p = toScene(e);
    if (!p) return;
    const mt = matteRef.current;
    if (mt) {
      const st = useSceneStore.getState();
      matteStroke(mt.node, mt.x, mt.y, p.x, p.y, st.matteMode, st.brush.size);
      matteRef.current = { node: mt.node, x: p.x, y: p.y };
      schedule();
      return;
    }
    const rub = rubRef.current;
    if (rub) {
      eraseRecordingDabs(rub.node, rub.x, rub.y, p.x, p.y, useSceneStore.getState().brush.size);
      rubRef.current = { node: rub.node, x: p.x, y: p.y };
      schedule();
      return;
    }
    const cap = captureRef.current;
    if (cap) {
      if ((e.buttons & cap.held) === 0) {
        endPaint(e); // the button is up but its release never reached us
        return;
      }
      captureSeg(cap, cap.lastX, cap.lastY, p.x, p.y); // the loop rAF renders the live stroke
      return;
    }
    const last = paintRef.current;
    if (!last) return;
    paintStroke(last.node, last.x, last.y, p.x, p.y, brushOpts());
    paintRef.current = { node: last.node, x: p.x, y: p.y };
    schedule();
  };
  // Commit the active stroke exactly once. Both the surface pointer-up and the window
  // safety net below route through this; whichever runs first clears the ref so the
  // other is a no-op. An overdub capture becomes ONE PaintRevealEvent (a timeline
  // layer that draws-in each loop); a static stroke snapshots the paint layer's undo.
  const finishPaint = useCallback(() => {
    const mt = matteRef.current;
    if (mt) {
      matteRef.current = null;
      endMatteStroke(mt.node); // the painted cutout → ONE undo step
      return;
    }
    if (rubRef.current) {
      rubRef.current = null;
      endRecordingErase(); // the rubbed strokes → ONE undo step
      return;
    }
    const cap = captureRef.current;
    if (cap) {
      captureRef.current = null;
      commitCapture(cap);
      return;
    }
    if (!paintRef.current) return;
    commitPaint(paintRef.current.node);
    paintRef.current = null;
  }, []);
  const endPaint = (e: PointerEvent<HTMLDivElement>) => {
    // Account for BOTH a static stroke (paintRef) and an overdub capture (captureRef) so
    // the surface handler owns the commit + pointer-capture release; the window listener
    // stays a pure safety net (finishPaint is idempotent, so a double call is a no-op).
    if (!paintRef.current && !captureRef.current && !matteRef.current && !rubRef.current) return;
    finishPaint();
    try {
      surfaceRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  // Safety net: if setPointerCapture failed and the pointer is released OFF the
  // surface, the surface's pointer-up never fires — commit here so the stroke isn't
  // silently merged into the next one. A no-op when no stroke is active (arrange).
  useEffect(() => {
    window.addEventListener('pointerup', finishPaint);
    window.addEventListener('pointercancel', finishPaint);
    return () => {
      window.removeEventListener('pointerup', finishPaint);
      window.removeEventListener('pointercancel', finishPaint);
    };
  }, [finishPaint]);

  const paintFrozen =
    tool === 'paint' &&
    selected.length > 0 &&
    !nodes.some((n) => selected.includes(n.id) && hasDrawnRaster(n)) &&
    !mattePhoto();

  return (
    <div
      ref={surfaceRef}
      className={`scene-surface${tool === 'paint' ? ' is-paint' : ''}${paintFrozen ? ' is-frozen' : ''}`}
      onPointerDown={onPaintDown}
      onPointerMove={onPaintMove}
      onPointerUp={endPaint}
      onPointerCancel={endPaint}
      onPointerLeave={hideRing}
      onContextMenu={(e) => e.preventDefault()} // RIGHT-hold = draw-in, not a menu
      onDragStart={(e) => e.preventDefault()} // never the browser's drag-and-drop
    >
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        style={{ imageRendering: 'pixelated', width: '100%', height: '100%', display: 'block' }}
      />
      {box.w > 0 && (
        <Stage
          width={box.w}
          height={box.h}
          className="scene-konva"
          // Arrange interactions live while STOPPED (edit) and while RECORDING (E5
          // path capture — dragging performs a movement into the loop); plain Play
          // stays view-only. Paint mode bypasses Konva entirely.
          listening={tool !== 'paint' && transport !== 'playing'}
          onMouseDown={(e) => {
            if (e.target === e.target.getStage()) useSceneStore.getState().clearSelection();
          }}
          onMouseMove={onStagePointerMove}
          onMouseUp={onStagePointerUp}
        >
          <Layer>
            {nodes.map((n) => {
              const asset = getAssetCache().get(n.assetId);
              // The layer's footprint in squares: a Fine picture holds 4 values per square.
              const per = asset?.per ?? 1;
              const nw = ((asset?.w ?? 16) / per) * cellPx;
              const nh = ((asset?.h ?? 16) / per) * cellPx;
              return (
                <Rect
                  key={n.id}
                  ref={(node) => {
                    if (node) nodeRefs.current.set(n.id, node);
                    else nodeRefs.current.delete(n.id);
                  }}
                  x={n.placement.x * cellPx}
                  y={n.placement.y * cellPx}
                  offsetX={nw / 2}
                  offsetY={nh / 2}
                  width={nw}
                  height={nh}
                  scaleX={n.placement.scaleX}
                  scaleY={n.placement.scaleY}
                  rotation={n.placement.rotationDeg}
                  // Fully transparent but still hit-testable (Konva's hit graph
                  // ignores fill alpha) — so there is NO visible box around an
                  // element. Selection is shown only by the Transformer. Output
                  // pixels come only from the dither canvas.
                  fill="rgba(0,0,0,0)"
                  listening={!n.hidden} // a hidden layer can't be grabbed on the canvas
                  // With ONE layer selected only it drags (others hand the press to it).
                  draggable={n.id !== activeCrop && (selected.length !== 1 || selected[0] === n.id)}
                  dragBoundFunc={(pos) => {
                    if (n.kind === 'image' || altRef.current || cellPx === 0) return pos;
                    return {
                      x: Math.round(pos.x / cellPx) * cellPx,
                      y: Math.round(pos.y / cellPx) * cellPx,
                    };
                  }}
                  onMouseDown={(e) => {
                    e.cancelBubble = true; // don't clear selection
                    const ev = e.evt;
                    if (selected.includes(n.id)) return;
                    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
                    if (selected.length === 1 && !additive && nodeRefs.current.has(selected[0])) {
                      pendingRef.current = {
                        id: n.id,
                        x: ev.clientX,
                        y: ev.clientY,
                        selId: selected[0],
                      };
                      return;
                    }
                    selectNode(n.id, additive);
                  }}
                  onDragStart={() => {
                    if (n.kind === 'image') return beginImageGesture(n);
                    const lp = useLoopStore.getState();
                    if (lp.transport === 'recording') {
                      // E5: this drag is a PERFORMANCE — sample it into the layer's loop.
                      claimLayer(n, absFrameRef.current);
                      pathCapRef.current = beginPathCapture(
                        n.id,
                        lp.recordPass ?? 0,
                        layerFrameNow(n).frame,
                      );
                      notifyBanner('Recording path…');
                    }
                    beginGesture([n.id]);
                  }}
                  onDragMove={(e) => {
                    if (n.kind === 'image') return panImage(n, e.target as Konva.Rect);
                    const cap = pathCapRef.current;
                    if (cap && cap.nodeId === n.id && cellPx > 0) {
                      const kn = e.target as Konva.Rect;
                      const clk = layerFrameNow(n);
                      samplePath(cap, clk.frame, clk.frames, {
                        x: kn.x() / cellPx,
                        y: kn.y() / cellPx,
                        scaleX: kn.scaleX(),
                        scaleY: kn.scaleY(),
                        rotationDeg: kn.rotation(),
                      });
                      return; // the loop rAF renders the live drag
                    }
                    schedule();
                  }}
                  onDragEnd={(e) => {
                    if (n.kind === 'image') {
                      panImage(n, e.target as Konva.Rect);
                      return endImageGesture();
                    }
                    const cap = pathCapRef.current;
                    if (cap && cap.nodeId === n.id) {
                      pathCapRef.current = null;
                      const lp = useLoopStore.getState();
                      const evt = finishPathCapture(
                        cap,
                        layerFrameNow(n).frames,
                        nextEventId('op-'),
                      );
                      if (evt) lp.commitEvents([evt]);
                      // The drag was a performance, not an arrangement edit: the base
                      // placement is untouched (Undo Take / mute cover the event), so
                      // snap the Konva proxy back to it.
                      const kn = e.target as Konva.Rect;
                      if (cellPx > 0) {
                        kn.position({ x: n.placement.x * cellPx, y: n.placement.y * cellPx });
                        kn.scale({ x: n.placement.scaleX, y: n.placement.scaleY });
                        kn.rotation(n.placement.rotationDeg);
                      }
                      endGesture();
                      return;
                    }
                    commitNode(n.id, e.target as Konva.Rect);
                    endGesture();
                  }}
                  onTransformStart={() => beginGesture([n.id])}
                  onTransform={schedule}
                  onTransformEnd={(e) => {
                    commitNode(n.id, e.target as Konva.Rect);
                    endGesture();
                  }}
                />
              );
            })}
            {picNode && picRect && cellPx > 0 && (
              <>
                <Rect
                  ref={picRef}
                  x={picRect.cx * cellPx}
                  y={picRect.cy * cellPx}
                  width={picRect.w * cellPx}
                  height={picRect.h * cellPx}
                  offsetX={(picRect.w * cellPx) / 2}
                  offsetY={(picRect.h * cellPx) / 2}
                  rotation={picRect.rot}
                  fill="rgba(0,0,0,0)"
                  draggable
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                  }}
                  onDragStart={picBegin}
                  onDragMove={picApply}
                  onDragEnd={picEnd}
                  onTransformStart={picBegin}
                  onTransform={picApply}
                  onTransformEnd={picEnd}
                />
                <Transformer
                  ref={picTrRef}
                  keepRatio
                  rotateEnabled
                  rotationSnaps={[0, 90, 180, 270]}
                  rotationSnapTolerance={6}
                  flipEnabled={false}
                  enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
                  ignoreStroke
                />
              </>
            )}
            <Transformer
              ref={trRef}
              rotateEnabled
              rotationSnaps={[0, 90, 180, 270]}
              rotationSnapTolerance={8}
              flipEnabled={false}
              ignoreStroke
              boundBoxFunc={(oldBox, newBox) => {
                void oldBox;
                if (cellPx === 0 || altRef.current) return newBox;
                // Quantize the resized box to whole cells (keep a 1-cell minimum).
                const w = Math.max(cellPx, Math.round(newBox.width / cellPx) * cellPx);
                const h = Math.max(cellPx, Math.round(newBox.height / cellPx) * cellPx);
                return { ...newBox, width: w, height: h };
              }}
            />

            {/* H-A0 DIRECTION+SIZE HANDLE (owner-designed): a draggable arrow from
                the selected element's centre. Its ANGLE points the directional motion
                (marquee travel / drift axis / bounce floor) anywhere; its dragged
                LENGTH sets the motion's amp (1 cell of amp per scene cell — round-2
                speed rework: the deck ± became Speed, so amplitude lives HERE). One
                gesture defines the motion; zero deck rows. Chrome only — Konva
                CONTROLLER layer (never exported), shows only while STOPPED in
                Arrange (crop-box precedent). Dragging updates the arrow live
                (imperative, no store churn); the descriptor commits ONCE on drag end
                (the setPlacement gesture idiom) as normalized (ax, ay) = (cosθ, sinθ)
                + integer amp — the data model is untouched. */}
            {dirNode &&
              dirMotion &&
              tool === 'arrange' &&
              transport === 'stopped' &&
              dirNode.id !== activeCrop &&
              cellPx > 0 &&
              (() => {
                const cx = dirNode.placement.x * cellPx;
                const cy = dirNode.placement.y * cellPx;
                const dLen = Math.hypot(dirMotion.ax, dirMotion.ay);
                const ux = dLen > 1e-9 ? dirMotion.ax / dLen : 1;
                const uy = dLen > 1e-9 ? dirMotion.ay / dLen : 0;
                const armLen = ampToLen(dirMotion.amp, cellPx); // length ⇔ amp
                const tx = cx + ux * armLen;
                const ty = cy + uy * armLen;
                const setCursor = (e: Konva.KonvaEventObject<MouseEvent>, c: string) => {
                  const st = e.target.getStage();
                  if (st) st.container().style.cursor = c;
                };
                return (
                  <Group>
                    <Arrow
                      ref={dirArrowRef}
                      points={[cx, cy, tx, ty]}
                      pointerLength={8}
                      pointerWidth={7}
                      stroke={uiAccent()}
                      fill={uiAccent()}
                      strokeWidth={2}
                      listening={false}
                    />
                    <Circle
                      x={tx}
                      y={ty}
                      radius={5.5}
                      fill={uiAccent()}
                      stroke="#1a1a1a"
                      strokeWidth={1}
                      draggable
                      hitStrokeWidth={12}
                      onMouseEnter={(e) => setCursor(e, 'grab')}
                      onMouseLeave={(e) => setCursor(e, '')}
                      onMouseDown={(e) => {
                        e.cancelBubble = true; // never clears selection / starts a node drag
                      }}
                      dragBoundFunc={(pos) => {
                        // Free polar drag about the element centre: the angle gets the
                        // gentle 45° magnet; the radius (= amp) is clamped to the amp
                        // range so the arrow always reads a legal size.
                        const dx = pos.x - cx;
                        const dy = pos.y - cy;
                        let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
                        deg = magnet45(deg);
                        const rad = (deg * Math.PI) / 180;
                        const r = Math.max(
                          ARROW_MIN_PX,
                          Math.min(AMP_MAX * cellPx, Math.hypot(dx, dy)),
                        );
                        return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
                      }}
                      onDragStart={(e) => setCursor(e, 'grabbing')}
                      onDragMove={(e) => {
                        const k = e.target as Konva.Circle;
                        dirArrowRef.current?.points([cx, cy, k.x(), k.y()]);
                      }}
                      onDragEnd={(e) => {
                        setCursor(e, '');
                        const k = e.target as Konva.Circle;
                        const dx = k.x() - cx;
                        const dy = k.y() - cy;
                        const rad = Math.atan2(dy, dx);
                        useSceneStore.getState().setMotion(dirNode.id, {
                          ...dirMotion,
                          ax: Math.cos(rad),
                          ay: Math.sin(rad),
                          amp: lenToAmp(Math.hypot(dx, dy), cellPx),
                        });
                      }}
                    />
                  </Group>
                );
              })()}

            {/* Crop layer: a box in the element's own frame (so it aligns even when
                the element is rotated/scaled). Resizes freely; snaps to whole cells
                on commit. Double-click the box to clear the crop. */}
            {activeCrop &&
              cropNode &&
              transport === 'stopped' && // crop is an edit, not a performance
              cellPx > 0 &&
              (() => {
                const asset = getAssetCache().get(cropNode.assetId);
                const aw = asset?.w ?? 16;
                const ah = asset?.h ?? 16;
                // Crops are in the picture's own cells: px per picture cell (Detail).
                const rc = cellPx / (asset?.per ?? 1);
                const crop = cropNode.crop;
                const commitCrop = () => {
                  const rect = cropRectRef.current;
                  if (!rect) return;
                  const w = Math.max(rc, rect.width() * rect.scaleX());
                  const h = Math.max(rc, rect.height() * rect.scaleY());
                  const x0 = Math.max(0, Math.min(Math.round(rect.x() / rc), aw - 1));
                  const y0 = Math.max(0, Math.min(Math.round(rect.y() / rc), ah - 1));
                  const cw = Math.max(1, Math.min(Math.round(w / rc), aw - x0));
                  const ch = Math.max(1, Math.min(Math.round(h / rc), ah - y0));
                  useSceneStore.getState().setCrop(activeCrop, { x: x0, y: y0, w: cw, h: ch });
                };
                return (
                  <Group
                    x={cropNode.placement.x * cellPx}
                    y={cropNode.placement.y * cellPx}
                    offsetX={(aw * rc) / 2}
                    offsetY={(ah * rc) / 2}
                    scaleX={cropNode.placement.scaleX}
                    scaleY={cropNode.placement.scaleY}
                    rotation={cropNode.placement.rotationDeg}
                  >
                    <Rect
                      ref={cropRectRef}
                      x={(crop ? crop.x : 0) * rc}
                      y={(crop ? crop.y : 0) * rc}
                      width={(crop ? crop.w : aw) * rc}
                      height={(crop ? crop.h : ah) * rc}
                      scaleX={1}
                      scaleY={1}
                      draggable
                      fill={uiAccent(0.06)}
                      stroke={uiAccent()}
                      strokeWidth={2}
                      dash={[6, 4]}
                      strokeScaleEnabled={false}
                      onDragEnd={commitCrop}
                      onTransformEnd={commitCrop}
                      onDblClick={() => useSceneStore.getState().setCrop(activeCrop, null)}
                    />
                    <Transformer
                      ref={cropTrRef}
                      rotateEnabled={false}
                      flipEnabled={false}
                      keepRatio={false}
                      ignoreStroke
                    />
                  </Group>
                );
              })()}
            {/* The animation window: a box fixed on the canvas, in whole canvas
                squares. Drag it or its edges; double-click clears it. */}
            {activeWin?.window &&
              cellPx > 0 &&
              (() => {
                const w = activeWin.window;
                const commitWin = (rect: Konva.Node) => {
                  const x = Math.round(rect.x() / cellPx);
                  const y = Math.round(rect.y() / cellPx);
                  const ww = Math.max(1, Math.round((rect.width() * rect.scaleX()) / cellPx));
                  const hh = Math.max(1, Math.round((rect.height() * rect.scaleY()) / cellPx));
                  rect.scale({ x: 1, y: 1 });
                  useSceneStore.getState().setWindow(activeWin.id, { x, y, w: ww, h: hh });
                };
                return (
                  <>
                    <Rect
                      ref={winRectRef}
                      x={w.x * cellPx}
                      y={w.y * cellPx}
                      width={w.w * cellPx}
                      height={w.h * cellPx}
                      draggable
                      fill={uiAccent(0.05)}
                      stroke={uiAccent()}
                      strokeWidth={2}
                      dash={[10, 5]}
                      strokeScaleEnabled={false}
                      onDragEnd={(e) => commitWin(e.target)}
                      onTransformEnd={(e) => commitWin(e.target)}
                      onDblClick={() => {
                        const st = useSceneStore.getState();
                        st.setWindow(activeWin.id, null);
                        st.setWindowId(null);
                      }}
                    />
                    <Transformer
                      ref={winTrRef}
                      rotateEnabled={false}
                      flipEnabled={false}
                      keepRatio={false}
                      ignoreStroke
                    />
                  </>
                );
              })()}
            {winShown && cellPx > 0 && (
              <Rect
                x={winShown.x * cellPx}
                y={winShown.y * cellPx}
                width={winShown.w * cellPx}
                height={winShown.h * cellPx}
                stroke={uiAccent(0.4)}
                strokeWidth={1}
                dash={[6, 6]}
                listening={false}
              />
            )}
          </Layer>
        </Stage>
      )}
      {/* Loop cue overlay (live-only; never dithered). The bar sweeps 0→1 across
          the top edge; the flash pulses on each downbeat (loop start + wrap). */}
      <div ref={cueRef} className="loop-cue" aria-hidden="true">
        <div ref={cueFlashRef} className="loop-cue-flash" />
        <div ref={cueBarRef} className="loop-cue-bar" />
      </div>
      <div ref={ringRef} className="brush-ring" aria-hidden="true" />
    </div>
  );
}
