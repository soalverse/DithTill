// =============================================================================
// Mode store: which place is active. merged everything into ONE canvas (a
// layered scene: photos, drawings, video, track) + the Library asset store, so there
// are just two: Canvas · Library. The active mode supplies the
// shell's `{screen, deck}` slots; per-mode state (and undo) lives with each mode —
// switching modes never discards a mode's work.
// =============================================================================
import { create } from 'zustand';

export type ModeId = 'canvas' | 'library';

export interface ModeMeta {
  id: ModeId;
  label: string;
  ready: boolean; // false → renders the "coming soon" placeholder
}

export const MODES: ModeMeta[] = [
  { id: 'canvas', label: 'Canvas', ready: true },
  { id: 'library', label: 'Library', ready: true },
];

interface ModeState {
  mode: ModeId;
  setMode(mode: ModeId): void;
}

export const useModeStore = create<ModeState>((set) => ({
  mode: 'canvas',
  setMode: (mode) => set({ mode }),
}));
