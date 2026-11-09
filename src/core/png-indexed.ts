// =============================================================================
// True indexed (PNG color-type 3) encoder — the WebView-portable, sharp-free
// export path. Consumes an IndexBuffer's packed bytes DIRECTLY (the locked
// storage seam) and emits a PLTE + IDAT PNG at the buffer's native bit depth
// (1/2/4/8). Result: the smallest, crispest file — a true 1-bit PNG for the
// two-tone core, a 4-bit PNG for the 6-color ramps. An optional tRNS chunk
// carries per-index alpha for transparency (Stage 9).
// =============================================================================
import { deflate } from 'pako';
import type { IndexBuffer } from './types';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Encode an IndexBuffer + its palette into an indexed PNG at the buffer's bit
 * depth. `paletteRgb` is flat RGB (length 3*N); indices in the buffer must be
 * < N and < 2**bitDepth. `trns` (optional) is per-index alpha (length <= N);
 * indices beyond it are opaque — used to mark a transparent palette entry.
 */
export function encodeIndexedPng(
  buf: IndexBuffer,
  paletteRgb: Uint8Array,
  trns?: Uint8Array,
): Uint8Array {
  const { width, height, bitDepth } = buf;
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const packed = buf.toBytes();

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 3; // color type 3 = indexed (palette)
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // no filter
  ihdr[12] = 0; // no interlace

  // Prepend the per-scanline filter byte (0 = None) ahead of each packed row.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0;
    raw.set(packed.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }

  // tRNS (if any) must sit after PLTE and before IDAT.
  const chunks: Uint8Array[] = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('PLTE', paletteRgb)];
  if (trns && trns.length > 0) chunks.push(chunk('tRNS', trns));
  chunks.push(chunk('IDAT', deflate(raw)));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}
