// =============================================================================
// Library store (v1 ecosystem increment 2). The in-memory mirror of
// the content-addressed backpack + multi-selection state for the panel. Writes
// through to the swappable LibraryBackend (IndexedDB by default — durable,
// on-device). The four modes save into here ("Add to Library") and load back out
// of it (Library → Draw stage now; Library → Record scene in increment 3).
// =============================================================================
import { create } from 'zustand';
import {
  buildElement,
  buildVideoElement,
  orphanHashes,
  type AssetRecord,
  type BuildVideoInput,
  type BuiltElement,
  type CompositeLook,
  type RecordingAssetRecord,
  type ElementSource,
  type LibraryBackend,
} from '../core/library';
import type { Composite } from '../core/composite';
import type { AspectId, PaletteId, PatternId } from '../core/dither-constants';
import { createLibraryBackend } from '../platform/library-db';
import { sweepLibraryInbox } from '../platform/library-inbox';
import { notifyBanner } from './notify-store';

/** Everything needed to mint one element (the bytes + its live params). */
export interface AddInput {
  composite: Composite;
  png: Uint8Array;
  thumbnail: string;
  source: ElementSource;
  aspect: AspectId;
  palette: PaletteId;
  matrix: PatternId;
  /** The scene-wide look shown at save (v4). Omitted / neutral = a pre-v4 save. */
  look?: CompositeLook;
  /** v5: the producing Pixel of the composite's native grid. */
  cell?: number;
}

interface LibraryState {
  /** True once the backend has loaded (persisted elements are in). */
  ready: boolean;
  /** Saved elements, newest first. */
  elements: AssetRecord[];
  /** Selected element ids (selection order preserved). */
  selected: string[];
  init: () => Promise<void>;
  add: (input: AddInput) => Promise<AssetRecord>;
  addVideo: (input: Omit<BuildVideoInput, 'createdAt'>) => Promise<AssetRecord>;
  /** Save a built recording; an identical save dedupes onto its record. */
  addRecording: (built: BuiltElement<RecordingAssetRecord>) => Promise<AssetRecord>;
  remove: (ids: string[]) => Promise<void>;
  toggle: (id: string) => void;
  clearSelection: () => void;
  getBlob: (hash: string) => Promise<Uint8Array | undefined>;
}

const backend: LibraryBackend = createLibraryBackend();

export const useLibraryStore = create<LibraryState>((set, get) => ({
  ready: false,
  elements: [],
  selected: [],

  init: async () => {
    if (get().ready) return;
    // AI-3 bridge: ingest any element files dropped into the
    // library-inbox BEFORE loading, so they arrive in this very session.
    // Desktop-only inside; a sweep failure must never block the library.
    try {
      const swept = await sweepLibraryInbox(backend);
      if (swept.ingested > 0) notifyBanner(`Imported ${swept.ingested} from the inbox`);
      // A file that failed parse/verify stays in place silently otherwise — surface it
      // (the sweep must never fail invisibly).
      if (swept.skipped.length > 0)
        notifyBanner(`Inbox: ${swept.skipped.length} file(s) failed to import — see console`);
    } catch (err) {
      console.error('library-inbox sweep failed:', err);
    }
    const recs = await backend.loadAll();
    recs.sort((a, b) => b.createdAt - a.createdAt);
    set({ elements: recs, ready: true });
  },

  add: async (input) => {
    const built = await buildElement({ ...input, createdAt: Date.now() });
    // An identical re-save dedupes onto the same record — it keeps its first name.
    const prev = get().elements.find((e) => e.id === built.record.id);
    if (prev?.name) built.record.name = prev.name;
    for (const b of built.blobs) await backend.putBlob(b.hash, b.bytes);
    await backend.putRecord(built.record);
    set((s) => ({
      // Content-addressed: re-saving the same look replaces (dedupes) its record.
      elements: [built.record, ...s.elements.filter((e) => e.id !== built.record.id)],
    }));
    return built.record;
  },

  addVideo: async (input) => {
    const built = await buildVideoElement({ ...input, createdAt: Date.now() });
    for (const b of built.blobs) await backend.putBlob(b.hash, b.bytes);
    await backend.putRecord(built.record);
    set((s) => ({
      // Content-addressed by (source bytes + trim window): same segment dedupes.
      elements: [built.record, ...s.elements.filter((e) => e.id !== built.record.id)],
    }));
    return built.record;
  },

  addRecording: async (built) => {
    const prev = get().elements.find((e) => e.id === built.record.id);
    if (prev?.name) built.record.name = prev.name;
    for (const b of built.blobs) await backend.putBlob(b.hash, b.bytes);
    await backend.putRecord(built.record);
    set((s) => ({
      elements: [built.record, ...s.elements.filter((e) => e.id !== built.record.id)],
    }));
    return built.record;
  },

  remove: async (ids) => {
    const removing = new Set(ids);
    const survivors = get().elements.filter((e) => !removing.has(e.id));
    const removed = get().elements.filter((e) => removing.has(e.id));
    for (const rec of removed) {
      await backend.deleteRecord(rec.id);
      for (const h of orphanHashes(rec, survivors)) await backend.deleteBlob(h);
    }
    set((s) => ({
      elements: survivors,
      selected: s.selected.filter((id) => !removing.has(id)),
    }));
  },

  toggle: (id) =>
    set((s) => ({
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
    })),

  clearSelection: () => set({ selected: [] }),

  getBlob: (hash) => backend.getBlob(hash),
}));
