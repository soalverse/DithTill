// =============================================================================
// Main-thread client for the loop-audio analysis Worker. A lazy
// singleton worker; each analyzeLoopAudio() call is correlated to its response by an
// incrementing id. The heavy buildLoopAudioMix + preAnalyze run in the worker; the
// live AudioBufferSourceNode swap stays on the main thread (ui/audio-engine).
//
// It NEVER rejects: without a Worker (vitest/jsdom, or a browser that can't spawn a
// module worker) — and if the worker ever crashes — it falls back to the SAME pure
// core functions inline, so the result is identical either way. ui/audio-engine's
// existing syncSeq supersede-guard drops any stale result after the await.
// =============================================================================
import { buildLoopAudioMix, monoMix, type SampleClip, type StereoPcm } from '../core/loop-audio';
import { preAnalyze, type FeatureArray } from '../core/audio-features';
import type { LoopAudioRequest, LoopAudioResponse, LoopAudioError } from './loop-audio.worker';

export interface LoopAudioParams {
  sources: { pcm: StereoPcm; clipSamples: number; clips?: SampleClip[] }[];
  frames: number;
  fps: number;
  seamFade: boolean;
  rate: number;
  totalFrames: number;
}

export interface LoopAudioResult {
  mix: StereoPcm;
  features: FeatureArray;
}

/** The pure computation — the worker's body, reused verbatim as the fallback. */
function runInline(p: LoopAudioParams): LoopAudioResult {
  const mix = buildLoopAudioMix(p.sources, p.frames, p.fps, p.seamFade, p.rate, p.totalFrames);
  const features = preAnalyze({
    pcm: monoMix(mix),
    sampleRate: p.rate,
    frames: p.totalFrames,
    fps: p.fps,
  });
  return { mix, features };
}

interface Pending {
  resolve: (r: LoopAudioResult) => void;
  params: LoopAudioParams;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

/** A worker crash/uncloneable-message settles every in-flight call via the inline
 *  fallback (never rejects) and forces a fresh worker next time. */
function fallbackAll(): void {
  for (const [, p] of pending) p.resolve(runInline(p.params));
  pending.clear();
  worker = null;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./loop-audio.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<LoopAudioResponse | LoopAudioError>) => {
      const data = e.data;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ('error' in data) p.resolve(runInline(p.params));
      else
        p.resolve({
          mix: { left: new Float32Array(data.left), right: new Float32Array(data.right) },
          features: data.features,
        });
    };
    worker.onerror = () => fallbackAll();
    worker.onmessageerror = () => fallbackAll();
  }
  return worker;
}

/**
 * Build the canonical loop-audio mix + frame-indexed features off the main thread.
 * Falls back to the identical inline computation when no Worker is available.
 */
export function analyzeLoopAudio(params: LoopAudioParams): Promise<LoopAudioResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(runInline(params));
  let w: Worker;
  try {
    w = getWorker();
  } catch {
    return Promise.resolve(runInline(params));
  }
  const id = ++seq;
  return new Promise<LoopAudioResult>((resolve) => {
    pending.set(id, { resolve, params });
    const req: LoopAudioRequest = {
      id,
      // Inputs are CLONED (not transferred) — the caller's videoPcm cache reuses these.
      sources: params.sources.map((s) => ({
        left: s.pcm.left,
        right: s.pcm.right,
        clipSamples: s.clipSamples,
        ...(s.clips ? { clips: s.clips } : {}),
      })),
      frames: params.frames,
      fps: params.fps,
      seamFade: params.seamFade,
      rate: params.rate,
      totalFrames: params.totalFrames,
    };
    w.postMessage(req);
  });
}
