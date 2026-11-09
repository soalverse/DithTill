import { create } from 'zustand';

// =============================================================================
// On-glass notification system (the ONE reusable channel for user-facing
// messages). Three flavours:
//   - confirm : an OK card the user MUST click (exports, errors)
//   - banner  : a transient line that auto-fades (minor info)
//   - progress: a persistent line shown while a long op runs (render/decode)
// Rendered on the CRT glass by <Notifications/>, styled to match the '?' help.
// =============================================================================

export type NoticeKind = 'banner' | 'confirm';

export interface Notice {
  id: number;
  kind: NoticeKind;
  title?: string;
  message: string;
}

interface NotifyState {
  notices: Notice[];
  /** A persistent progress line (no auto-dismiss) shown while a long op runs. */
  progress: string | null;
  dismiss: (id: number) => void;
  setProgress: (msg: string | null) => void;
}

let seq = 0;
const resolvers = new Map<number, () => void>();
const BANNER_MS = 3500;

export const useNotifyStore = create<NotifyState>((set) => ({
  notices: [],
  progress: null,
  dismiss: (id) => {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
    const r = resolvers.get(id);
    if (r) {
      resolvers.delete(id);
      r();
    }
  },
  setProgress: (msg) => set({ progress: msg }),
}));

function push(kind: NoticeKind, message: string, title?: string): number {
  const id = ++seq;
  useNotifyStore.setState((s) => ({ notices: [...s.notices, { id, kind, message, title }] }));
  return id;
}

/** Transient info — auto-dismisses after a few seconds. */
export function notifyBanner(message: string, title?: string): void {
  const id = push('banner', message, title);
  setTimeout(() => useNotifyStore.getState().dismiss(id), BANNER_MS);
}

/** Important message (exports, errors) — requires an explicit OK click. The
 *  returned promise resolves when the user dismisses it. */
export function notifyConfirm(message: string, title?: string): Promise<void> {
  return new Promise((resolve) => {
    const id = push('confirm', message, title);
    resolvers.set(id, resolve);
  });
}

/** The parent folder name of a saved path — so we show "to exports", not the
 *  whole "C:\…\exports\file.mp4". Falls back to the file name if there's no
 *  parent (e.g. a browser download). */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[parts.length - 1] ?? path);
}
