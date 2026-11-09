// =============================================================================
// Storage abstraction for dithered pixels.
// 1-bit bitset NOW (the locked MVP core); the SAME interface extends to a
// Uint8 palette-index buffer LATER (N-color) with no change at call sites.
// (SCOPE.md §2: "backing buffer is a bitset now, behind an interface that
// extends to a Uint8 palette index later — no rewrite".)
// =============================================================================

export interface IndexBuffer {
  readonly width: number;
  readonly height: number;
  /** Bits stored per index: 1 now (two-tone), up to 8 later (N-color palette). */
  readonly bitDepth: number;
  /** Read the palette index at (x, y). */
  get(x: number, y: number): number;
  /** Write the palette index at (x, y). */
  set(x: number, y: number, index: number): void;
  /** Pack to the densest PNG-ready byte representation (scanline-aligned). */
  toBytes(): Uint8Array;
}
