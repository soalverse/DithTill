// =============================================================================
// Main-thread client for the background-removal Worker (B7). Mirrors
// engine-cpu/worker-client: a lazy singleton worker, calls correlated by id, and
// every terminal path (success / worker error / crash) settles the promise so a
// failed matte can't hang or leak the pending map. The heavy BiRefNet inference
// runs in the worker; this side just marshals pixels in and rebuilds the cutout
// image out. See.
// =============================================================================
import type { BgRemoveResponse, BgRemoveError } from './bg-remove.worker';

interface Pending {
  resolve: (r: BgRemoveResponse) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function rejectAll(message: string): void {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
  worker = null; // force a fresh worker on the next call
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./bg-remove.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<BgRemoveResponse | BgRemoveError>) => {
      const data = e.data;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if ('error' in data) p.reject(new Error(data.error));
      else p.resolve(data);
    };
    worker.onerror = (e) => rejectAll(`bg-remove worker crashed: ${e.message}`);
    worker.onmessageerror = () => rejectAll('bg-remove worker sent an uncloneable message');
  }
  return worker;
}

/** Image or canvas -> its RGBA pixels at natural resolution, via a canvas. */
function imageToRgba(image: HTMLImageElement | HTMLCanvasElement): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const width = image instanceof HTMLCanvasElement ? image.width : image.naturalWidth;
  const height = image instanceof HTMLCanvasElement ? image.height : image.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.drawImage(image, 0, 0);
  return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** Cutout RGBA -> an HTMLImageElement, so it flows through the existing burn
 *  pipeline (transparent areas dither away and export as a tRNS PNG, Stage 9). */
function rgbaToImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<HTMLImageElement> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  // Build an ArrayBuffer-backed ImageData then copy (matches PreviewCanvas) —
  // avoids the strict Uint8ClampedArray<ArrayBufferLike> mismatch on the ctor.
  const imgData = new ImageData(width, height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('cutout encode failed'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('cutout image decode failed'));
      };
      img.src = url;
    }, 'image/png');
  });
}

/**
 * Remove the background from an image, returning a transparent-background cutout
 * as an HTMLImageElement. Fully offline (vendored BiRefNet_lite weights + ORT
 * wasm). The cutout drops straight into the burn pipeline — its removed region is
 * transparent and exports as a tRNS PNG.
 */
export async function removeBackground(
  image: HTMLImageElement | HTMLCanvasElement,
): Promise<HTMLImageElement> {
  const { rgba, width, height } = imageToRgba(image);
  const buf = rgba.buffer as ArrayBuffer; // fresh per getImageData — safe to transfer
  const id = ++seq;
  const res = await new Promise<BgRemoveResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, rgba: buf, width, height }, [buf]);
  });
  return rgbaToImage(new Uint8ClampedArray(res.rgba), res.width, res.height);
}
