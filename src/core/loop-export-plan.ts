// =============================================================================
// PURE planning for the long export walk ("export length != loop
// length"). Holds the branch decision the deterministic exporter
// (platform/loop-export.ts) makes, so vitest can pin it without the codec: whether
// the scene is CYCLE-IDENTICAL and so the render-once-and-repeat fast path applies
// (D4 — the encoder repeats one rendered cycle). The D3 walk needs no plan since
// frames stream straight into the encoder, so there are no chunks to
// bound. No I/O, no wall clock — plain data in, a plan out.
// =============================================================================
import {
  hasSongBeatMotion,
  motionPeriodFrames,
  type LayerLoop,
  type TimedEvent,
} from './loop-events';
import type { BeatClock } from './tempo';
import { hasDrawnMod, hasSoundMod, type ModMap } from './modulators';
import type { FeatureArray } from './audio-features';
import type { MotionDescriptor, SceneNode } from '../state/scene-store';

/** The plain-data inputs the fast-path predicate inspects (all already on the
 *  export input — passed as primitives/arrays so the rule is unit-testable). */
export interface FastPathInputs {
  /** T — the absolute export length in frames. */
  totalFrames: number;
  /** F — the authoring loop length in frames. */
  frames: number;
  /** The merged event log (overdubs + reactions), as the caller folds them. */
  events: readonly TimedEvent[];
  /** The scene nodes — a `kind:'visualizer'` node reads features[absFrame]. */
  nodes: readonly SceneNode[];
  /** The frame-indexed audio features (length T), or null in without-audio mode. */
  features: FeatureArray | null;
  /** Each placed video clip's INTEGER frame count (rec.frameCount). */
  videoFrameCounts: readonly number[];
  /** The project's beat clock (J1); absent = no tempo-synced motion is honoured. */
  beat?: BeatClock;
  /** The canvas's modulators (J2); layers carry their own on the nodes. */
  canvasMods?: ModMap;
  /** The Whole canvas Motion. */
  canvasMotion?: MotionDescriptor | null;
  /** Each layer's own loop. */
  layerLoops?: Readonly<Record<string, LayerLoop>>;
}

/**
 * The render-once-and-repeat fast path (D4) is eligible only when every loop
 * cycle renders PIXEL-IDENTICALLY, so one rendered cycle can be stream-copied N
 * times (plus a trimmed tail). That holds when T > F AND nothing in the scene
 * reads the ABSOLUTE frame:
 *   - no `audio-react` event is bound (reactions read features[absFrame]);
 *   - every placed video's footage fits the loop a whole number of times (videos play
 *     on song time, so any other length shows a different stretch per cycle);
 *   - no layer has clips on the song or its own loop length;
 *   - no visualizer node while features are present (a visualizer reads
 *     features[absFrame] even with no audio-react event bound, breaking cycle
 *     identity; with null features it is deterministic per loopFrame, so it stays
 *     eligible);
 *   - no SLOW motion (½×, ¼×, ⅛× — one cycle over several loops, read on the absolute
 *     clock);
 *   - no drawn line (J2b — it runs across the whole video on the absolute frame).
 * Cheap to decide — the event log, node list and clip lengths are all data.
 */
export function fastPathEligible(i: FastPathInputs): boolean {
  if (i.totalFrames <= i.frames) return false; // T == F is today's single-pass path
  if (i.events.some((e) => e.kind === 'audio-react')) return false;
  // A video plays its footage on song time: the loops look alike only when the
  // footage fits the loop a whole number of times.
  if (i.videoFrameCounts.some((fc) => fc > i.frames || i.frames % Math.max(1, fc) !== 0))
    return false;
  // A layer placed on the song (clips) or with its own loop length runs on its own clock.
  if (i.nodes.some((n) => n.clips || n.kind === 'recording')) return false;
  if (Object.values(i.layerLoops ?? {}).some((l) => l.frames !== i.frames || l.offset))
    return false;
  if (i.features != null && i.nodes.some((n) => n.kind === 'visualizer')) return false;
  // Follow sound (J2) reads features[absFrame], like a reaction.
  if (i.features != null && hasSoundMod([i.canvasMods, ...i.nodes.map((n) => n.mods)]))
    return false;
  // A drifting grain (J6) keeps travelling, so no two loops look the same.
  if (i.nodes.some((n) => n.look.drift || n.mods?.drift) || i.canvasMods?.drift) return false;
  // A drawn line (J2b) runs across the whole video, so no two loops look the same.
  if (hasDrawnMod([i.canvasMods, ...i.nodes.map((n) => n.mods)])) return false;
  // A slow motion / long Wave (one trip every 2–8 loops) shows a different stretch each loop.
  if (
    motionPeriodFrames(i.frames, i.nodes, i.events, i.beat, i.canvasMods, i.canvasMotion) > i.frames
  )
    return false;
  // A tempo-synced motion or Wave on a SONG's beat drifts against the loop (no two alike).
  if (hasSongBeatMotion(i.nodes, i.events, i.beat, i.canvasMods, i.canvasMotion)) return false;
  return true;
}
