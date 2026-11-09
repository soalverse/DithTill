// =============================================================================
// Custom colour — the ONE resolve funnel (custom-colour Phase 1, gap-plan §8.B).
//
// A `Swatch` is a flat colour CHOICE for either the flat canvas BACKGROUND or the
// Halftone DOT INK. Three shapes, discriminated by `Array.isArray`:
//   - number  : an INDEX into the current palette's shade ramp. A preset shade —
//               it TRACKS the palette on a switch (clamped to shorter ramps), the
// behaviour. A back-compatible stored `number` still means
//               "shade index".
//   - [r,g,b] : a CUSTOM RGB colour (0..255 per channel). It PINS across palette
//               switches (a fixed colour, palette-independent).
//   - null    : transparent / none.
//
// The colour NEVER enters the quantizer (the dither is colour-blind — the parity
// snapshots are untouched). It resolves at the render/encode layer ONLY, through
// this one funnel, so preview == export holds across all five paths (GPU shader
// CSS bg, CPU mirror, the print screens live + exported, video frames, SVG). PURE,
// dep-free of DOM — safe on the deterministic export path.
// =============================================================================
import { LUMA, PALETTES, paletteLength, paletteRgbAt, type PaletteId } from './dither-constants';

export type Rgb = [number, number, number];

/** A flat-colour choice: preset shade index | custom RGB | transparent (null). */
export type Swatch = number | Rgb | null;

/** True when the swatch is a custom RGB triple (pins across palette switches). */
export function isCustomSwatch(s: Swatch): s is Rgb {
  return Array.isArray(s);
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Clamp a raw RGB triple to whole bytes (defensive — a custom value is stored raw). */
export function clampRgb(rgb: Rgb): Rgb {
  return [clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2])];
}

/**
 * Resolve a background/none Swatch to concrete RGB bytes, or null (transparent):
 *   number  → the clamped palette shade (the existing paletteRgbAt clamp policy).
 *   [r,g,b] → its own clamped bytes (palette-independent).
 *   null    → null (transparent / none).
 * The ONE funnel every background render/encode site calls (preview == export).
 */
export function resolveSwatch(s: Swatch, palette: PaletteId): Rgb | null {
  if (s === null) return null;
  if (Array.isArray(s)) return clampRgb(s);
  return paletteRgbAt(palette, s);
}

/**
 * Resolve a Halftone dot INK Swatch to RGB. UNLIKE a background, an ink `null`
 * (or `undefined`) means the palette's BRIGHTEST shade — the default dots-on-dark
 * — never transparent. A number is a palette shade (clamped); an array is custom.
 */
export function resolveInk(ink: Swatch | undefined, palette: PaletteId): Rgb {
  if (ink === null || ink === undefined) return paletteRgbAt(palette, paletteLength(palette) - 1);
  if (Array.isArray(ink)) return clampRgb(ink);
  return paletteRgbAt(palette, ink);
}

const hex2 = (v: number): string => clampByte(v).toString(16).padStart(2, '0');

/** '#rrggbb' for an RGB triple. */
export function rgbToHex(rgb: Rgb): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** Hex colour table for one palette (dark -> light, same order as PALETTES). */
export function paletteHex(palette: PaletteId): string[] {
  const pal = PALETTES[palette];
  const out: string[] = [];
  for (let i = 0; i < pal.length; i += 3) out.push(rgbToHex([pal[i], pal[i + 1], pal[i + 2]]));
  return out;
}

/** Parse '#rrggbb' (or '#rgb') to an RGB triple; falls back to black on garbage. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16) || 0,
      parseInt(h[1] + h[1], 16) || 0,
      parseInt(h[2] + h[2], 16) || 0,
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

/** Integer Rec.601 luma (0..255) of an RGB triple — the shared quantizer weights.
 *  The TONE a flat background contributes under the opacity "over" stack. */
export function rgbTone(rgb: Rgb): number {
  const [r, g, b] = clampRgb(rgb);
  return (LUMA.WR * r + LUMA.WG * g + LUMA.WB * b) >> 8;
}

/** A background Swatch's integer luma tone, or undefined when null (transparent). */
export function swatchTone(s: Swatch, palette: PaletteId): number | undefined {
  const rgb = resolveSwatch(s, palette);
  return rgb === null ? undefined : rgbTone(rgb);
}
