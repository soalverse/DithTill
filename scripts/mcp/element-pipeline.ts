// =============================================================================
// Headless save_to_library (AI-3 — personal AI tooling, NOT app code).
// An AI-authored SVG/PNG becomes a real Library element through the app's OWN
// Burn intake seams: sharp fronts the decode (EXIF/ICC like the app's canvas),
// the source is contained into the 480 aspect frame, area-averaged down to the
// element DOC grid (DRAW_LONG = 128, exactly sourceToDocGrid's output shape),
// toned (gamma/levels), then gridToBase bakes contrast/invert into per-cell
// tones — the SAME element shape Burn's "Add to Library" mints. The record +
// blobs come from core/library.buildElement (content-addressed ids) and land as
// a hash-verified element file (core/element-file) in the app's library-inbox,
// where the app ingests it on next Library open.
// =============================================================================
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  ASPECT_IDS,
  MATRIX_IDS,
  PALETTE_IDS,
  quantizeContrast,
  MAX_CONTRAST,
  type AspectId,
  type MatrixId,
  type PaletteId,
} from '../../src/core/dither-constants';
import { downscale } from '../../src/core/downscale';
import { applyToneLut, GAMMA_MAX, GAMMA_MIN, isNeutralTone, toneLut } from '../../src/core/tone';
import { gridToBase } from '../../src/state/stage-store';
import { encodeCompositePng, type Composite } from '../../src/core/composite';
import { buildElement, type CompositeLook } from '../../src/core/library';
import {
  encodeElementFile,
  ELEMENT_FILE_SUFFIX,
  type ElementFileJson,
} from '../../src/core/element-file';
import {
  CELL_STYLE_DEFAULT,
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_DENSITY_MAX,
  HALFTONE_DENSITY_MIN,
  HALFTONE_SIZE_DEFAULT,
  HALFTONE_SIZE_MAX,
  HALFTONE_SIZE_MIN,
  type CellStyle,
} from '../../src/core/cell-style';
import type { Swatch } from '../../src/core/color';
import { targetFrame } from '../../src/ui/image-to-grid';
import { parseHexColor } from './halftone-pipeline';

/** Elements are captured at the app's doc resolution (draw-store DRAW_LONG). */
export const ELEMENT_DOC_LONG = 128;
/** The app's Library bake scale (ui/library-actions BAKE_SCALE). */
export const ELEMENT_BAKE_SCALE = 6;
/** Thumbnails mirror the app's crisp ×2 render (THUMB_SRC_SCALE). */
const THUMB_SRC_SCALE = 2;

/** The active-look cell styles (the app's picker); the retired styles stay
 *  render-only for old scenes and are not mintable here. */
export const LOOK_CELL_STYLES = ['square', 'round', 'block'] as const;

export interface SaveElementOptions {
  /** Absolute path to the source image (anything sharp decodes: svg/png/jpg…). */
  input: string;
  aspect?: AspectId; // default 'square'
  palette?: PaletteId; // default 'two'
  matrix?: MatrixId; // default 8 (the app's default screen)
  contrast?: number; // 0.5..2.5, baked into the tones (Burn treatment)
  invert?: boolean; // baked
  gamma?: number; // pre-dither tone, baked
  black?: number; // levels black point, baked
  white?: number; // levels white point, baked
  // ---- the v4 look blob (travels with the element, NOT baked) ----
  cellStyle?: (typeof LOOK_CELL_STYLES)[number];
  dotDensity?: number;
  dotSize?: number;
  dotGrow?: boolean;
  dotInk?: string; // '#rrggbb'
  background?: string; // '#rrggbb'
  /** Where the element file lands; default = the app's library-inbox. */
  outputDir?: string;
}

export interface SaveElementResult {
  id: string;
  file: string;
  w: number;
  h: number;
  aspect: AspectId;
  neutralLook: boolean;
  bytes: number;
}

/** The app's library-inbox for this OS user — the same folder
 *  platform/library-inbox sweeps (appDataDir of com.soalverse.dithtill). */
export function defaultInboxDir(): string {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return path.join(base, 'com.soalverse.dithtill', 'library-inbox');
}

/** Doc-grid dims for an aspect — sourceToDocGrid's exact output shape (the 480
 *  frame scaled to DRAW_LONG on the long edge). */
export function elementDocDims(aspect: AspectId): { w: number; h: number } {
  const { targetW, targetH } = targetFrame(aspect);
  const k = ELEMENT_DOC_LONG / Math.max(targetW, targetH);
  return { w: Math.round(targetW * k), h: Math.round(targetH * k) };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Render an AI-authored source into a Library element and write it as a
 *  hash-verified element file. Deterministic apart from `createdAt`. */
export async function saveElementFile(opts: SaveElementOptions): Promise<SaveElementResult> {
  const aspect = opts.aspect ?? 'square';
  if (!ASPECT_IDS.includes(aspect)) throw new Error(`unknown aspect '${aspect}'`);
  const palette = opts.palette ?? 'two';
  if (!PALETTE_IDS.includes(palette)) throw new Error(`unknown palette '${palette}'`);
  const matrix = opts.matrix ?? 8;
  if (!MATRIX_IDS.includes(matrix)) throw new Error(`unknown matrix '${matrix}'`);
  const contrast = clamp(opts.contrast ?? 1, 0, MAX_CONTRAST);
  const gamma = clamp(opts.gamma ?? 1, GAMMA_MIN, GAMMA_MAX);
  const black = clamp(Math.round(opts.black ?? 0), 0, 254);
  const white = clamp(Math.round(opts.white ?? 255), black + 1, 255);

  const look: CompositeLook = {
    cellStyle: (opts.cellStyle ?? CELL_STYLE_DEFAULT) as CellStyle,
    dotDensity: clamp(
      Math.round(opts.dotDensity ?? HALFTONE_DENSITY_DEFAULT),
      HALFTONE_DENSITY_MIN,
      HALFTONE_DENSITY_MAX,
    ),
    dotSize: clamp(
      Math.round(opts.dotSize ?? HALFTONE_SIZE_DEFAULT),
      HALFTONE_SIZE_MIN,
      HALFTONE_SIZE_MAX,
    ),
    dotGrow: opts.dotGrow ?? true,
    dotInk: (opts.dotInk ? parseHexColor(opts.dotInk) : null) as Swatch,
    background: (opts.background ? parseHexColor(opts.background) : null) as Swatch,
  };

  // 1. Source → the app's 480 aspect frame (EXIF + ICC fronted like the canvas).
  const { targetW, targetH } = targetFrame(aspect);
  const frame = await sharp(opts.input)
    .autoOrient()
    .keepIccProfile()
    .ensureAlpha()
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer();

  // 2. Area-average down to the element doc grid, then tone (gamma/levels).
  const { w, h } = elementDocDims(aspect);
  const rgba = downscale(
    new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length),
    targetW,
    targetH,
    w,
    h,
  );
  const tone = { gamma, black, white };
  if (!isNeutralTone(tone)) applyToneLut(rgba, toneLut(tone));

  // 3. Bake contrast/invert into per-cell tones — Burn's exact intake transform.
  const { tones, covered, fine } = gridToBase(
    rgba,
    w,
    h,
    quantizeContrast(contrast),
    opts.invert ?? false,
  );
  if (!covered.some((c) => c !== 0)) {
    throw new Error(`source renders fully transparent — nothing to save (${opts.input})`);
  }
  // The exact-luma low byte rides along so the saved element re-dithers
  // bit-for-bit; an all-zero plane is dropped (byte-identical to the old shape).
  const composite: Composite = fine.some((v) => v !== 0)
    ? { w, h, tones, covered, fine }
    : { w, h, tones, covered };

  // 4. Bake the PNG (the content address) + the crisp ×2 thumbnail.
  const png = encodeCompositePng(composite, palette, matrix, ELEMENT_BAKE_SCALE);
  // The baked PNG is a ×6 block upscale; a nearest ×(1/3) decimation of block
  // content is an exact crisp ×2 render — the app's THUMB_SRC_SCALE look.
  const thumbPng = await sharp(Buffer.from(png))
    .resize(w * THUMB_SRC_SCALE, h * THUMB_SRC_SCALE, { kernel: 'nearest' })
    .png()
    .toBuffer();
  const thumbnail = `data:image/png;base64,${thumbPng.toString('base64')}`;

  // 5. Mint the record (content-addressed id) + write the element file.
  const built = await buildElement({
    composite,
    png,
    thumbnail,
    source: 'burn', // the AI enters through the Burn intake transform
    aspect,
    palette,
    matrix,
    look,
    createdAt: Date.now(),
  });
  const dir = opts.outputDir ?? defaultInboxDir();
  await mkdir(dir, { recursive: true });
  const text = encodeElementFile(built);
  const file = path.join(dir, `${built.record.id.slice(0, 24)}${ELEMENT_FILE_SUFFIX}`);
  await writeFile(file, text);
  return {
    id: built.record.id,
    file,
    w,
    h,
    aspect,
    neutralLook: built.record.look === undefined,
    bytes: text.length,
  };
}

/** Re-export the on-disk JSON type for the scene tools' element loading. */
export type { ElementFileJson };
