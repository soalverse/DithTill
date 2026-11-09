// =============================================================================
// SESSION assets. A video imported straight onto the canvas is a layer,
// not a Library element — the Library holds only what the user Saves. But the whole
// video machinery (live frames, audio, the loop export) is addressed by an asset
// RECORD + its source bytes. So imported videos get the same record shape, kept here
// in memory for the session, and every lookup goes through `findRecord` /
// `getAssetBytes`: the session first, then the Library. One lookup path, two stores.
// =============================================================================
import { useLibraryStore } from '../state/library-store';
import type { AssetRecord } from '../core/library';

const records = new Map<string, AssetRecord>();
const blobs = new Map<string, Uint8Array>();
/** Full source duration (s) per video hash — what a layer's Trim can reach. */
const durations = new Map<string, number>();

/** Register an imported (unsaved) asset record + its source bytes. */
export function registerSessionAsset(
  rec: AssetRecord,
  bytes: { hash: string; data: Uint8Array },
  durationSec?: number,
): void {
  records.set(rec.id, rec);
  blobs.set(bytes.hash, bytes.data);
  if (durationSec !== undefined) durations.set(bytes.hash, durationSec);
}

/** The record behind a scene asset id — an imported layer's, else the Library's. */
export function findRecord(id: string): AssetRecord | undefined {
  return records.get(id) ?? useLibraryStore.getState().elements.find((e) => e.id === id);
}

/** Source bytes by content hash — the session's, else the Library blob store's. */
export async function getAssetBytes(hash: string): Promise<Uint8Array | undefined> {
  return blobs.get(hash) ?? useLibraryStore.getState().getBlob(hash);
}

/** Register one more blob of a session record (a reopened project's media). */
export function registerSessionBlob(hash: string, data: Uint8Array): void {
  blobs.set(hash, data);
}

/** A video's full source length by hash (what its Trim can reach), if known. */
export const sessionDuration = (hash: string): number | undefined => durations.get(hash);
