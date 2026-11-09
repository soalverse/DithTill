// =============================================================================
// Merging recordings: one recording afterwards that LOOKS the same as the two
// did apart. PURE: plain data in, plain data out; no store, no wall clock.
//
// The merged recording has one bar (earliest start → latest end) and one loop as long as that bar.
// Every event keeps its own frames and gains a `part`: where it plays on the merged recording's
// clock and how that maps back to the clock it was recorded on. So a 1-bar O keeps redrawing and a
// W at 4–7 s shows then and is gone, in one row (the merged one Repeats). If the merged-into one
// Holds, the other's strokes draw in when they were drawn and stay, and the drawn part reaches
// them (a part with `hold`). The other's own Hold does not come along: it shows for its drawn part.
// =============================================================================
import type { EventPart, LayerLoop, TimedEvent } from './loop-events';
import { clipEnd, clipSpeed, drawnEnd, type TimelineClip } from './timeline-edit';
import type { Placement, RecordingPlay } from '../state/scene-store';

export interface MergeSide {
  id: string;
  assetId: string;
  clips?: TimelineClip[];
  loop?: LayerLoop;
  rec?: RecordingPlay;
  placement: Placement;
  /** Its raster's size + density (strokes move between the two rasters' cells). */
  raster: { w: number; h: number; per?: number };
  events: TimedEvent[];
}

export interface MergeResult {
  clip: TimelineClip;
  loop: LayerLoop;
  rec: RecordingPlay;
  /** The merged-into recording's events, as they now are. */
  into: TimedEvent[];
  /** The other's strokes, re-keyed onto the merged-into recording. */
  joined: TimedEvent[];
  /** Its takes' new numbers (old pass → new), so a muted take stays muted. */
  passes: ReadonlyMap<number, number>;
}

/** Numbers takes afresh past `topPass`, the same old pass always getting the same new one. */
export function passRenumber(topPass: number): {
  next: (pass: number) => number;
  passes: ReadonlyMap<number, number>;
} {
  const passes = new Map<number, number>();
  return {
    passes,
    next: (pass) => {
      let n = passes.get(pass);
      if (n === undefined) {
        n = topPass + 1 + passes.size;
        passes.set(pass, n);
      }
      return n;
    },
  };
}

/** A part's window never ends: its strokes stay until the merged recording's bar does. */
const FOREVER = 1e9;

const barOf = (s: MergeSide, videoFrames: number): TimelineClip[] =>
  s.clips?.length ? s.clips : [{ id: `${s.id}-all`, start: 0, duration: videoFrames, sourceIn: 0 }];

/** Add a piece of a bar to an event's clock, around any part it already has. */
const withPart = (e: TimedEvent, part: EventPart): TimedEvent => ({
  ...e,
  part: e.part ? { ...part, inner: e.part } : part,
});

/** A stroke's cell in `from`'s raster → the same place on the canvas in `to`'s raster. */
function moveCell(
  x: number,
  y: number,
  from: MergeSide,
  to: MergeSide,
): { x: number; y: number; scale: number } {
  const perF = from.raster.per ?? 1;
  const perT = to.raster.per ?? 1;
  const a = from.placement;
  const b = to.placement;
  const ra = (a.rotationDeg * Math.PI) / 180;
  const ex = ((x - from.raster.w / 2) * a.scaleX) / perF;
  const ey = ((y - from.raster.h / 2) * a.scaleY) / perF;
  const sx = a.x + ex * Math.cos(ra) - ey * Math.sin(ra);
  const sy = a.y + ex * Math.sin(ra) + ey * Math.cos(ra);
  const rb = (-b.rotationDeg * Math.PI) / 180;
  const dx = sx - b.x;
  const dy = sy - b.y;
  const sa = (Math.abs(a.scaleX) + Math.abs(a.scaleY)) / 2 || 1;
  const sb = (Math.abs(b.scaleX) + Math.abs(b.scaleY)) / 2 || 1;
  return {
    x: to.raster.w / 2 + ((dx * Math.cos(rb) - dy * Math.sin(rb)) * perT) / (b.scaleX || 1e-6),
    y: to.raster.h / 2 + ((dx * Math.sin(rb) + dy * Math.cos(rb)) * perT) / (b.scaleY || 1e-6),
    scale: ((sa / perF) * perT) / sb,
  };
}

/** The other recording's strokes (only strokes: its hand moves + effects stay behind) keyed to
 *  `into`, its takes renumbered past `topPass`. */
function joinStrokes(
  other: MergeSide,
  into: MergeSide,
  next: (pass: number) => number,
): TimedEvent[] {
  const same =
    other.placement.x === into.placement.x &&
    other.placement.y === into.placement.y &&
    other.placement.scaleX === into.placement.scaleX &&
    other.placement.scaleY === into.placement.scaleY &&
    other.placement.rotationDeg === into.placement.rotationDeg &&
    other.raster.w === into.raster.w &&
    other.raster.h === into.raster.h &&
    (other.raster.per ?? 1) === (into.raster.per ?? 1);
  const out: TimedEvent[] = [];
  for (const e of other.events) {
    if (e.kind !== 'paint-reveal') continue;
    const pass = next(e.pass);
    out.push({
      ...e,
      nodeId: into.id,
      assetId: into.assetId,
      pass,
      layer: pass,
      stamps: same
        ? e.stamps
        : e.stamps.map((s) => {
            const c = moveCell(s.x, s.y, other, into);
            return { ...s, x: c.x, y: c.y, r: s.r * c.scale };
          }),
    });
  }
  return out;
}

/** One piece (clip) of a side's bar as a part on the merged clock, which starts at `u0`. */
function pieceOf(c: TimelineClip, s: MergeSide, u0: number, F: number, back: boolean): EventPart {
  return {
    at: c.start - u0,
    len: c.duration,
    from: c.sourceIn,
    rate: clipSpeed(c),
    frames: s.loop?.frames ?? F,
    ...(s.loop?.offset ? { offset: s.loop.offset } : {}),
    ...(back ? { back: true } : {}),
  };
}

/** Each event repeated for each piece of its bar: one event, one clock, ids never shared. */
function spread(events: TimedEvent[], pieces: EventPart[], taken: Set<string>): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const e of events) {
    if (e.kind === 'motion' || e.kind === 'audio-react') {
      out.push(e);
      continue;
    }
    pieces.forEach((p, i) => {
      let id = e.id;
      for (let k = i; k > 0 && taken.has(id); k++) id = `${e.id}.${k}`;
      taken.add(id);
      out.push(withPart({ ...e, id }, p));
    });
  }
  return out;
}

/** Merge `other` into `into`. `F` = the canvas loop; `videoFrames` = the
 *  video's length (a bar for a recording with none); `topPass` = the highest pass in the log. */
export function mergeRecordings(
  into: MergeSide,
  other: MergeSide,
  F: number,
  videoFrames: number,
  topPass: number,
): MergeResult {
  const barA = barOf(into, videoFrames);
  const barB = barOf(other, videoFrames);
  const seamA = into.loop ? drawnEnd(barA, into.loop) : null;
  const seamB = other.loop ? drawnEnd(barB, other.loop) : null;
  const endA = Math.max(...barA.map(clipEnd));
  const endB = Math.max(...barB.map(clipEnd));
  // Where the other's drawn part ends: its own Hold or repeats past that don't count for a Hold
  // merge, and its Hold doesn't come along (it ends there) for a Repeat merge.
  const drawnB = seamB ? seamB.at : endB;
  const u0 = Math.min(...barA.map((c) => c.start), ...barB.map((c) => c.start));

  const { next, passes } = passRenumber(topPass);
  const joined = joinStrokes(other, into, next);
  const taken = new Set([...into.events, ...other.events].map((e) => e.id));
  const keep = into.events;
  const first = barA[0];
  const last = barA[barA.length - 1];
  // Its Motion keeps the clock it had: the merged loop is longer.
  const motionAt = first.start - u0 - first.sourceIn + (into.loop?.offset ?? 0);
  const motionLoop = into.rec?.motionLoop
    ? { ...into.rec.motionLoop, at: into.rec.motionLoop.at + first.start - u0 }
    : { frames: into.loop?.frames ?? F, at: motionAt };
  const fades = {
    ...(first.fadeIn ? { fadeIn: first.fadeIn } : {}),
    ...(last.fadeOut ? { fadeOut: last.fadeOut } : {}),
  };

  if (into.rec?.hold) {
    const u1 = Math.max(endA, drawnB);
    const drawnA = seamA ? seamA.at : endA;
    const D = Math.max(1, Math.round(Math.max(drawnA, drawnB) - u0));
    const piecesA = barA.map((c, i) => ({
      ...pieceOf(c, into, u0, F, false),
      hold: true,
      ...(i === barA.length - 1 ? { len: FOREVER } : {}),
    }));
    const pieceB: EventPart = {
      ...pieceOf(barB[0], other, u0, F, false),
      hold: true,
      len: FOREVER,
    };
    return {
      clip: { id: first.id, start: u0, duration: u1 - u0, sourceIn: 0, ...fades },
      loop: { frames: D, free: true },
      rec: { ...into.rec, motionLoop },
      into: spread(keep, piecesA, taken),
      joined: spread(joined, [pieceB], taken),
      passes,
    };
  }

  // Repeat: nothing on screen changes. Each piece plays in its window, on its own clock.
  const piecesA = barA.map((c) => pieceOf(c, into, u0, F, !!into.rec?.backwards));
  const piecesB: EventPart[] = [];
  for (const c of barB) {
    if (other.rec?.hold && seamB) {
      if (c.start >= drawnB) continue;
      const part = pieceOf(c, other, u0, F, !!other.rec.backwards);
      piecesB.push({ ...part, len: Math.min(c.duration, drawnB - c.start) });
    } else piecesB.push(pieceOf(c, other, u0, F, !!other.rec?.backwards));
  }
  const u1 = Math.max(endA, other.rec?.hold ? drawnB : endB);
  const D = Math.max(1, Math.round(u1 - u0));
  return {
    clip: { id: first.id, start: u0, duration: D, sourceIn: 0, ...fades },
    loop: { frames: D, free: true },
    rec: { motionLoop },
    into: spread(keep, piecesA, taken),
    joined: spread(joined, piecesB, taken),
    passes,
  };
}
