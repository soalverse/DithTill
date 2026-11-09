// =============================================================================
// Loop-audio analysis Worker — runs the HEAVY canonical-mix build +
// feature pre-analysis off the main thread. With the two-clock model a placed
// 5-minute clip makes T_live ≈ 9000 frames, so buildLoopAudioMix + preAnalyze cost
// seconds; running them here keeps the UI responsive on every audio toggle / mute /
// length change. It runs the SAME PURE core functions as the export, so the result
// is byte-identical — this is a live-preview responsiveness move, not a behaviour
// change (the deterministic EXPORT rebuilds its own mix in platform/loop-export and
// never touches this Worker or the live engine).
// =============================================================================
import { buildLoopAudioMix, monoMix, type SampleClip, type StereoPcm } from '../core/loop-audio';
import { preAnalyze, type FeatureArray } from '../core/audio-features';

export interface LoopAudioRequest {
  id: number;
  /** Source PCM (planar Float32Array channels) + each clip's tile length in samples.
   *  Cloned over postMessage (NOT transferred — the caller's videoPcm cache is reused). */
  sources: {
    left: Float32Array;
    right: Float32Array;
    clipSamples: number;
    clips?: SampleClip[];
  }[];
  frames: number;
  fps: number;
  seamFade: boolean;
  rate: number;
  totalFrames: number;
}

export interface LoopAudioResponse {
  id: number;
  /** The canonical mix's planar channels (their ArrayBuffers are transferred back). */
  left: ArrayBuffer;
  right: ArrayBuffer;
  /** The frame-indexed features (structured-clone-able). */
  features: FeatureArray;
}

export interface LoopAudioError {
  id: number;
  error: string;
}

// Avoid pulling the WebWorker lib globally (it conflicts with DOM lib); type the
// worker scope locally instead (mirrors dither.worker.ts).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<LoopAudioRequest>) => void) | null;
  postMessage: (message: LoopAudioResponse | LoopAudioError, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e) => {
  const { id, sources, frames, fps, seamFade, rate, totalFrames } = e.data;
  try {
    const src = sources.map((s) => ({
      pcm: { left: s.left, right: s.right } as StereoPcm,
      clipSamples: s.clipSamples,
      ...(s.clips ? { clips: s.clips } : {}),
    }));
    const mix = buildLoopAudioMix(src, frames, fps, seamFade, rate, totalFrames);
    const features = preAnalyze({ pcm: monoMix(mix), sampleRate: rate, frames: totalFrames, fps });
    const left = mix.left.buffer as ArrayBuffer;
    const right = mix.right.buffer as ArrayBuffer;
    ctx.postMessage({ id, left, right, features }, [left, right]);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
