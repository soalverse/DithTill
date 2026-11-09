// =============================================================================
// The codec — ONE interface over DithTill's pure-Rust video/audio layer
// (src-tauri/codec): MP4 (H.264 + AAC) / GIF export, a placed video's exact frames,
// and song / soundtrack decode at the pinned rate. Two implementations of the same
// Rust code: NATIVE Tauri commands in the desktop app (platform/codec.ts) and this
// WASM build (the web app, the MCP tools, the tests). Environment-agnostic: callers
// hand in the wasm bytes or module (fetch in a page, fs in node).
// =============================================================================
import type { StereoPcm } from '../core/loop-audio';
import type { SceneRaster } from '../core/scene-resolver';

/** One rendered frame, exactly as the scene renderer produces it (SceneRaster):
 *  packed index rows (1/2/4/8-bit, MSB-first, rows padded to whole bytes), the RGB
 *  palette and per-entry alpha. */
export interface CodecFrame {
  width: number;
  height: number;
  bitDepth: number;
  rowBytes: number;
  data: Uint8Array;
  palette: Uint8Array;
  alpha: Uint8Array;
}

/** A rendered scene raster → the codec's frame (the same pixels the PNG export writes). */
export function codecFrame(r: SceneRaster): CodecFrame {
  return {
    width: r.buf.width,
    height: r.buf.height,
    bitDepth: r.buf.bitDepth,
    rowBytes: r.buf.rowBytes,
    data: r.buf.toBytes(),
    palette: r.palette,
    alpha: r.trns,
  };
}

export type CodecContainer = 'mp4' | 'gif';

export interface CodecEncodeOptions {
  container: CodecContainer;
  width: number;
  height: number;
  fps: number;
  /** The pushed frames are ONE loop cycle repeating to `total` frames. */
  cycle?: { frames: number; total: number };
}

export interface CodecEncoder {
  pushFrame(frame: CodecFrame): Promise<void>;
  /** The soundtrack (MP4 only), trimmed to the video length. */
  setAudio(pcm: StereoPcm, rate: number): Promise<void>;
  /** Finish the file. With `outPath`, an implementation that can write files (native)
   *  writes it there and returns null; otherwise the file's bytes come back. */
  finish(outPath?: string): Promise<Uint8Array | null>;
  /** Drop an unfinished encoder (cancel / error). */
  abort(): Promise<void>;
}

export interface CodecVideoInfo {
  /** Display size (rotation applied). */
  width: number;
  height: number;
  duration: number;
  frames: number;
  rotation: number;
  codec: string;
}

export interface CodecVideo {
  info(): Promise<CodecVideoInfo>;
  /** Presentation times (seconds) of the frames in the trim window [inS, outS). */
  frameTimes(inS: number, outS: number): Promise<number[]>;
  /** RGBA frames `first .. first+count` of the trim window, each `w × h`, concatenated. */
  decode(
    inS: number,
    outS: number,
    first: number,
    count: number,
    w: number,
    h: number,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface Codec {
  createEncoder(opts: CodecEncodeOptions): Promise<CodecEncoder>;
  openVideo(bytes: Uint8Array): Promise<CodecVideo>;
  /** Planar stereo at `rate`, optionally trimmed to [inS, outS); null = no audio stream. */
  decodeAudio(
    bytes: Uint8Array,
    inS: number | null,
    outS: number | null,
    rate: number,
  ): Promise<StereoPcm | null>;
}

interface Exports {
  memory: WebAssembly.Memory;
  dt_alloc(len: number): number;
  dt_free(ptr: number, len: number): void;
  dt_result_ptr(): number;
  dt_result_len(): number;
  dt_take_error(): number;
  dt_release_result(): void;
  dt_enc_new(container: number, w: number, h: number, fps: number, cf: number, ct: number): number;
  dt_enc_frame(
    id: number,
    w: number,
    h: number,
    bitDepth: number,
    rowBytes: number,
    data: number,
    dataLen: number,
    pal: number,
    palLen: number,
    alpha: number,
    alphaLen: number,
  ): number;
  dt_enc_audio(id: number, l: number, r: number, n: number, rate: number): number;
  dt_enc_finish(id: number): number;
  dt_enc_drop(id: number): void;
  dt_video_open(ptr: number, len: number): number;
  dt_video_info(id: number): number;
  dt_video_times(id: number, inS: number, outS: number): number;
  dt_video_decode(
    id: number,
    inS: number,
    outS: number,
    first: number,
    count: number,
    w: number,
    h: number,
  ): number;
  dt_video_close(id: number): void;
  dt_audio_decode(
    ptr: number,
    len: number,
    trim: number,
    inS: number,
    outS: number,
    rate: number,
  ): number;
}

/** Instantiate the codec wasm (bytes or a compiled module) → the Codec interface. */
export async function createWasmCodec(source: BufferSource | WebAssembly.Module): Promise<Codec> {
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, {})
      : (await WebAssembly.instantiate(source, {})).instance;
  return wrap(instance.exports as unknown as Exports);
}

function wrap(x: Exports): Codec {
  const err = (): Error => {
    const n = x.dt_take_error();
    const msg = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.dt_result_ptr(), n));
    x.dt_release_result();
    return new Error(msg || 'codec error');
  };
  /** Copy `bytes` into wasm memory for the duration of `fn`. */
  const withBytes = <T>(bytes: Uint8Array, fn: (ptr: number) => T): T => {
    const len = bytes.byteLength;
    const ptr = x.dt_alloc(len);
    new Uint8Array(x.memory.buffer, ptr, len).set(bytes);
    try {
      return fn(ptr);
    } finally {
      x.dt_free(ptr, len);
    }
  };
  /** The result buffer, copied out (wasm memory may grow and move it later). */
  const result = (): Uint8Array => {
    const out = new Uint8Array(x.memory.buffer, x.dt_result_ptr(), x.dt_result_len()).slice();
    x.dt_release_result();
    return out;
  };
  const check = (status: number): void => {
    if (status !== 1) throw err();
  };
  const f64s = (b: Uint8Array): Float64Array =>
    new Float64Array(b.buffer, b.byteOffset, b.byteLength >> 3);

  return {
    async createEncoder(o) {
      const id = x.dt_enc_new(
        o.container === 'gif' ? 1 : 0,
        o.width,
        o.height,
        o.fps,
        o.cycle?.frames ?? 0,
        o.cycle?.total ?? 0,
      );
      if (id === 0) throw err();
      let open = true;
      return {
        async pushFrame(f) {
          const total = f.data.byteLength + f.palette.byteLength + f.alpha.byteLength;
          const buf = new Uint8Array(total);
          buf.set(f.data, 0);
          buf.set(f.palette, f.data.byteLength);
          buf.set(f.alpha, f.data.byteLength + f.palette.byteLength);
          withBytes(buf, (p) =>
            check(
              x.dt_enc_frame(
                id,
                f.width,
                f.height,
                f.bitDepth,
                f.rowBytes,
                p,
                f.data.byteLength,
                p + f.data.byteLength,
                f.palette.byteLength,
                p + f.data.byteLength + f.palette.byteLength,
                f.alpha.byteLength,
              ),
            ),
          );
        },
        async setAudio(pcm, rate) {
          const n = Math.min(pcm.left.length, pcm.right.length);
          const bytes = new Uint8Array(n * 8);
          const fl = new Float32Array(bytes.buffer);
          fl.set(pcm.left.subarray(0, n), 0);
          fl.set(pcm.right.subarray(0, n), n);
          withBytes(bytes, (p) => check(x.dt_enc_audio(id, p, p + n * 4, n, rate)));
        },
        async finish() {
          open = false;
          check(x.dt_enc_finish(id));
          return result();
        },
        async abort() {
          if (open) x.dt_enc_drop(id);
          open = false;
        },
      };
    },

    async openVideo(bytes) {
      const id = withBytes(bytes, (p) => x.dt_video_open(p, bytes.byteLength));
      if (id === 0) throw err();
      return {
        async info() {
          check(x.dt_video_info(id));
          const b = result();
          const v = f64s(b.slice(0, 40));
          return {
            width: v[0],
            height: v[1],
            duration: v[2],
            frames: v[3],
            rotation: v[4],
            codec: new TextDecoder().decode(b.subarray(40)),
          };
        },
        async frameTimes(inS, outS) {
          check(x.dt_video_times(id, inS, outS));
          return Array.from(f64s(result()));
        },
        async decode(inS, outS, first, count, w, h) {
          check(x.dt_video_decode(id, inS, outS, first, count, w, h));
          return result();
        },
        async close() {
          x.dt_video_close(id);
        },
      };
    },

    async decodeAudio(bytes, inS, outS, rate) {
      const trim = inS != null && outS != null;
      const status = withBytes(bytes, (p) =>
        x.dt_audio_decode(p, bytes.byteLength, trim ? 1 : 0, inS ?? 0, outS ?? 0, rate),
      );
      if (status === 2) return null;
      check(status);
      const b = result();
      const all = new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
      const n = all.length >> 1;
      return { left: all.slice(0, n), right: all.slice(n) };
    },
  };
}
