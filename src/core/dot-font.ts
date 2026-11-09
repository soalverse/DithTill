// =============================================================================
// The dot-matrix text alphabet ("halftone font — just pure
// dots"). Our OWN LED-sign letters — owner-made content, no font file, no licence —
// each a 5-dot-wide grid on a 9-row cell: capitals + digits sit on rows 0–6 (the
// baseline is row 6), lowercase has a 5-row x-height (rows 2–6) and descenders drop to
// rows 7–8. A text layer's raster is laid out here as a PURE function of its config:
// one dot = one canvas cell, and a bigger Size SPREADS the dots (same dot, wider pitch)
// instead of growing them, so the letters stay pure dots in every canvas mode. The dots
// are bright tone on a transparent ground and flow through the ONE resolveSceneGrid
// dither like any layer (preview == export).
// =============================================================================
import type { CachedAsset } from './scene-resolver';

export type TextAlign = 'left' | 'center' | 'right';

export interface TextLayerConfig {
  /** What it says. Line breaks start new lines; characters outside the alphabet are blank. */
  text: string;
  /** Dot pitch in canvas cells: 1 = dots touching, bigger = the same dots spread apart. */
  size: number;
  /** Empty dot columns between letters. */
  spacing: number;
  /** How lines of different lengths line up. */
  align: TextAlign;
}

export const TEXT_DEFAULT: TextLayerConfig = {
  text: 'HELLO',
  size: 3,
  spacing: 1,
  align: 'center',
};

export const TEXT_SIZE_MAX = 10;
export const TEXT_SPACING_MAX = 4;
/** The longest text a layer keeps (a big paste can't stall the canvas). */
export const TEXT_MAX_CHARS = 500;

/** Glyph width and full cell height, in dots. */
export const GLYPH_W = 5;
export const GLYPH_H = 9;
/** Empty dot rows between lines (on top of the 2 descender rows). */
const LINE_GAP = 1;
/** The tone of a lit dot — full brightness, like the brush at 100%. */
const DOT_TONE = 255;

// Rows top-down, '#' = a dot. Capitals/digits/punctuation give 7 rows (the descender
// rows are blank); lowercase and the comma give up to 9.
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],

  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.#...'],
  g: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '#...#', '#...#', '####.', '#....', '#....'],
  q: ['.....', '.....', '.####', '#...#', '#...#', '#...#', '.####', '....#', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.###.', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '###..', '.#...', '.#...', '.#..#', '..##.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '#...#', '#...#', '.####', '....#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],

  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],

  ' ': [],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..', '..#..', '.#...'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  "'": ['..#..', '..#..', '.#...'],
  '"': ['.#.#.', '.#.#.', '.#.#.'],
  '-': ['.....', '.....', '.....', '.###.'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '@': ['.###.', '#...#', '....#', '.##.#', '#.#.#', '#.#.#', '.###.'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..'],
  '=': ['.....', '.....', '#####', '.....', '#####'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
};

/** Every character the alphabet draws (anything else is a blank of the same width). */
export const DOT_FONT_CHARS: string = Object.keys(GLYPHS).join('');

/** The dot rows of one character ('' for an unknown one). */
export function glyphRows(ch: string): readonly string[] {
  return GLYPHS[ch] ?? [];
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/** Normalise a config (clamped Size/Spacing, capped length, \r\n → \n). */
export function normalizeText(cfg: TextLayerConfig): TextLayerConfig {
  return {
    text: String(cfg.text ?? '')
      .replace(/\r\n?/g, '\n')
      .slice(0, TEXT_MAX_CHARS),
    size: clampInt(cfg.size, 1, TEXT_SIZE_MAX),
    spacing: clampInt(cfg.spacing, 0, TEXT_SPACING_MAX),
    align: cfg.align === 'left' || cfg.align === 'right' ? cfg.align : 'center',
  };
}

/**
 * Lay the text out as a tone raster: lit dots = bright tone + covered, everything else
 * transparent. Dot (dx, dy) lands on cell (dx·size, dy·size), so the raster is
 * `(dotsW − 1)·size + 1` cells wide. Empty text = one transparent cell.
 */
export function renderTextRaster(config: TextLayerConfig): CachedAsset {
  const cfg = normalizeText(config);
  const lines = cfg.text.split('\n');
  const advance = GLYPH_W + cfg.spacing;
  const lineDots = (line: string) => (line.length === 0 ? 0 : line.length * advance - cfg.spacing);
  const dotsW = Math.max(1, ...lines.map(lineDots));
  const dotsH = lines.length * GLYPH_H + (lines.length - 1) * LINE_GAP;
  const pitch = cfg.size;
  const w = (dotsW - 1) * pitch + 1;
  const h = (dotsH - 1) * pitch + 1;
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h);
  lines.forEach((line, li) => {
    const free = dotsW - lineDots(line);
    const x0 = cfg.align === 'left' ? 0 : cfg.align === 'right' ? free : Math.floor(free / 2);
    const y0 = li * (GLYPH_H + LINE_GAP);
    for (let c = 0; c < line.length; c++) {
      const rows = glyphRows(line[c]);
      for (let gy = 0; gy < rows.length; gy++) {
        const row = rows[gy];
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (row[gx] !== '#') continue;
          const i = (y0 + gy) * pitch * w + (x0 + c * advance + gx) * pitch;
          tones[i] = DOT_TONE;
          covered[i] = 1;
        }
      }
    }
  });
  return { w, h, tones, covered };
}
