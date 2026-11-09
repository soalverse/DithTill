import type { PaletteId, PatternId } from '../core/dither-constants';
import type { CellStyle } from '../core/cell-style';

/** Shared display label for a Pattern option (used by every deck).
 *  Bayer sizes read as n×n; the Group G screens and the diffusion recipes read by name. */
export const matrixLabel = (m: PatternId): string => {
  if (m === 'none') return 'None';
  if (typeof m === 'number') return `${m}×${m}`;
  const names: Record<Exclude<PatternId, 'none' | 2 | 4 | 8>, string> = {
    dot: 'Dot',
    lines: 'Lines',
    cross: 'Cross',
    blue: 'Blue',
    floyd: 'Floyd–Steinberg',
    atkinson: 'Atkinson',
    jarvis: 'Jarvis',
    stucki: 'Stucki',
    sierra: 'Sierra',
  };
  return names[m];
};

/** Display label for a palette id — 'two' (the B&W ramp) reads as "Mono". */
export const paletteLabel = (p: PaletteId): string =>
  p === 'two' ? 'Mono' : p.charAt(0).toUpperCase() + p.slice(1);

/** The Cell menu's two MODES (shared by Burn + Record): 'dither' = the classic 1-bit
 *  pixel dither (cellStyle 'square'); 'halftone' = the tonal dots (cellStyle 'round'|'block'),
 *  which then pick a Shape. */
export type CellMode = 'dither' | 'halftone';
export const CELL_MODES: CellMode[] = ['dither', 'halftone'];
export const cellModeLabel = (m: CellMode): string => (m === 'dither' ? 'Dither' : 'Halftone');
/** Halftone dot SHAPE: Circle ('round') or Square ('block'). */
export const SHAPE_STYLES: CellStyle[] = ['round', 'block'];
export const shapeLabel = (s: CellStyle): string => (s === 'block' ? 'Square' : 'Circle');
