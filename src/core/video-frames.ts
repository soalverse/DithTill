// =============================================================================
// Canonical video frame addressing. A video element is addressed in
// INTEGER ticks of the loop clock, never in float seconds: tick k of a clip is
// "the source frame displayed at time inSeconds + k/fps". Every consumer — the
// live flipbook, the stopped view, and the codec export — selects frames through
// THESE pure rules, so preview == export is a property of shared code, not of two
// decoders happening to agree (the golden parity test enforces it).
// =============================================================================
import { layerPosAt, type TimelineClip } from './timeline-edit';

/** The one canonical sampling rate — matches the loop clock (loop-store meta.fps
 *  default). Fixed at element-save time into the record so a future fps change
 *  can never silently re-time saved elements. */
export const VIDEO_FPS = 30;

/** Video raster long edge == the scene lattice (SCENE_LONG), so a full-glass
 *  video maps ~1:1 onto scene cells. Shared by the live previewer AND the
 *  export decoder — the rasters must be the same shape for parity to hold. */
export const VIDEO_RASTER_LONG = 192;

/** The cell-resolution raster dims for a source of (vw × vh) pixels: long edge
 *  = VIDEO_RASTER_LONG, short edge rounded, 1 minimum. Zero/missing dims fall
 *  back to a square raster. */
export function videoRasterDims(
  vw: number,
  vh: number,
  long: number = VIDEO_RASTER_LONG,
): { w: number; h: number } {
  const W = vw > 0 ? vw : long;
  const H = vh > 0 ? vh : long;
  return W >= H
    ? { w: long, h: Math.max(1, Math.round((long * H) / W)) }
    : { w: Math.max(1, Math.round((long * W) / H)), h: long };
}

/** The clip-local time (seconds) of tick k: the middle of the tick's interval.
 *  Mid-tick sampling keeps the pick stable against float jitter at frame
 *  boundaries (a frame's own pts is never a hair past the probe time). */
export function tickTimeSeconds(k: number, fps: number, inSeconds = 0): number {
  return inSeconds + (k + 0.5) / fps;
}

/** Select, for each of `frameCount` ticks, the index of the source frame that is
 *  displayed at that tick — the LAST frame whose start pts <= the tick time.
 *  `ptsSeconds` is the sorted list of source frame start times (clip-relative or
 *  absolute; pass a matching `inSeconds`). Pure; shared by every decode path. */
export function selectFrameForTicks(
  ptsSeconds: readonly number[],
  frameCount: number,
  fps: number,
  inSeconds = 0,
): Int32Array {
  const out = new Int32Array(frameCount);
  let j = 0;
  for (let k = 0; k < frameCount; k++) {
    const t = tickTimeSeconds(k, fps, inSeconds);
    while (j + 1 < ptsSeconds.length && ptsSeconds[j + 1] <= t) j++;
    out[k] = j;
  }
  return out;
}

/** Map a LOOP frame onto a clip tick: clips shorter than the loop repeat inside
 *  it (modulo), clips as long as the loop map 1:1. Pure integer math. */
export function loopFrameToClipTick(loopFrame: number, clipFrames: number): number {
  if (clipFrames <= 0) return 0;
  const m = loopFrame % clipFrames;
  return m < 0 ? m + clipFrames : m;
}

/** Map an ABSOLUTE export frame onto a clip tick under the two-clock rule
 *  (K2, locked 2026-07-18): a clip that OUTLASTS the loop (clipFrames > loopFrames)
 *  advances ABSOLUTELY through the whole export (`frame mod clipFrames`), so each
 *  loop pass shows the next stretch of a long video; a clip SHORTER than (or equal
 *  to) the loop tiles per loop CYCLE exactly as today (`loopFrameToClipTick` of
 *  `frame mod loopFrames`), restarting at every loop boundary. Negative-safe and
 *  degenerate-safe (clipFrames <= 0 → 0) like loopFrameToClipTick. NOTE: for any
 *  `frame < loopFrames` the two agree exactly — loopFrame == frame, and the short
 *  branch's outer modulo is a no-op — so today's loop-length walks are unchanged. */
export function clipTickForFrame(frame: number, loopFrames: number, clipFrames: number): number {
  if (clipFrames <= 0) return 0;
  if (clipFrames > loopFrames) {
    const m = frame % clipFrames;
    return m < 0 ? m + clipFrames : m;
  }
  const L = Math.max(1, loopFrames);
  const loopFrame = ((frame % L) + L) % L;
  return loopFrameToClipTick(loopFrame, clipFrames);
}

/** The clip tick a video LAYER shows at song frame `frame`. An untimed layer
 *  plays its footage from the start of the song; a TIMED layer shows media frame
 *  sourceIn + (t − start) × speed of the clip under t, or null in a gap (the layer is off
 *  then). Past the end of the footage it repeats (a clip dragged longer plays it again).
 *  The ONE rule live, scrub and export share. */
export function layerTick(
  clips: readonly TimelineClip[] | undefined,
  frame: number,
  clipFrames: number,
): number | null {
  const pos = layerPosAt(clips, frame);
  if (pos === null) return null;
  return loopFrameToClipTick(pos, clipFrames);
}
