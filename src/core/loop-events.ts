// =============================================================================
// The looper timeline model + the pure motion resolver (Group E/F).
//
// evaluateScene is THE place the clock enters the system (its `frame` arg) and the
// ONLY new step between authoring and the dither: it turns (base t=0 nodes + the
// TimedEvent log) into a plain SceneNode[] + a folded scene Look — the EXACT shape
// resolveSceneGrid already eats. So the resolver / quantizeCell stay 0 lines changed
// and preview == export hold by construction (the resolver is time-blind; motion is
// evaluated BEFORE it, mirroring how SceneStage.render already substitutes a derived
// node list during a gesture).
//
// PURE: no zustand, no DOM, no wall-clock. Its only "side input" is the keyed,
// stateless SeededRng (itself a pure function of (seed, eventId, frame, channel)).
// Everything authored is keyed by an INTEGER loop frame in [0, F) — wall-clock and
// the live speed knob never appear here, so the export is speed-invariant.
// =============================================================================
import { MATRIX_IDS, PALETTE_IDS, isDiffusion } from './dither-constants';
import { HALFTONE_SIZE_MAX, HALFTONE_SIZE_MIN } from './cell-style';
import type {
  Look,
  LookOverride,
  MotionDescriptor,
  Placement,
  RecordingPlay,
  SceneNode,
} from '../state/scene-store';
import { reactionDelta, type FeatureArray, type ReactionDelta } from './audio-features';
import { stampDab } from './raster-brush';
import type { CachedAsset } from './scene-resolver';
import type { LayerFx } from './layer-fx';
import type { SeededRng } from './seeded-rng';
import { fadeGainAt, layerPosAt, visibleAt } from './timeline-edit';
import { BPM_DEFAULT, beatAt, beatSpanLoops, framesPerBeat, type BeatClock } from './tempo';
import {
  hasMods,
  hasSongBeatMod,
  modKey,
  modSpan,
  modulate,
  type ModContext,
  type ModMap,
  type ModParam,
} from './modulators';

/** How the loop length is set: 'bars' (J1, the default), a 'fixed' frame count, or 'free' (a new recording is as long as you record it; `frames` stays the canvas loop). */
export type LoopLengthMode = 'tap' | 'fixed' | 'bars' | 'free';

export type TimedEventKind =
  | 'paint-reveal' // E4: a paint layer's stroke DRAWS IN over a window (true stamp replay)
  | 'object-path' // E5 HOLD: a recorded movement path, sampled per integer frame
  | 'object-static' // E5 CLICK: a node holds at one placement (degenerate path)
  | 'motion' // D8: drift/bob/parallax/blink/marquee/twinkle (phase strictly from frame)
  | 'audio-react'; // F7: an audio reaction (contrast/invert/palette pulse) as a timeline layer

/** Where an event plays on a merged recording's clock, and how that maps
 *  back to the clock it was recorded on, so it looks the same as it did apart. */
export interface EventPart {
  /** Its window on the merged clock: `len` frames from `at`. Off it, the event isn't on screen. */
  at: number;
  len: number;
  /** Its own layer position at `at`, and how fast it ran there. */
  from: number;
  rate: number;
  /** Its own loop: it wraps at `frames` from `offset` (or pins there with `hold`, without
   *  its flashes), and `back` mirrors it. */
  frames: number;
  offset?: number;
  hold?: boolean;
  back?: boolean;
  /** The part it already had when this recording was merged again. */
  inner?: EventPart;
}

/** A frame on a merged clock through an event's part: its own frame + loop, whether it is
 *  pinned past its end, or null off its window. Pure. */
export function partFrame(
  part: EventPart,
  c: number,
): { frame: number; frames: number; held: boolean } | null {
  if (c < part.at || c >= part.at + part.len) return null;
  const p = Math.floor(part.from + (c - part.at) * part.rate) - (part.offset ?? 0);
  const L = Math.max(1, Math.round(part.frames));
  const held = !!part.hold && p >= L;
  let frame = held ? L - 1 : ((p % L) + L) % L;
  if (part.back) frame = held ? -1 : L - 1 - frame;
  if (!part.inner) return { frame, frames: L, held };
  const inner = partFrame(part.inner, frame);
  return inner && { ...inner, held: inner.held || held };
}

export interface TimedEventBase {
  id: string;
  kind: TimedEventKind;
  /** scene-store node this animates ('' for a scene-global look reaction). */
  nodeId: string;
  /** Overdub pass index (E7). Monotonic; never reused. */
  pass: number;
  /** Logical layer for mute (E7). Usually === pass. */
  layer: number;
  /** INTEGER loop frame in [0, F). */
  startFrame: number;
  /** INTEGER loop frame in [0, F]. === startFrame for an instantaneous event. */
  endFrame: number;
  /** On a merged recording: its own window + clock. Absent = the layer's clock. */
  part?: EventPart;
}

/** One captured brush dab, tagged with the loop frame it was laid at. */
export interface DabStamp {
  frame: number;
  x: number;
  y: number;
  r: number;
  shade: number;
  erase: boolean;
}

export interface PaintRevealEvent extends TimedEventBase {
  kind: 'paint-reveal';
  /** The paint:<n> layer whose coverage animates in. */
  assetId: string;
  /** Ordered dab stamps; replaying stamps[0..count] (count = #stamps with
   *  frame <= current) reproduces the partial stroke. */
  stamps: DabStamp[];
  /** BLINK-STAMP: when present, this stroke is visible ONLY while the loop frame
   *  is inside the wrap-aware window [startFrame, startFrame + holdFrames) — a
   *  quick click flashes on its beat every loop instead of accumulating. Absent
   *  (all pre-existing events) = the persistent draw-in. Loops never persist to
   *  disk yet; if a loop-save format ever lands, treat this as optional. */
  holdFrames?: number;
}

/** Frames a quick-click blink stamp stays visible (~133ms at 30fps). */
export const BLINK_HOLD_FRAMES = 4;

/** Is a paint-reveal event visible at `frame`? Persistent events (no holdFrames)
 *  always are. Blink events are visible inside [startFrame, endFrame+holdFrames) —
 *  the flash FOLLOWS the gesture (a tap blinks on its beat; a left-drag draws in
 *  over its frames, lingers holdFrames, then hides) — wrapping past the loop end.
 *  `frame >= frames` is the AT-REST sentinel (the stopped view shows everything so
 *  blink marks stay inspectable); the export walks 0..F-1 and never passes it, so
 *  determinism is untouched. */
export function paintWindowVisible(
  startFrame: number,
  endFrame: number,
  holdFrames: number | undefined,
  frame: number,
  frames: number,
): boolean {
  if (holdFrames == null) return true;
  if (frame >= frames) return true; // at-rest sentinel (revealFrame = F)
  const end = endFrame + holdFrames;
  if (end <= frames) return frame >= startFrame && frame < end;
  return frame >= startFrame || frame < end - frames; // window wraps the loop end
}

export interface ObjectPathEvent extends TimedEventBase {
  kind: 'object-path';
  /** samples[i] is the placement at frame (startFrame + i), frame-quantized at capture. */
  samples: Placement[];
  interp: 'hold' | 'linear';
}

export interface ObjectStaticEvent extends TimedEventBase {
  kind: 'object-static';
  placement: Placement;
}

export interface MotionEvent extends TimedEventBase {
  kind: 'motion';
  motion: MotionDescriptor;
}

export interface AudioReactEvent extends TimedEventBase {
  kind: 'audio-react';
  band: 'rms' | 'low' | 'mid' | 'high' | 'onset';
  target:
    | { kind: 'look'; key: 'contrast' | 'brightness' }
    | { kind: 'invert' }
    | { kind: 'palette' }
    | { kind: 'matrixStep' }
    // MOVE reactions: the art itself moves to the music.
    | { kind: 'pulse' }
    | { kind: 'bounce' }
    | { kind: 'shake' }
    | { kind: 'flash' }
    | { kind: 'dotSize' };
  depth: number;
}

export type TimedEvent =
  | PaintRevealEvent
  | ObjectPathEvent
  | ObjectStaticEvent
  | MotionEvent
  | AudioReactEvent;

/**
 * The distinct take (pass) indices in the event log whose owning node is still LIVE
 * (present in `liveNodeIds`); a scene-global event (nodeId '') always counts. A deleted
 * layer's events are non-destructively filtered out here so its take clears from the
 * counter/guards (an undo brings the node — and its take — back). ONE truth shared by
 * the take counter (LoopTransport), the length lock, and the resolution lock
 * (RecordControls): a log holding ONLY dead-layer events reads as take-free, so it can
 * never falsely lock a control.
 */
export function liveTakes(
  events: readonly TimedEvent[],
  liveNodeIds: ReadonlySet<string>,
): number[] {
  const seen = new Set<number>();
  for (const e of events) if (e.nodeId === '' || liveNodeIds.has(e.nodeId)) seen.add(e.pass);
  return [...seen].sort((a, b) => a - b);
}

/** The evaluated frame, ready for resolveSceneGrid. `nodes` + `scene` already have
 *  motion + audio-react folded in (so the resolver call shape is byte-identical to a
 *  static render). The *Delta fields are diagnostics (the deck's "what's reacting"
 *  readout + tests); the caller passes `nodes`/`scene` straight to the resolver. */
export interface EvaluatedScene {
  nodes: SceneNode[];
  scene: Look;
  /** assetId → number of stamps to replay this frame (paint-reveal; §B.3). */
  paintReveal: Map<string, number>;
  sceneLookDelta: Partial<Look>;
  nodeLookDelta: Map<string, Partial<Look>>;
  /** The canvas Density this frame when a modulator moves it (J2); absent = unchanged. */
  dotDensity?: number;
  /** The Whole canvas effects this frame (their moving amounts folded in); absent = none. */
  canvasFx?: LayerFx;
  /** Every modulated slider's value this frame, by modKey (the sliders' live marker). */
  modValues: Map<string, number>;
  /** Each on-screen layer's own loop clock this frame, by node id — the paint
   *  draw-in replays on it (`applyPaintReveal`'s `clockOf`). */
  clocks: Map<string, LayerClock>;
}

/** A layer's own loop clock at one song frame. `frame` in [0, frames). */
export interface LayerClock {
  frame: number;
  frames: number;
  /** The layer's unwrapped position (frames into its clip's media, or the song frame for
   *  an untimed layer) — slow motions that span several loops read it. */
  pos: number;
  /** A recording with Hold / Play backwards: the frame its strokes + hand moves
   *  replay at when that differs from `frame` (−1 = before anything was drawn). */
  replay?: number;
  /** A recording in its held stretch: the finished picture stays still, without flashes. */
  held?: boolean;
}

/** A recording's Repeat / Hold + Play backwards applied to its own clock: past
 *  its drawn part it wraps (Repeat) or pins at the last moment shown (Hold), and backwards
 *  mirrors the drawn part, so a held backwards recording is blank. Pure. */
export function recordingClock(c: LayerClock, rec: RecordingPlay, offset = 0): LayerClock {
  const past = c.pos - offset >= c.frames;
  if (rec.hold && past) return { ...c, replay: rec.backwards ? -1 : c.frames - 1, held: true };
  return rec.backwards ? { ...c, replay: c.frames - 1 - c.frame } : c;
}

/** A layer's OWN loop — it belongs to the layer's recorded takes, so it lives
 *  with them in the loop store (`layerLoops`, by node id), never on the layer (an edit
 *  Undo must not take it away from its takes). `bars` at the project tempo, or `free` (a
 *  recorded length rounded to the beat). `offset` = the layer position its loop starts at
 *  (a take that began mid-song on an untimed layer); absent = 0. */
export interface LayerLoop {
  frames: number;
  bars?: number;
  free?: boolean;
  offset?: number;
}

/** A layer's own loop clock at song frame `abs`: inside its clip it runs from
 *  the clip's in-point (sourceIn + (abs − start) × speed), an untimed layer from the start
 *  of the song, wrapped by the layer's own loop (`loop`, else the project's `F`). Null
 *  in a gap — the layer is off then. */
export function layerClock(
  n: Pick<SceneNode, 'clips'>,
  abs: number,
  F: number,
  loop?: LayerLoop,
): LayerClock | null {
  const pos = layerPosAt(n.clips, abs);
  if (pos === null) return null;
  const L = Math.max(1, Math.round(loop?.frames ?? F));
  const p = pos - (loop?.offset ?? 0);
  return { frame: ((p % L) + L) % L, frames: L, pos };
}

// NaN/Infinity-safe clamp: a malformed authored number is neutralised to `lo` at this
// one pre-resolver seam so it can never propagate into placement / the dither.
const clamp = (v: number, lo: number, hi: number): number =>
  !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
const frac = (v: number): number => v - Math.floor(v);

/** A per-frame motion contribution: a placement delta + an optional brightness pulse +
 *  a multiplicative scale delta (final scale ×= 1 + dscale). Marquee is NOT produced
 *  here — it needs the node footprint + scene dims, so it is resolved at the apply step
 *  (`marqueeOffset`). */
/** The noise key of the Whole canvas Motion (a layer's is its id; no id is empty). */
const CANVAS_MOTION_KEY = '';

interface MotionOut {
  dx: number;
  dy: number;
  drot: number;
  dbright: number;
  dscale: number;
}

/** Fold a MotionDescriptor at loop phase p = frame/F → a placement/brightness/scale
 *  delta. Periodic motions use INTEGER `cycles` so they close seamlessly at p = 1 —
 *  and since ANY whole number of cycles closes at the wrap, `cycles` (1..8) IS the
 *  motion SPEED (the deck ± stepper) with zero seam compromise. The two randomized
 *  motions (twinkle brightness, shake dx/dy) use the keyed PRNG — they are NOISE, not
 *  smooth periodics, so they repeat identically every loop (frame k is a pure function
 *  of its integer index); speed has no periodic meaning for them, so their ± stepper
 *  adjusts `amp` (INTENSITY) instead. `blink` is a phase square wave that toggles at
 *  the same duty every loop (cycles = flashes per loop). `marquee` is intentionally NOT
 *  handled here — it is a wrap-around scroll resolved at the apply step where the node
 *  footprint + scene dims are known (cycles = traversals per loop there). Amp units are
 *  per-type (see below); for the DIRECTIONAL types (marquee/drift/bounce) amp is set by
 *  the on-glass arrow's dragged LENGTH (cells), not a deck control. */
function foldMotion(
  d: MotionDescriptor,
  frame: number,
  frames: number,
  eventId: string,
  rng: SeededRng,
): MotionOut {
  const p = frames > 0 ? frame / frames : 0;
  const ang = 2 * Math.PI * d.cycles * p + 2 * Math.PI * d.phase0;
  const out: MotionOut = { dx: 0, dy: 0, drot: 0, dbright: 0, dscale: 0 };
  switch (d.type) {
    case 'drift': // amp = scene cells
      out.dx = d.amp * d.ax * Math.sin(ang);
      out.dy = d.amp * d.ay * Math.sin(ang);
      break;
    case 'bob': // amp = scene cells
      out.dy = d.amp * Math.sin(ang);
      break;
    case 'parallax': // amp = scene cells (labelled "Orbit" in the UI — an ellipse)
      out.dx = d.amp * d.ax * Math.sin(ang);
      out.dy = d.amp * d.ay * Math.cos(ang);
      break;
    case 'spin': {
      // SPEED = integer `cycles` (the deck ± stepper): drot = 360·cycles·p is a whole
      // number of revolutions at p = 1, so the rotation closes seamlessly (frame 0 ==
      // frame F, mod 360). `amp` is UNUSED for spin — rotation has no amplitude notion;
      // one Speed field (`cycles`) drives every periodic type identically.
      const revs = Math.max(1, Math.round(d.cycles));
      out.drot = 360 * revs * p;
      break;
    }
    case 'pendulum': // amp = swing degrees; sin closes at p=1 for integer cycles
      out.drot = d.amp * Math.sin(ang);
      break;
    case 'bounce': {
      // amp = scene cells; cusp at the floor (|sin|), closes at p=1. DIRECTIONAL:
      // (ax, ay) is the bounce AXIS — the arrow points at the "floor" (default down,
      // (0,1)) and the element bounces OPPOSITE it (displacement along −direction).
      const len = Math.hypot(d.ax, d.ay);
      const bx = len > 1e-9 ? d.ax / len : 0;
      const by = len > 1e-9 ? d.ay / len : 1;
      const k = -d.amp * Math.abs(Math.sin(ang));
      out.dx = k * bx;
      out.dy = k * by;
      break;
    }
    case 'pulse': // amp = % scale swing → dscale in [-amp/100, amp/100]; sin closes at p=1
      out.dscale = (d.amp / 100) * Math.sin(ang);
      break;
    case 'blink': {
      // Phase-fraction square wave (NOT the FP sign of sin) so the duty cycle is
      // stable at the period boundary → frame 0 == frame F for integer cycles.
      const ph = frac(d.cycles * p + d.phase0);
      out.dbright = ph < 0.5 ? 0 : -Math.round(255 * d.amp);
      break;
    }
    case 'twinkle': // keyed-PRNG brightness noise (channel 0) — loop-repeat-identical
      out.dbright = Math.round((rng.value(eventId, frame, 0) - 0.5) * 2 * d.amp * 255);
      break;
    case 'shake': // keyed-PRNG dx/dy noise (channels 1/2) — loop-repeat-identical
      out.dx = (rng.value(eventId, frame, 1) - 0.5) * 2 * d.amp * d.ax;
      out.dy = (rng.value(eventId, frame, 2) - 0.5) * 2 * d.amp * d.ay;
      break;
    case 'marquee':
      break; // resolved at the apply step (needs base placement + footprint + dims)
  }
  return out;
}

/** Options threaded from the render/export callers so the apply step can resolve
 *  layout-dependent motion (marquee) and the object-path loop-close blend. All fields
 *  are OPTIONAL so pure unit tests can call `evaluateScene` without them (marquee then
 *  falls back to a degenerate span — still frame-0 == frame-F — and pathClose is off,
 *  i.e. today's byte-identical behaviour). */
export interface EvaluateOptions {
  /** Scene grid dims (scene cells) — the marquee wrap span basis. */
  dims?: { w: number; h: number };
  /** Native raster dims by assetId; footprint = |scale| × (crop dims ?? native dims). */
  assetDims?: (assetId: string) => { w: number; h: number; per?: number } | undefined;
  /** Object-path loop-close blend (loop meta.pathClose). Default (undefined) = off. */
  pathClose?: boolean;
  /** two-clock: the ABSOLUTE export frame, used ONLY for the audio-feature
   *  lookup (features[absFrame], length T) so reactivity tracks the whole track while
   *  every AUTHORED clock stays on `frame` (= loopFrame). Default (undefined) = the
   *  `frame` arg, i.e. today's single-clock behaviour, byte-identical. */
  absFrame?: number;
  /** The project's beat clock (Group J1) — a tempo-synced motion (`beats` set) reads its
   *  phase from it. Absent = tempo-synced motions fall back to their `cycles`. */
  beat?: BeatClock;
  /** The canvas's modulators (J2: Dot size, Density); layers carry their own (node.mods). */
  canvasMods?: ModMap;
  /** The Whole canvas Motion: the whole picture moving as one, every
   *  layer together about the canvas centre. */
  canvasMotion?: MotionDescriptor | null;
  /** The Whole canvas effects (J5 step 3); their amounts move with `canvasMods`. */
  canvasFx?: LayerFx | null;
  /** Each layer's own loop by node id. Absent =
   *  every layer loops at `frames`. An explicit input like the mutes (preview == export). */
  layerLoops?: Readonly<Record<string, LayerLoop>>;
  /** The canvas Density (scene-wide) — the base a Density modulator moves. */
  dotDensity?: number;
}

/** Marquee wrap-around scroll, resolved at the apply step (it needs the BASE placement,
 *  the node footprint, the scene dims, and F). The element travels along the direction
 *  unit vector u = normalize(ax, ay) — default horizontal — on the line THROUGH ITS BASE
 *  PLACEMENT: the base is the anchor (mid-sweep the element passes its resting spot) and
 *  the perpendicular axis NEVER moves (every point of the travel line shares the base's
 *  perpendicular coordinate by construction).
 *
 *  Seam guarantee at ANY angle θ: the element can only touch the glass while its centre
 *  projects (along u) inside a slab of extent |W·cosθ| + |H·sinθ| + footprint-projection,
 *  centred on the STAGE centre. `m` (the stage-centre offset from the base along u)
 *  shifts the sweep so that slab is always covered no matter where the base sits; ±amp/2
 *  adds the clearance.
 *
 *  SPEED = integer `cycles` c (the deck ± stepper): c full traversals per loop. The span
 *  is stretched by F/(F−c) so EVERY teleport is off-glass: the s-grid point nearest below
 *  any wrap sits at 1 − d/F with d ≤ c, giving t = m + span0/2 + span0·(c−d)/(F−c) ≥
 *  m + span0/2 — always at least amp/2 past the exit edge, for any integer c < F and any
 *  angle (incl. the c−1 interior teleports and the loop-end wrap). Pure fn of
 *  (descriptor, frame, frames, node placement/footprint, dims) — determinism holds. */
function marqueeOffset(
  d: MotionDescriptor,
  frame: number,
  frames: number,
  node: SceneNode,
  opts: EvaluateOptions | undefined,
): { dx: number; dy: number } {
  // Axis-aligned footprint = |scale| × (crop dims ?? native raster dims).
  const a = opts?.assetDims?.(node.assetId);
  // Footprint in squares: raster (or crop) cells over the picture's density (Detail).
  const per = a?.per ?? 1;
  const cw = (node.crop ? node.crop.w : (a?.w ?? 0)) / per;
  const ch = (node.crop ? node.crop.h : (a?.h ?? 0)) / per;
  const fw = Math.abs(node.placement.scaleX) * cw;
  const fh = Math.abs(node.placement.scaleY) * ch;
  // Inside an animation window the window is the stage it scrolls across.
  return marqueeTravel(d, frame, frames, node.placement, fw, fh, opts, node.window);
}

/** The marquee travel of anything based at `base` with an fw × fh footprint: a layer, or
 *  the whole canvas (base = the canvas centre, footprint = the canvas). */
function marqueeTravel(
  d: MotionDescriptor,
  frame: number,
  frames: number,
  base: { x: number; y: number },
  fw: number,
  fh: number,
  opts: EvaluateOptions | undefined,
  stage?: { x: number; y: number; w: number; h: number } | null,
): { dx: number; dy: number } {
  const p = frames > 0 ? frame / frames : 0;
  const c = Math.max(1, Math.round(d.cycles)); // SPEED: integer traversals per loop
  const s = frac(c * p + d.phase0);
  // Direction unit vector; a degenerate (0,0) falls back to horizontal.
  const len = Math.hypot(d.ax, d.ay);
  const ux = len > 1e-9 ? d.ax / len : 1;
  const uy = len > 1e-9 ? d.ay / len : 0;
  const W = stage ? stage.w : (opts?.dims?.w ?? 0);
  const H = stage ? stage.h : (opts?.dims?.h ?? 0);
  const sx = stage ? stage.x : 0;
  const sy = stage ? stage.y : 0;
  // (stage + footprint) extent projected onto the travel direction.
  const proj = (W + fw) * Math.abs(ux) + (H + fh) * Math.abs(uy);
  const amp = Math.max(0, d.amp); // extra off-glass clearance (amp/2 each side)
  // Offset of the stage centre from the base along u — recentres the covered slab on
  // the stage while the travel line stays anchored to the base placement.
  const m = (sx + W / 2 - base.x) * ux + (sy + H / 2 - base.y) * uy;
  const span0 = proj + amp;
  const span = frames > c ? (span0 * frames) / (frames - c) : span0;
  const t = m - span0 / 2 + s * span; // signed travel distance along u from the base
  return { dx: t * ux, dy: t * uy };
}

/** SLOW speeds ("the marquee is still too fast even on speed 1"): a
 *  periodic motion's `cycles` may be ½, ¼ or ⅛ — one cycle every 2, 4 or 8 LOOPS. How
 *  many loops one cycle spans (1 for every whole-number speed and for the noise types,
 *  which have no speed). */
export function motionSpan(d: MotionDescriptor, beat?: BeatClock): number {
  if (d.type === 'twinkle' || d.type === 'shake') return 1;
  if (d.beats && beat) return beatSpanLoops(beat, d.beats);
  if (!(d.cycles > 0 && d.cycles < 1)) return 1;
  return Math.min(8, Math.max(2, 2 ** Math.round(Math.log2(1 / d.cycles))));
}

/** The frames a whole number of every motion's cycles fits in: F × the longest span
 *  (F when nothing is slow). The live clock and the export's Loop length stretch to it,
 *  so a slow motion still loops seamlessly. */
export function motionPeriodFrames(
  frames: number,
  nodes: readonly SceneNode[],
  events: readonly TimedEvent[] = [],
  beat?: BeatClock,
  canvasMods?: ModMap,
  canvasMotion?: MotionDescriptor | null,
): number {
  let k = 1;
  if (canvasMotion) k = motionSpan(canvasMotion, beat);
  for (const n of nodes) if (n.motion) k = Math.max(k, motionSpan(n.motion, beat));
  for (const e of events) if (e.kind === 'motion') k = Math.max(k, motionSpan(e.motion, beat));
  // A Wave longer than the loop (J2) stretches it the same way.
  k = Math.max(k, modSpan([canvasMods, ...nodes.map((n) => n.mods)], beat));
  return Math.max(1, Math.floor(frames)) * k;
}

/** Does any motion read the song's absolute beat (so no two loops look the same)? */
export function hasSongBeatMotion(
  nodes: readonly SceneNode[],
  events: readonly TimedEvent[],
  beat?: BeatClock,
  canvasMods?: ModMap,
  canvasMotion?: MotionDescriptor | null,
): boolean {
  if (!beat?.song) return false;
  const synced = (d: MotionDescriptor) => !!d.beats && d.type !== 'twinkle' && d.type !== 'shake';
  return (
    (!!canvasMotion && synced(canvasMotion)) ||
    nodes.some((n) => !!n.motion && synced(n.motion)) ||
    events.some((e) => e.kind === 'motion' && synced(e.motion)) ||
    hasSongBeatMod([canvasMods, ...nodes.map((n) => n.mods)], beat)
  );
}

/** A slow motion runs on the ABSOLUTE clock over its span of k loops (one cycle in k·F
 *  frames); every other motion is untouched (byte-identical: the loop clock, as is). */
function motionClock(
  d: MotionDescriptor,
  frame: number,
  frames: number,
  absFrame: number | undefined,
  beat: BeatClock | undefined,
  /** Where a slow motion's trip is counted from: the layer's own position.
   *  Absent = the absolute frame. */
  slowPos?: number,
): { d: MotionDescriptor; frame: number; frames: number } {
  // TEMPO-SYNCED (J1): one cycle = `beats` beats on the project's beat clock — the
  // song's time when there is one, else the loop's exact bars (core/tempo).
  if (d.beats && beat && d.type !== 'twinkle' && d.type !== 'shake') {
    const P = d.beats;
    const u = beatAt(beat, absFrame ?? frame);
    const pos = ((u % P) + P) % P;
    const fpb =
      beat.song || beat.loopBeats == null
        ? framesPerBeat(beat.bpm, beat.fps)
        : Math.max(1, beat.frames) / beat.loopBeats;
    return { d: { ...d, cycles: 1 }, frame: pos * fpb, frames: P * fpb };
  }
  const k = motionSpan(d);
  if (k === 1) return { d, frame, frames };
  const P = k * frames;
  const f = slowPos ?? absFrame ?? frame;
  return { d: { ...d, cycles: 1 }, frame: ((f % P) + P) % P, frames: P };
}

const smoothstep = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, e: number): number => a + (b - a) * e;
/** Shortest-arc angle lerp so a recorded path that ends near a wrap (e.g. 350°→10°)
 *  eases the short way home rather than unwinding a near-full turn. */
const lerpAngle = (a: number, b: number, e: number): number =>
  a + (((b - a + 540) % 360) - 180) * e;
const blendPlacement = (a: Placement, b: Placement, e: number): Placement => ({
  x: lerp(a.x, b.x, e),
  y: lerp(a.y, b.y, e),
  scaleX: lerp(a.scaleX, b.scaleX, e),
  scaleY: lerp(a.scaleY, b.scaleY, e),
  rotationDeg: lerpAngle(a.rotationDeg, b.rotationDeg, e),
});

/** Merge ReactionDelta `b` into accumulator `a` (sum numerics, OR invert, sum steps). */
function mergeDelta(a: ReactionDelta, b: ReactionDelta): void {
  if (b.brightness) a.brightness = (a.brightness ?? 0) + b.brightness;
  if (b.contrast) a.contrast = (a.contrast ?? 0) + b.contrast;
  if (b.invert) a.invert = true;
  if (b.paletteStep) a.paletteStep = (a.paletteStep ?? 0) + b.paletteStep;
  if (b.matrixStep) a.matrixStep = (a.matrixStep ?? 0) + b.matrixStep;
  if (b.dx) a.dx = (a.dx ?? 0) + b.dx;
  if (b.dy) a.dy = (a.dy ?? 0) + b.dy;
  if (b.dscale) a.dscale = (a.dscale ?? 0) + b.dscale;
  if (b.dotSize) a.dotSize = (a.dotSize ?? 0) + b.dotSize;
}

const hasDelta = (d: ReactionDelta): boolean =>
  d.brightness != null ||
  d.contrast != null ||
  d.invert != null ||
  d.paletteStep != null ||
  d.matrixStep != null ||
  d.dx != null ||
  d.dy != null ||
  d.dscale != null ||
  d.dotSize != null;

/** Apply an accumulated ReactionDelta on top of a base Look → the changed fields. */
function applyDelta(base: Look, d: ReactionDelta): Partial<Look> {
  const out: Partial<Look> = {};
  if (d.brightness) out.brightness = clamp(base.brightness + d.brightness, -255, 255);
  if (d.contrast) out.contrast = clamp(base.contrast + d.contrast, 0.25, 4);
  if (d.invert) out.invert = !base.invert; // a beat XORs the base invert
  if (d.paletteStep) {
    const i = PALETTE_IDS.indexOf(base.palette);
    const n = PALETTE_IDS.length;
    out.palette = PALETTE_IDS[(((i + d.paletteStep) % n) + n) % n];
  }
  if (d.matrixStep && !isDiffusion(base.matrix)) {
    // MATRIX_IDS = ['none', 2, 4, 8] (ascending fineness). A beat COARSENS the dither
    // ("chunkier"), so step toward a LOWER index (8 → 4 → 2 → none). A diffusion pattern
    // has no coarser step: it stays.
    const i = MATRIX_IDS.indexOf(base.matrix);
    out.matrix = MATRIX_IDS[clamp(i - d.matrixStep, 0, MATRIX_IDS.length - 1)];
  }
  if (d.dotSize)
    out.dotSize = clamp(Math.round(base.dotSize + d.dotSize), HALFTONE_SIZE_MIN, HALFTONE_SIZE_MAX);
  return out;
}

/** Fold a reaction's MOVE part (dx/dy in scene cells, dscale as a fraction) into a
 *  placement. `about` = the point it scales around: the canvas centre for a whole-canvas
 *  pulse (everything swells together), else the node's own centre. */
function applyMove(p: Placement, d: ReactionDelta, about?: { x: number; y: number }): Placement {
  if (!d.dx && !d.dy && !d.dscale) return p;
  const k = 1 + (d.dscale ?? 0);
  const ox = about ? about.x + (p.x - about.x) * k : p.x;
  const oy = about ? about.y + (p.y - about.y) * k : p.y;
  return {
    ...p,
    x: ox + (d.dx ?? 0),
    y: oy + (d.dy ?? 0),
    scaleX: p.scaleX * k,
    scaleY: p.scaleY * k,
  };
}

/** A layer's modulators (J2) folded into its settings for this frame: opacity, a photo's
 *  tone dials, a text layer's Size / Spacing, a visualizer's dials (a noise motion's
 *  Intensity is folded where the motion is). Each moved value is filed in `out`. */
/** Frames per beat for grain Drift: the project's tempo, else the default tempo at 30 fps. */
const driftFpb = (ctx: ModContext): number =>
  ctx.beat ? framesPerBeat(ctx.beat.bpm, ctx.beat.fps) : framesPerBeat(BPM_DEFAULT, 30);

/** How far a layer's grain has drifted by this frame (canvas squares), or null when still. */
function grainOffset(
  n: SceneNode,
  canvasMods: ModMap | undefined,
  ctx: ModContext,
  out: Map<string, number>,
): { x: number; y: number } | null {
  const base = n.look.drift ?? 0;
  const own = n.mods?.drift;
  const m = own ?? canvasMods?.drift;
  if (!base && !m) return null;
  const fpb = driftFpb(ctx);
  const at = Math.max(0, ctx.absFrame);
  let squares: number;
  if (m) {
    const key = modKey(own ? n.id : '', 'drift');
    squares = 0;
    for (let k = 0; k < at; k++)
      squares += modulate('drift', base, m, key, { ...ctx, absFrame: k });
    squares /= fpb;
    out.set(key, modulate('drift', base, m, key, ctx));
  } else squares = (base * at) / fpb;
  const a = ((n.look.driftDir ?? 0) * Math.PI) / 180;
  return { x: squares * Math.cos(a), y: -squares * Math.sin(a) };
}

/** A layer's (or the canvas's) effects with their moving amounts this frame (J5). */
function foldFx(
  src: LayerFx,
  mods: ModMap,
  mod: (param: ModParam, base: number) => number,
): LayerFx {
  const fx = { ...src };
  if (fx.blur && mods['fx.blur']) fx.blur = { radius: mod('fx.blur', fx.blur.radius) };
  if (fx.posterize && mods['fx.posterize'])
    fx.posterize = { steps: mod('fx.posterize', fx.posterize.steps) };
  if (fx.outline && mods['fx.outline'])
    fx.outline = { strength: mod('fx.outline', fx.outline.strength) };
  if (fx.kaleido && (mods['fx.kaleido.wedges'] || mods['fx.kaleido.turn']))
    fx.kaleido = {
      wedges: mod('fx.kaleido.wedges', fx.kaleido.wedges),
      turn: mod('fx.kaleido.turn', fx.kaleido.turn),
    };
  if (fx.wave && (mods['fx.wave.amount'] || mods['fx.wave.size'] || mods['fx.wave.flow']))
    fx.wave = {
      amount: mod('fx.wave.amount', fx.wave.amount),
      size: mod('fx.wave.size', fx.wave.size),
      flow: mod('fx.wave.flow', fx.wave.flow),
    };
  if (fx.trail && (mods['fx.trail.length'] || mods['fx.trail.fade']))
    fx.trail = {
      ...fx.trail,
      length: mod('fx.trail.length', fx.trail.length),
      fade: mod('fx.trail.fade', fx.trail.fade),
    };
  return fx;
}

function applyNodeMods(n: SceneNode, ctx: ModContext, out: Map<string, number>): void {
  const mods = n.mods;
  if (!hasMods(mods)) return;
  const mod = (param: ModParam, base: number): number => {
    const m = mods[param];
    if (!m) return base;
    const v = modulate(param, base, m, modKey(n.id, param), ctx);
    out.set(modKey(n.id, param), v);
    return v;
  };
  if (mods.opacity) n.opacity = mod('opacity', n.opacity ?? 100);
  // The layer's own Look sliders.
  if (mods.dotSize || mods.density || mods.bitSize)
    n.look = {
      ...n.look,
      ...(mods.dotSize && n.look.dotSize !== undefined
        ? { dotSize: mod('dotSize', n.look.dotSize) }
        : {}),
      ...(mods.density && n.look.density !== undefined
        ? { density: mod('density', n.look.density) }
        : {}),
      ...(mods.bitSize && n.look.bitSize !== undefined
        ? { bitSize: mod('bitSize', n.look.bitSize) }
        : {}),
    };
  if (
    n.image &&
    (mods['photo.brightness'] ||
      mods['photo.contrast'] ||
      mods['photo.gamma'] ||
      mods['photo.black'] ||
      mods['photo.white'])
  )
    n.image = {
      ...n.image,
      ...(mods['photo.brightness']
        ? { brightness: mod('photo.brightness', n.image.brightness ?? 0) }
        : {}),
      contrast: mod('photo.contrast', n.image.contrast),
      gamma: mod('photo.gamma', n.image.gamma),
      black: mod('photo.black', n.image.black),
      white: mod('photo.white', n.image.white),
    };
  if (n.fx) n.fx = foldFx(n.fx, mods, mod);
  if (n.text && (mods['text.size'] || mods['text.spacing']))
    n.text = {
      ...n.text,
      size: mod('text.size', n.text.size),
      spacing: mod('text.spacing', n.text.spacing),
    };
  if (n.viz && (mods['viz.gain'] || mods['viz.smooth'] || mods['viz.amount']))
    n.viz = {
      ...n.viz,
      gain: mod('viz.gain', n.viz.gain),
      ...(mods['viz.smooth'] ? { smooth: mod('viz.smooth', n.viz.smooth ?? 0) } : {}),
      ...(mods['viz.amount'] ? { amount: mod('viz.amount', n.viz.amount ?? 0.5) } : {}),
    };
}

/** Deterministic event order: by pass, then id. Returns 0 on full equality so the
 *  comparator is a valid strict weak ordering even if a duplicate id ever slips past
 *  the uniqueness contract (for the same-node placement overwrite, a higher pass wins
 *  — overdub on top). */
function ordered(events: TimedEvent[]): TimedEvent[] {
  return [...events].sort((a, b) =>
    a.pass !== b.pass ? a.pass - b.pass : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * Resolve the timeline at one INTEGER loop `frame` → the node list + scene Look ready
 * for resolveSceneGrid, plus paint-reveal counts and (diagnostic) look deltas.
 * `frames` = F (the canvas loop length). Each LAYER runs on its own clock from the song
 * frame `opts.absFrame`; `frame` / `frames` drive only the
 * scene-global events and the Whole canvas Motion. `features` null in without-audio mode.
 * `opts` (optional) carries the scene dims + asset footprints (marquee wrap) and the
 * object-path loop-close toggle; omitting it keeps today's byte-identical behaviour.
 */
export function evaluateScene(
  baseNodes: SceneNode[],
  baseScene: Look,
  events: TimedEvent[],
  frame: number,
  frames: number,
  features: FeatureArray | null,
  rng: SeededRng,
  mutedLayers: ReadonlySet<number>,
  opts?: EvaluateOptions,
): EvaluatedScene {
  // 1. Clone the base nodes (never mutate the store's arrays/objects).
  const work = new Map<string, SceneNode>();
  for (const n of baseNodes) {
    work.set(n.id, {
      ...n,
      placement: { ...n.placement },
      look: { ...n.look },
      crop: n.crop ? { ...n.crop } : null,
    });
  }

  // 1a. Each layer's own loop clock: the song frame mapped through its clip and
  //     wrapped by its own loop. A layer in a gap has none — it is off this frame. Without
  //     an absolute frame (abs = frame) an untimed layer's clock is `frame` itself.
  const abs = opts?.absFrame ?? frame;
  const clocks = new Map<string, LayerClock>();
  for (const n of baseNodes) {
    const loop = opts?.layerLoops?.[n.id];
    const c = layerClock(n, abs, frames, loop);
    if (c) clocks.set(n.id, n.rec ? recordingClock(c, n.rec, loop?.offset) : c);
  }

  // 1b. Modulators (J2) on the ABSOLUTE frame + the beat clock, like tempo-synced motion.
  const modValues = new Map<string, number>();
  const modCtx: ModContext = {
    absFrame: opts?.absFrame ?? frame,
    frames,
    beat: opts?.beat,
    features,
  };
  const cm = opts?.canvasMods;
  let dotDensity: number | undefined;
  if (cm?.dotSize) {
    const v = modulate('dotSize', baseScene.dotSize, cm.dotSize, modKey('', 'dotSize'), modCtx);
    modValues.set(modKey('', 'dotSize'), v);
    baseScene = { ...baseScene, dotSize: v };
  }
  if (cm?.density && opts?.dotDensity !== undefined) {
    dotDensity = modulate('density', opts.dotDensity, cm.density, modKey('', 'density'), modCtx);
    modValues.set(modKey('', 'density'), dotDensity);
  }
  let bitSize: number | undefined;
  if (cm?.bitSize) {
    bitSize = modulate('bitSize', baseScene.bitSize, cm.bitSize, modKey('', 'bitSize'), modCtx);
    modValues.set(modKey('', 'bitSize'), bitSize);
    baseScene = { ...baseScene, bitSize };
  }
  // A Whole canvas move moves EVERY layer together (each layer keeps its own look,
  // P4): the moving value is every layer's this frame. A layer's own move still wins.
  const canvasLook: LookOverride = {
    ...(cm?.dotSize ? { dotSize: baseScene.dotSize } : {}),
    ...(dotDensity !== undefined ? { density: dotDensity } : {}),
    ...(bitSize !== undefined ? { bitSize } : {}),
  };
  if (Object.keys(canvasLook).length)
    for (const n of work.values()) n.look = { ...n.look, ...canvasLook };
  for (const n of work.values()) applyNodeMods(n, modCtx, modValues);
  // Grain Drift (J6): each layer's grid of bits / dots has slid speed × beats so
  // far; a moving speed (the layer's own ∿, else the Whole canvas's) is summed frame by frame.
  for (const n of work.values()) {
    const g = grainOffset(n, cm, modCtx, modValues);
    if (g) n.grain = g;
  }
  // The Whole canvas effects' moving amounts (J5).
  let canvasFx = opts?.canvasFx ?? undefined;
  if (canvasFx && cm && hasMods(cm))
    canvasFx = foldFx(canvasFx, cm, (param, base) => {
      const m = cm[param];
      if (!m) return base;
      const v = modulate(param, base, m, modKey('', param), modCtx);
      modValues.set(modKey('', param), v);
      return v;
    });

  // 2. Bucket events (deterministic order, active + non-muted only). Position
  //    overwrites (object-static/path) and procedural motion are collected PER NODE so
  //    composition is well-defined and order-independent: the position is the frame's
  //    BASE placement and motion wobbles ON TOP (step 3) — never the reverse, and a
  //    motion event ordered before a position event is no longer silently wiped.
  const positionByNode = new Map<string, Placement>();
  const motionByNode = new Map<string, { motion: MotionDescriptor; eventId: string }>();
  const paintReveal = new Map<string, number>();
  const sceneAccum: ReactionDelta = {};
  const nodeAccum = new Map<string, ReactionDelta>();

  for (const ev of ordered(events)) {
    if (mutedLayers.has(ev.layer)) continue;
    // A layer's events replay on its own loop clock; a scene-global one ('')
    // on the canvas loop. A layer that is off (or gone) this frame plays nothing.
    let fr = frame;
    let frs = frames;
    const c = ev.nodeId !== '' ? clocks.get(ev.nodeId) : undefined;
    if (c) {
      // A recording's Hold / backwards moves its strokes + hand moves only.
      fr = ev.kind === 'motion' || ev.kind === 'audio-react' ? c.frame : (c.replay ?? c.frame);
      frs = c.frames;
    } else if (ev.nodeId !== '' && baseNodes.some((n) => n.id === ev.nodeId)) continue;
    let held = !!c?.held;
    if (ev.part && c) {
      const m = partFrame(ev.part, fr);
      if (!m) continue; // off its window on the merged recording
      fr = m.frame;
      frs = m.frames;
      held = held || m.held;
    }
    if (ev.kind === 'paint-reveal') {
      // Coverage is monotonic in frame; count stamps laid at or before this frame
      // (the [start,end] window only marks when authoring began). A blink stamp
      // outside its visibility window contributes 0. Counts ACCUMULATE per asset
      // so a hidden blink event can't zero out a persistent event's count.
      let count = 0;
      if (
        !(held && ev.holdFrames != null) &&
        paintWindowVisible(ev.startFrame, ev.endFrame, ev.holdFrames, fr, frs)
      ) {
        for (const s of ev.stamps) if (s.frame <= fr) count++;
      }
      paintReveal.set(ev.assetId, (paintReveal.get(ev.assetId) ?? 0) + count);
      continue;
    }
    if (fr < ev.startFrame || fr > ev.endFrame) continue; // outside this event's window
    switch (ev.kind) {
      case 'object-static':
        positionByNode.set(ev.nodeId, ev.placement); // last (highest-pass) wins
        break;
      case 'object-path': {
        if (ev.samples.length === 0) break;
        // Capture is frame-quantized, so `rel` is an integer index into samples.
        // Linear interp for loop RE-timing is a later refinement (`ev.interp`, P5).
        const rel = clamp(fr - ev.startFrame, 0, ev.samples.length - 1);
        let sampled = ev.samples[rel];
        // LOOP-CLOSE blend (H-A0, opt-in via meta.pathClose): over the final ~0.5s of
        // the loop, smoothstep the sampled placement back toward the path's FIRST
        // sample so frame F−1 lands adjacent to frame 0 (no wrap teleport). Window =
        // min(15, ceil(F·0.1)) frames (≈0.5s at 30fps, capped so long loops don't over-
        // blend). Non-destructive — `ev.samples` is never rewritten (mute/undo intact).
        if (opts?.pathClose && frs > 1 && !held) {
          const win = Math.min(15, Math.max(1, Math.ceil(frs * 0.1)));
          const wrapStart = frs - win;
          if (fr >= wrapStart) {
            const e = smoothstep((fr - wrapStart) / win);
            sampled = blendPlacement(sampled, ev.samples[0], e);
          }
        }
        positionByNode.set(ev.nodeId, sampled);
        break;
      }
      case 'motion':
        motionByNode.set(ev.nodeId, { motion: ev.motion, eventId: ev.id }); // canonical
        break;
      case 'audio-react': {
        // Features index the ABSOLUTE frame; absFrame defaults to `frame`.
        const delta = reactionDelta(ev, features, abs);
        if (!hasDelta(delta)) break;
        if (ev.nodeId === '') {
          mergeDelta(sceneAccum, delta);
        } else {
          const acc = nodeAccum.get(ev.nodeId) ?? {};
          mergeDelta(acc, delta);
          nodeAccum.set(ev.nodeId, acc);
        }
        break;
      }
    }
  }

  // 3. Apply per node: the position overwrite is the frame's BASE placement; then
  //    procedural motion folds ON TOP (additive). A canonical MotionEvent SUPPRESSES
  //    the node.motion convenience mirror for that node (never double-apply).
  for (const n of work.values()) {
    const pos = positionByNode.get(n.id);
    if (pos) n.placement = { ...pos };
    const mEvt = motionByNode.get(n.id);
    let motion = mEvt ? mEvt.motion : n.motion;
    // A noise motion's Intensity can be modulated (J2) — its only slider.
    const ampMod = n.mods?.['motion.amp'];
    if (motion && ampMod && (motion.type === 'twinkle' || motion.type === 'shake')) {
      const k = modKey(n.id, 'motion.amp');
      motion = { ...motion, amp: modulate('motion.amp', motion.amp, ampMod, k, modCtx) };
      modValues.set(k, motion.amp);
    }
    const lc = clocks.get(n.id);
    if (motion && lc) {
      // The layer's own loop clock; slow speeds count whole trips from the
      // layer's own position, tempo-synced ones read the song's beat (motionClock).
      const ml = n.rec?.motionLoop;
      const mp = ml ? lc.pos - ml.at : lc.pos;
      const mf = ml ? ((mp % ml.frames) + ml.frames) % ml.frames : lc.frame;
      const mc = motionClock(
        motion,
        mf,
        ml ? ml.frames : lc.frames,
        opts?.absFrame,
        opts?.beat,
        mp,
      );
      if (mc.d.type === 'marquee') {
        // Wrap-around scroll: resolved here (needs base placement + footprint + dims).
        const off = marqueeOffset(mc.d, mc.frame, mc.frames, n, opts);
        n.placement.x += off.dx;
        n.placement.y += off.dy;
      } else {
        const m = foldMotion(mc.d, mc.frame, mc.frames, mEvt ? mEvt.eventId : n.id, rng);
        n.placement.x += m.dx;
        n.placement.y += m.dy;
        n.placement.rotationDeg += m.drot;
        if (m.dscale) {
          n.placement.scaleX *= 1 + m.dscale;
          n.placement.scaleY *= 1 + m.dscale;
        }
        if (m.dbright)
          n.look = {
            ...n.look,
            brightness: clamp((n.look.brightness ?? baseScene.brightness) + m.dbright, -255, 255),
          };
      }
    }
  }

  // 3b. The Whole canvas Motion: the whole picture moves as one — every layer turns, grows
  //     and travels together about the canvas centre, on top of its own motion.
  let cmo = opts?.canvasMotion;
  const cAmp = cm?.['motion.amp'];
  if (cmo && cAmp && (cmo.type === 'twinkle' || cmo.type === 'shake')) {
    const k = modKey('', 'motion.amp');
    cmo = { ...cmo, amp: modulate('motion.amp', cmo.amp, cAmp, k, modCtx) };
    modValues.set(k, cmo.amp);
  }
  if (cmo && work.size) {
    const W = opts?.dims?.w ?? 0;
    const H = opts?.dims?.h ?? 0;
    const cx = W / 2;
    const cy = H / 2;
    const mc = motionClock(cmo, frame, frames, opts?.absFrame, opts?.beat);
    const m =
      mc.d.type === 'marquee'
        ? {
            ...marqueeTravel(mc.d, mc.frame, mc.frames, { x: cx, y: cy }, W, H, opts),
            drot: 0,
            dscale: 0,
            dbright: 0,
          }
        : foldMotion(mc.d, mc.frame, mc.frames, CANVAS_MOTION_KEY, rng);
    const k = 1 + m.dscale;
    const rad = (m.drot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const n of work.values()) {
      const ox = (n.placement.x - cx) * k;
      const oy = (n.placement.y - cy) * k;
      n.placement.x = cx + ox * cos - oy * sin + m.dx;
      n.placement.y = cy + ox * sin + oy * cos + m.dy;
      n.placement.rotationDeg += m.drot;
      n.placement.scaleX *= k;
      n.placement.scaleY *= k;
      if (m.dbright)
        n.look = {
          ...n.look,
          brightness: clamp((n.look.brightness ?? baseScene.brightness) + m.dbright, -255, 255),
        };
    }
  }

  // 4. Fold audio-react deltas into the scene Look + per-node look overrides.
  let scene: Look = baseScene;
  const sceneLookDelta = applyDelta(baseScene, sceneAccum);
  if (Object.keys(sceneLookDelta).length) {
    scene = { ...baseScene, ...sceneLookDelta };
    // A whole-canvas reaction reaches every layer, measured from each layer's own look.
    for (const n of work.values()) {
      const d = applyDelta({ ...baseScene, ...n.look }, sceneAccum);
      if (Object.keys(d).length) n.look = { ...n.look, ...(d as LookOverride) };
    }
  }

  // MOVE reactions: a layer's own (about its centre), then the whole canvas's (everything
  // together, about the canvas centre) — on top of the frame's position + motion.
  const centre = opts?.dims ? { x: opts.dims.w / 2, y: opts.dims.h / 2 } : undefined;
  for (const n of work.values()) {
    const own = nodeAccum.get(n.id);
    if (own) n.placement = applyMove(n.placement, own);
    n.placement = applyMove(n.placement, sceneAccum, centre ?? n.placement);
  }

  const nodeLookDelta = new Map<string, Partial<Look>>();
  for (const [nodeId, acc] of nodeAccum) {
    const n = work.get(nodeId);
    if (!n) continue;
    const effectiveBase: Look = { ...scene, ...n.look };
    const delta = applyDelta(effectiveBase, acc);
    if (Object.keys(delta).length) {
      n.look = { ...n.look, ...(delta as LookOverride) };
      nodeLookDelta.set(nodeId, delta);
    }
  }

  // Preserve the base node order (the resolver sorts by z anyway). A TIMED layer (3b)
  // is only present inside its clips — the same rule live, scrubbed and exported.
  const nodes = baseNodes
    .map((n) => work.get(n.id))
    .filter((n): n is SceneNode => !!n && visibleAt(n.clips, abs))
    // A clip's fade in / out (3c) scales the layer's opacity — the same pre-dither
    // blend opacity already uses, so a fade is an ink-density ramp, never a pixel wipe.
    .map((n) => {
      const g = fadeGainAt(n.clips, abs);
      return g < 1 ? { ...n, opacity: Math.round((n.opacity ?? 100) * g) } : n;
    });
  return {
    nodes,
    scene,
    paintReveal,
    sceneLookDelta,
    nodeLookDelta,
    modValues,
    clocks,
    ...(dotDensity !== undefined ? { dotDensity } : {}),
    ...(canvasFx ? { canvasFx } : {}),
  };
}

function copyAsset(a: CachedAsset): CachedAsset {
  // Keep the Detail density: a Fine recording's raster holds 2× the values per square, and
  // without `per` the renderer would draw it twice as big, its strokes off where they were drawn.
  return {
    w: a.w,
    h: a.h,
    tones: a.tones.slice(),
    covered: a.covered.slice(),
    ...(a.per ? { per: a.per } : {}),
  };
}

/**
 * Build the per-frame asset map for paint-reveal (E4 animate-in / overdub). For each
 * paint:<n> layer that has reveal events (or a live in-progress capture), produce a
 * SCRATCH CachedAsset = a COPY of the base raster with the dab stamps laid at or
 * before `frame` replayed via the shared brush (raster-brush.stampDab). The base
 * raster in the cache is NEVER mutated, so the stroke draws-in deterministically each
 * loop without ever crawling (it's a pre-dither tone source dithered later by the
 * resolver). Unaffected layers fall through to the base cache (same Map ref returned
 * when nothing is affected → zero per-frame copies in the common case).
 *
 * `live` is the in-progress overdub stroke (preview only — its stamps show in full so
 * the performer sees the brush). It is NEVER passed in the export path, so determinism
 * holds: the export replays only committed events at the integer virtual clock.
 */
export function applyPaintReveal(
  baseAssets: Map<string, CachedAsset>,
  events: TimedEvent[],
  frame: number,
  frames: number,
  mutedLayers: ReadonlySet<number>,
  live?: { assetId: string; stamps: DabStamp[] } | null,
  /** Each layer's own loop clock: a stroke replays on
   *  its layer's clock. Absent (or no clock for the layer) = `frame` / `frames`. */
  clockOf?: (
    nodeId: string,
  ) => { frame: number; frames: number; replay?: number; held?: boolean } | undefined,
): Map<string, CachedAsset> {
  const byAsset = new Map<string, PaintRevealEvent[]>();
  for (const ev of events) {
    if (ev.kind !== 'paint-reveal' || mutedLayers.has(ev.layer)) continue;
    const arr = byAsset.get(ev.assetId);
    if (arr) arr.push(ev);
    else byAsset.set(ev.assetId, [ev]);
  }
  const affected = new Set<string>(byAsset.keys());
  if (live) affected.add(live.assetId);
  if (affected.size === 0) return baseAssets; // nothing to reveal — no copy

  const merged = new Map(baseAssets);
  const replay = (scratch: CachedAsset, s: DabStamp): void =>
    stampDab(scratch, s.x, s.y, {
      tool: s.erase ? 'eraser' : 'brush',
      size: s.r,
      shade: s.shade,
    });

  for (const assetId of affected) {
    const base = baseAssets.get(assetId);
    if (!base) continue;
    const scratch = copyAsset(base);
    // Committed reveal events: replay (in commit order) every stamp laid by this
    // frame — skipping blink events outside their visibility window (the scratch
    // is rebuilt from the base every call, so expiry needs no erasing).
    for (const ev of byAsset.get(assetId) ?? []) {
      const c = clockOf?.(ev.nodeId);
      let fr = c ? (c.replay ?? c.frame) : frame;
      let frs = c ? c.frames : frames;
      let held = !!c?.held;
      if (ev.part && c) {
        const m = partFrame(ev.part, fr);
        if (!m) continue; // off its window on the merged recording
        fr = m.frame;
        frs = m.frames;
        held = held || m.held;
      }
      if (held && ev.holdFrames != null) continue; // flashes are not in the held picture
      if (!paintWindowVisible(ev.startFrame, ev.endFrame, ev.holdFrames, fr, frs)) continue;
      for (const s of ev.stamps) if (s.frame <= fr) replay(scratch, s);
    }
    // The live in-progress stroke (preview only): show it in full.
    if (live && live.assetId === assetId) for (const s of live.stamps) replay(scratch, s);
    merged.set(assetId, scratch);
  }
  return merged;
}
