// =============================================================================
// Tempo (Group J1,: "just do what fruity loops does"). FL Studio's
// model: ONE project tempo in BPM (default 130), 4/4, loop lengths in bars, motion
// speeds as beat lengths (tempo-synced), clips snapping to beats. Pure maths — no
// DOM, no store, no wall clock — shared by the live canvas, the export and the
// timeline so they can never disagree (preview == export).
//
// THE BEAT CLOCK. Frames are whole numbers and beats rarely are (1 bar at 130 BPM =
// 55.38 frames at 30 fps), so there are two honest mappings and the choice is an
// explicit input:
//   - WITH A SONG the beat follows the song's own time exactly — beat(f) =
//     (f/fps − offset)·bpm/60 on the ABSOLUTE frame — so a "1 bar" spin stays on the
//     song's bars for its whole length (a loop-framed beat would drift a frame or so
//     per loop against the music).
//   - WITHOUT A SONG the loop is the master: each loop holds exactly its bars, so a
//     beat-timed motion closes perfectly at every wrap (the tempo is off by at most
//     half a frame per loop, which nothing can hear).
// =============================================================================

export const BPM_DEFAULT = 130; // FL Studio's default project tempo
export const BPM_MIN = 40;
export const BPM_MAX = 300;
export const BEATS_PER_BAR = 4; // 4/4, FL's default

/** Loop lengths offered, in bars (plus "Song" / "Clip" stops in the timeline). */
export const LOOP_BARS = [1, 2, 4, 8, 16, 32] as const;

/** Motion speeds as one cycle's length in BEATS (FL tempo-sync): ¼ beat … 8 bars. */
export const BEAT_LENGTHS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

export interface BeatClock {
  bpm: number;
  fps: number;
  /** Seconds from the start of the video to bar 1, beat 1 (Detect sets it from a song). */
  offsetSec: number;
  /** F — the loop length in frames. */
  frames: number;
  /** Beats in one loop when the loop is a whole number of bars; null otherwise. */
  loopBeats: number | null;
  /** A song sets the time (the absolute, drift-free mapping); else the loop does. */
  song: boolean;
}

export const clampBpm = (bpm: number): number =>
  Math.min(BPM_MAX, Math.max(BPM_MIN, Number.isFinite(bpm) ? bpm : BPM_DEFAULT));

/** Frames per beat at this tempo (a float). */
export const framesPerBeat = (bpm: number, fps: number): number => (fps * 60) / clampBpm(bpm);

/** The loop length in whole frames for `bars` bars at this tempo (at least 1). */
export function barsToFrames(bars: number, bpm: number, fps: number): number {
  return Math.max(1, Math.round(bars * BEATS_PER_BAR * framesPerBeat(bpm, fps)));
}

/** The beat position (0 = bar 1, beat 1) at an absolute frame. */
export function beatAt(clock: BeatClock, absFrame: number): number {
  if (clock.song || clock.loopBeats == null) {
    return (absFrame / clock.fps - clock.offsetSec) * (clampBpm(clock.bpm) / 60);
  }
  const F = Math.max(1, clock.frames);
  const loop = Math.floor(absFrame / F);
  return loop * clock.loopBeats + ((absFrame - loop * F) * clock.loopBeats) / F;
}

/** How many loops one cycle of `beats` spans (1 when it fits in a loop) — the live
 *  clock and the export's Loop length stretch to it so the cycle closes. */
export function beatSpanLoops(clock: BeatClock, beats: number): number {
  if (clock.loopBeats != null && clock.loopBeats > 0) {
    return Math.max(1, Math.ceil(beats / clock.loopBeats - 1e-9));
  }
  const F = Math.max(1, clock.frames);
  return Math.max(1, Math.ceil((beats * framesPerBeat(clock.bpm, clock.fps)) / F - 1e-9));
}

/** "¼ beat", "1 beat", "2 beats", "1 bar", "4 bars". */
export function beatLengthLabel(beats: number): string {
  if (beats >= BEATS_PER_BAR) {
    const bars = beats / BEATS_PER_BAR;
    return `${bars} bar${bars === 1 ? '' : 's'}`;
  }
  const frac: Record<number, string> = { 0.25: '¼', 0.5: '½' };
  const n = frac[beats] ?? String(beats);
  return `${n} beat${beats > 1 ? 's' : ''}`;
}

/** Whole-frame positions of every beat in [0, total] (bar lines every BEATS_PER_BAR). */
export function beatFrames(
  bpm: number,
  fps: number,
  offsetSec: number,
  total: number,
): { frame: number; beat: number }[] {
  const fpb = framesPerBeat(bpm, fps);
  const out: { frame: number; beat: number }[] = [];
  const first = Math.ceil((-offsetSec * fps) / fpb - 1e-9);
  for (let b = first; ; b++) {
    const f = Math.round(offsetSec * fps + b * fpb);
    if (f > total) break;
    if (f >= 0) out.push({ frame: f, beat: b });
  }
  return out;
}

/** Tap tempo (FL's Tap): the BPM from tap times in ms (the newest last), using the
 *  last 8 taps; a gap over 2 s starts over. Null until there are two taps. */
export function tapTempo(tapsMs: readonly number[]): number | null {
  let start = 0;
  for (let i = 1; i < tapsMs.length; i++) if (tapsMs[i] - tapsMs[i - 1] > 2000) start = i;
  const taps = tapsMs.slice(Math.max(start, tapsMs.length - 8));
  if (taps.length < 2) return null;
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  return avg > 0 ? Math.round(clampBpm(60000 / avg) * 10) / 10 : null;
}

/** A Free recording's loop length: `len` frames rounded to the NEAREST beat (at
 *  least one beat), so its repeats stay on the beat; `exact` (Shift held as the take ends)
 *  keeps the frames as recorded. */
export function roundToBeat(len: number, bpm: number, fps: number, exact = false): number {
  const n = Math.max(1, Math.round(len));
  if (exact) return n;
  const fpb = framesPerBeat(bpm, fps);
  return Math.max(Math.round(fpb), Math.round(Math.max(1, Math.round(n / fpb)) * fpb));
}
