import { create } from 'zustand';
import type { LoopExportFormat } from '../platform/loop-export';

// =============================================================================
// The Record export-length picker's transient state (K3; F5 format
// row 2026-07-19). NON-persisted, NON-undoable — it never touches loop meta or the
// zundo partialize; it is a one-shot request/resolve channel exactly like
// notifyConfirm. RecordExportMenu calls `pickExportLength(...)`, the on-glass
// <ExportLengthPanel/> collects the choice, and the promise resolves with the
// export's absolute frame count T AND the chosen container format (or null when the
// user cancels / the export is aborted).
// =============================================================================

/** What the export panel needs: the video's length, and the loops that move in
 *  it (for the GIF seamless check + "Fit to N bars"). The marked part is read live from the
 *  loop store (Fit can mark a new one while the panel is open). */
export interface ExportLengthRequest {
  /** The output frame rate (loop meta.fps). */
  fps: number;
  /** The whole video's length in frames (the song, else the last layer bar). */
  videoFrames: number;
  /** The frame lengths of the loops that move (each recorded layer's own loop; a moving
   *  layer's motion period). */
  loops: number[];
  /** The tempo — "Fit to N bars" counts in it. */
  bpm: number;
  beatsPerBar: number;
}

/** The panel's choice: how many frames from which song frame, in which container. */
export interface ExportLengthChoice {
  frames: number;
  start: number;
  format: LoopExportFormat;
}

interface ExportLengthState {
  /** The active request while the picker is open; null when closed. */
  request: ExportLengthRequest | null;
}

export const useExportLengthStore = create<ExportLengthState>(() => ({ request: null }));

// One pending resolver — exports are serial, so a single slot is enough.
let pending: ((choice: ExportLengthChoice | null) => void) | null = null;

function finish(choice: ExportLengthChoice | null): void {
  const r = pending;
  pending = null;
  useExportLengthStore.setState({ request: null });
  if (r) r(choice);
}

/** Open the on-glass picker and resolve with the chosen T + format, or null on
 *  cancel. `signal` (the ExportMenu Cancel button) resolves null too. */
export function pickExportLength(
  req: ExportLengthRequest,
  signal?: AbortSignal,
): Promise<ExportLengthChoice | null> {
  if (pending) finish(null); // supersede any stray prior request
  useExportLengthStore.setState({ request: req });
  return new Promise((resolve) => {
    pending = resolve;
    if (signal) {
      if (signal.aborted) finish(null);
      else signal.addEventListener('abort', () => finish(null), { once: true });
    }
  });
}

/** The panel confirms with the length, the start frame and the container format. */
export function confirmExportLength(frames: number, start: number, format: LoopExportFormat): void {
  finish({ frames, start, format });
}

/** The panel (or the caller's abort) cancels the pick. */
export function cancelExportLength(): void {
  finish(null);
}
