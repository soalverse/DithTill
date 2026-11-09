// =============================================================================
// The video's length and the export's — the PURE math behind BOTH
// the live clock (T_live) and the export panel (Whole video / Marked part, the GIF cap and
// "Fit to N bars"). No DOM, no store, no wall clock: plain numbers in, plain numbers out, so
// the callers (ui/audio-engine, ui/ExportLengthPanel) can never disagree and vitest can pin
// every branch.
// =============================================================================

/** Round `n` UP to the next positive multiple of `F` (>= F for any n). Used to
 *  land the LIVE wrap of an absolute-timeline source on a loop boundary so the
 *  authored content stays seamless. */
export function ceilToMultiple(n: number, F: number): number {
  const f = Math.max(1, Math.floor(F));
  const v = Math.ceil(n);
  if (v <= f) return f;
  return Math.ceil(v / f) * f;
}

/**
 * T_live — the video's length in frames: the longest absolute-timeline source
 * (the song; the end of the last layer bar; an untimed video's footage) — EXACT, no longer
 * rounded up to whole loops — and never shorter than the loop F. With no such source the
 * canvas is just its loop: F, stretched to whole trips of a slow motion
 * so it never jumps. The CALLER decides which lengths are absolute.
 */
export function liveTotalFrames(
  F: number,
  absoluteSourceFrames: readonly number[],
  motionFrames: number = F,
): number {
  const f = Math.max(1, Math.floor(F));
  let t = 0;
  for (const s of absoluteSourceFrames) t = Math.max(t, Math.ceil(s));
  return t > 0 ? Math.max(f, t) : ceilToMultiple(motionFrames, f);
}

/** The longest GIF: past a minute an export is MP4 only — a GIF has no
 *  sound and its size grows fast. */
export const GIF_MAX_SECONDS = 60;

/** Within this many frames of a whole pass counts as one: loops are whole frames of a tempo
 *  whose beats rarely are (1 bar at 130 BPM = 55.38 frames), so two loops in bars only line
 *  up to the frame. */
const FIT_SLACK = 1;

/** How far `len` frames is from a whole number of passes of a `L`-frame loop. */
const offPass = (len: number, L: number): number => Math.abs(len - Math.round(len / L) * L);

/** Does a `len`-frame export end every loop on a whole pass (a GIF that loops
 *  seamlessly)? `loops` = the frame lengths of the loops that move in it. */
export function loopsFit(len: number, loops: readonly number[]): boolean {
  return loops.every((L) => L <= 0 || (len >= L - FIT_SLACK && offPass(len, L) <= FIT_SLACK));
}

/** "Fit to N bars": the shortest length that ends EVERY loop on a whole pass — a
 *  whole number of the longest loop that is within a frame of a whole number of each other
 *  one. Null when none fits within `maxFrames` (the GIF cap). */
export function fitLoopsLength(loops: readonly number[], maxFrames: number): number | null {
  const ls = loops.filter((L) => L > 0).map((L) => Math.round(L));
  if (ls.length === 0) return null;
  const top = Math.max(...ls);
  for (let t = top; t <= maxFrames; t += top) if (loopsFit(t, ls)) return t;
  return null;
}

/** Seconds → a clock string: `m:ss`, or `h:mm:ss` past an hour. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A rough render-time estimate window (seconds) for T frames. The
 *  prototype measured ~70-110 fps on synthetic frames; real halftone scenes render
 *  slower, so the advertised band is a conservative 70 fps (fast) down to 25 fps
 *  (slow, halftone) — i.e. [T/70, T/25]. In the WEB app the codec runs single-threaded
 *  wasm (~8–18 fps encode at 960×720), so the band drops to [T/18, T/6].
 *  A guide only; never a promise. */
export function estimateRenderSeconds(frames: number, web = false): { fast: number; slow: number } {
  const f = Math.max(0, frames);
  return web ? { fast: f / 18, slow: f / 6 } : { fast: f / 70, slow: f / 25 };
}

/** Past this export duration (seconds) the picker's Export button arms two-press
 *  (K3 soft confirm — free entry, no hard cap). 15 minutes. */
export const CONFIRM_OVER_SECONDS = 15 * 60;
