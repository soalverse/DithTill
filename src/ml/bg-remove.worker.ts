// =============================================================================
// Background-removal Worker (B7) — runs U-2-Net matting OFF the main thread, FULLY
// OFFLINE, on the CPU/WASM path. The vendored ONNX weights + ONNX-runtime WASM load
// from public/ (no network). U-2-Net (Apache-2.0, general salient-object) outputs a
// saliency matte that we apply as alpha -> an RGBA cutout. The cutout drops into the
// existing burn pipeline unchanged — its transparency flows to a tRNS PNG via
// ALPHA_CUTOFF (Stage 9). Heavy inference stays off the UI thread. See.
// =============================================================================
import * as ort from 'onnxruntime-web';

const MODEL_URL = '/models/Heliosoph/u2net-onnx/u2net.onnx';
const SIZE = 320; // U-2-Net's native (fixed) input resolution
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Offline, single-threaded CPU. The vendored ORT wasm loads from /ort/ (served raw
// by the serveOrtRaw dev middleware; static in the packaged app). numThreads=1
// avoids the SharedArrayBuffer COOP/COEP requirement, fragile under Tauri + the dev
// server. (WebGPU — B6 — could accelerate later; U-2-Net at 320^2 is light on CPU.)
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = 1;

export interface BgRemoveRequest {
  id: number;
  rgba: ArrayBuffer; // source pixels (transferred), length width*height*4
  width: number;
  height: number;
}
export interface BgRemoveResponse {
  id: number;
  rgba: ArrayBuffer; // cutout pixels (transferred), same dims
  width: number;
  height: number;
}
export interface BgRemoveError {
  id: number;
  error: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BgRemoveRequest>) => void) | null;
  postMessage: (m: BgRemoveResponse | BgRemoveError, transfer?: Transferable[]) => void;
};

// Lazy singleton — the model is parsed once and reused across calls.
let sessionP: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionP) {
    sessionP = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
  }
  return sessionP;
}

function ctx2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const c = canvas.getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('OffscreenCanvas 2D context unavailable');
  return c;
}

/** Source RGBA -> 320x320, scaled to [0,1] + ImageNet-normalized, NCHW float tensor. */
function preprocess(rgba: ArrayBuffer, width: number, height: number): ort.Tensor {
  const src = new OffscreenCanvas(width, height);
  ctx2d(src).putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const small = new OffscreenCanvas(SIZE, SIZE);
  const sctx = ctx2d(small);
  sctx.drawImage(src, 0, 0, SIZE, SIZE);
  const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
  const area = SIZE * SIZE;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    data[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0]; // R plane
    data[area + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1]; // G plane
    data[2 * area + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2]; // B plane
  }
  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
}

/** d0 saliency [0,1] (320x320) -> min-max-normalized alpha matte resized to w x h. */
function matteFromD0(d0: Float32Array, width: number, height: number): Uint8ClampedArray {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < d0.length; i++) {
    if (d0[i] < mn) mn = d0[i];
    if (d0[i] > mx) mx = d0[i];
  }
  const range = mx - mn || 1;
  const small = new OffscreenCanvas(SIZE, SIZE);
  const sctx = ctx2d(small);
  const img = sctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = ((d0[i] - mn) / range) * 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const full = new OffscreenCanvas(width, height);
  const fctx = ctx2d(full);
  fctx.drawImage(small, 0, 0, width, height); // bilinear upscale to source size
  return fctx.getImageData(0, 0, width, height).data;
}

async function removeBackground(
  rgba: ArrayBuffer,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const session = await getSession();
  const inName = session.inputNames.includes('input.1') ? 'input.1' : session.inputNames[0];
  const outName = session.outputNames.includes('d0') ? 'd0' : session.outputNames[0];

  const input = preprocess(rgba, width, height);
  const results = await session.run({ [inName]: input });
  const d0 = results[outName].data as Float32Array;
  const matte = matteFromD0(d0, width, height);

  // Source RGB + the matte as alpha (respecting any existing source transparency).
  const src = new Uint8ClampedArray(rgba);
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < width * height; i++) {
    out[i * 4 + 3] = (matte[i * 4] * src[i * 4 + 3]) / 255;
  }
  return out.buffer;
}

ctx.onmessage = (e) => {
  const { id, rgba, width, height } = e.data;
  removeBackground(rgba, width, height)
    .then((out) => ctx.postMessage({ id, rgba: out, width, height }, [out]))
    .catch((err) =>
      ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
    );
};
