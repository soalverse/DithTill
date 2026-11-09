// =============================================================================
// Headless animation tools (personal AI tooling — NOT part of the app bundle).
// AI-2 of the MCP suite, two halves:
//   renderHalftoneFrames — an ORDERED set of source images -> numbered per-frame
//     halftone PNGs through the one dither seam (halftone-pipeline), shared
//     dials, ONE aspect frame => one grid => the fixed blue-noise lattice, so
//     unchanged source regions are byte-stable across frames.
//   exportFramesVideo — a frames directory -> MP4 / GIF through the app's OWN codec
//     (the wasm build of src-tauri/codec) — the same encoder the loop
//     exporter uses, with the same recipes.
// Frame naming mirrors the loop exporter: frame_000001.png…, 1-based.
// =============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  createWasmCodec,
  type Codec,
  type CodecContainer,
  type CodecFrame,
} from '../../src/platform/codec-wasm';
import {
  headlessFrame,
  renderHalftone,
  type HalftoneRenderOptions,
  type HalftoneRenderResult,
} from './halftone-pipeline';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// ---- Refuse-the-job ceilings (locked at AI-2 kickoff, 2026-07-14) ----------
export const FRAMES_MAX = 900;
export const FPS_MIN = 1;
export const FPS_MAX = 60;
export const FPS_DEFAULT = 12;

// ---- The loop exporter's frame naming, shared by both halves --------------
export const frameFileName = (frame1Based: number): string =>
  `frame_${String(frame1Based).padStart(6, '0')}.png`;
export const FRAME_FILE_RE = /^frame_(\d{6})\.png$/;
/** The numbered frame files' pattern in a frames directory (what export_frames_video reads). */
export const framesPattern = (dir: string): string => path.join(dir, 'frame_%06d.png');

// ---- The codec (wasm, loaded once) -----------------------------------------
let codecP: Promise<Codec> | null = null;
/** The app's codec in node: the committed wasm build (npm run build:codec). */
export function nodeCodec(): Promise<Codec> {
  codecP ??= createWasmCodec(
    readFileSync(path.join(ROOT, 'src', 'platform', 'dithtill-codec.wasm')),
  );
  return codecP;
}

/** The output container from a path's extension, or null. */
export function containerForPath(file: string): CodecContainer | null {
  const ext = path.extname(file).toLowerCase();
  return ext === '.mp4' ? 'mp4' : ext === '.gif' ? 'gif' : null;
}

/** An RGBA frame → the codec's indexed frame. DithTill frames are palette art; a frame
 *  with more than 256 distinct colours (RGBA) is refused rather than quantized. */
export function rgbaToCodecFrame(
  rgba: Uint8Array,
  w: number,
  h: number,
  label: string,
): CodecFrame {
  const index = new Map<number, number>();
  const data = new Uint8Array(w * h);
  const palette: number[] = [];
  const alpha: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    let k = index.get(key);
    if (k === undefined) {
      k = index.size;
      if (k >= 256) throw new Error(`${label} has more than 256 colours — not palette art`);
      index.set(key, k);
      palette.push(rgba[o], rgba[o + 1], rgba[o + 2]);
      alpha.push(rgba[o + 3]);
    }
    data[i] = k;
  }
  return {
    width: w,
    height: h,
    bitDepth: 8,
    rowBytes: w,
    data,
    palette: Uint8Array.from(palette),
    alpha: Uint8Array.from(alpha),
  };
}

// ---- renderHalftoneFrames ---------------------------------------------------

export interface FramesRenderOptions extends Omit<HalftoneRenderOptions, 'input'> {
  /** Ordered absolute source paths — inputs[k] becomes frame_{k+1}. */
  inputs: string[];
  /** Directory for the numbered frame PNGs (created if missing). */
  outputDir: string;
}

export interface FramesRenderResult {
  frames: number;
  /** Per-frame pixel dims + grid + aspect frame (identical for every frame). */
  width: number;
  height: number;
  LW: number;
  LH: number;
  targetW: number;
  targetH: number;
  /** The numbered frame files' pattern export_frames_video will read. */
  pattern: string;
  /** Total bytes written across all frame PNGs. */
  totalBytes: number;
}

/** Render an ordered set of source images to numbered halftone frame PNGs with
 *  ONE shared dial set. All sources must present the same aspect frame (with a
 *  fixed `aspect` that is automatic; under 'auto' every source must match the
 *  first) — one frame means one grid and one blue-noise lattice, so a region
 *  whose source pixels do not change renders byte-identically in every frame. */
export async function renderHalftoneFrames(opts: FramesRenderOptions): Promise<FramesRenderResult> {
  const { inputs, outputDir, ...dials } = opts;
  if (inputs.length === 0) throw new Error('inputs is empty — nothing to render');
  if (inputs.length > FRAMES_MAX) {
    throw new Error(
      `${inputs.length} frames exceeds the ${FRAMES_MAX}-frame ceiling — split the job into shorter loops`,
    );
  }

  // ONE aspect frame across the set. Cheap metadata pass BEFORE any rendering,
  // so a mixed batch fails fast instead of leaving a half-written frame set.
  const aspect = dials.aspect ?? 'auto';
  let first: { targetW: number; targetH: number } | null = null;
  if (aspect === 'auto') {
    for (const [i, input] of inputs.entries()) {
      const meta = await sharp(input).metadata();
      const w = meta.autoOrient?.width ?? meta.width;
      const h = meta.autoOrient?.height ?? meta.height;
      if (!w || !h) throw new Error(`Could not read dimensions of ${input}`);
      const frame = headlessFrame('auto', w, h);
      if (!first) first = frame;
      else if (frame.targetW !== first.targetW || frame.targetH !== first.targetH) {
        throw new Error(
          `frame ${i + 1} (${input}) presents a ${frame.targetW}x${frame.targetH} frame but ` +
            `frame 1 is ${first.targetW}x${first.targetH} — under aspect 'auto' every source ` +
            `must share one aspect (fix the sources or set a fixed aspect)`,
        );
      }
    }
  }

  // Stale-frame guard: numbered files PAST this set would be swept into a later
  // encode (export_frames_video reads the numbering contiguously) — refuse up front.
  // Same-numbered files are overwritten deliberately (re-rendering into the
  // same directory while iterating on dials).
  if (existsSync(outputDir)) {
    const stale = (await readdir(outputDir))
      .filter((f) => {
        const m = FRAME_FILE_RE.exec(f);
        return m !== null && Number(m[1]) > inputs.length;
      })
      .sort();
    if (stale.length > 0) {
      throw new Error(
        `outputDir already holds ${stale.length} frame(s) past #${inputs.length} ` +
          `(${stale[0]}…) — a later encode would sweep them in; clean the directory first`,
      );
    }
  }
  await mkdir(outputDir, { recursive: true });

  let head: HalftoneRenderResult | null = null;
  let totalBytes = 0;
  for (const [i, input] of inputs.entries()) {
    const res = await renderHalftone({ input, ...dials });
    head ??= res;
    await writeFile(path.join(outputDir, frameFileName(i + 1)), res.png);
    totalBytes += res.png.length;
  }
  // head is set: inputs.length >= 1 (guarded above).
  const h = head as HalftoneRenderResult;
  return {
    frames: inputs.length,
    width: h.width,
    height: h.height,
    LW: h.LW,
    LH: h.LH,
    targetW: h.targetW,
    targetH: h.targetH,
    pattern: framesPattern(outputDir),
    totalBytes,
  };
}

// ---- exportFramesVideo ------------------------------------------------------

export interface FramesVideoOptions {
  /** Directory holding frame_000001.png… (renderHalftoneFrames writes them). */
  framesDir: string;
  /** Output file path; the extension picks the container: .mp4 / .gif. */
  output: string;
  /** Playback rate, FPS_MIN..FPS_MAX (default FPS_DEFAULT). */
  fps?: number;
}

export interface FramesVideoResult {
  container: CodecContainer;
  frames: number;
  fps: number;
  seconds: number;
  bytes: number;
}

/** Encode a numbered frames directory to MP4 / GIF with the app's own codec. */
export async function exportFramesVideo(opts: FramesVideoOptions): Promise<FramesVideoResult> {
  const fps = Math.round(opts.fps ?? FPS_DEFAULT);
  if (fps < FPS_MIN || fps > FPS_MAX) {
    throw new Error(`fps must be ${FPS_MIN}–${FPS_MAX}, got ${opts.fps}`);
  }
  const container = containerForPath(opts.output);
  if (!container) {
    throw new Error(`output must end in .mp4 or .gif, got '${opts.output}'`);
  }

  if (!existsSync(opts.framesDir)) throw new Error(`framesDir not found: ${opts.framesDir}`);
  const frames = (await readdir(opts.framesDir)).filter((f) => FRAME_FILE_RE.test(f)).sort();
  if (frames.length === 0) {
    throw new Error(
      `no frame_000001.png-style frames in ${opts.framesDir} (render_halftone_frames writes them)`,
    );
  }
  if (frames.length > FRAMES_MAX) {
    throw new Error(
      `${frames.length} frames exceeds the ${FRAMES_MAX}-frame ceiling — split the job into shorter loops`,
    );
  }
  frames.forEach((name, i) => {
    if (Number((FRAME_FILE_RE.exec(name) as RegExpExecArray)[1]) !== i + 1) {
      throw new Error(
        `frames must be numbered contiguously from frame_000001.png — missing ${frameFileName(i + 1)}`,
      );
    }
  });

  await mkdir(path.dirname(opts.output), { recursive: true });
  const codec = await nodeCodec();
  let enc: Awaited<ReturnType<Codec['createEncoder']>> | null = null;
  try {
    for (const name of frames) {
      const { data, info } = await sharp(path.join(opts.framesDir, name))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const frame = rgbaToCodecFrame(new Uint8Array(data), info.width, info.height, name);
      // Silent loop MP4 — no soundtrack here, exactly like a sound-less app export.
      enc ??= await codec.createEncoder({
        container,
        width: info.width,
        height: info.height,
        fps,
      });
      await enc.pushFrame(frame);
    }
    const out = (await enc!.finish())!;
    enc = null;
    await writeFile(opts.output, out);
    return {
      container,
      frames: frames.length,
      fps,
      seconds: frames.length / fps,
      bytes: out.length,
    };
  } finally {
    await enc?.abort();
  }
}
