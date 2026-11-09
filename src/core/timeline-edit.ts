// =============================================================================
// Timeline edit algebra — PORTED from FilmCraft's `filmcraft-edit`
// (storytold/filmcraft, MIT OR Apache-2.0), which follows Premiere Pro's semantics.
// One DithTill layer is one TRACK; its `clips` are the track items. A clip is a span of
// timeline frames [start, start + duration) showing media from `sourceIn` at `speed`
// (media frame at timeline frame t = sourceIn + floor((t − start) · speed)), with
// optional fade in / out (frames) at its ends.
//
// The same guarantees as the original:
//   - every edit validates first and applies WHOLE, or returns the input unchanged;
//   - clips on a track never overlap, are never shorter than one frame, and never START
//     outside their media (`media` = frames available; null = a still, unlimited). One
//     deviation: a clip may run past the END of its media — the footage (or the
//     layer's loop) repeats, so dragging an edge out makes it play more times;
//   - splits keep the picture continuous (the right piece's sourceIn advances by the
//     media the left piece used: round(cut · speed), FilmCraft's `src_of`).
// Integer frames of SONG time throughout, like FilmCraft's integer ticks.
// Pure + deterministic — no DOM, no stores.
// =============================================================================

export interface TimelineClip {
  id: string;
  /** First timeline frame (loop frame) the clip shows on. */
  start: number;
  /** Length in frames (≥ 1). */
  duration: number;
  /** Media frame shown at `start` (0 for stills). */
  sourceIn: number;
  /** Playback speed (3c; absent = 1). 2 = twice as fast, 0.5 = slow motion. */
  speed?: number;
  /** Fade in / fade out length in frames (3c; absent = 0), applied to opacity + sound. */
  fadeIn?: number;
  fadeOut?: number;
}

/** Frames of media a layer has: a video's frame count, or null for a still/drawing. */
export type MediaLen = number | null;

export type Edge = 'in' | 'out';

export const MIN_DURATION = 1;
/** Speed limits for presets and rate stretch (FilmCraft refuses non-positive speeds). */
export const SPEED_MIN = 1 / 16;
export const SPEED_MAX = 16;

export const clipEnd = (c: TimelineClip): number => c.start + c.duration;
export const clipSpeed = (c: TimelineClip): number => c.speed ?? 1;
/** Media frames a timeline span uses at a speed (FilmCraft `src_of`). */
const srcOf = (dur: number, speed: number): number => Math.round(dur * speed);
/** The first media frame AFTER the clip (FilmCraft `source_out`). */
export const sourceOut = (c: TimelineClip): number => c.sourceIn + srcOf(c.duration, clipSpeed(c));

const sorted = (clips: readonly TimelineClip[]): TimelineClip[] =>
  [...clips].sort((a, b) => a.start - b.start);

/** Keep fades inside the clip after any length change (fadeIn + fadeOut ≤ duration). */
function fitFades(c: TimelineClip): TimelineClip {
  if (!c.fadeIn && !c.fadeOut) return c;
  const fi = Math.min(c.fadeIn ?? 0, c.duration);
  const fo = Math.min(c.fadeOut ?? 0, c.duration - fi);
  const out: TimelineClip = { ...c };
  if (fi > 0) out.fadeIn = fi;
  else delete out.fadeIn;
  if (fo > 0) out.fadeOut = fo;
  else delete out.fadeOut;
  return out;
}

/** The clip showing at timeline frame `t` (start ≤ t < end), if any. */
export function clipAt(clips: readonly TimelineClip[], t: number): TimelineClip | undefined {
  return clips.find((c) => c.start <= t && t < clipEnd(c));
}

/** The media frame a layer shows at timeline frame `t`, or null when no clip is there. */
export function mediaFrameAt(clips: readonly TimelineClip[], t: number): number | null {
  const c = clipAt(clips, t);
  return c ? c.sourceIn + Math.floor((t - c.start) * clipSpeed(c)) : null;
}

/** A layer's own position at song frame `t`: inside a clip, its media frame
 *  (unwrapped — the caller wraps it by the footage or the layer's loop); an untimed layer
 *  runs from frame 0 of the song. Null in a gap (the layer is off). */
export function layerPosAt(clips: readonly TimelineClip[] | undefined, t: number): number | null {
  return clips ? mediaFrameAt(clips, t) : t;
}

/** Is a layer on screen at song frame `t`? (No clips = always on.) */
export function visibleAt(clips: readonly TimelineClip[] | undefined, t: number): boolean {
  return !clips || clipAt(clips, t) !== undefined;
}

/** The fade gain (0..1] of the clip under frame `t` — 1 outside any fade, or no clips. */
export function fadeGainAt(clips: readonly TimelineClip[] | undefined, t: number): number {
  if (!clips) return 1;
  const c = clipAt(clips, t);
  if (!c) return 1;
  let g = 1;
  const into = t - c.start;
  const left = clipEnd(c) - 1 - t;
  if (c.fadeIn && into < c.fadeIn) g = Math.min(g, (into + 1) / (c.fadeIn + 1));
  if (c.fadeOut && left < c.fadeOut) g = Math.min(g, (left + 1) / (c.fadeOut + 1));
  return g;
}

/** Invariants (FilmCraft's `Sequence::check`): sorted, no overlaps, ≥ 1 frame, starting
 *  inside the media, never before frame 0, a positive speed, fades inside the clip. A clip
 *  may run PAST the end of its media — it repeats the footage. Returns a reason,
 *  or null when valid. */
export function checkClips(clips: readonly TimelineClip[], media: MediaLen): string | null {
  let prevEnd = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (
      !Number.isInteger(c.start) ||
      !Number.isInteger(c.duration) ||
      !Number.isInteger(c.sourceIn)
    )
      return `clip ${c.id} has a fractional frame`;
    if (c.duration < MIN_DURATION) return `clip ${c.id} is shorter than one frame`;
    if (c.start < 0) return `clip ${c.id} starts before frame 0`;
    if (c.start < prevEnd) return `clip ${c.id} overlaps the clip before it`;
    const sp = clipSpeed(c);
    if (!(Number.isFinite(sp) && sp > 0)) return `clip ${c.id} has a bad speed`;
    if (media !== null && c.sourceIn < 0) return `clip ${c.id} shows media it doesn't have`;
    if (
      (c.fadeIn ?? 0) < 0 ||
      (c.fadeOut ?? 0) < 0 ||
      (c.fadeIn ?? 0) + (c.fadeOut ?? 0) > c.duration
    )
      return `clip ${c.id} fades past its ends`;
    prevEnd = clipEnd(c);
  }
  return null;
}

/** Neighbours on the track: (previous clip's end, next clip's start). */
function neighbours(clips: readonly TimelineClip[], i: number, hi: number): [number, number] {
  const prevEnd = i > 0 ? clipEnd(clips[i - 1]) : 0;
  const nextStart = i + 1 < clips.length ? clips[i + 1].start : hi;
  return [prevEnd, nextStart];
}

/** Timeline frames a clip may grow by at its tail: unlimited — past the end of its media
 *  the footage repeats. */
const tailFrames = (): number => Number.POSITIVE_INFINITY;
/** Timeline frames of media before a clip at its speed (head handle). */
const headFrames = (c: TimelineClip, media: MediaLen): number =>
  media === null ? Number.POSITIVE_INFINITY : Math.floor(c.sourceIn / clipSpeed(c));

/** Rounding at fractional speeds can leave an edit one media frame over (FilmCraft guards
 *  the same way with `check`): step the delta toward 0 until the track is valid. */
function settle(
  d: number,
  apply: (d: number) => TimelineClip[],
  media: MediaLen,
): { clips: TimelineClip[]; applied: number } {
  let k = d;
  let out = apply(k);
  while (k !== 0 && media !== null && checkClips(out, media) !== null) {
    k -= Math.sign(k);
    out = apply(k);
  }
  return { clips: out, applied: k };
}

/** Split the clip strictly containing `t` (start < t < end) into two; the right piece gets
 *  `newId` and media continuing exactly where the left stops. The left keeps the fade in,
 *  the right the fade out. Null when nothing to split. */
export function splitAt(
  clips: readonly TimelineClip[],
  t: number,
  newId: string,
): { clips: TimelineClip[]; rightId: string } | null {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.start < t && t < clipEnd(c));
  if (i < 0) return null;
  const c = list[i];
  const cut = t - c.start;
  const { fadeOut, ...leftBase } = c;
  const left = fitFades({ ...leftBase, duration: cut });
  const { fadeIn, ...rightBase } = c;
  void fadeIn;
  void fadeOut;
  const right = fitFades({
    ...rightBase,
    id: newId,
    start: t,
    duration: c.duration - cut,
    sourceIn: c.sourceIn + srcOf(cut, clipSpeed(c)),
  });
  list.splice(i, 1, left, right);
  return { clips: list, rightId: newId };
}

/** How far a Regular trim of `edge` may actually move (FilmCraft `clamp_trim`): limited by
 *  the neighbours, the media handles (at the clip's speed), the 1-frame minimum and the
 *  timeline end `hi`. */
export function clampTrim(
  clips: readonly TimelineClip[],
  id: string,
  edge: Edge,
  delta: number,
  media: MediaLen,
  hi = Number.POSITIVE_INFINITY,
): number {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return 0;
  const c = list[i];
  const [prevEnd, nextStart] = neighbours(list, i, hi);
  if (edge === 'in') {
    const lo = Math.max(-(c.start - prevEnd), -headFrames(c, media));
    const up = c.duration - MIN_DURATION;
    return Math.min(Math.max(delta, lo), up);
  }
  const lo = -(c.duration - MIN_DURATION);
  const up = Math.min(nextStart - clipEnd(c), tailFrames());
  return Math.min(Math.max(delta, lo), Math.max(up, lo));
}

/** Regular trim of one edge (the edge drag). Returns the applied delta + the new clips. */
export function trim(
  clips: readonly TimelineClip[],
  id: string,
  edge: Edge,
  delta: number,
  media: MediaLen,
  hi = Number.POSITIVE_INFINITY,
): { clips: TimelineClip[]; applied: number } {
  const d0 = clampTrim(clips, id, edge, delta, media, hi);
  if (d0 === 0) return { clips: sorted(clips), applied: 0 };
  const apply = (d: number) =>
    sorted(clips).map((c) => {
      if (c.id !== id) return c;
      if (edge === 'in') {
        return fitFades({
          ...c,
          start: c.start + d,
          duration: c.duration - d,
          // a still has no media position to keep
          sourceIn: media === null ? c.sourceIn : c.sourceIn + srcOf(d, clipSpeed(c)),
        });
      }
      return fitFades({ ...c, duration: c.duration + d });
    });
  return settle(d0, apply, media);
}

/** Roll the edit point between two ADJACENT clips (left.end == right.start): one grows,
 *  the other shrinks, the cut moves, nothing else shifts (FilmCraft `roll`). */
export function roll(
  clips: readonly TimelineClip[],
  leftId: string,
  rightId: string,
  delta: number,
  media: MediaLen,
): { clips: TimelineClip[]; applied: number } {
  const list = sorted(clips);
  const l = list.find((c) => c.id === leftId);
  const r = list.find((c) => c.id === rightId);
  if (!l || !r || clipEnd(l) !== r.start) return { clips: list, applied: 0 };
  let d = delta;
  d = Math.max(d, -(l.duration - MIN_DURATION), -headFrames(r, media));
  d = Math.min(d, r.duration - MIN_DURATION, tailFrames());
  if (d === 0) return { clips: list, applied: 0 };
  return settle(
    d,
    (d) =>
      list.map((c) =>
        c.id === leftId
          ? fitFades({ ...c, duration: c.duration + d })
          : c.id === rightId
            ? fitFades({
                ...c,
                start: c.start + d,
                duration: c.duration - d,
                sourceIn: media === null ? c.sourceIn : c.sourceIn + srcOf(d, clipSpeed(c)),
              })
            : c,
      ),
    media,
  );
}

/** Slip: change which part of the media a clip shows without moving it (FilmCraft
 *  `slip`). A still has nothing to slip. */
export function slip(
  clips: readonly TimelineClip[],
  id: string,
  deltaMedia: number,
  media: MediaLen,
): { clips: TimelineClip[]; applied: number } {
  const list = sorted(clips);
  const c = list.find((x) => x.id === id);
  if (!c || media === null) return { clips: list, applied: 0 };
  // The footage repeats past its end, so any start inside it is valid.
  const maxIn = Math.max(0, media - 1);
  const nextIn = Math.min(Math.max(c.sourceIn + deltaMedia, 0), maxIn);
  const d = nextIn - c.sourceIn;
  if (d === 0) return { clips: list, applied: 0 };
  return { applied: d, clips: list.map((x) => (x.id === id ? { ...x, sourceIn: nextIn } : x)) };
}

/** Slide: move a clip between its neighbours, trimming them so the span stays gapless
 *  (FilmCraft `slide`). Without an adjacent neighbour on a side it just moves into the gap. */
export function slide(
  clips: readonly TimelineClip[],
  id: string,
  delta: number,
  media: MediaLen,
  hi = Number.POSITIVE_INFINITY,
): { clips: TimelineClip[]; applied: number } {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return { clips: list, applied: 0 };
  const c = list[i];
  const prev = i > 0 && clipEnd(list[i - 1]) === c.start ? list[i - 1] : null;
  const next = i + 1 < list.length && list[i + 1].start === clipEnd(c) ? list[i + 1] : null;
  const [prevEnd, nextStart] = neighbours(list, i, hi);
  let d = delta;
  if (prev) {
    d = Math.max(d, -(prev.duration - MIN_DURATION));
    d = Math.min(d, tailFrames());
  } else d = Math.max(d, -(c.start - prevEnd));
  if (next) {
    d = Math.min(d, next.duration - MIN_DURATION);
    d = Math.max(d, -headFrames(next, media));
  } else d = Math.min(d, nextStart - clipEnd(c));
  if (d === 0) return { clips: list, applied: 0 };
  return settle(
    d,
    (d) =>
      list.map((x) => {
        if (prev && x.id === prev.id) return fitFades({ ...x, duration: x.duration + d });
        if (next && x.id === next.id)
          return fitFades({
            ...x,
            start: x.start + d,
            duration: x.duration - d,
            sourceIn: media === null ? x.sourceIn : x.sourceIn + srcOf(d, clipSpeed(x)),
          });
        if (x.id === id) return { ...x, start: x.start + d };
        return x;
      }),
    media,
  );
}

/** Rate stretch (FilmCraft `rate_stretch`): drag an edge to change the clip's length while
 *  it keeps showing the SAME media — the speed changes to fit. Returns the new speed. */
export function rateStretch(
  clips: readonly TimelineClip[],
  id: string,
  edge: Edge,
  delta: number,
  hi = Number.POSITIVE_INFINITY,
): { clips: TimelineClip[]; speed: number } {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return { clips: list, speed: 1 };
  const c = list[i];
  const [prevEnd, nextStart] = neighbours(list, i, hi);
  const srcLen = sourceOut(c) - c.sourceIn;
  // speed limits bound how long / short the clip may become for this much media
  const longest = Math.max(MIN_DURATION, Math.floor(srcLen / SPEED_MIN));
  const shortest = Math.max(MIN_DURATION, Math.ceil(srcLen / SPEED_MAX));
  let d =
    edge === 'out'
      ? Math.min(Math.max(delta, -(c.duration - MIN_DURATION)), nextStart - clipEnd(c))
      : Math.min(Math.max(delta, -(c.start - prevEnd)), c.duration - MIN_DURATION);
  let dur = edge === 'out' ? c.duration + d : c.duration - d;
  const bounded = Math.min(Math.max(dur, shortest), longest);
  if (bounded !== dur) {
    d += edge === 'out' ? bounded - dur : dur - bounded;
    dur = bounded;
  }
  if (dur === c.duration || srcLen <= 0) return { clips: list, speed: clipSpeed(c) };
  const speed = srcLen / dur;
  return {
    speed,
    clips: list.map((x) =>
      x.id === id
        ? fitFades({ ...x, start: edge === 'in' ? x.start + d : x.start, duration: dur, speed })
        : x,
    ),
  };
}

/** Speed / Duration (FilmCraft `set_speed`, no ripple): the clip keeps its media and its
 *  length becomes media ÷ speed — stopping at the next clip (it then shows less media). */
export function setSpeed(
  clips: readonly TimelineClip[],
  id: string,
  speed: number,
  hi = Number.POSITIVE_INFINITY,
): TimelineClip[] {
  if (!(Number.isFinite(speed) && speed > 0)) return sorted(clips);
  const sp = Math.min(Math.max(speed, SPEED_MIN), SPEED_MAX);
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return list;
  const c = list[i];
  const [, nextStart] = neighbours(list, i, hi);
  const srcLen = sourceOut(c) - c.sourceIn;
  let dur = Math.max(MIN_DURATION, Math.min(Math.round(srcLen / sp), nextStart - c.start));
  while (dur > MIN_DURATION && srcOf(dur, sp) > srcLen) dur--;
  if (srcOf(dur, sp) > srcLen && srcLen > 0) return list; // too fast for this little media
  return list.map((x) => {
    if (x.id !== id) return x;
    const next: TimelineClip = { ...x, duration: dur, speed: sp };
    if (sp === 1) delete next.speed;
    return fitFades(next);
  });
}

/** Set a clip's fade in / out (frames), kept inside the clip. */
export function setFades(
  clips: readonly TimelineClip[],
  id: string,
  fadeIn: number,
  fadeOut: number,
): TimelineClip[] {
  return sorted(clips).map((c) =>
    c.id === id
      ? fitFades({
          ...c,
          fadeIn: Math.max(0, Math.round(fadeIn)),
          fadeOut: Math.max(0, Math.round(fadeOut)),
        })
      : c,
  );
}

/** Move a clip to start at `start` without overwriting anything: it stops at its
 *  neighbours (and frame 0 / `hi`). Returns the start it actually landed on. */
export function moveClip(
  clips: readonly TimelineClip[],
  id: string,
  start: number,
  hi = Number.POSITIVE_INFINITY,
): { clips: TimelineClip[]; start: number } {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return { clips: list, start: 0 };
  const c = list[i];
  const [prevEnd, nextStart] = neighbours(list, i, hi);
  const s = Math.min(Math.max(Math.round(start), prevEnd), nextStart - c.duration);
  if (s < prevEnd) return { clips: list, start: c.start }; // no room (can't happen when valid)
  return { start: s, clips: list.map((x) => (x.id === id ? { ...x, start: s } : x)) };
}

/** Delete a clip, leaving a gap (FilmCraft `delete_items` / Premiere Lift). */
export function deleteClip(clips: readonly TimelineClip[], id: string): TimelineClip[] {
  return sorted(clips).filter((c) => c.id !== id);
}

/** Duplicate a clip into the gap right after it (same media). Null when it won't fit. */
export function duplicateClip(
  clips: readonly TimelineClip[],
  id: string,
  newId: string,
  hi = Number.POSITIVE_INFINITY,
): TimelineClip[] | null {
  const list = sorted(clips);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const c = list[i];
  const nextStart = i + 1 < list.length ? list[i + 1].start : hi;
  if (nextStart - clipEnd(c) < c.duration) return null;
  return sorted([...list, { ...c, id: newId, start: clipEnd(c) }]);
}

/** Snap `t` to the nearest target within `threshold` frames (playhead, clip edges, whole
 *  seconds). Returns `t` unchanged when nothing is near. */
export function snapFrame(t: number, targets: readonly number[], threshold: number): number {
  let best = t;
  let bestD = threshold + 1;
  for (const s of targets) {
    const d = Math.abs(s - t);
    if (d <= threshold && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Where a recording's drawn part ends on its bar, in song frames, and the stretch
 *  of its bar past that: where the Repeat / Hold chip sits, and what Hold draws striped.
 *  Null when the bar never runs past its drawn part. */
export function drawnEnd(
  clips: readonly TimelineClip[],
  loop: { frames: number; offset?: number },
): { at: number; stretches: { a: number; b: number }[] } | null {
  const seam = (loop.offset ?? 0) + loop.frames;
  const stretches: { a: number; b: number }[] = [];
  for (const c of clips) {
    const sp = clipSpeed(c);
    const end = c.sourceIn + c.duration * sp;
    if (end <= seam) continue;
    stretches.push({
      a: c.sourceIn >= seam ? c.start : c.start + Math.ceil((seam - c.sourceIn) / sp),
      b: clipEnd(c),
    });
  }
  const live = stretches.filter((s) => s.b > s.a);
  return live.length ? { at: live[0].a, stretches: live } : null;
}

/** Where a layer's loop repeats and its takes play, in song frames, across its bars:
 *  the loop restarts wherever its own clock wraps (`layerClock`), and each take
 *  plays in its window of every pass. `passes` = every pass start (one at a bar's start
 *  too) with its length in song frames, `first` on the pass the loop began on (its
 *  offset) — the ruler's loop bracket. Capped so a short loop on
 *  a long song stays cheap. */
export function loopMarks(
  clips: readonly TimelineClip[],
  loop: { frames: number; offset?: number } | undefined,
  F: number,
  /** The layer's takes: [pass, its window of loop frames + its mute layer]. */
  blocks: readonly (readonly [number, { layer: number; a: number; b: number }])[],
): {
  reps: number[];
  takes: { pass: number; layer: number; a: number; b: number }[];
  passes: { at: number; len: number; first: boolean }[];
} {
  const reps: number[] = [];
  const passes: { at: number; len: number; first: boolean }[] = [];
  const takes: { pass: number; layer: number; a: number; b: number }[] = [];
  if (!loop && blocks.length === 0) return { reps, takes, passes };
  const L = Math.max(1, loop?.frames ?? F);
  const off = loop?.offset ?? 0;
  const CAP = 400;
  for (const c of clips) {
    const sp = clipSpeed(c);
    const p0 = c.sourceIn;
    const p1 = c.sourceIn + c.duration * sp;
    const at = (pos: number) => c.start + (pos - c.sourceIn) / sp; // song frame of a position
    for (let k = Math.ceil((p0 - off) / L); off + k * L < p1 && reps.length < CAP; k++) {
      const t = at(off + k * L);
      if (t > c.start + 0.5) reps.push(t);
      passes.push({ at: t, len: L / sp, first: k === 0 });
    }
    for (const [pass, b] of blocks) {
      const kA = Math.floor((p0 - off - b.b) / L);
      for (let k = kA; off + k * L + b.a < p1 && takes.length < CAP; k++) {
        const a = Math.max(c.start, at(off + k * L + b.a));
        const e = Math.min(clipEnd(c), at(off + k * L + b.b + 1));
        if (e > a) takes.push({ pass, layer: b.layer, a, b: e });
      }
    }
  }
  return { reps, takes, passes };
}
