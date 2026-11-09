// =============================================================================
// Audio decode → planar stereo PCM at the PINNED rate (P6). The codec (native in the desktop app, wasm on the web) decodes and
// resamples to loop-audio's AUDIO_RATE with one fixed resampler — the same samples on
// every machine and in every browser, so the canonical mix, the FeatureArray and the
// export are machine-independent.
//
// Fallback only: a format the codec doesn't read (e.g. Apple Lossless) goes through the
// browser's decodeAudioData + an OfflineAudioContext resample — playable, but the
// engine's resampler is not pinned.
//
// Returns null when the input has no audio stream (a silent video clip).
// =============================================================================
import { AUDIO_RATE, type StereoPcm } from '../core/loop-audio';
import { getCodec } from './codec';

async function decodeViaWebAudio(
  bytes: Uint8Array,
  inSeconds: number | null,
  outSeconds: number | null,
): Promise<StereoPcm | null> {
  let decoded: AudioBuffer;
  try {
    // decodeAudioData needs a plain ArrayBuffer copy (it detaches the buffer).
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const probeCtx = new OfflineAudioContext(2, 1, AUDIO_RATE);
    decoded = await probeCtx.decodeAudioData(ab as ArrayBuffer);
  } catch {
    return null; // no decodable audio stream
  }
  const start = inSeconds ?? 0;
  const end = outSeconds ?? decoded.duration;
  const frames = Math.max(1, Math.round((end - start) * AUDIO_RATE));
  // Resample + trim in one offline render at the pinned rate.
  const ctx = new OfflineAudioContext(2, frames, AUDIO_RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start(0, start, end - start);
  const rendered = await ctx.startRendering();
  return {
    left: rendered.getChannelData(0).slice(),
    right: rendered.getChannelData(rendered.numberOfChannels > 1 ? 1 : 0).slice(),
  };
}

/**
 * Decode a container's audio to planar stereo at AUDIO_RATE, optionally trimmed
 * to [inSeconds, outSeconds). Null = no audio stream.
 */
export async function decodeAudioPcm(
  bytes: Uint8Array,
  inSeconds: number | null = null,
  outSeconds: number | null = null,
): Promise<StereoPcm | null> {
  try {
    const codec = await getCodec();
    return await codec.decodeAudio(bytes, inSeconds, outSeconds, AUDIO_RATE);
  } catch {
    return decodeViaWebAudio(bytes, inSeconds, outSeconds);
  }
}
