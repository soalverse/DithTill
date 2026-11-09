// Minimal ambient types for upng-js (ships no official types).
declare module 'upng-js' {
  interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    data: Uint8Array;
    frames: unknown[];
    tabs: Record<string, unknown>;
  }
  const UPNG: {
    /** Lossless when cnum=0; lossy/quantized to `cnum` colors otherwise. */
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[]): ArrayBuffer;
    /** Low-level lossless encode with explicit channels + bit depth. */
    encodeLL(
      imgs: ArrayBuffer[],
      w: number,
      h: number,
      cc: number,
      ac: number,
      depth: number,
      dels?: number[],
    ): ArrayBuffer;
    decode(buf: ArrayBuffer): UPNGImage;
    toRGBA8(img: UPNGImage): ArrayBuffer[];
  };
  export default UPNG;
}
