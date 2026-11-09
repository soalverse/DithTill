// =============================================================================
// Scene asset cache (Record). The scene resolver needs each placed
// element's PRE-dither tone raster (tones/covered). Those big TypedArrays live
// here, keyed by assetId — loaded once from the Library BlobStore — NOT in the
// scene store and NOT in undo history (the scene store only holds the lightweight
// node model). Cleared with the cache on demand.
// =============================================================================
import { useSceneStore, sceneLongFromPixel, DETAIL_FACTOR } from '../state/scene-store';
import type { CachedAsset } from '../core/scene-resolver';
import { ensureVideoAsset, rebuildVideoRasters } from './video-assets';
import { findRecord, getAssetBytes } from './session-assets';

const cache = new Map<string, CachedAsset>();

// Scene-resolution pass: a MANUAL resolution change while video previewers exist rebuilds
// their rasters at the new lattice long edge (the raster object changes — new byte
// length — so the cache entry must be re-registered), then re-renders. The auto-adopt
// path (empty-scene drop) sets the resolution BEFORE any video is placed, so this only
// fires for the manual-change-with-videos case; with no entries it is a no-op.
useSceneStore.subscribe((s, prev) => {
  if (s.pixel === prev.pixel && s.detail === prev.detail) return;
  const f = DETAIL_FACTOR[s.detail];
  const rebuilt = rebuildVideoRasters(sceneLongFromPixel(s.pixel) * f, f);
  if (rebuilt.length === 0) return;
  for (const [id, asset] of rebuilt) cache.set(id, asset);
  useSceneStore.getState().bump();
});

/** The live cache (passed to resolveSceneGrid). */
export function getAssetCache(): Map<string, CachedAsset> {
  return cache;
}

/** Inject/replace an in-memory raster (NOT from the BlobStore) — used to flow the
 *  live Draw stage into the Record scene as a synced node (the ecosystem bridge). */
export function setAsset(id: string, asset: CachedAsset): void {
  cache.set(id, asset);
}

/** Load any not-yet-cached assets from the BlobStore. Returns true if anything
 *  new loaded (so the caller can trigger a re-render once the bytes are in). */
export async function ensureAssets(assetIds: string[]): Promise<boolean> {
  let loaded = false;
  for (const id of assetIds) {
    if (cache.has(id)) continue;
    const rec = findRecord(id);
    if (!rec || rec.kind === 'recording') continue; // a recording is placed, not cached
    if (rec.kind === 'video') {
      // A video's CachedAsset is a LIVE raster owned by video-assets:
      // tick 0 exact now; the loop render rewrites its tones per frame in place.
      const bytes = await getAssetBytes(rec.videoHash);
      if (!bytes) continue;
      cache.set(id, await ensureVideoAsset(rec, bytes));
      loaded = true;
      continue;
    }
    // Session first (a reopened project's media), then the Library.
    const [tones, covered, fine, ink] = await Promise.all([
      getAssetBytes(rec.tonesHash),
      getAssetBytes(rec.coveredHash),
      rec.fineHash ? getAssetBytes(rec.fineHash) : Promise.resolve(undefined),
      rec.inkHash ? getAssetBytes(rec.inkHash) : Promise.resolve(undefined),
    ]);
    if (!tones || !covered) continue;
    cache.set(id, {
      w: rec.w,
      h: rec.h,
      tones: new Uint8Array(tones),
      covered: new Uint8Array(covered),
      // v5 exact-luma low byte: the element re-dithers bit-for-bit as saved.
      ...(fine ? { fine: new Uint8Array(fine) } : {}),
      // v6 per-layer dot colours: the saved canvas keeps its dots.
      ...(ink && rec.inks ? { ink: new Uint8Array(ink), inks: rec.inks } : {}),
    });
    loaded = true;
  }
  return loaded;
}
