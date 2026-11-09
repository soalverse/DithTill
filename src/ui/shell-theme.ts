import type { CSSProperties } from 'react';
import { PALETTES, paletteLength, paletteRgbAt, type PaletteId } from '../core/dither-constants';

// Shell themes: each tints ALL the on-screen text, borders and glow
// like a real CRT phosphor — not just the highlight colour (the radio-era moods only
// re-tinted the accent on the black screen, so they barely differed). Applied to the
// whole page (<html>), so pop-ups follow the theme too. The original radio body lives
// on in the `legacy` branch.

type Rgb = readonly [number, number, number];

export interface Theme {
  id: string;
  name: string;
  /** The phosphor: body text, borders, rails. */
  ink: Rgb;
  /** The glow under the text. */
  glow: Rgb;
  /** The highlight: selected / active things. */
  accent: Rgb;
  /** Deep end of the accent (pressed buttons). */
  accentDeep: Rgb;
  /** Text ON the accent. */
  accentInk: Rgb;
}

export const THEMES: Theme[] = [
  {
    id: 'amber',
    name: 'Amber',
    ink: [255, 222, 176],
    glow: [255, 170, 40],
    accent: [255, 176, 0],
    accentDeep: [214, 136, 0],
    accentInk: [26, 16, 0],
  },
  {
    id: 'green',
    name: 'Green screen',
    ink: [168, 255, 184],
    glow: [60, 255, 110],
    accent: [70, 255, 120],
    accentDeep: [30, 200, 80],
    accentInk: [0, 26, 8],
  },
  {
    id: 'violet',
    name: 'Soalverse violet',
    ink: [222, 210, 255],
    glow: [150, 110, 255],
    accent: [168, 128, 255],
    accentDeep: [124, 84, 230],
    accentInk: [18, 8, 31],
  },
  {
    id: 'ice',
    name: 'Ice',
    ink: [206, 250, 255],
    glow: [70, 225, 255],
    accent: [80, 232, 255],
    accentDeep: [30, 186, 214],
    accentInk: [0, 22, 26],
  },
  {
    id: 'rose',
    name: 'Rose',
    ink: [255, 214, 232],
    glow: [255, 95, 168],
    accent: [255, 100, 172],
    accentDeep: [222, 56, 138],
    accentInk: [31, 0, 16],
  },
];

/** What "Match my canvas" shows for a grey palette: a neutral white phosphor. */
const NEUTRAL: Theme = {
  id: 'neutral',
  name: 'Neutral',
  ink: [208, 217, 232],
  glow: [180, 205, 255],
  accent: [255, 255, 255],
  accentDeep: [196, 210, 232],
  accentInk: [10, 14, 20],
};

/** The automatic theme's id: tints the UI from the canvas palette. */
export const MATCH_CANVAS = 'canvas';
export const THEME_DEFAULT = 'amber';

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const sat = (c: Rgb): number => Math.max(...c) - Math.min(...c);
const lum = (c: Rgb): number => (c[0] * 77 + c[1] * 150 + c[2] * 29) / 256;

/** "Match my canvas": the accent = the palette's most colourful bright shade, the ink a
 *  pale version of it; a grey palette (Mono / two-tone) has no colour to match, so it reads
 *  as a neutral white (not offered on its own). */
export function canvasTheme(palette: PaletteId): Theme {
  if (!PALETTES[palette]) return { ...THEMES[0], id: MATCH_CANVAS, name: 'Match my canvas' };
  const n = paletteLength(palette);
  const shades = Array.from({ length: n }, (_, i) => paletteRgbAt(palette, i) as Rgb);
  const bright = shades.filter((c) => lum(c) >= 90);
  const pick = (bright.length ? bright : shades).reduce((a, b) =>
    sat(b) * (0.5 + lum(b) / 510) > sat(a) * (0.5 + lum(a) / 510) ? b : a,
  );
  if (sat(pick) < 40) return { ...NEUTRAL, id: MATCH_CANVAS, name: 'Match my canvas' };
  // Lift a dark-ish pick so it still glows on black.
  const accent = lum(pick) < 150 ? mix(pick, [255, 255, 255], 0.35) : pick;
  return {
    id: MATCH_CANVAS,
    name: 'Match my canvas',
    ink: mix(accent, [255, 255, 255], 0.62),
    glow: accent,
    accent,
    accentDeep: mix(accent, [0, 0, 0], 0.2),
    accentInk: mix(accent, [0, 0, 0], 0.88),
  };
}

/** The theme for an id (the canvas one needs the current palette). */
export function resolveTheme(id: string, palette: PaletteId): Theme {
  if (id === MATCH_CANVAS) return canvasTheme(palette);
  return THEMES.find((t) => t.id === id) ?? (THEMES[0] as Theme);
}

const rgb = (c: Rgb): string => `${c[0]}, ${c[1]}, ${c[2]}`;
const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Every CSS variable a theme drives (the phosphor tokens + the older names the shared
 *  deck styles still read). Set on <html> so portaled pop-ups inherit them. */
export function themeVars(t: Theme): Record<`--${string}`, string> {
  return {
    '--phos-rgb': rgb(t.ink),
    '--glow-rgb': rgb(t.glow),
    '--accent-rgb': rgb(t.accent),
    '--phos': hex(t.ink),
    '--phos-dim': `rgba(${rgb(t.ink)}, 0.62)`,
    '--phos-faint': `rgba(${rgb(t.ink)}, 0.16)`,
    '--phos-glow': `0 0 6px rgba(${rgb(t.glow)}, 0.45)`,
    '--accent': hex(t.accent),
    '--accent-deep': hex(t.accentDeep),
    '--accent-ink': hex(t.accentInk),
    '--led-glow': `rgba(${rgb(t.accent)}, 0.85)`,
    '--ink': hex(t.ink),
    '--sub': `rgba(${rgb(t.ink)}, 0.72)`,
    '--deck-label': `rgba(${rgb(t.ink)}, 0.5)`,
    '--sage': `rgba(${rgb(t.ink)}, 0.62)`,
    '--jungle': `rgba(${rgb(t.ink)}, 0.62)`,
    '--rim': `rgba(${rgb(t.ink)}, 0.18)`,
    '--mango': hex(t.accent),
    '--papaya': hex(t.accent),
  };
}

/** A theme's swatch colour for the picker. */
export const themeSwatch = (t: Theme): string => hex(t.accent);

// React allows CSS custom properties on `style`; this keeps them type-safe.
export type CSSVars = CSSProperties & Record<`--${string}`, string>;

// Persist the theme by id; plain localStorage (the app deliberately has no
// store-persistence middleware to piggyback on).
export const THEME_KEY = 'dithtill:theme';

export function loadTheme(): string {
  try {
    const id = localStorage.getItem(THEME_KEY);
    return id && (id === MATCH_CANVAS || THEMES.some((t) => t.id === id)) ? id : THEME_DEFAULT;
  } catch {
    return THEME_DEFAULT;
  }
}

/** The palette ids, for the canvas swatch's preview strip. */
export const paletteStrip = (p: PaletteId): string[] =>
  !PALETTES[p]
    ? []
    : Array.from({ length: Math.min(4, PALETTES[p].length / 3) }, (_, i) =>
        hex(paletteRgbAt(p, Math.round((i * (paletteLength(p) - 1)) / 3)) as Rgb),
      );

// ⚙ ▸ Credits & licences. The full list is THIRD-PARTY-NOTICES.md, generated.
export const CREDITS = {
  byline: 'DithTill by Soalverse · Apache-2.0',
  eyebrow: 'Who made what · v1',
  intro:
    'DithTill is built on the work of people who gave theirs away, so that people like us could make something with it. None of this would feel the way it does without them.',
  entries: [
    {
      name: 'U-2-Net, by Xuebin Qin et al.',
      does: 'Finds the subject of your photo, so that Cut out knows what to keep, on your own machine.',
    },
    { name: 'ONNX Runtime', does: 'Runs U-2-Net, with no help from the internet.' },
    { name: 'FilmCraft', does: 'Makes the MP4s and reads your videos, in pure Rust.' },
    { name: 'Tauri', does: 'Turns all of this into a desktop app.' },
    { name: 'React', does: 'Draws every button you are looking at.' },
    { name: 'Konva', does: 'Gives your layers their drag handles.' },
    { name: 'zustand', does: 'Remembers what you are doing, so that Undo can forget it.' },
    {
      name: 'Archivo, DM Mono, VT323 (OFL-1.1)',
      does: 'The letters. You are reading VT323 right now.',
    },
  ],
  rest: 'The other 500-odd packages are named one by one in THIRD-PARTY-NOTICES.md, with their licences. It comes with the app and with the code.',
};

// Help: nine short topics on the Help card, every line in capitals.
export const HELP_TOPICS = [
  {
    id: 'layers',
    label: 'Layers',
    lines: [
      '+ ADDS A DRAWING, PHOTO OR VIDEO, VISUALIZER, TEXT OR TRACK',
      'CLICK A ROW TO PICK IT · DRAG ROWS TO REORDER',
      'RIGHT-CLICK A ROW: SHOW / HIDE · DUPLICATE · DELETE',
      'WHOLE CANVAS = NO LAYER PICKED: ITS MOVES AND EFFECTS ARE FOR EVERYTHING',
      'EACH LAYER KEEPS ITS OWN LOOK, MOVES AND EFFECTS',
      'CLEAR ALL (CLICK TWICE) EMPTIES THE CANVAS · UNDO BRINGS IT BACK',
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    lines: [
      'DRAW · ERASE · MOVE AT THE TOP LEFT',
      'SIZE = THE BRUSH · SHADE = HOW BRIGHT IT PAINTS',
      'ERASE WITH A PHOTO PICKED CUTS IT OUT',
      'MOVE: DRAG, SCALE AND TURN A LAYER · HOLD ALT TO PLACE IT FREELY',
      '↶ ↷ UNDO AND REDO EVERY EDIT',
    ],
  },
  {
    id: 'look',
    label: 'Look',
    lines: [
      'PALETTE = THE COLOURS · STYLE = DITHER BITS OR HALFTONE DOTS',
      'PATTERN = HOW THE BITS SIT · BLUE STAYS CALM WHEN THINGS MOVE',
      'DOT SIZE · DENSITY · TONAL = DOTS GROW IN THE BRIGHT PARTS',
      'TONAL OFF: SAME-SIZE DOTS · ITS PATTERN PICKS WHICH SHOW',
      'DRIFT SLIDES THE DOTS OVER A STILL PICTURE · DIRECTION SETS THE WAY',
      '▸ MORE: ANGLE · DOTS TURN + GROW WITH THE LAYER',
      'DETAIL · ASPECT · BG ARE FOR THE WHOLE CANVAS',
    ],
  },
  {
    id: 'animate',
    label: 'Animate',
    lines: [
      '+ ADD MOVE: DRIFT, BOB, SPIN, BOUNCE, BLINK… OR A HIT ON THE SOUND',
      '∿ ON ANY SLIDER MAKES IT MOVE',
      'BEAT = IN TIME WITH THE TEMPO · SOUND = FOLLOWS THE MUSIC',
      'FRAME DOTS = DRAW ITS LINE ON A TIMELINE LANE (DOUBLE-CLICK ADDS A DOT)',
      '✕ ON A MOVE STOPS IT · ON WHOLE CANVAS THEY MOVE EVERYTHING',
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    lines: [
      '+ ADD EFFECT, UNDER EFFECTS IN ANIMATE',
      'MIRROR · KALEIDOSCOPE · WAVE · BLUR · POSTERIZE · OUTLINE',
      'TRAIL: ECHO = FADING COPIES · SMEAR = A LONG EXPOSURE',
      'EVERY AMOUNT CAN MOVE WITH ∿',
      'ON WHOLE CANVAS THEY WORK ON THE WHOLE PICTURE',
      '✕ REMOVES ONE',
    ],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    lines: [
      'ANIMATE ▸ TIMELINE OPENS IT · ▶ PLAYS',
      '● RECORDS A TAKE: DRAW OR MOVE WHILE IT PLAYS',
      'DRAWING WHILE RECORDING MAKES A ● RECORDING · PICK ONE TO ADD A TAKE',
      'THE CHIP ON ITS BAR: ⟳ REPEAT OR ▬ HOLD · RIGHT-CLICK TO MERGE, REVERSE OR KEEP AS DRAWING',
      'TEMPO IN BPM · TAP IT, OR DETECT IT FROM THE TRACK',
      'LOOP LENGTH IN BARS · EACH LAYER IS A CLIP YOU CAN DRAG',
      'S SPLITS A CLIP AT THE PLAYHEAD',
      'DRAG ALONG THE RULER TO MARK A PART · PLAY REPEATS IT',
    ],
  },
  {
    id: 'sound',
    label: 'Sound',
    lines: [
      'LAYERS + ▸ TRACK ADDS A SONG',
      'DETECT LINES BAR 1 UP WITH ITS FIRST BEAT',
      'VISUALIZERS AND SOUND MOVES REACT TO THE TRACK',
      'SOUND / MUTED (TOP RIGHT) TURNS WHAT YOU HEAR ON OR OFF',
      'AN MP4 EXPORT CARRIES THE SOUND',
    ],
  },
  {
    id: 'save',
    label: 'Save + export',
    lines: [
      'IT SAVES ITSELF AS YOU WORK',
      'PROJECT ▾: NEW · BACK UP AS FILE · OPEN FILE',
      'SAVE TO LIBRARY KEEPS THIS PICTURE TO USE IN OTHER PROJECTS',
      'EXPORT PNG · SVG · VIDEO (MP4 OR GIF)',
      'A MARKED PART EXPORTS JUST THAT PART',
      'LIBRARY = ALL YOUR PROJECTS AND SAVED PIECES',
    ],
  },
  {
    id: 'keys',
    label: 'Keys',
    lines: [
      'ESC: HELP ON / OFF (CLOSES AN OPEN MENU FIRST)',
      'H: HIDE / SHOW THE UI',
      'S: SPLIT THE PICKED CLIP AT THE PLAYHEAD',
      'DELETE: DELETE THE PICKED CLIP',
      'ALT WHILE MOVING: PLACE FREELY',
      'SHIFT AS A TAKE ENDS: KEEP ITS EXACT LENGTH',
      'SHIFT WHILE MARKING A PART: NO SNAPPING',
    ],
  },
] as const;

/** The theme's accent for canvas-drawn overlays (Konva can't read CSS variables):
 *  read live from <html>, Amber before the shell has applied a theme. */
export function uiAccent(alpha = 1): string {
  const rgbStr =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  return `rgba(${rgbStr || '255, 176, 0'}, ${alpha})`;
}
