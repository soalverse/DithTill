// =============================================================================
// Library "backpack" — the content-addressed asset store (F6,
// ecosystem increment 2). Small JSON metadata records reference the
// big pixel bytes by SHA-256 hash (never inline), behind a swappable BlobStore
// backend (IndexedDB in the browser/Tauri webview; an in-memory map for tests +
// fallback; a filesystem backend can drop in later behind this same interface —
// D11). Hashing dedupes identical bytes automatically.
//
// Each element is stored BOTH renderable (per-cell tones+covered + palette/matrix
// → re-render / recolour at any size, the Record-scene need) AND baked (the
// indexed-PNG bytes → the content address, the thumbnail source, a ready drop-in).
// =============================================================================
import type { AspectId, PaletteId, PatternId } from './dither-constants';
import type { Composite } from './composite';
import type { LayerLoop, TimedEvent } from './loop-events';
import type { TimelineClip } from './timeline-edit';
import type { SceneNode } from '../state/scene-store';
import type { Swatch } from './color';
import {
  CELL_STYLE_DEFAULT,
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_SIZE_DEFAULT,
  type CellStyle,
} from './cell-style';

/** Bump when the record shape changes (forces a migration path later).
 *  v2: adds the `kind: 'video'` record — additive, v1 records load as-is.
 *  v3: video records gain an optional saved `reframe` — additive, v2 loads as-is
 *  (no reframe = the full frame, exactly the old behaviour).
 *  v4 (custom-colour Phase 2, §8.B): composite AND video records gain an optional `look`
 *  blob (cellStyle/dotDensity/dotSize/dotGrow/dotInk/background + producing Pixel cellSize)
 *  so the FULL producing look travels Burn/Draw → Library → Record, closing G-13. Videos
 *  carry it too (the owner's primary medium) so a fine-burned clip re-enters Record at its
 *  producing resolution + style. Additive — a v3 record (absent look) loads + drops EXACTLY
 *  as today (a neutral look is omitted, so an un-styled save keeps its byte-identical pre-v4
 *  id + dedupes against old records).
 *  v5: composite records gain an optional `fineHash` (the exact
 *  luma's low byte, so re-dithering reproduces the canvas bit-for-bit) and `cell` (the
 *  producing Pixel the element's native grid was made at, so it lands 1:1). Additive — a
 *  v4 record (both absent) loads, renders and keeps its id exactly as before.
 *  v6: composite records gain an optional `inkHash` + `inks` — the per-cell
 *  halftone dot-colour slots of a canvas whose layers overrode their dot colour, so it
 *  reopens with the same dots. Additive — absent = every cell takes the canvas colour. */
/** v7: the look may carry the element's own print `screen`. Additive — older
 *  records have none and drop in with the canvas look. */
export const SCHEMA_VERSION = 7;

/**
 * The scene-wide look a Library element was SHOWN with at save (v4). Persists the
 * knobs that used to be lost between modes: the cell RENDER style + its two Halftone
 * globals (density scene-wide; size/grow per-element in the scene Look), the Halftone
 * dot INK, and the flat canvas BACKGROUND (where a mode doesn't already bake it into
 * the element's content). Swatch values (dotInk/background) serialize as-is —
 * `number` (palette-shade index) | `[r,g,b]` (custom, pinned) | `null`.
 */
export interface CompositeLook {
  cellStyle: CellStyle;
  dotDensity: number;
  dotSize: number;
  dotGrow: boolean;
  dotInk: Swatch;
  background: Swatch;
  /** The producing "Pixel" the element was made at (scene-resolution pass), in the shared
   *  480-frame units. ABSENT (undefined) is the ONLY neutral value — the SAVE SITE omits
   *  the field at its own default (Burn omits at cellSize 5; a scene-save omits at the scene
   *  Pixel default 2.5), so a default save stays byte-identical + keeps deduping. Any PRESENT
   *  value is a deliberate resolution: folded into the id, and adopted on an EMPTY-scene drop
   *  (the dropped node coarsens to that Pixel in a finer scene). Making `undefined` the sole
   *  sentinel is what lets Burn's default (5) and a deliberate scene Pixel of 5 coexist —
   *  each save site carries its own default's absence, not a shared magic number. */
  cellSize?: number;
  /** The element's own screen: Dither / Halftone, dot shape + Density, the
   *  screen angle, Dots turn + grow, Bit size and One ink / Palette — so an element drops
   *  in as the layer it was saved from. Absent (every older save) = the canvas's on drop. */
  screen?: ElementScreen;
}

/** The print-screen part of an element's look. */
export interface ElementScreen {
  style: 'dither' | 'halftone';
  shape: 'circle' | 'square';
  density: number;
  angle: number;
  dotsTurn: boolean;
  bitSize: number;
  colourMode: 'ink' | 'palette';
}

/** Burn's default cellSize. `currentBurnLook` OMITS the look's `cellSize` at this value so a
 *  default Burn save stays neutral (undefined). NOT a shared neutral sentinel — the id
 *  functions below treat only `undefined` as neutral, so a scene deliberately set to Pixel 5
 *  (== this value) is still a distinct, adopted resolution. Mirrors state/burn-store
 *  DEFAULT_PARAMS.cellSize (a literal so core stays free of the UI store). */
export const LOOK_CELL_SIZE_DEFAULT = 5;

/** The look that changes nothing vs today's default render — omitted from the record
 *  AND from the id hash so a pre-v4 (un-styled) save stays byte-identical (dedupe
 *  preserved), mirroring `isNeutralReframe`. */
export function isNeutralLook(look: CompositeLook | undefined): boolean {
  if (!look) return true;
  return (
    look.cellStyle === CELL_STYLE_DEFAULT &&
    look.dotDensity === HALFTONE_DENSITY_DEFAULT &&
    look.dotSize === HALFTONE_SIZE_DEFAULT &&
    look.dotGrow === true &&
    look.dotInk === null &&
    look.background === null &&
    look.cellSize === undefined &&
    look.screen === undefined
  );
}

/** Canonical serialization of a Swatch for the id hash (stable across sessions). */
function swatchKey(s: Swatch): string {
  if (s === null) return 'n';
  if (Array.isArray(s)) return `c${s[0]}.${s[1]}.${s[2]}`;
  return `i${s}`;
}

/** Canonical serialization of a non-neutral look, folded into the composite id hash
 *  so same-content + different-look = a SEPARATE element (save styled variants side by
 *  side), while same-content + same-look dedupes. Order-fixed + value-canonical. */
export function serializeLook(look: CompositeLook): string {
  const parts = [
    `cs:${look.cellStyle}`,
    `dd:${look.dotDensity}`,
    `ds:${look.dotSize}`,
    `dg:${look.dotGrow ? 1 : 0}`,
    `di:${swatchKey(look.dotInk)}`,
    `bg:${swatchKey(look.background)}`,
  ];
  // Fold a PRESENT Pixel into the hash — the save site already omitted its own default, so
  // an absent cellSize appends nothing (pre-scene-resolution elements serialize + dedupe
  // byte-identically) while a deliberate one (incl. a scene Pixel of exactly 5) is distinct.
  if (look.cellSize !== undefined) {
    parts.push(`cz:${look.cellSize}`);
  }
  // A present screen is part of the look: same pixels, different screen = a
  // separate element. Older saves carry none and hash as before.
  const sc = look.screen;
  if (sc)
    parts.push(
      `sc:${sc.style}.${sc.shape}.${sc.density}.${sc.angle}.${sc.dotsTurn ? 1 : 0}.${sc.bitSize}.${sc.colourMode}`,
    );
  return parts.join(':');
}

/** Which mode produced an element (provenance). */
export type ElementSource = 'burn' | 'draw' | 'record';

/** A saved Library element: small metadata that references its bytes by hash. */
export interface CompositeAssetRecord {
  /** Content address of the baked look (== pngHash) — identical saves dedupe. */
  id: string;
  schemaVersion: number;
  kind: 'composite';
  /** Which mode produced it (provenance only). */
  source: ElementSource;
  /** Doc-resolution grid dims (the canonical capture size; aspect-derived). */
  w: number;
  h: number;
  aspect: AspectId;
  /** Live display params — NOT baked into the tone, so the element recolours. */
  palette: PaletteId;
  matrix: PatternId;
  /** Blob refs (SHA-256) into the BlobStore. */
  tonesHash: string;
  coveredHash: string;
  pngHash: string;
  /** v5: blob ref of the exact-luma LOW byte plane (`lum = tones·256 + fine`).
   *  Absent = 0 everywhere (v4 elements, strokes-only canvases). */
  fineHash?: string;
  /** v5: the producing Pixel (480-frame units) the native grid was made at —
   *  the Make canvas cell size. Absent on v4 records (their grid is the old 128-cell doc). */
  cell?: number;
  /** v6: blob ref of the per-cell dot-ink slot plane + the slot Swatches
   *  (slot 0 = inherit the canvas dot colour). Both absent = no per-layer dot colours. */
  inkHash?: string;
  inks?: Swatch[];
  /** The scene-wide look this element was shown with at save (v4). Absent / neutral =
   *  today's behaviour exactly. Rehydrated on drop: per-element dotSize/dotGrow always;
   *  the scene-wide knobs only when dropping into an EMPTY scene (record-actions). */
  look?: CompositeLook;
  /** Small PNG data URL kept inline so the grid renders without decoding blobs. */
  thumbnail: string;
  createdAt: number;
  /** Display name — the project it was saved from. NOT part of the content id,
   *  so identical saves still dedupe; absent on older records. */
  name?: string;
}

/**
 * A saved VIDEO element. Stores the FULL source bytes content-addressed
 * (segments of one source share the blob — dedupe) + a non-destructive trim window;
 * the element IS that window. The video feeds the dither as a PRE-dither tone
 * source per frame (never a baked bitmap), so palette/matrix stay live params here
 * exactly like a composite element.
 */
export interface VideoAssetRecord {
  /** Content address of (videoHash + trim window + palette/matrix + non-neutral
   *  reframe + non-neutral look) — identical saves dedupe; a different look = a
   *  separate element (save variants). */
  id: string;
  schemaVersion: number;
  kind: 'video';
  source: ElementSource;
  /** Source video pixel dims. */
  w: number;
  h: number;
  aspect: AspectId;
  /** Default look when dropped (same contract as a composite element). */
  palette: PaletteId;
  matrix: PatternId;
  /** The scene-wide look this video was SHOWN with at save (v4 — the same blob as a
   *  composite element). Videos are the owner's primary medium, so the FULL producing
   *  look (cellStyle/dotDensity/dotSize/dotGrow/dotInk/background + the producing Pixel
   *  `cellSize`) must travel Burn → Library → Record for a video too. Absent / neutral =
   *  pre-v4 behaviour exactly (a byte-identical id that dedupes with old records).
   *  Rehydrated on drop like a composite: scene-wide fields (incl. resolution adopt) on
   *  an EMPTY scene; per-element dotSize/dotGrow/pixel always. */
  look?: CompositeLook;
  /** Blob ref (SHA-256) of the full source bytes. */
  videoHash: string;
  /** Container MIME ('video/mp4' …) so playback/export name the bytes right. */
  mime: string;
  /** Trim window in SECONDS within the source (inSeconds < outSeconds). */
  inSeconds: number;
  outSeconds: number;
  /** Canonical loop-clock sampling rate (frames/second) the element is addressed
   *  at, and the derived integer frame count = round((out-in)*fps). Fixed at save
   *  so the loop-frame mapping is pure integer math forever after. */
  fps: number;
  frameCount: number;
  /** Burn's spatial reframe at save time (zoom >= 1 crops in; offsets pan as a
   *  fraction of the aspect frame). Carried to Record as the dropped node's
   *  initial CROP, so the element arrives framed as it was saved. Absent /
   *  neutral = the full frame (v2 records). */
  reframe?: VideoReframe;
  thumbnail: string;
  createdAt: number;
  /** Display name — not part of the id; absent on older records. */
  name?: string;
}

/** The saved spatial window (mirrors ui/image-to-grid's Reframe shape — kept
 *  structural here so core stays UI-import-free). */
export interface VideoReframe {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Neutral = nothing to carry: the id hash and the record omit it, so an
 *  un-reframed save is byte-identical to a pre-v3 save (dedupe preserved). */
export const isNeutralReframe = (r: VideoReframe | undefined): boolean =>
  !r || (r.zoom === 1 && r.offsetX === 0 && r.offsetY === 0);

/** A saved RECORDING: the layer itself, not a picture of it. Its strokes +
 *  timing live in the `data` blob (JSON, `RecordingElementData`); `png` is its finished picture.
 *  Adding it to a canvas makes a recording again. */
export interface RecordingAssetRecord {
  /** Content address of its data + finished picture: identical saves dedupe. */
  id: string;
  schemaVersion: number;
  kind: 'recording';
  source: ElementSource;
  /** Its raster's size + picture values per canvas square. */
  w: number;
  h: number;
  per?: number;
  aspect: AspectId;
  /** The canvas Pixel it was made at (its strokes are that many canvas squares). */
  cell: number;
  palette: PaletteId;
  matrix: PatternId;
  dataHash: string;
  pngHash: string;
  /** Its bar's length, in frames at `fps` (the tile's badge). */
  frames: number;
  fps: number;
  thumbnail: string;
  createdAt: number;
  name?: string;
  /** Recordings carry their own layer Look in `data`, never a scene-wide one. */
  look?: undefined;
}

/** What a saved recording holds: everything that makes it the layer it was. Frames are its own;
 *  its bar's clips start from 0, and a placed bar always starts at the start of the video. */
export interface RecordingElementData {
  events: TimedEvent[];
  loop: LayerLoop;
  clips: TimelineClip[];
  layer: Pick<
    SceneNode,
    | 'look'
    | 'opacity'
    | 'placement'
    | 'crop'
    | 'motion'
    | 'rec'
    | 'solid'
    | 'fx'
    | 'mods'
    | 'window'
  >;
  /** The canvas size its placement + strokes were made on. */
  canvas: { w: number; h: number };
  /** Its muted takes (passes in `events`): they stay muted, and out of its tile. */
  muted?: number[];
}

/** Assemble a recording's record + blobs (pure apart from hashing). */
export async function buildRecordingElement(input: {
  data: RecordingElementData;
  png: Uint8Array;
  thumbnail: string;
  w: number;
  h: number;
  per?: number;
  aspect: AspectId;
  cell: number;
  palette: PaletteId;
  matrix: PatternId;
  fps: number;
  createdAt: number;
  name?: string;
}): Promise<BuiltElement<RecordingAssetRecord>> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.data));
  const [dataHash, pngHash] = await Promise.all([sha256Hex(bytes), sha256Hex(input.png)]);
  const frames = Math.max(1, ...input.data.clips.map((c) => c.start + c.duration));
  const id = await recordingId(dataHash, pngHash);
  return {
    record: {
      id,
      schemaVersion: SCHEMA_VERSION,
      kind: 'recording',
      source: 'record',
      w: input.w,
      h: input.h,
      ...(input.per && input.per !== 1 ? { per: input.per } : {}),
      aspect: input.aspect,
      cell: input.cell,
      palette: input.palette,
      matrix: input.matrix,
      dataHash,
      pngHash,
      frames,
      fps: input.fps,
      thumbnail: input.thumbnail,
      createdAt: input.createdAt,
      ...(input.name ? { name: input.name } : {}),
    },
    blobs: [
      { hash: dataHash, bytes },
      { hash: pngHash, bytes: input.png },
    ],
  };
}

/** A recording's content id: the same for identical saves. */
export function recordingId(dataHash: string, pngHash: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`recording:${dataHash}:${pngHash}`));
}

export type AssetRecord = CompositeAssetRecord | VideoAssetRecord | RecordingAssetRecord;

/**
 * The swappable content store. Blobs are addressed by hash; records
 * are small JSON keyed by id. One implementation is live at a time; the same
 * interface backs IndexedDB now and the Tauri filesystem later (D11).
 */
export interface LibraryBackend {
  loadAll(): Promise<AssetRecord[]>;
  putRecord(rec: AssetRecord): Promise<void>;
  deleteRecord(id: string): Promise<void>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | undefined>;
  hasBlob(hash: string): Promise<boolean>;
  deleteBlob(hash: string): Promise<void>;
}

/** SHA-256 of bytes as lowercase hex, via Web Crypto (browser + Node + Tauri). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a definitely-ArrayBuffer-backed view so the digest call type-checks
  // regardless of `bytes`'s backing buffer (ArrayBufferLike vs ArrayBuffer).
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

export interface BuildInput {
  composite: Composite;
  /** The baked indexed-PNG bytes (the content address + drop-in artifact). */
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
  createdAt: number;
  /** Display name (the source project) — not part of the id. */
  name?: string;
}

/** THE composite id rule (minting + element-file verification share it). A record with
 *  no non-neutral look, no fine plane and no producing cell keeps the pre-v4 id (the PNG
 *  hash) so old saves dedupe; any of the three folds into a hashed id in a fixed order. */
export async function compositeId(
  pngHash: string,
  look: CompositeLook | undefined,
  fineHash: string | undefined,
  cell: number | undefined,
  /** v6: the dot-ink plane hash + its slot Swatches (absent = no per-layer dot colours). */
  ink?: { hash: string; inks: Swatch[] },
): Promise<string> {
  const neutral = isNeutralLook(look);
  if (neutral && fineHash === undefined && cell === undefined && !ink) return pngHash;
  if (fineHash === undefined && cell === undefined && !ink) {
    return sha256Hex(new TextEncoder().encode(`composite:${pngHash}:look:${serializeLook(look!)}`));
  }
  const parts = [`composite:${pngHash}`];
  if (!neutral) parts.push(`look:${serializeLook(look!)}`);
  if (fineHash !== undefined) parts.push(`fine:${fineHash}`);
  if (cell !== undefined) parts.push(`cell:${cell}`);
  if (ink) parts.push(`ink:${ink.hash}:${JSON.stringify(ink.inks)}`);
  return sha256Hex(new TextEncoder().encode(parts.join(':')));
}
export interface BuiltElement<R extends AssetRecord = AssetRecord> {
  record: R;
  blobs: { hash: string; bytes: Uint8Array }[];
}

export interface BuildVideoInput {
  /** The FULL source container bytes (stored whole; the trim is metadata). */
  bytes: Uint8Array;
  mime: string;
  w: number;
  h: number;
  inSeconds: number;
  outSeconds: number;
  /** Canonical loop-clock fps the element will be addressed at. */
  fps: number;
  thumbnail: string;
  source: ElementSource;
  aspect: AspectId;
  palette: PaletteId;
  matrix: PatternId;
  /** Burn's spatial reframe at save time (neutral/omitted = full frame). */
  reframe?: VideoReframe;
  /** The scene-wide look shown at save (v4). Omitted / neutral = a pre-v4 save. */
  look?: CompositeLook;
  createdAt: number;
}

/** Hash the source bytes and mint a video record. Content-addressed by
 *  (videoHash, trim window, LOOK, non-neutral REFRAME) so re-saving the identical
 *  thing dedupes while the same segment saved under a different palette/matrix or
 *  a different reframe is its OWN element — save edited variants side by side —
 *  and every variant (and every segment of one source) shares the ONE source
 *  blob. A neutral reframe is omitted from the hash so an un-reframed save keeps
 *  its pre-v3 id (dedupes against old records). */
export async function buildVideoElement(
  input: BuildVideoInput,
): Promise<BuiltElement<VideoAssetRecord>> {
  const videoHash = await sha256Hex(input.bytes);
  const inSeconds = Math.max(0, input.inSeconds);
  const outSeconds = Math.max(inSeconds, input.outSeconds);
  const reframe = isNeutralReframe(input.reframe) ? undefined : input.reframe;
  const reframeKey = reframe
    ? `:rf:${reframe.zoom.toFixed(4)}:${reframe.offsetX.toFixed(4)}:${reframe.offsetY.toFixed(4)}`
    : '';
  // Fold a NON-neutral look into the id EXACTLY like the reframe + the composite path:
  // a neutral (or absent) look appends nothing, so a pre-v4 (un-styled) video save keeps
  // its byte-identical id and dedupes against old records; a styled save is its own variant.
  const look = isNeutralLook(input.look) ? undefined : input.look;
  const lookKey = look ? `:look:${serializeLook(look)}` : '';
  const id = await sha256Hex(
    new TextEncoder().encode(
      `video:${videoHash}:${inSeconds.toFixed(3)}:${outSeconds.toFixed(3)}:${input.palette}:${input.matrix}${reframeKey}${lookKey}`,
    ),
  );
  const record: VideoAssetRecord = {
    id,
    schemaVersion: SCHEMA_VERSION,
    kind: 'video',
    source: input.source,
    w: input.w,
    h: input.h,
    aspect: input.aspect,
    palette: input.palette,
    matrix: input.matrix,
    videoHash,
    mime: input.mime,
    inSeconds,
    outSeconds,
    fps: input.fps,
    frameCount: Math.max(1, Math.round((outSeconds - inSeconds) * input.fps)),
    ...(reframe ? { reframe } : {}),
    ...(look ? { look } : {}),
    thumbnail: input.thumbnail,
    createdAt: input.createdAt,
  };
  return { record, blobs: [{ hash: videoHash, bytes: input.bytes }] };
}

/** Hash the composite's bytes + the baked PNG, and assemble the record + blob set
 *  ready to persist. Pure (apart from hashing); content-addressed by the PNG.
 *
 *  The id is `pngHash` when the look is neutral (a pre-v4 save → byte-identical id,
 *  dedupes with old records), else `sha256(pngHash + canonical-look)` so same content
 *  under a DIFFERENT look is its own element (mirrors the video-id precedent
 *  that folds palette/matrix/reframe). The `png`/`tones`/`covered` blobs stay
 *  content-addressed as before, so styled variants still share the renderable data. */
export async function buildElement(input: BuildInput): Promise<BuiltElement<CompositeAssetRecord>> {
  const { composite, png } = input;
  const hasInk = !!composite.ink && !!composite.inks;
  const [tonesHash, coveredHash, pngHash, fineHash, inkHash] = await Promise.all([
    sha256Hex(composite.tones),
    sha256Hex(composite.covered),
    sha256Hex(png),
    composite.fine ? sha256Hex(composite.fine) : Promise.resolve(undefined),
    hasInk ? sha256Hex(composite.ink!) : Promise.resolve(undefined),
  ]);
  const look = isNeutralLook(input.look) ? undefined : input.look;
  const inkRef = inkHash !== undefined ? { hash: inkHash, inks: composite.inks! } : undefined;
  const id = await compositeId(pngHash, look, fineHash, input.cell, inkRef);
  const record: CompositeAssetRecord = {
    id,
    schemaVersion: SCHEMA_VERSION,
    kind: 'composite',
    source: input.source,
    w: composite.w,
    h: composite.h,
    aspect: input.aspect,
    palette: input.palette,
    matrix: input.matrix,
    tonesHash,
    coveredHash,
    pngHash,
    ...(fineHash !== undefined ? { fineHash } : {}),
    ...(input.cell !== undefined ? { cell: input.cell } : {}),
    ...(inkRef ? { inkHash: inkRef.hash, inks: inkRef.inks } : {}),
    ...(look ? { look } : {}),
    thumbnail: input.thumbnail,
    createdAt: input.createdAt,
    ...(input.name ? { name: input.name } : {}),
  };
  const blobs = [
    { hash: tonesHash, bytes: composite.tones },
    { hash: coveredHash, bytes: composite.covered },
    { hash: pngHash, bytes: png },
  ];
  if (fineHash !== undefined && composite.fine)
    blobs.push({ hash: fineHash, bytes: composite.fine });
  if (inkHash !== undefined && composite.ink) blobs.push({ hash: inkHash, bytes: composite.ink });
  return { record, blobs };
}

/** The blob hashes a record references. */
export function referencedHashes(rec: AssetRecord): string[] {
  if (rec.kind === 'video') return [rec.videoHash];
  if (rec.kind === 'recording') return [rec.dataHash, rec.pngHash];
  const hashes = [rec.tonesHash, rec.coveredHash, rec.pngHash];
  if (rec.fineHash) hashes.push(rec.fineHash);
  if (rec.inkHash) hashes.push(rec.inkHash);
  return hashes;
}

/** Of a removed record's blobs, those no surviving record still references — safe
 *  to delete (dedupe-aware GC sweep). */
export function orphanHashes(removed: AssetRecord, survivors: AssetRecord[]): string[] {
  const live = new Set(survivors.flatMap(referencedHashes));
  return referencedHashes(removed).filter((h) => !live.has(h));
}

/** In-memory BlobStore — the test backend and the no-IndexedDB fallback. */
export class MemoryBackend implements LibraryBackend {
  private records = new Map<string, AssetRecord>();
  private blobs = new Map<string, Uint8Array>();

  async loadAll(): Promise<AssetRecord[]> {
    return [...this.records.values()];
  }
  async putRecord(rec: AssetRecord): Promise<void> {
    this.records.set(rec.id, rec);
  }
  async deleteRecord(id: string): Promise<void> {
    this.records.delete(id);
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes); // hash-addressed → dedupe
  }
  async getBlob(hash: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(hash);
  }
  async hasBlob(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
  async deleteBlob(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }
}
