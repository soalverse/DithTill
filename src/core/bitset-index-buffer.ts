import { PackedIndexBuffer } from './packed-index-buffer';

/**
 * 1-bit (two-tone) index buffer — the locked MVP storage core, a thin
 * specialization of PackedIndexBuffer. The N-color extension is just
 * PackedIndexBuffer at depth 2/4/8 behind the same IndexBuffer interface,
 * so nothing at the call site changes when palettes grow past two colors.
 */
export class BitsetIndexBuffer extends PackedIndexBuffer {
  constructor(width: number, height: number) {
    super(width, height, 1);
  }
}
