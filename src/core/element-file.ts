// =============================================================================
// The ELEMENT FILE — the AI↔app Library bridge's interchange format (AI-3).
// A single self-contained JSON file holding one composite element:
// the record (the app's exact CompositeAssetRecord shape) + every referenced
// blob as base64. Written headlessly by the MCP `save_to_library` tool into the
// library-inbox folder; ingested by the app (platform/library-inbox) into
// whatever LibraryBackend is active. Content-addressed end to end: every blob
// hash AND the record id are re-verified on parse, so a corrupt or tampered
// file can never mint a record — and re-ingesting the same file is a no-op by
// construction (same id = same element). PURE + webcrypto only, so the exact
// same parser runs in the app (browser) and in vitest/Node.
// =============================================================================
import {
  isNeutralLook,
  compositeId,
  recordingId,
  sha256Hex,
  type BuiltElement,
  type CompositeAssetRecord,
  type RecordingAssetRecord,
} from './library';
import { ASPECT_IDS, PALETTE_IDS, PATTERN_IDS } from './dither-constants';

export const ELEMENT_FILE_FORMAT = 'dithtill-element';
export const ELEMENT_FILE_VERSION = 1;
/** Element files are named `<id-prefix>.dtelement.json`; the ingest sweep takes
 *  any `*.json`, so hand-renamed files still ingest. */
export const ELEMENT_FILE_SUFFIX = '.dtelement.json';

/** The on-disk JSON shape. `blobs` maps sha256-hex → base64 bytes. */
export interface ElementFileJson<R = CompositeAssetRecord> {
  format: typeof ELEMENT_FILE_FORMAT;
  version: number;
  record: R;
  blobs: Record<string, string>;
}

// ---- base64 (hand-rolled: identical bytes in browser + Node, no atob quirks)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV: Int16Array = (() => {
  const rev = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) rev[B64.charCodeAt(i)] = i;
  return rev;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_REV[clean.charCodeAt(i) & 127];
    if (v < 0) throw new Error('element file: invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

/** Serialize a built composite element to the interchange JSON text. */
export function encodeElementFile(
  built: BuiltElement<CompositeAssetRecord | RecordingAssetRecord>,
): string {
  const blobs: Record<string, string> = {};
  for (const b of built.blobs) blobs[b.hash] = bytesToBase64(b.bytes);
  const json: ElementFileJson<CompositeAssetRecord | RecordingAssetRecord> = {
    format: ELEMENT_FILE_FORMAT,
    version: ELEMENT_FILE_VERSION,
    record: built.record,
    blobs,
  };
  return JSON.stringify(json, null, 1);
}

const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Grid dims sanity — elements are doc-resolution (~128 cells long); this cap
 *  only guards against absurd allocations from a malformed file. */
const GRID_DIM_MAX = 2048;

/** Parse + VERIFY an element file of either kind: what the Library inbox ingests. */
export async function parseAnyElementFile(
  text: string,
): Promise<BuiltElement<CompositeAssetRecord | RecordingAssetRecord>> {
  let json: ElementFileJson<CompositeAssetRecord | RecordingAssetRecord> | null = null;
  try {
    json = JSON.parse(text) as ElementFileJson<CompositeAssetRecord | RecordingAssetRecord>;
  } catch {
    /* parseElementFile says why */
  }
  const rec = json?.record;
  if (json?.format === ELEMENT_FILE_FORMAT && rec?.kind === 'recording')
    return parseRecordingFile(rec, json);
  return parseElementFile(text);
}

/** Decode + verify every blob against its claimed hash. */
async function verifiedBlobs(
  json: Pick<ElementFileJson, 'blobs'>,
): Promise<{ hash: string; bytes: Uint8Array }[]> {
  if (json.blobs === null || typeof json.blobs !== 'object') {
    throw new Error('element file: missing blobs');
  }
  const blobs: { hash: string; bytes: Uint8Array }[] = [];
  for (const [hash, b64] of Object.entries(json.blobs)) {
    if (!isHex64(hash) || typeof b64 !== 'string') {
      throw new Error('element file: malformed blob entry');
    }
    const bytes = base64ToBytes(b64);
    if ((await sha256Hex(bytes)) !== hash) {
      throw new Error(`element file: blob ${hash.slice(0, 12)}… fails its hash (corrupt file)`);
    }
    blobs.push({ hash, bytes });
  }
  return blobs;
}

/** A saved recording: the same checks, and its data must parse. */
async function parseRecordingFile(
  rec: RecordingAssetRecord,
  json: Pick<ElementFileJson, 'blobs'>,
): Promise<BuiltElement<RecordingAssetRecord>> {
  if (
    !Number.isInteger(rec.w) ||
    !Number.isInteger(rec.h) ||
    rec.w < 1 ||
    rec.h < 1 ||
    rec.w > GRID_DIM_MAX * 4 ||
    rec.h > GRID_DIM_MAX * 4
  ) {
    throw new Error(`element file: bad grid dims ${rec.w}x${rec.h}`);
  }
  if (!PALETTE_IDS.includes(rec.palette)) throw new Error('element file: unknown palette');
  if (!PATTERN_IDS.includes(rec.matrix)) throw new Error('element file: unknown matrix');
  if (!ASPECT_IDS.includes(rec.aspect)) throw new Error('element file: unknown aspect');
  if (typeof rec.thumbnail !== 'string' || !rec.thumbnail.startsWith('data:image/')) {
    throw new Error('element file: thumbnail must be an image data URL');
  }
  if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) {
    throw new Error('element file: bad createdAt');
  }
  if (!isHex64(rec.dataHash) || !isHex64(rec.pngHash)) {
    throw new Error('element file: blob hashes must be sha256 hex');
  }
  const blobs = await verifiedBlobs(json);
  const data = blobs.find((b) => b.hash === rec.dataHash);
  if (!data || !blobs.some((b) => b.hash === rec.pngHash)) {
    throw new Error('element file: record references a blob the file does not carry');
  }
  const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!positive(rec.cell) || !positive(rec.fps) || !positive(rec.frames)) {
    throw new Error('element file: bad recording numbers');
  }
  let parsed: {
    events?: unknown;
    loop?: { frames?: unknown };
    clips?: unknown;
    layer?: { placement?: Record<string, unknown>; look?: unknown };
    canvas?: { w?: unknown; h?: unknown };
  };
  try {
    parsed = JSON.parse(new TextDecoder().decode(data.bytes));
  } catch {
    throw new Error('element file: recording data is not valid JSON');
  }
  const place = parsed.layer?.placement;
  if (
    !Array.isArray(parsed.events) ||
    !Array.isArray(parsed.clips) ||
    !positive(parsed.loop?.frames) ||
    !parsed.layer?.look ||
    !place ||
    !['x', 'y', 'scaleX', 'scaleY', 'rotationDeg'].every((k) => Number.isFinite(place[k])) ||
    !positive(parsed.canvas?.w) ||
    !positive(parsed.canvas?.h)
  ) {
    throw new Error('element file: recording data is incomplete');
  }
  if (rec.id !== (await recordingId(rec.dataHash, rec.pngHash))) {
    throw new Error('element file: record id does not match its content (corrupt file)');
  }
  return { record: rec, blobs };
}

/**
 * Parse + VERIFY an element file. Throws with a plain-English reason on any
 * malformation, hash mismatch, or id mismatch — a file that parses is safe to
 * put straight into a LibraryBackend. Returns the app's BuiltElement shape.
 */
export async function parseElementFile(text: string): Promise<BuiltElement<CompositeAssetRecord>> {
  let json: ElementFileJson;
  try {
    json = JSON.parse(text) as ElementFileJson;
  } catch {
    throw new Error('element file: not valid JSON');
  }
  if (json?.format !== ELEMENT_FILE_FORMAT) {
    throw new Error(`element file: not a ${ELEMENT_FILE_FORMAT} file`);
  }
  if (json.version !== ELEMENT_FILE_VERSION) {
    throw new Error(`element file: unsupported version ${json.version} (expected 1)`);
  }
  const rec = json.record;
  if (!rec || typeof rec !== 'object' || rec.kind !== 'composite') {
    throw new Error("element file: record.kind must be 'composite' (v1 imports composites only)");
  }
  if (
    !Number.isInteger(rec.w) ||
    !Number.isInteger(rec.h) ||
    rec.w < 1 ||
    rec.h < 1 ||
    rec.w > GRID_DIM_MAX ||
    rec.h > GRID_DIM_MAX
  ) {
    throw new Error(`element file: bad grid dims ${rec.w}x${rec.h}`);
  }
  if (!PALETTE_IDS.includes(rec.palette)) throw new Error('element file: unknown palette');
  if (!PATTERN_IDS.includes(rec.matrix)) throw new Error('element file: unknown matrix');
  if (!ASPECT_IDS.includes(rec.aspect)) throw new Error('element file: unknown aspect');
  if (typeof rec.thumbnail !== 'string' || !rec.thumbnail.startsWith('data:image/')) {
    throw new Error('element file: thumbnail must be an image data URL');
  }
  if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) {
    throw new Error('element file: bad createdAt');
  }
  if (!isHex64(rec.tonesHash) || !isHex64(rec.coveredHash) || !isHex64(rec.pngHash)) {
    throw new Error('element file: blob hashes must be sha256 hex');
  }
  if (json.blobs === null || typeof json.blobs !== 'object') {
    throw new Error('element file: missing blobs');
  }

  // Decode + verify EVERY blob against its claimed hash.
  const blobs: { hash: string; bytes: Uint8Array }[] = [];
  for (const [hash, b64] of Object.entries(json.blobs)) {
    if (!isHex64(hash) || typeof b64 !== 'string') {
      throw new Error('element file: malformed blob entry');
    }
    const bytes = base64ToBytes(b64);
    const actual = await sha256Hex(bytes);
    if (actual !== hash) {
      throw new Error(`element file: blob ${hash.slice(0, 12)}… fails its hash (corrupt file)`);
    }
    blobs.push({ hash, bytes });
  }
  const byHash = new Map(blobs.map((b) => [b.hash, b.bytes]));
  const tones = byHash.get(rec.tonesHash);
  const covered = byHash.get(rec.coveredHash);
  if (!tones || !covered || !byHash.has(rec.pngHash)) {
    throw new Error('element file: record references a blob the file does not carry');
  }
  if (tones.length !== rec.w * rec.h || covered.length !== rec.w * rec.h) {
    throw new Error('element file: tones/covered length does not match the grid dims');
  }
  // v5: an exact-luma fine plane must be carried + sized like the tones.
  if (rec.fineHash !== undefined) {
    if (!isHex64(rec.fineHash)) throw new Error('element file: blob hashes must be sha256 hex');
    const fine = byHash.get(rec.fineHash);
    if (!fine) throw new Error('element file: record references a blob the file does not carry');
    if (fine.length !== rec.w * rec.h) {
      throw new Error('element file: fine length does not match the grid dims');
    }
  }
  if (rec.cell !== undefined && !(typeof rec.cell === 'number' && rec.cell > 0)) {
    throw new Error('element file: bad producing cell');
  }
  // v6: a dot-ink plane comes with its slot list, sized like the tones.
  if ((rec.inkHash === undefined) !== (rec.inks === undefined)) {
    throw new Error('element file: dot-ink plane and slots must travel together');
  }
  if (rec.inkHash !== undefined) {
    if (!isHex64(rec.inkHash)) throw new Error('element file: blob hashes must be sha256 hex');
    const ink = byHash.get(rec.inkHash);
    if (!ink) throw new Error('element file: record references a blob the file does not carry');
    if (ink.length !== rec.w * rec.h || !Array.isArray(rec.inks)) {
      throw new Error('element file: dot-ink plane does not match the grid dims');
    }
    for (const v of ink) {
      if (v >= rec.inks.length) throw new Error('element file: dot-ink slot out of range');
    }
  }

  // Verify the record id — the exact minting rule from core/library (compositeId).
  const look = isNeutralLook(rec.look) ? undefined : rec.look;
  const expectedId = await compositeId(
    rec.pngHash,
    look,
    rec.fineHash,
    rec.cell,
    rec.inkHash !== undefined && rec.inks ? { hash: rec.inkHash, inks: rec.inks } : undefined,
  );
  if (rec.id !== expectedId) {
    throw new Error('element file: record id does not match its content (corrupt file)');
  }

  return { record: rec, blobs };
}
