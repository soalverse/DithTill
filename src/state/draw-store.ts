import { create } from 'zustand';
import {
  ASPECT_RATIO,
  computeGrid,
  FRAME_LONG,
  type AspectId,
  type MatrixId,
  type PaletteId,
} from '../core/dither-constants';
import type { Composite } from '../core/composite';
import type { Swatch } from '../core/color';
import { stampLine } from '../core/raster-brush';
import { useStageStore } from './stage-store';

// =============================================================================
// Mode 02 "Draw" state (Group C). A blank doc-space dither canvas. Each cell
// stores the painted TONE (0..255) + a covered flag — palette + matrix are LIVE
// display params (the same model as Burn): turning the Palette knob recolours the
// whole drawing, changing the Matrix re-dithers it, and the tone is dithered in
// DOC space (so the Bayer pattern never crawls). Empty cells are transparent
// (the black CRT glass shows through → drawing reads as glowing phosphor), and
// export marks them tRNS-transparent. The doc shape follows the shared device
// aspect (Burn's aspect), so the glass never reshapes on a mode switch.
// =============================================================================

/** Doc cells on the long edge (the short edge follows the aspect ratio). */
export const DRAW_LONG = 128;
const MAX_HISTORY = 24;

/** Make canvas tools: paint, erase, or MOVE the imported image (reframe). */
export type DrawTool = 'brush' | 'eraser' | 'move';

/** The Make canvas grid: the aspect frame (FRAME_LONG on the long edge)
 *  divided by the Pixel cell size — EXACTLY the grid Burn's glass always showed
 *  (`computeGrid` via sourceToGrid), so an imported image, the strokes and a saved
 *  element all live on one grid with no re-sample. */
export function makeDims(aspect: AspectId, cellSize: number): { w: number; h: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  const targetW = rw >= rh ? FRAME_LONG : Math.round((FRAME_LONG * rw) / rh);
  const targetH = rh >= rw ? FRAME_LONG : Math.round((FRAME_LONG * rh) / rw);
  const { LW, LH } = computeGrid(targetW, targetH, cellSize);
  return { w: LW, h: LH };
}

/** Nearest re-grid of a per-cell plane (a Pixel change with strokes, confirm-armed). */
export function regridPlane(
  src: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / w));
      out[y * w + x] = src[sy * sw + sx];
    }
  }
  return out;
}

/** Doc dimensions for an aspect (long edge = DRAW_LONG). */
export function docDims(aspect: AspectId): { w: number; h: number } {
  const { w: rw, h: rh } = ASPECT_RATIO[aspect];
  return rw >= rh
    ? { w: DRAW_LONG, h: Math.round((DRAW_LONG * rh) / rw) }
    : { w: Math.round((DRAW_LONG * rw) / rh), h: DRAW_LONG };
}

interface Snapshot {
  tones: Uint8Array;
  covered: Uint8Array;
}
function blank(w: number, h: number): Snapshot {
  return { tones: new Uint8Array(w * h), covered: new Uint8Array(w * h) };
}

interface DrawState {
  tool: DrawTool;
  size: number; // brush radius in cells
  shade: number; // 0..1 tone painted into covered cells
  matrix: MatrixId; // live: re-dithers the doc
  palette: PaletteId; // live: recolours the doc
  /** Canvas background: a Swatch — a palette shade
   *  index (tracks the palette) | a custom `[r,g,b]` (pinned) | null = transparent.
   *  Flat colour, never dithered. Live param like palette. */
  background: Swatch;
  w: number;
  h: number;
  tones: Uint8Array;
  covered: Uint8Array;
  rev: number; // bumps when the DISPLAY must refresh (paint / undo / palette / matrix)
  histIndex: number;
  history: Snapshot[];
  setTool: (t: DrawTool) => void;
  setSize: (n: number) => void;
  setShade: (s: number) => void;
  setMatrix: (m: MatrixId) => void;
  setPalette: (p: PaletteId) => void;
  setBackground: (b: Swatch) => void;
  /** Resize the doc to the aspect (resets it if the shape changed). */
  ensureAspect: (aspect: AspectId) => void;
  /** Blank the doc to exact dims + reset history, WITHOUT touching the stage base
   *  (used when loading a Library element: the base is set separately). */
  resetDoc: (w: number, h: number) => void;
  /** Re-grid the strokes NEAREST to new dims (a confirmed Pixel change) + reset history. */
  regrid: (w: number, h: number) => void;
  /** Stamp the brush along a doc-space segment (a click is x0==x1). */
  paintLine: (x0: number, y0: number, x1: number, y1: number) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

const initDims = makeDims('landscape', 5); // Burn's default Pixel
const initBlank = blank(initDims.w, initDims.h);

export const useDrawStore = create<DrawState>((set, get) => ({
  tool: 'brush',
  size: 3,
  shade: 0.85,
  matrix: 8,
  palette: 'two',
  background: null,
  w: initDims.w,
  h: initDims.h,
  tones: initBlank.tones,
  covered: initBlank.covered,
  rev: 0,
  histIndex: 0,
  history: [{ tones: initBlank.tones.slice(), covered: initBlank.covered.slice() }],

  setTool: (tool) => set({ tool }),
  setSize: (size) => set({ size }),
  setShade: (shade) => set({ shade }),
  // palette + matrix are live → bump rev so the display re-dithers.
  setMatrix: (matrix) => set((s) => ({ matrix, rev: s.rev + 1 })),
  setPalette: (palette) => set((s) => ({ palette, rev: s.rev + 1 })),
  setBackground: (background) => set((s) => ({ background, rev: s.rev + 1 })),

  ensureAspect: (aspect) => {
    const dims = docDims(aspect);
    const s = get();
    if (s.w === dims.w && s.h === dims.h) return;
    useStageStore.getState().clear(); // the base was sized for the old shape
    const b = blank(dims.w, dims.h);
    set({
      w: dims.w,
      h: dims.h,
      tones: b.tones,
      covered: b.covered,
      history: [{ tones: b.tones.slice(), covered: b.covered.slice() }],
      histIndex: 0,
      rev: s.rev + 1,
    });
  },

  resetDoc: (w, h) => {
    const b = blank(w, h);
    set((s) => ({
      w,
      h,
      tones: b.tones,
      covered: b.covered,
      history: [{ tones: b.tones.slice(), covered: b.covered.slice() }],
      histIndex: 0,
      rev: s.rev + 1,
    }));
  },

  regrid: (w, h) => {
    const s = get();
    if (s.w === w && s.h === h) return;
    const tones = regridPlane(s.tones, s.w, s.h, w, h);
    const covered = regridPlane(s.covered, s.w, s.h, w, h);
    set({
      w,
      h,
      tones,
      covered,
      history: [{ tones: tones.slice(), covered: covered.slice() }],
      histIndex: 0,
      rev: s.rev + 1,
    });
  },

  paintLine: (x0, y0, x1, y1) => {
    const s = get();
    // The shared brush stamps the same { w, h, tones, covered } the store holds.
    if (s.tool === 'move') return; // Move reframes the image; it never paints
    stampLine(s, x0, y0, x1, y1, { tool: s.tool, size: s.size, shade: s.shade });
    set((st) => ({ rev: st.rev + 1 }));
  },

  commit: () =>
    set((s) => {
      const snap = { tones: s.tones.slice(), covered: s.covered.slice() };
      const history = s.history.slice(0, s.histIndex + 1);
      history.push(snap);
      while (history.length > MAX_HISTORY) history.shift();
      return { history, histIndex: history.length - 1 };
    }),

  undo: () =>
    set((s) => {
      if (s.histIndex <= 0) return {};
      const i = s.histIndex - 1;
      const snap = s.history[i];
      return {
        tones: snap.tones.slice(),
        covered: snap.covered.slice(),
        histIndex: i,
        rev: s.rev + 1,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.histIndex >= s.history.length - 1) return {};
      const i = s.histIndex + 1;
      const snap = s.history[i];
      return {
        tones: snap.tones.slice(),
        covered: snap.covered.slice(),
        histIndex: i,
        rev: s.rev + 1,
      };
    }),

  clear: () => {
    const s = get();
    const b = blank(s.w, s.h);
    set({ tones: b.tones, covered: b.covered, rev: s.rev + 1 });
    get().commit();
  },
}));

/** The SINGLE per-cell resolver for the Draw composite (stage base + strokes),
 *  used by BOTH the live canvas and the exporter so flatten == preview. Stroke
 *  wins on top; the base shows through gaps; else transparent. */
export function resolveCell(i: number): { tone: number; fine: number; covered: number } {
  const d = useDrawStore.getState();
  if (d.covered[i]) return { tone: d.tones[i], fine: 0, covered: 1 };
  const s = useStageStore.getState();
  if (s.baseCovered && s.w === d.w && s.h === d.h && s.baseCovered[i]) {
    return { tone: s.baseTones![i], fine: s.baseFine ? s.baseFine[i] : 0, covered: 1 };
  }
  return { tone: 0, fine: 0, covered: 0 };
}

/** Flatten the live stage (base + strokes) into a standalone Composite raster via
 *  the SAME resolveCell, DEEP-COPIED so it can't alias the still-mutating doc.
 *  Used by the Draw export and "Add to Library" — flatten == preview. */
export function snapshotComposite(): Composite {
  const { w, h } = useDrawStore.getState();
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h);
  const fine = new Uint8Array(w * h);
  let anyFine = false;
  for (let i = 0; i < w * h; i++) {
    const c = resolveCell(i);
    if (c.covered) {
      covered[i] = 1;
      tones[i] = c.tone;
      fine[i] = c.fine;
      if (c.fine) anyFine = true;
    }
  }
  // An all-zero fine plane is omitted: the composite is then byte-identical to the old
  // 8-bit shape (a strokes-only canvas, a v4 element).
  return anyFine ? { w, h, tones, covered, fine } : { w, h, tones, covered };
}
