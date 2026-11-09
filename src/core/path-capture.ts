// =============================================================================
// Object-path capture (E5, the loop-flow pass) — the PURE half of "drag an
// element while recording and the loop replays its movement". SceneStage feeds
// pointer-drag placements in here per rAF; the module quantizes them onto
// INTEGER loop frames (monotonic + wrap-pinned, mirroring paint's captureSeg)
// and finishes into the EXISTING TimedEvent shapes that evaluateScene already
// replays and tests cover:
//   - a >1-frame gesture → ObjectPathEvent  (samples[i] = placement at start+i)
//   - a ≤1-frame gesture → ObjectStaticEvent held to the loop end ("place this
//     element on this beat")
// No DOM, no Konva, no wall-clock — unit-testable and deterministic.
// =============================================================================
import type { Placement } from '../state/scene-store';
import type { ObjectPathEvent, ObjectStaticEvent } from './loop-events';

export interface PathCapture {
  nodeId: string;
  pass: number;
  startFrame: number;
  /** Monotonic max frame seen (wrap-pinned like paint's captureSeg). */
  lastFrame: number;
  /** samples[frame - startFrame]; holes (pointer held still across frames) are
   *  filled forward on finish (hold semantics). */
  samples: (Placement | undefined)[];
}

export function beginPathCapture(nodeId: string, pass: number, frame: number): PathCapture {
  return { nodeId, pass, startFrame: frame, lastFrame: frame, samples: [] };
}

/** Record `placement` at the current raw loop frame. Wrap pinning: once the live
 *  phase wraps past the loop end mid-drag, the tail pins to F-1 so the stored
 *  samples stay ONE ascending run. Re-samples on the same frame overwrite (the
 *  latest position within a frame wins). */
export function samplePath(
  cap: PathCapture,
  rawFrame: number,
  frames: number,
  placement: Placement,
): void {
  let frame = rawFrame;
  if (frame < cap.startFrame) frame = frames - 1; // phase wrapped mid-drag
  frame = Math.max(cap.lastFrame, frame);
  cap.lastFrame = frame;
  cap.samples[frame - cap.startFrame] = { ...placement };
}

/** Close the capture into a committed event (or null if nothing was sampled).
 *  Holes fill forward (hold). A gesture spanning ≤1 frame becomes an
 *  ObjectStaticEvent holding its final placement to the loop end. */
export function finishPathCapture(
  cap: PathCapture,
  frames: number,
  id: string,
): ObjectPathEvent | ObjectStaticEvent | null {
  const filled: Placement[] = [];
  let last: Placement | undefined;
  for (let i = 0; i < cap.samples.length; i++) {
    const s = cap.samples[i] ?? last;
    if (!s) continue; // cannot happen after the first sample; guards an empty run
    filled.push(s);
    last = s;
  }
  if (!last) return null;

  const base = {
    id,
    nodeId: cap.nodeId,
    pass: cap.pass,
    layer: cap.pass,
  };
  if (filled.length <= 2) {
    // A click/short-nudge: place the element here from this beat to the loop end.
    return {
      ...base,
      kind: 'object-static',
      startFrame: cap.startFrame,
      endFrame: frames,
      placement: { ...last },
    };
  }
  return {
    ...base,
    kind: 'object-path',
    startFrame: cap.startFrame,
    endFrame: cap.startFrame + filled.length - 1,
    samples: filled,
    interp: 'hold',
  };
}
