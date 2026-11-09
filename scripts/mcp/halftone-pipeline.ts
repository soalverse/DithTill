// =============================================================================
// Headless Halftone pipeline (personal AI tooling — NOT part of the app bundle).
// Image file -> 1-bit round/block-dot halftone PNG, reusing the app's own seams:
// sharp decodes + contains the source into the SAME 480-long-edge aspect frame
// sourceToGrid uses, then the repo's `downscale` (area-average), `toneLut`, and the
// app's print screens (core/print-screen) produce the PNG — the app's pipeline
// from the frame onward (the only divergence is sharp-vs-Chromium resampling of
// the source INTO the frame, sub-pixel only). Halftone exclusively by design.
// =============================================================================
import sharp from 'sharp';
import {
  computeGrid,
  MAX_CONTRAST,
  PALETTE_IDS,
  type AspectId,
  type PaletteId,
} from '../../src/core/dither-constants';
import { downscale } from '../../src/core/downscale';
import { applyToneLut, GAMMA_MAX, GAMMA_MIN, isNeutralTone, toneLut } from '../../src/core/tone';
import { CELL_RENDER_SCALE } from '../../src/core/scene-resolver';
import { paletteRgbAt, paletteLength, quantizeContrast } from '../../src/core/dither-constants';
import { encodeIndexedPng } from '../../src/core/png-indexed';
import { renderPrintScreen, SCREEN_LOOK_DEFAULT } from '../../src/core/print-screen';
import { printFrameToRaster } from '../../src/core/scene-screen';
import { gridToBase } from '../../src/state/stage-store';
import {
  HALFTONE_DENSITY_MAX,
  HALFTONE_DENSITY_MIN,
  HALFTONE_SIZE_MAX,
  HALFTONE_SIZE_MIN,
} from '../../src/core/cell-style';
import type { Rgb } from '../../src/core/color';
import { targetFrame } from '../../src/ui/image-to-grid';

/** The app's fixed aspect frames, plus 'auto' = follow the source's own aspect
 *  (headless-only convenience; the app itself offers the three fixed frames). */
export type HeadlessAspect = AspectId | 'auto';

/** Long-edge resolution of the 'auto' pre-downscale frame — must equal
 *  image-to-grid's PREVIEW_MAX (private; fixed aspects reuse `targetFrame`
 *  directly, and the drift-pin test asserts this constant stays in step). */
export const FRAME_LONG_EDGE = 480;

export interface HalftoneRenderOptions {
  /** Absolute path to the source image (anything sharp decodes: png/jpg/webp/svg…). */
  input: string;
  /** Colour ramp. 'two' = the 1-bit Mono look (UI ranges in parentheses below). */
  palette?: PaletteId; // default 'two'
  contrast?: number; // 0.5..2.5 (UI), default 1
  invert?: boolean; // default false
  gamma?: number; // 0.4..2.5, default 1 (pre-dither tone)
  black?: number; // 0..120, default 0 (levels black point)
  white?: number; // 135..255, default 255 (levels white point)
  cellSize?: number; // 2..14, default 5 — the "Pixel" dial; sets grid granularity
  shape?: 'round' | 'block'; // dot shape, default 'round'
  dotSize?: number; // 1..32 px diameter, default 10
  tonal?: boolean; // default true — dots grow in brighter areas
  density?: number; // 1..20 (sparse..cluster), default 10 — lattice spacing
  angle?: number; // 0..90 degrees, default 45 — the dot screen's angle (like a print ink)
  aspect?: HeadlessAspect; // default 'auto'
  /** Flat background '#rrggbb'; omitted = transparent PNG. */
  background?: string;
  /** Dot ink '#rrggbb'; omitted = the palette's brightest shade. */
  ink?: string;
}

export interface HalftoneRenderResult {
  /** Raw bytes of the indexed PNG. */
  png: Uint8Array;
  /** Output pixel dimensions (grid cells x CELL_RENDER_SCALE). */
  width: number;
  height: number;
  /** Grid resolution in cells. */
  LW: number;
  LH: number;
  /** The aspect frame the source was contained into. */
  targetW: number;
  targetH: number;
}

/** Strict '#rrggbb' parser — throws on anything else (a silent fallback would
 *  render confusingly). Deliberately NOT core's lenient hexToRgb (color.ts). */
export function parseHexColor(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Expected a '#rrggbb' hex colour, got '${hex}'`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Frame dimensions for an aspect: the app's three fixed frames (via the app's
 *  own `targetFrame`), or the source's aspect at the same long edge for 'auto'. */
export function headlessFrame(
  aspect: HeadlessAspect,
  srcW: number,
  srcH: number,
): { targetW: number; targetH: number } {
  if (aspect !== 'auto') return targetFrame(aspect);
  return {
    targetW:
      srcW >= srcH ? FRAME_LONG_EDGE : Math.max(1, Math.round((FRAME_LONG_EDGE * srcW) / srcH)),
    targetH:
      srcH >= srcW ? FRAME_LONG_EDGE : Math.max(1, Math.round((FRAME_LONG_EDGE * srcH) / srcW)),
  };
}

/** Decode an image file and render it as a halftone PNG via the one dither seam. */
export async function renderHalftone(opts: HalftoneRenderOptions): Promise<HalftoneRenderResult> {
  const palette = opts.palette ?? 'two';
  if (!PALETTE_IDS.includes(palette)) {
    throw new Error(`Unknown palette '${palette}' (valid: ${PALETTE_IDS.join(', ')})`);
  }
  const contrast = clamp(opts.contrast ?? 1, 0, MAX_CONTRAST);
  const gamma = clamp(opts.gamma ?? 1, GAMMA_MIN, GAMMA_MAX);
  const black = clamp(Math.round(opts.black ?? 0), 0, 254);
  const white = clamp(Math.round(opts.white ?? 255), black + 1, 255);
  const cellSize = clamp(Math.round(opts.cellSize ?? 5), 2, 14);
  const shape = opts.shape ?? 'round';
  const dotSize = clamp(Math.round(opts.dotSize ?? 10), HALFTONE_SIZE_MIN, HALFTONE_SIZE_MAX);
  const density = clamp(Math.round(opts.density ?? 10), HALFTONE_DENSITY_MIN, HALFTONE_DENSITY_MAX);
  const angle = clamp(opts.angle ?? 45, 0, 90);
  const background: Rgb | null = opts.background ? parseHexColor(opts.background) : null;
  const ink: Rgb = opts.ink
    ? parseHexColor(opts.ink)
    : paletteRgbAt(palette, paletteLength(palette) - 1);

  // Browsers apply EXIF orientation and colour-manage ICC-tagged sources to
  // sRGB before the app's canvas ever sees them — mirror both here, or phone
  // photos render sideways/tonally shifted vs the app. autoOrient() rotates
  // the pixels; meta.autoOrient carries the post-rotation dimensions;
  // keepIccProfile() makes sharp import tagged pixels through their profile
  // (sRGB-converted bytes out; untagged inputs pass through untouched).
  const meta = await sharp(opts.input).metadata();
  const srcW = meta.autoOrient?.width ?? meta.width;
  const srcH = meta.autoOrient?.height ?? meta.height;
  if (!srcW || !srcH) throw new Error(`Could not read dimensions of ${opts.input}`);
  const { targetW, targetH } = headlessFrame(opts.aspect ?? 'auto', srcW, srcH);

  // Contain the source into the transparent aspect frame (the app leaves
  // off-frame space alpha-0; 'contain' with a transparent background matches).
  const frame = await sharp(opts.input)
    .autoOrient()
    .keepIccProfile()
    .ensureAlpha()
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer();

  const { LW, LH } = computeGrid(targetW, targetH, cellSize);
  const rgba = downscale(
    new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length),
    targetW,
    targetH,
    LW,
    LH,
  );
  const tone = { gamma, black, white };
  if (!isNeutralTone(tone)) applyToneLut(rgba, toneLut(tone));

  // One layer through the app's print screens: the treated tones (contrast +
  // invert, exactly as the app's photo treatment), its own dot screen, one ink.
  const base = gridToBase(rgba, LW, LH, quantizeContrast(contrast), opts.invert ?? false);
  const frameOut = renderPrintScreen({
    layers: [
      {
        raster: { w: LW, h: LH, tones: base.tones, covered: base.covered },
        placement: { x: LW / 2, y: LH / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        look: {
          ...SCREEN_LOOK_DEFAULT,
          style: 'halftone',
          shape: shape === 'block' ? 'square' : 'circle',
          dotSize,
          density,
          tonal: opts.tonal ?? true,
          angle,
          colour: { mode: 'ink', ink },
        },
      },
    ],
    dims: { w: LW, h: LH },
    scale: CELL_RENDER_SCALE,
    background,
  });
  const r = printFrameToRaster(frameOut);
  const png = encodeIndexedPng(r.buf, r.palette, r.trns);

  return {
    png,
    width: LW * CELL_RENDER_SCALE,
    height: LH * CELL_RENDER_SCALE,
    LW,
    LH,
    targetW,
    targetH,
  };
}
