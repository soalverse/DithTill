// =============================================================================
// THE CANONICAL LOOP-AUDIO BUFFER (P6; decisions locked 2026-07-03).
// Renders exactly F/fps seconds of PCM ONCE — and live playback (ui/audio-engine),
// the feature pre-analysis (audio-features.preAnalyze), AND the export mux all
// consume THAT buffer. What you hear == what reacts == what exports, byte-for-byte
// by construction.
//
// LOCKED MODEL: the Loop Sound is a MIX — every placed video's audio plays (each
// placed on the song by its clips and repeating its footage past the end, mirroring
// EXACTLY how layerTick picks the clip's FRAMES on song time),
// an imported track (session-transient) layers on top, and per-layer audio mutes
// simply exclude a source from this mix (WYSIWYG — mutes are an input, like the
// visual mutes). Seam fades are a stored ON/OFF toggle (meta), default on.
//
// PURE Float32Array math. Decoding runs through the codec (platform/
// audio-decode) at the PINNED rate below with one fixed resampler — decodeAudioData
// resamples with the browser engine's own and would make features machine-dependent
// (it stays a fallback for formats the codec doesn't read).
// =============================================================================

/** The one pinned analysis/mix sample rate. Every decoded source is resampled to
 *  this by the codec, so the canonical buffer is machine-independent. */
export const AUDIO_RATE = 48000;

/** Seam crossfade length (seconds) at tile joins + the loop wrap — kills the
 *  click when a clip doesn't end at a zero crossing. Toggleable (stored). */
export const SEAM_FADE_SECONDS = 0.005;

/** Planar stereo PCM in [-1, 1]. */
export interface StereoPcm {
  left: Float32Array;
  right: Float32Array;
}

/** One source feeding the mix: a decoded, already-trimmed clip at AUDIO_RATE. */
export interface LoopAudioSource {
  pcm: StereoPcm;
  /** The tile length in samples — the clip's CANONICAL duration (for a video,
   *  clipSampleCount(frameCount, fps) so audio repeats exactly with the frames;
   *  for an imported track, its full decoded length). PCM shorter than this is
   *  zero-padded; longer is truncated. */
  clipSamples: number;
  /** TIMED layer: its clips in SAMPLES of song time — the source
   *  sounds only inside them, from `sourceIn` (an index into `pcm`). Absent = untimed. */
  clips?: SampleClip[];
}

/** A timing clip in samples (song-time start/duration, pcm index sourceIn). */
export interface SampleClip {
  start: number;
  duration: number;
  sourceIn: number;
  /** Playback speed (tape-style: pitch follows); absent = 1. */
  speed?: number;
  /** Fade in / out in samples; absent = none. */
  fadeIn?: number;
  fadeOut?: number;
}

/** Frame clips (core/timeline-edit) → sample clips at `rate` — the same integer frames,
 *  so the sound lines up with the picture exactly. */
export function frameClipsToSamples(
  clips: readonly {
    start: number;
    duration: number;
    sourceIn: number;
    speed?: number;
    fadeIn?: number;
    fadeOut?: number;
  }[],
  fps: number,
  rate: number = AUDIO_RATE,
): SampleClip[] {
  const s = (f: number) => Math.round((f / Math.max(1, fps)) * rate);
  return clips.map((c) => ({
    start: s(c.start),
    duration: s(c.start + c.duration) - s(c.start),
    sourceIn: s(c.sourceIn),
    ...(c.speed && c.speed !== 1 ? { speed: c.speed } : {}),
    ...(c.fadeIn ? { fadeIn: s(c.fadeIn) } : {}),
    ...(c.fadeOut ? { fadeOut: s(c.fadeOut) } : {}),
  }));
}

/** Loop buffer length in samples: round(F/fps · rate) — derived, like loopMs. */
export function loopSampleCount(frames: number, fps: number, rate: number = AUDIO_RATE): number {
  return Math.max(1, Math.round((Math.max(1, frames) / Math.max(1, fps)) * rate));
}

/** A video clip's canonical audio length in samples — from its INTEGER frame
 *  count (never the container's float duration), so audio tiles land exactly
 *  where loopFrameToClipTick restarts the frames. */
export function clipSampleCount(
  clipFrames: number,
  fps: number,
  rate: number = AUDIO_RATE,
): number {
  return Math.max(1, Math.round((Math.max(1, clipFrames) / Math.max(1, fps)) * rate));
}

/** The decode-cache key for a placed video's audio: the source hash PLUS the trim
 *  window. Keying by the hash ALONE is wrong — the decoded PCM is trimmed to
 *  [inSeconds, outSeconds), and two Library variants of one source (same bytes,
 *  different trim) are distinct clips with distinct audio. Look-only variants
 *  (same trim, different palette) legitimately share one decode. This mirrors the
 *  frame cache (video-assets keys per record) so the live mix == the export. */
export function audioSourceKey(videoHash: string, inSeconds: number, outSeconds: number): string {
  return `${videoHash}:${inSeconds}:${outSeconds}`;
}

const readTile = (ch: Float32Array, idx: number): number => (idx < ch.length ? ch[idx] : 0);

/**
 * Mix the sources into the canonical audio buffer over SONG time: the
 * output is loopSampleCount(totalFrames, …) samples (`totalFrames` defaults to the
 * loop length `frames`). Every source runs on the song's own clock, like the picture:
 *   - a TIMED source sounds only inside its clips, from `sourceIn` at the clip's
 *     speed, and repeats its footage when a clip runs past the end of it;
 *   - an untimed source (a video with no clips, the imported song) plays from the start
 *     of the song and repeats every `clipSamples`.
 *
 * `seamFade` ramps the edges that could click: every clip edge, each footage repeat
 * (a tile join) and the buffer's own ends. The sum is peak-normalized only if it
 * clips over the whole output buffer (deterministic — a pure function of the inputs).
 */
export function buildLoopAudioMix(
  sources: readonly LoopAudioSource[],
  frames: number,
  fps: number,
  seamFade: boolean,
  rate: number = AUDIO_RATE,
  totalFrames: number = frames,
): StereoPcm {
  const n = loopSampleCount(totalFrames, fps, rate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const fadeN = seamFade ? Math.min(Math.round(SEAM_FADE_SECONDS * rate), n >> 1) : 0;

  for (const src of sources) {
    const clip = Math.max(1, Math.floor(src.clipSamples));
    const tileFade = Math.min(fadeN, clip >> 1);
    if (src.clips) {
      // TIMED (3b): sound only inside the clips, with the seam ramp at every clip edge
      // and footage repeat so cuts never click.
      for (let i = 0; i < n; i++) {
        const c = src.clips.find((k) => k.start <= i && i < k.start + k.duration);
        if (!c) continue;
        const t = (c.sourceIn + Math.floor((i - c.start) * (c.speed ?? 1))) % clip;
        let g = 1;
        // the clip's own fades (3c), sample-exact twins of the picture's opacity ramp
        const into = i - c.start;
        const toEnd = c.start + c.duration - 1 - i;
        if (c.fadeIn && into < c.fadeIn) g = Math.min(g, (into + 1) / (c.fadeIn + 1));
        if (c.fadeOut && toEnd < c.fadeOut) g = Math.min(g, (toEnd + 1) / (c.fadeOut + 1));
        if (fadeN > 0) {
          const edge = Math.min(into + 1, toEnd + 1, i + 1, n - i);
          const f = Math.min(fadeN, c.duration >> 1);
          if (f > 0 && edge <= f) g = Math.min(g, edge / (f + 1));
          if (tileFade > 0) {
            const join = Math.min(t + 1, clip - t);
            if (join <= tileFade) g = Math.min(g, join / (tileFade + 1));
          }
        }
        left[i] += readTile(src.pcm.left, t) * g;
        right[i] += readTile(src.pcm.right, t) * g;
      }
      continue;
    }
    for (let i = 0; i < n; i++) {
      const t = i % clip;
      let g = 1;
      if (tileFade > 0) {
        // Tile-join seams (t near 0 / clip) + the buffer's own ends (i near 0 / n).
        const edge = Math.min(t + 1, clip - t, i + 1, n - i);
        if (edge <= tileFade) g = edge / (tileFade + 1);
      }
      left[i] += readTile(src.pcm.left, t) * g;
      right[i] += readTile(src.pcm.right, t) * g;
    }
  }

  // Peak-normalize only when the sum clips (unity gain otherwise).
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 1) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) {
      left[i] *= g;
      right[i] *= g;
    }
  }
  return { left, right };
}

/** Mono downmix (L+R)/2 — the analysis input (audio-features.preAnalyze). */
export function monoMix(pcm: StereoPcm): Float32Array {
  const n = Math.min(pcm.left.length, pcm.right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (pcm.left[i] + pcm.right[i]) / 2;
  return out;
}
