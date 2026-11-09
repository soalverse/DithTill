import type { IndexBuffer } from './types';

/**
 * Bit-packed palette-index buffer at 1/2/4/8 bits per pixel. Row-major,
 * MSB-first within each byte, rows padded to whole bytes — i.e. exactly the
 * PNG indexed-image scanline layout, so toBytes() drops straight into an
 * indexed-PNG IDAT (see png-indexed.ts).
 *
 * This is the concrete realization of the locked storage abstraction: 1-bit
 * NOW (two-tone, via BitsetIndexBuffer) extends to N-color simply by raising
 * the bit depth — no call-site change.
 */
export class PackedIndexBuffer implements IndexBuffer {
  /** Bytes per scanline (whole-byte padded). */
  readonly rowBytes: number;
  private readonly data: Uint8Array;
  private readonly mask: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly bitDepth: number,
  ) {
    if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8) {
      throw new Error(`bitDepth must be 1, 2, 4, or 8; got ${bitDepth}`);
    }
    this.rowBytes = Math.ceil((width * bitDepth) / 8);
    this.data = new Uint8Array(this.rowBytes * height);
    this.mask = (1 << bitDepth) - 1;
  }

  get(x: number, y: number): number {
    const bitPos = x * this.bitDepth;
    const byteIdx = y * this.rowBytes + (bitPos >> 3);
    const shift = 8 - this.bitDepth - (bitPos & 7);
    return (this.data[byteIdx] >> shift) & this.mask;
  }

  set(x: number, y: number, index: number): void {
    const v = index & this.mask;
    const bitPos = x * this.bitDepth;
    const byteIdx = y * this.rowBytes + (bitPos >> 3);
    const shift = 8 - this.bitDepth - (bitPos & 7);
    this.data[byteIdx] = (this.data[byteIdx] & ~(this.mask << shift)) | (v << shift);
  }

  toBytes(): Uint8Array {
    return this.data;
  }

  /** Overwrite the packed contents in place (e.g. restoring an undo snapshot).
   *  `bytes` must match this buffer's packed length. The buffer reference stays
   *  stable so holders (the Draw doc) don't need to rebind. */
  loadBytes(bytes: Uint8Array): void {
    if (bytes.length !== this.data.length) {
      throw new Error(`byte length mismatch: expected ${this.data.length}, got ${bytes.length}`);
    }
    this.data.set(bytes);
  }
}
