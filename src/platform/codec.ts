// =============================================================================
// The app's codec: the desktop app runs the Rust codec NATIVELY through
// Tauri commands (src-tauri/src/codec.rs — multi-threaded, fast); the web app loads
// the SAME crate as wasm (codec-wasm.ts, fetched on first use). Both implement the one
// `Codec` interface, so export / import code never branches on the platform.
// =============================================================================
import { invoke } from '@tauri-apps/api/core';
import wasmUrl from './dithtill-codec.wasm?url';
import {
  createWasmCodec,
  type Codec,
  type CodecEncoder,
  type CodecVideo,
  type CodecVideoInfo,
} from './codec-wasm';

export type {
  Codec,
  CodecContainer,
  CodecEncodeOptions,
  CodecEncoder,
  CodecFrame,
  CodecVideo,
} from './codec-wasm';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const bytesOf = (r: ArrayBuffer | Uint8Array | number[]): Uint8Array =>
  r instanceof Uint8Array ? r : r instanceof ArrayBuffer ? new Uint8Array(r) : Uint8Array.from(r);

/** The native (Tauri command) implementation — bulk data rides raw IPC bodies. */
const nativeCodec: Codec = {
  async createEncoder(o) {
    const id = await invoke<number>('codec_encoder_new', {
      opts: {
        container: o.container,
        width: o.width,
        height: o.height,
        fps: o.fps,
        cycleFrames: o.cycle?.frames,
        cycleTotal: o.cycle?.total,
      },
    });
    let open = true;
    const enc: CodecEncoder = {
      async pushFrame(f) {
        const body = new Uint8Array(f.data.byteLength + f.palette.byteLength + f.alpha.byteLength);
        body.set(f.data, 0);
        body.set(f.palette, f.data.byteLength);
        body.set(f.alpha, f.data.byteLength + f.palette.byteLength);
        const meta = [
          f.width,
          f.height,
          f.bitDepth,
          f.rowBytes,
          f.data.byteLength,
          f.palette.byteLength,
        ].join(',');
        await invoke('codec_encoder_frame', body, {
          headers: { 'x-id': String(id), 'x-frame': meta },
        });
      },
      async setAudio(pcm, rate) {
        const n = Math.min(pcm.left.length, pcm.right.length);
        const fl = new Float32Array(n * 2);
        fl.set(pcm.left.subarray(0, n), 0);
        fl.set(pcm.right.subarray(0, n), n);
        await invoke('codec_encoder_audio', new Uint8Array(fl.buffer), {
          headers: { 'x-id': String(id), 'x-rate': String(rate) },
        });
      },
      async finish(outPath) {
        open = false;
        const r = await invoke<ArrayBuffer>('codec_encoder_finish', {
          id,
          outPath: outPath ?? null,
        });
        return outPath ? null : bytesOf(r);
      },
      async abort() {
        if (open) await invoke('codec_encoder_abort', { id }).catch(() => {});
        open = false;
      },
    };
    return enc;
  },

  async openVideo(bytes) {
    const id = await invoke<number>('codec_video_open', bytes);
    const v: CodecVideo = {
      info: () => invoke<CodecVideoInfo>('codec_video_info', { id }),
      frameTimes: (inS, outS) => invoke<number[]>('codec_video_times', { id, inS, outS }),
      async decode(inS, outS, first, count, w, h) {
        const r = await invoke<ArrayBuffer>('codec_video_decode', {
          id,
          inS,
          outS,
          first,
          count,
          w,
          h,
        });
        return bytesOf(r);
      },
      async close() {
        await invoke('codec_video_close', { id }).catch(() => {});
      },
    };
    return v;
  },

  async decodeAudio(bytes, inS, outS, rate) {
    const headers: Record<string, string> = { 'x-rate': String(rate) };
    if (inS != null && outS != null) headers['x-trim'] = `${inS},${outS}`;
    const b = bytesOf(await invoke<ArrayBuffer>('codec_audio_decode', bytes, { headers }));
    if (b.byteLength === 0) return null;
    const all = new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
    const n = all.length >> 1;
    return { left: all.slice(0, n), right: all.slice(n) };
  },
};

let wasmCodec: Promise<Codec> | null = null;

/** The codec for this platform: native in the desktop app, wasm (loaded once) on the web. */
export function getCodec(): Promise<Codec> {
  if (isTauri()) return Promise.resolve(nativeCodec);
  wasmCodec ??= fetch(wasmUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`codec download failed (${r.status})`);
      return r.arrayBuffer();
    })
    .then((b) => createWasmCodec(b))
    .catch((e: unknown) => {
      wasmCodec = null; // let a later call retry
      throw e;
    });
  return wasmCodec;
}
