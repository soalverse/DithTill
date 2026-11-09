// Library backpack guards: content-addressing dedupes + GCs correctly,
// and a stored element's BAKED PNG decodes to EXACTLY the composite preview — so a
// Library element is preview==export, the same parity the rest of the app holds.
import { describe, it, expect } from 'vitest';
import UPNG from 'upng-js';
import {
  buildElement,
  isNeutralLook,
  serializeLook,
  orphanHashes,
  referencedHashes,
  sha256Hex,
  MemoryBackend,
  type BuildInput,
  type CompositeLook,
} from '../src/core/library';
import {
  CELL_STYLE_DEFAULT,
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_SIZE_DEFAULT,
} from '../src/core/cell-style';
import {
  compositeCellIndex,
  encodeCompositePng,
  compositeHasContent,
  type Composite,
} from '../src/core/composite';
import { PALETTES, type MatrixId, type PaletteId } from '../src/core/dither-constants';

/** A small covered tone ramp for tests. */
function rampComposite(w: number, h: number): Composite {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < w * h; i++) tones[i] = ((i * 255) / (w * h)) | 0;
  return { w, h, tones, covered };
}

function input(c: Composite, palette: PaletteId, matrix: MatrixId): BuildInput {
  const png = encodeCompositePng(c, palette, matrix, 1);
  return {
    composite: c,
    png,
    thumbnail: '',
    source: 'draw',
    aspect: 'landscape',
    palette,
    matrix,
    createdAt: 0,
  };
}

describe('sha256Hex', () => {
  it('matches the known empty-input digest', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('is deterministic for the same bytes', async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    const b = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
    expect(a).not.toBe(await sha256Hex(new Uint8Array([1, 2, 4])));
  });
});

describe('buildElement (content addressing)', () => {
  it('builds a record with three referenced blobs and id == pngHash', async () => {
    const c = rampComposite(12, 8);
    const { record, blobs } = await buildElement(input(c, 'dusk', 8));
    expect(record.id).toBe(record.pngHash);
    expect(record.w).toBe(12);
    expect(record.h).toBe(8);
    expect(blobs.map((b) => b.hash).sort()).toEqual(referencedHashes(record).sort());
    expect(blobs).toHaveLength(3);
  });

  it('dedupes identical content to the same id', async () => {
    const a = await buildElement(input(rampComposite(10, 10), 'two', 4));
    const b = await buildElement(input(rampComposite(10, 10), 'two', 4));
    expect(a.record.id).toBe(b.record.id);
    expect(a.record.tonesHash).toBe(b.record.tonesHash);
  });

  it('a different palette yields a different baked id but the SAME tones blob', async () => {
    const c = rampComposite(10, 10);
    const a = await buildElement(input(c, 'two', 4));
    const b = await buildElement(input(c, 'dusk', 4));
    expect(a.record.id).not.toBe(b.record.id); // different baked look
    expect(a.record.tonesHash).toBe(b.record.tonesHash); // renderable data is shared
  });
});

const NEUTRAL_LOOK: CompositeLook = {
  cellStyle: CELL_STYLE_DEFAULT,
  dotDensity: HALFTONE_DENSITY_DEFAULT,
  dotSize: HALFTONE_SIZE_DEFAULT,
  dotGrow: true,
  dotInk: null,
  background: null,
};

describe('v4 look blob (custom-colour Phase 2, §8.B)', () => {
  it('isNeutralLook: the default look (and undefined) is neutral; any change is not', () => {
    expect(isNeutralLook(undefined)).toBe(true);
    expect(isNeutralLook(NEUTRAL_LOOK)).toBe(true);
    expect(isNeutralLook({ ...NEUTRAL_LOOK, cellStyle: 'round' })).toBe(false);
    expect(isNeutralLook({ ...NEUTRAL_LOOK, dotGrow: false })).toBe(false);
    expect(isNeutralLook({ ...NEUTRAL_LOOK, dotInk: [10, 20, 30] })).toBe(false);
    expect(isNeutralLook({ ...NEUTRAL_LOOK, background: 2 })).toBe(false);
  });

  it('serializeLook canonicalizes each Swatch shape (null / index / custom RGB)', () => {
    expect(serializeLook({ ...NEUTRAL_LOOK, dotInk: null, background: null })).toContain('di:n');
    expect(serializeLook({ ...NEUTRAL_LOOK, dotInk: 3 })).toContain('di:i3');
    expect(serializeLook({ ...NEUTRAL_LOOK, background: [4, 5, 6] })).toContain('bg:c4.5.6');
  });

  it('a NEUTRAL/absent look keeps the pre-v4 id (id == pngHash) and omits the record field', async () => {
    const c = rampComposite(10, 10);
    const bare = await buildElement(input(c, 'two', 4)); // no look
    const neutral = await buildElement({ ...input(c, 'two', 4), look: NEUTRAL_LOOK });
    expect(bare.record.id).toBe(bare.record.pngHash); // byte-identical to before v4
    expect(bare.record.look).toBeUndefined();
    expect(neutral.record.id).toBe(neutral.record.pngHash); // neutral omitted → same id
    expect(neutral.record.look).toBeUndefined();
    expect(bare.record.id).toBe(neutral.record.id); // dedupes with an old v3 record
  });

  it('a NON-neutral look mints a DISTINCT id, persists the look, shares the content blobs', async () => {
    const c = rampComposite(10, 10);
    const plain = await buildElement(input(c, 'two', 4));
    const styled = await buildElement({
      ...input(c, 'two', 4),
      look: { ...NEUTRAL_LOOK, cellStyle: 'round', dotInk: [200, 30, 30] },
    });
    expect(styled.record.id).not.toBe(plain.record.id); // a different element
    expect(styled.record.look).toEqual({
      ...NEUTRAL_LOOK,
      cellStyle: 'round',
      dotInk: [200, 30, 30],
    });
    // Renderable + baked bytes are still content-addressed → shared (dedupe by content).
    expect(styled.record.tonesHash).toBe(plain.record.tonesHash);
    expect(styled.record.pngHash).toBe(plain.record.pngHash);
  });

  it('same content + same look dedupes; two DIFFERENT looks are two elements', async () => {
    const c = rampComposite(10, 10);
    const look = { ...NEUTRAL_LOOK, cellStyle: 'round' as const, dotDensity: 14 };
    const a = await buildElement({ ...input(c, 'two', 4), look });
    const b = await buildElement({ ...input(c, 'two', 4), look });
    const other = await buildElement({ ...input(c, 'two', 4), look: { ...look, dotDensity: 6 } });
    expect(a.record.id).toBe(b.record.id); // identical look → same id (dedupe)
    expect(a.record.id).not.toBe(other.record.id); // a different look → its own element
  });
});

describe('MemoryBackend', () => {
  it('round-trips records + blobs and dedupes blob writes', async () => {
    const be = new MemoryBackend();
    const { record, blobs } = await buildElement(input(rampComposite(8, 8), 'clay', 2));
    for (const b of blobs) await be.putBlob(b.hash, b.bytes);
    await be.putBlob(blobs[0].hash, blobs[0].bytes); // duplicate write — no-op
    await be.putRecord(record);
    expect(await be.loadAll()).toEqual([record]);
    expect(await be.hasBlob(record.pngHash)).toBe(true);
    expect(await be.getBlob(record.tonesHash)).toEqual(
      blobs.find((b) => b.hash === record.tonesHash)?.bytes,
    );
    await be.deleteBlob(record.pngHash);
    expect(await be.hasBlob(record.pngHash)).toBe(false);
  });
});

describe('orphanHashes (GC)', () => {
  it('only orphans blobs no survivor references', async () => {
    const shared = rampComposite(10, 10);
    const a = (await buildElement(input(shared, 'two', 4))).record; // shares tones with b
    const b = (await buildElement(input(shared, 'dusk', 4))).record;
    // Removing a, with b surviving: a's tones/covered are still referenced by b;
    // only a's unique png blob is orphaned.
    const orphans = orphanHashes(a, [b]);
    expect(orphans).toEqual([a.pngHash]);
    // Removing both: every blob is orphaned.
    expect(orphanHashes(a, []).sort()).toEqual(referencedHashes(a).sort());
  });
});

describe('stored element parity', () => {
  it('the baked PNG decodes to exactly the composite preview', () => {
    const c = rampComposite(16, 12);
    const palette: PaletteId = 'dusk';
    const matrix: MatrixId = 8;
    expect(compositeHasContent(c)).toBe(true);
    const png = encodeCompositePng(c, palette, matrix, 1);
    const dec = UPNG.decode(
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
    );
    const got = new Uint8Array(UPNG.toRGBA8(dec)[0]);
    const pal = PALETTES[palette];
    const N = pal.length / 3;
    let diffs = 0;
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const i = y * c.w + x;
        const idx = compositeCellIndex(c.tones[i], x, y, N, matrix);
        const o = i * 4;
        if (
          got[o] !== pal[idx * 3] ||
          got[o + 1] !== pal[idx * 3 + 1] ||
          got[o + 2] !== pal[idx * 3 + 2] ||
          got[o + 3] !== 255
        ) {
          diffs++;
        }
      }
    }
    expect(diffs).toBe(0);
  });
});
