// =============================================================================
// Burn parameter store (zustand + immer).
// Chosen on day one so v1's undo/redo (zundo is zustand middleware) and the
// playspace drop in without rewiring. Holds the live dither params (read by both
// the shader and the CPU export) plus display-only UI toggles (crtEffects).
// =============================================================================
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { AspectId, MatrixId, PaletteId } from '../core/dither-constants';
import type { Swatch } from '../core/color';
import {
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_DENSITY_MAX,
  HALFTONE_DENSITY_MIN,
  HALFTONE_SIZE_DEFAULT,
  HALFTONE_SIZE_MAX,
  HALFTONE_SIZE_MIN,
  type CellStyle,
} from '../core/cell-style';
import type { BurnSource } from '../ui/image-to-grid';

export interface BurnParams {
  cellSize: number;
  palette: PaletteId;
  matrix: MatrixId;
  contrast: number;
  invert: boolean;
  /** Viewing-window shape; reshapes the glass AND the shared grid (preview == export). */
  aspect: AspectId;
  /** Reframe within the aspect frame (Stage 8): zoom 1 = fit, >1 crops in;
   *  offsetX/Y pan as a fraction of the frame. Feed BOTH preview and export. */
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** G3 pre-dither tone (gamma/levels) — applied to the grid at the ONE
   *  sourceToGrid seam, so preview/export/video all see the treated bytes. */
  gamma: number;
  black: number;
  white: number;
}

export const DEFAULT_PARAMS: BurnParams = {
  cellSize: 5,
  palette: 'two', // B&W 1-bit default
  matrix: 8,
  contrast: 1.0,
  invert: false,
  aspect: 'landscape', // the current 4:3 glass
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  gamma: 1,
  black: 0,
  white: 255,
};

/** The timer-crop window over a loaded video. Transient UI state —
 *  never feeds the dither. `lenSeconds` is the preset window length; `startSec`
 *  is where the window begins in the source. */
export interface VideoTrim {
  lenSeconds: number;
  startSec: number;
}

/** Copy the live dial values out of the state (history snapshots). */
const pickParams = (s: BurnParams): BurnParams => ({
  cellSize: s.cellSize,
  palette: s.palette,
  matrix: s.matrix,
  contrast: s.contrast,
  invert: s.invert,
  aspect: s.aspect,
  zoom: s.zoom,
  offsetX: s.offsetX,
  offsetY: s.offsetY,
  gamma: s.gamma,
  black: s.black,
  white: s.white,
});

/** Param-history depth (owner ask: a SMALL memory, deliberately not robust). */
const HISTORY_CAP = 24;
/** Coalesce rapid setParam bursts (a slider drag) into one history entry. */
const SNAP_COALESCE_MS = 400;
let lastSnapTs = 0;

export interface BurnState extends BurnParams {
  /** The loaded burn source (image / cutout canvas / video). Lives here (not App
   *  state) so other modes can read it. */
  source: BurnSource | null;
  /** True once the USER loads/treats a source; false for the bundled demo. The
   *  stage seeds the Draw base only from a user source (the demo stays Burn's). */
  sourceIsUser: boolean;
  /** CRT preview effects (scanlines / glow / curve). Display-only — never feeds
   *  the dither or the export. */
  crtEffects: boolean;
  /** DEVICE-wide cell RENDER style: how each dithered cell is drawn at
   *  the cell→pixel upscale — 'square' (default, unchanged) / 'dot' (round-dot) /
   *  'halftone'. Orthogonal to matrix; applies in every mode, live + export. Not a
   *  burn param (not in the dial history / reset). */
  cellStyle: CellStyle;
  /** Halftone DENSITY — how packed the dots are (sparse ↔ cluster). One shared dot
   *  lattice. In RECORD it is scene-wide; in BURN (one image) it is the global density.
   *  (In Record, Size + Tonal are PER-ELEMENT in the scene Look; in Burn they are the
   *  two globals below — Burn has no per-element look.) */
  dotDensity: number;
  /** Halftone dot SIZE + Tonal-grow for BURN (a single image → global). Record keeps
   *  its own per-element copies in the scene Look; these two are Burn's globals. Like
   *  cellStyle they are NOT burn params (not in the dial history / Reset). */
  dotSize: number;
  dotGrow: boolean;
  /** Flat canvas BACKGROUND: a Swatch — a palette
   *  shade index (tracks the palette) | a custom `[r,g,b]` (pinned) | null = transparent.
   *  The colour shown where the dither is transparent (e.g. behind a cut-out). Flat
   *  CHROME, never dithered; live == export. Like cellStyle, NOT a burn param (not in
   *  the dial history / Reset). */
  background: Swatch;
  /** Halftone DOT-COLOUR: a Swatch the round/block
   *  dots are drawn in — a palette shade index | a custom `[r,g,b]` | null = the
   *  palette's BRIGHTEST shade (the default dots-on-dark). Lets Halftone read as
   *  newsprint (dark dots on a light bg). Halftone-only; like cellStyle, NOT a burn
   *  param (not in the dial history / Reset). */
  dotInk: Swatch;
  /** Burn video AUDIO on/off (owner ask B1). A video LOADS muted (the autoplay
   *  policy needs it); the deck Sound toggle is the user gesture that unmutes,
   *  and the choice persists for the SESSION. Like cellStyle it is transient —
   *  NOT a burn param (never in the dial history / Reset). Ignored for images. */
  soundOn: boolean;
  /** Active timer-crop window on a video source, or null. While set,
   *  Add to Library saves just this window; playback confines to it. */
  videoTrim: VideoTrim | null;
  /** Light dial history (owner ask): coalesced snapshots, capped, params only —
   *  the source/trim/CRT toggles are never in it. */
  paramsPast: BurnParams[];
  paramsFuture: BurnParams[];
  setSource(src: BurnSource | null, isUser: boolean): void;
  setVideoTrim(trim: VideoTrim | null): void;
  setParam<K extends keyof BurnParams>(key: K, value: BurnParams[K]): void;
  setCrtEffects(on: boolean): void;
  setCellStyle(style: CellStyle): void;
  setDotDensity(n: number): void;
  setDotSize(n: number): void;
  setDotGrow(on: boolean): void;
  setBackground(b: Swatch): void;
  setDotInk(i: Swatch): void;
  setSoundOn(on: boolean): void;
  applyPreset(params: Partial<BurnParams>): void;
  /** Step the dials back/forward through the small history. */
  undoParams(): void;
  redoParams(): void;
  /** All dials to defaults EXCEPT aspect (the shared shape source —
   *  resetting it would reshape every mode's doc). Undoable. */
  resetParams(): void;
  reset(): void;
}

/** Release a replaced video source. A playing media element is GC-protected, so a
 *  swapped-out unmuted video would keep playing its AUDIO invisibly forever (the
 *  "ghost audio" the owner hit) — and its object URL / decoder would leak. Pause,
 *  drop the blob URL, and unload before the reference is overwritten. */
function releaseVideoSource(prev: unknown, next: unknown): void {
  if (!(prev instanceof HTMLVideoElement) || prev === next) return;
  prev.pause();
  prev.muted = true;
  const url = prev.src;
  prev.removeAttribute('src');
  prev.load();
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

export const useBurnStore = create<BurnState>()(
  immer((set, get) => ({
    ...DEFAULT_PARAMS,
    source: null,
    sourceIsUser: false,
    crtEffects: true,
    cellStyle: 'square',
    dotDensity: HALFTONE_DENSITY_DEFAULT,
    dotSize: HALFTONE_SIZE_DEFAULT,
    dotGrow: true,
    background: null,
    dotInk: null,
    soundOn: false,
    videoTrim: null,
    paramsPast: [],
    paramsFuture: [],
    setSource: (src, isUser) => {
      // Outside the immer recipe: the outgoing element needs real DOM calls.
      releaseVideoSource(get().source, src);
      set((s) => {
        // DOM nodes are non-draftable leaves to immer — stored by reference, not frozen.
        s.source = src as never;
        s.sourceIsUser = isUser;
        s.videoTrim = null; // a fresh source always drops the old trim window
        // F4: a freshly loaded video defaults to sound ON (W3
        // shipped it defaulting muted). A NEW video load flips the flag on; the
        // File-rail rocker (BurnSoundToggle) still toggles, and its effect unmutes the
        // element. The Burn export mux (always source audio, W3) is unaffected. Images
        // carry no audio, so the flag is left untouched for them.
        if (src instanceof HTMLVideoElement) s.soundOn = true;
      });
    },
    setVideoTrim: (trim) =>
      set((s) => {
        s.videoTrim = trim;
      }),
    setParam: (key, value) =>
      set((s) => {
        // Snapshot BEFORE the change — coalesced so one slider drag is one
        // history entry, capped so the memory stays small (owner ask).
        const now = Date.now();
        if (now - lastSnapTs > SNAP_COALESCE_MS) {
          s.paramsPast.push(pickParams(s));
          if (s.paramsPast.length > HISTORY_CAP) s.paramsPast.shift();
          s.paramsFuture = [];
        }
        lastSnapTs = now;
        // Computed-key assign keeps the generic setParam<K> type-safe at the call
        // site with no cast; immer's draft proxy records the mutation.
        Object.assign(s, { [key]: value });
      }),
    setCrtEffects: (on) =>
      set((s) => {
        s.crtEffects = on;
      }),
    setCellStyle: (style) =>
      set((s) => {
        s.cellStyle = style;
      }),
    setDotDensity: (n) =>
      set((s) => {
        s.dotDensity = Math.max(
          HALFTONE_DENSITY_MIN,
          Math.min(HALFTONE_DENSITY_MAX, Math.round(n)),
        );
      }),
    setDotSize: (n) =>
      set((s) => {
        s.dotSize = Math.max(HALFTONE_SIZE_MIN, Math.min(HALFTONE_SIZE_MAX, Math.round(n)));
      }),
    setDotGrow: (on) =>
      set((s) => {
        s.dotGrow = on;
      }),
    setBackground: (b) =>
      set((s) => {
        s.background = b;
      }),
    setDotInk: (i) =>
      set((s) => {
        s.dotInk = i;
      }),
    setSoundOn: (on) =>
      set((s) => {
        s.soundOn = on;
      }),
    applyPreset: (params) =>
      set((s) => {
        s.paramsPast.push(pickParams(s));
        if (s.paramsPast.length > HISTORY_CAP) s.paramsPast.shift();
        s.paramsFuture = [];
        lastSnapTs = Date.now();
        Object.assign(s, params);
      }),

    undoParams: () =>
      set((s) => {
        const prev = s.paramsPast.pop();
        if (!prev) return;
        s.paramsFuture.push(pickParams(s));
        lastSnapTs = 0; // the next live tweak starts a fresh history entry
        Object.assign(s, prev);
      }),

    redoParams: () =>
      set((s) => {
        const next = s.paramsFuture.pop();
        if (!next) return;
        s.paramsPast.push(pickParams(s));
        lastSnapTs = 0;
        Object.assign(s, next);
      }),

    resetParams: () =>
      set((s) => {
        s.paramsPast.push(pickParams(s));
        if (s.paramsPast.length > HISTORY_CAP) s.paramsPast.shift();
        s.paramsFuture = [];
        lastSnapTs = 0;
        // Everything to defaults EXCEPT aspect — the shared shape source;
        // the source/trim/CRT toggle are untouched.
        Object.assign(s, { ...DEFAULT_PARAMS, aspect: s.aspect });
      }),
    reset: () =>
      set((s) => {
        Object.assign(s, DEFAULT_PARAMS);
      }),
  })),
);
