// =============================================================================
// The element-file interchange format (AI-3) — the AI↔app Library
// bridge's contract. Round-trips a real built element, proves every tamper
// class is REFUSED (blob hash, id, structure), and proves the backend ingest
// (platform/library-inbox.ingestElementJson) is idempotent by content address.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  encodeElementFile,
  parseElementFile,
  type ElementFileJson,
} from '../src/core/element-file';
import { buildElement, MemoryBackend, type CompositeLook } from '../src/core/library';
import { encodeCompositePng, type Composite } from '../src/core/composite';
import { ingestElementJson } from '../src/platform/library-inbox';

/** A tiny 6x4 composite: a lit diagonal on transparent. */
function tinyComposite(): Composite {
  const w = 6;
  const h = 4;
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h);
  for (let i = 0; i < Math.min(w, h); i++) {
    covered[i * w + i] = 1;
    tones[i * w + i] = 60 + i * 40;
  }
  return { w, h, tones, covered };
}

const THUMB = 'data:image/png;base64,dGh1bWI=';

async function buildTiny(look?: CompositeLook) {
  const composite = tinyComposite();
  const png = encodeCompositePng(composite, 'two', 8, 2);
  return buildElement({
    composite,
    png,
    thumbnail: THUMB,
    source: 'burn',
    aspect: 'landscape',
    palette: 'two',
    matrix: 8,
    look,
    createdAt: 1_752_500_000_000,
  });
}

describe('base64 (hand-rolled, environment-identical)', () => {
  it('round-trips all lengths mod 3', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 255, 256, 257]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 255);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('rejects garbage characters', () => {
    expect(() => base64ToBytes('ab$d')).toThrow(/invalid base64/);
  });
});

describe('element file round-trip + verification', () => {
  it('encodes and parses back the exact record + blobs', async () => {
    const built = await buildTiny();
    const parsed = await parseElementFile(encodeElementFile(built));
    expect(parsed.record).toEqual(built.record);
    const byHash = new Map(parsed.blobs.map((b) => [b.hash, b.bytes]));
    for (const b of built.blobs) {
      expect(byHash.get(b.hash)).toEqual(b.bytes);
    }
  });

  it('a styled look survives and its id verifies', async () => {
    const look: CompositeLook = {
      cellStyle: 'round',
      dotDensity: 14,
      dotSize: 8,
      dotGrow: true,
      dotInk: [255, 64, 64],
      background: [10, 10, 12],
    };
    const built = await buildTiny(look);
    expect(built.record.look).toBeDefined();
    expect(built.record.id).not.toBe(built.record.pngHash);
    const parsed = await parseElementFile(encodeElementFile(built));
    expect(parsed.record.look).toEqual(look);
  });

  it('REFUSES a tampered blob (hash mismatch)', async () => {
    const built = await buildTiny();
    const json = JSON.parse(encodeElementFile(built)) as ElementFileJson;
    const firstHash = Object.keys(json.blobs)[0];
    const bytes = base64ToBytes(json.blobs[firstHash]);
    bytes[0] ^= 0xff;
    json.blobs[firstHash] = bytesToBase64(bytes);
    await expect(parseElementFile(JSON.stringify(json))).rejects.toThrow(/fails its hash/);
  });

  it('REFUSES a tampered look (id no longer matches the content)', async () => {
    const built = await buildTiny({
      cellStyle: 'round',
      dotDensity: 14,
      dotSize: 8,
      dotGrow: true,
      dotInk: null,
      background: null,
    });
    const json = JSON.parse(encodeElementFile(built)) as ElementFileJson;
    json.record.look = { ...json.record.look!, dotSize: 20 };
    await expect(parseElementFile(JSON.stringify(json))).rejects.toThrow(/id does not match/);
  });

  it('REFUSES structural breakage: format, version, missing blob, bad dims', async () => {
    const built = await buildTiny();
    const good = JSON.parse(encodeElementFile(built)) as ElementFileJson;

    await expect(parseElementFile('not json')).rejects.toThrow(/not valid JSON/);
    await expect(parseElementFile(JSON.stringify({ ...good, format: 'other' }))).rejects.toThrow(
      /not a dithtill-element/,
    );
    await expect(parseElementFile(JSON.stringify({ ...good, version: 99 }))).rejects.toThrow(
      /unsupported version/,
    );

    const missing = { ...good, blobs: { ...good.blobs } };
    delete missing.blobs[good.record.tonesHash];
    await expect(parseElementFile(JSON.stringify(missing))).rejects.toThrow(
      /does not carry|references a blob/,
    );

    const badDims = { ...good, record: { ...good.record, w: 9999 } };
    await expect(parseElementFile(JSON.stringify(badDims))).rejects.toThrow(
      /bad grid dims|length does not match/,
    );
  });
});

describe('backend ingest (the app half of the bridge)', () => {
  it('puts blobs + record and is idempotent by content address', async () => {
    const backend = new MemoryBackend();
    const built = await buildTiny();
    const text = encodeElementFile(built);

    const first = await ingestElementJson(text, backend);
    expect(first.id).toBe(built.record.id);
    expect(await backend.loadAll()).toHaveLength(1);
    expect(await backend.hasBlob(built.record.tonesHash)).toBe(true);
    expect(await backend.hasBlob(built.record.pngHash)).toBe(true);

    // Re-ingesting the same file rewrites the same record — still ONE element.
    await ingestElementJson(text, backend);
    expect(await backend.loadAll()).toHaveLength(1);
  });

  it('a corrupt file never touches the backend', async () => {
    const backend = new MemoryBackend();
    const built = await buildTiny();
    const json = JSON.parse(encodeElementFile(built)) as ElementFileJson;
    const firstHash = Object.keys(json.blobs)[0];
    json.blobs[firstHash] = bytesToBase64(new Uint8Array([1, 2, 3]));
    await expect(ingestElementJson(JSON.stringify(json), backend)).rejects.toThrow();
    expect(await backend.loadAll()).toHaveLength(0);
    expect(await backend.hasBlob(built.record.tonesHash)).toBe(false);
  });
});
