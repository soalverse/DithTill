// =============================================================================
// Projects: the versioned format + migrations, the one-file .dithtill
// container, silly names, the store's recovery versions + media sweep, and the id
// counters that keep a reopened project's ids from colliding with new ones.
// (Capture → reopen of a full canvas is proven in the browser: every layer's pixels and
// the layer / loop data reopen identical.)
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  PROJECT_FORMAT,
  SCHEMA_VERSION,
  ProjectFormatError,
  decodeProjectFile,
  encodeProjectFile,
  makeProjectDoc,
  maxIdSuffix,
  projectBlobHashes,
  sillyProjectName,
  upgradeProjectDoc,
  type ProjectBody,
} from '../src/core/project-format';
import { buildElement } from '../src/core/library';
import { nextFreeName } from '../src/platform/save-png';
import {
  MemoryProjectStore,
  RECOVERY_VERSIONS,
  type ProjectRecord,
} from '../src/platform/project-db';
import {
  LOOP_META_DEFAULT,
  nextEventId,
  reserveReactionIds,
  useLoopStore,
} from '../src/state/loop-store';
import { SCENE_LOOK_DEFAULT, reserveNodeIds, useSceneStore } from '../src/state/scene-store';

/** A small body naming the given media hashes (paint planes + a song). */
function body(name: string, media: { tones: string; covered: string; song?: string }): ProjectBody {
  return {
    name,
    canvas: {
      nodes: [],
      scene: { ...SCENE_LOOK_DEFAULT },
      background: null,
      dotInk: null,
      pixel: 2.5,
      aspect: 'landscape',
      detail: 'normal',
    },
    loop: {
      meta: { ...LOOP_META_DEFAULT },
      events: [],
      reactions: [],
      mutedLayers: [],
      audioMuted: [],
      animate: false,
    },
    media: {
      paints: [{ assetId: 'paint:1', w: 2, h: 2, tones: media.tones, covered: media.covered }],
      images: [],
      records: [],
      track: media.song ? { name: 'song.mp3', bytes: media.song } : null,
    },
  };
}

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

function rec(id: string, b: ProjectBody, updatedAt: number): ProjectRecord {
  return {
    id,
    name: b.name,
    createdAt: 1,
    updatedAt,
    thumbnail: '',
    doc: makeProjectDoc(b, 'test'),
  };
}

describe('project format (versioned envelope)', () => {
  it('writes the current schema and reads it back', () => {
    const doc = makeProjectDoc(body('Wobbly Moon', { tones: 'a', covered: 'b' }), 'test');
    expect(doc).toMatchObject({ format: PROJECT_FORMAT, schemaVersion: SCHEMA_VERSION });
    expect(upgradeProjectDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('refuses foreign, malformed and NEWER documents instead of half-reading them', () => {
    expect(() => upgradeProjectDoc({ format: 'something.else', schemaVersion: 1 })).toThrow(
      ProjectFormatError,
    );
    expect(() => upgradeProjectDoc({ format: PROJECT_FORMAT, schemaVersion: 0 })).toThrow(
      /Unknown project version/,
    );
    expect(() =>
      upgradeProjectDoc({ format: PROJECT_FORMAT, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrow(/newer DithTill/);
    expect(() =>
      upgradeProjectDoc({ format: PROJECT_FORMAT, schemaVersion: SCHEMA_VERSION }),
    ).toThrow(/damaged/);
  });

  it('lists every media hash once', () => {
    const b = body('x', { tones: 't', covered: 'c', song: 's' });
    b.media.images.push({
      assetId: 'img:1',
      mime: 'image/png',
      bytes: 'p',
      masks: [{ key: 'm1', alpha: 'a' }],
    });
    b.media.records.push({ record: {} as never, blobs: ['v', 't'] });
    expect(projectBlobHashes(b).sort()).toEqual(['a', 'c', 'p', 's', 't', 'v']);
  });
});

describe('.dithtill file (one self-contained file)', () => {
  const b = body('Static Pancake', { tones: 'h1', covered: 'h2', song: 'h3' });
  const doc = makeProjectDoc(b, 'test');
  const blobs = new Map([
    ['h1', bytes(1, 2, 3, 4)],
    ['h2', bytes(1, 1, 0, 0)],
    ['h3', bytes(9, 8, 7)],
  ]);

  it('round-trips the document and every blob byte for byte', () => {
    const file = encodeProjectFile(doc, blobs);
    expect(new TextDecoder().decode(file.subarray(0, 8))).toBe('DITHTILL');
    const back = decodeProjectFile(file);
    expect(back.doc).toEqual(doc);
    for (const [h, b2] of blobs) expect([...back.blobs.get(h)!]).toEqual([...b2]);
  });

  it('refuses a file missing media, a truncated file and a non-project file', () => {
    expect(() => encodeProjectFile(doc, new Map([['h1', bytes(1)]]))).toThrow(/Missing media/);
    const file = encodeProjectFile(doc, blobs);
    expect(() => decodeProjectFile(file.subarray(0, file.length - 2))).toThrow(ProjectFormatError);
    expect(() => decodeProjectFile(bytes(1, 2, 3))).toThrow(/Not a .dithtill/);
  });

  it('refuses a container from a newer DithTill', () => {
    const file = encodeProjectFile(doc, blobs);
    new DataView(file.buffer).setUint32(8, 99, true);
    expect(() => decodeProjectFile(file)).toThrow(/newer DithTill/);
  });
});

describe('silly project names (owner: "like Suno")', () => {
  it('is two capitalised words and steers clear of names already taken', () => {
    let i = 0;
    const seq = [0.1, 0.2, 0.1, 0.2, 0.7, 0.3];
    const rand = () => seq[i++ % seq.length];
    const first = sillyProjectName(rand);
    expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    i = 0;
    const second = sillyProjectName(rand, new Set([first]));
    expect(second).not.toBe(first);
  });

  it('falls back to a number when every draw is taken', () => {
    const rand = () => 0;
    const name = sillyProjectName(rand);
    expect(sillyProjectName(rand, new Set([name]))).toBe(`${name} 2`);
  });
});

describe('project store (recovery versions + media sweep)', () => {
  it('lists newest first and keeps earlier saves for recovery, newest first, capped', async () => {
    const s = new MemoryProjectStore();
    const blobs = new Map([
      ['t', bytes(1)],
      ['c', bytes(2)],
    ]);
    for (let n = 1; n <= RECOVERY_VERSIONS + 4; n++)
      await s.save(rec('p1', body('One', { tones: 't', covered: 'c' }), n), blobs);
    await s.save(rec('p2', body('Two', { tones: 't', covered: 'c' }), 100), blobs);
    expect((await s.list()).map((p) => p.name)).toEqual(['Two', 'One']);
    const v = await s.versions('p1');
    expect(v).toHaveLength(RECOVERY_VERSIONS);
    expect(v[0].savedAt).toBeGreaterThan(v[v.length - 1].savedAt);
  });

  it('keeps media while any project or version uses it; sweeps it on delete', async () => {
    const s = new MemoryProjectStore();
    const all = new Map([
      ['shared', bytes(1, 1)],
      ['onlyA', bytes(2, 2, 2)],
      ['onlyB', bytes(3)],
    ]);
    await s.save(rec('a', body('A', { tones: 'shared', covered: 'onlyA' }), 1), all);
    await s.save(rec('b', body('B', { tones: 'shared', covered: 'onlyB' }), 2), all);
    expect(await s.bytesUsed()).toBe(6);
    await s.delete('a');
    expect(await s.getBlob('onlyA')).toBeUndefined();
    expect(await s.getBlob('shared')).toBeDefined();
    expect(await s.bytesUsed()).toBe(3);
  });

  it('sweeps media only a pruned version used (no orphans pile up)', async () => {
    const s = new MemoryProjectStore();
    const blobs = new Map<string, Uint8Array>([['c', bytes(0)]]);
    for (let n = 0; n <= RECOVERY_VERSIONS + 1; n++) {
      blobs.set(`t${n}`, bytes(n));
      await s.save(rec('p', body('P', { tones: `t${n}`, covered: 'c' }), n + 1), blobs);
    }
    // The first save's raster was only in versions that have now been pruned.
    expect(await s.getBlob('t0')).toBeUndefined();
    expect(await s.getBlob(`t${RECOVERY_VERSIONS + 1}`)).toBeDefined();
  });

  it('a duplicate shares the stored media (saving needs no new blobs)', async () => {
    const s = new MemoryProjectStore();
    await s.save(
      rec('a', body('A', { tones: 't', covered: 'c' }), 1),
      new Map([
        ['t', bytes(1)],
        ['c', bytes(2)],
      ]),
    );
    const orig = (await s.get('a'))!;
    await s.save({ ...orig, id: 'copy', name: 'A copy' }, new Map());
    expect((await s.list()).map((p) => p.name).sort()).toEqual(['A', 'A copy']);
    await expect(
      s.save(rec('x', body('X', { tones: 'new', covered: 'c' }), 3), new Map()),
    ).rejects.toThrow(/missing media/);
  });
});

describe('id counters skip past a reopened project', () => {
  it('maxIdSuffix reads the highest number for a prefix', () => {
    expect(maxIdSuffix(['paint:3', 'paint:12', 'img:40', 'paint:x'], 'paint:')).toBe(12);
    expect(maxIdSuffix([], 'paint:')).toBe(0);
  });

  it('reaction / node / take ids never collide with loaded ones', () => {
    reserveReactionIds(['re-41']);
    const r = useLoopStore.getState().addReaction({
      nodeId: 'n',
      band: 'low',
      target: { kind: 'pulse' },
      depth: 0.5,
    });
    expect(r).toBe('re-42');

    reserveNodeIds(['node-900']);
    useSceneStore.getState().addPaintNode('paint:1', 10, 10);
    expect(useSceneStore.getState().nodes.some((n) => n.id === 'node-901')).toBe(true);

    useLoopStore.setState({ events: [{ id: 'pr-7' } as never, { id: 'op-2' } as never] });
    expect(nextEventId('pr-')).toBe('pr-8');
    expect(nextEventId('op-')).toBe('op-3');
  });
});

describe('Library element names', () => {
  it('a name rides on the record but never changes the content id (saves still dedupe)', async () => {
    const composite = {
      w: 2,
      h: 1,
      tones: Uint8Array.from([0, 255]),
      covered: Uint8Array.from([1, 1]),
    };
    const base = {
      composite,
      png: Uint8Array.from([137, 80, 78, 71]),
      thumbnail: '',
      source: 'record' as const,
      aspect: 'landscape' as const,
      palette: 'two' as const,
      matrix: 8 as const,
      createdAt: 1,
    };
    const plain = await buildElement(base);
    const named = await buildElement({ ...base, name: 'Wobbly Moon' });
    expect(named.record.id).toBe(plain.record.id);
    expect(named.record.name).toBe('Wobbly Moon');
    expect('name' in plain.record).toBe(false);
  });
});

describe('export file names', () => {
  it('suggests the next free name in the folder, numbered like Library elements', async () => {
    const onDisk = new Set(['Mellow Volcano.png', 'Mellow Volcano 2.png']);
    const taken = async (n: string) => onDisk.has(n);
    expect(await nextFreeName('Mellow Volcano.png', taken)).toBe('Mellow Volcano 3.png');
    expect(await nextFreeName('Mellow Volcano.svg', taken)).toBe('Mellow Volcano.svg');
    expect(await nextFreeName('Mellow Volcano', async (n) => n === 'Mellow Volcano')).toBe(
      'Mellow Volcano 2',
    );
  });
});

// ---- print screens data ---------------------------------------------------

/** A schema-1 document (before the per-layer screen fields + Detail). */
function v1Doc(cellStyle: string, dotDensity: number, palette: string): Record<string, unknown> {
  const b = body('Old', { tones: 'a', covered: 'b' }) as unknown as {
    canvas: Record<string, unknown>;
  };
  const scene: Record<string, unknown> = { ...SCENE_LOOK_DEFAULT, palette };
  for (const k of ['style', 'shape', 'density', 'angle', 'dotsTurn', 'bitSize', 'colourMode'])
    delete scene[k];
  const canvas: Record<string, unknown> = { ...b.canvas, scene, cellStyle, dotDensity };
  delete canvas.detail;
  return { format: PROJECT_FORMAT, schemaVersion: 1, generator: 'old', project: { ...b, canvas } };
}

describe('print screens data', () => {
  it('a v1 project upgrades: the canvas look takes its screen from the canvas-wide style', () => {
    const round = upgradeProjectDoc(v1Doc('round', 14, 'two')).project.canvas;
    expect(round.scene).toMatchObject({ style: 'halftone', shape: 'circle', density: 14 });
    expect(round.scene).toMatchObject({ angle: 45, dotsTurn: false, colourMode: 'ink' });
    expect(round.detail).toBe('normal');
    const block = upgradeProjectDoc(v1Doc('block', 3, 'two')).project.canvas.scene;
    expect(block).toMatchObject({ style: 'halftone', shape: 'square', density: 3 });
    // Dither keeps a multi-shade palette's shades; a two-shade palette is one ink.
    const dusk = upgradeProjectDoc(v1Doc('square', 10, 'dusk')).project.canvas.scene;
    expect(dusk).toMatchObject({ style: 'dither', colourMode: 'palette', palette: 'dusk' });
    const two = upgradeProjectDoc(v1Doc('square', 10, 'two')).project.canvas.scene;
    expect(two).toMatchObject({ style: 'dither', colourMode: 'ink' });
  });

  it('writes the current schema with the Detail', () => {
    expect(SCHEMA_VERSION).toBe(4);
    const doc = makeProjectDoc(body('New', { tones: 'a', covered: 'b' }), 'test');
    expect(upgradeProjectDoc(JSON.parse(JSON.stringify(doc))).project.canvas.detail).toBe('normal');
  });

  it('Solid and Detail are one undo step each; Solid rides on the layer', () => {
    const s = useSceneStore.getState();
    useSceneStore.setState({ nodes: [], detail: 'normal' });
    s.addPaintNode('paint:p2', 10, 10);
    const id = useSceneStore.getState().nodes[0].id;
    const t = useSceneStore.temporal.getState();
    t.clear();
    useSceneStore.getState().setSolid([id], true);
    expect(useSceneStore.getState().nodes[0].solid).toBe(true);
    useSceneStore.getState().setDetail('fine');
    expect(useSceneStore.getState().detail).toBe('fine');
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(2);
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().detail).toBe('normal');
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().nodes[0].solid).toBeUndefined();
    // Setting what's already set is no step.
    useSceneStore.getState().setDetail('normal');
    expect(useSceneStore.temporal.getState().pastStates.length).toBe(0);
  });

  it("the canvas look starts as today's Dither (one canvas square per bit, one ink)", () => {
    expect(SCENE_LOOK_DEFAULT).toMatchObject({
      style: 'dither',
      bitSize: 10,
      colourMode: 'ink',
      dotsTurn: false,
    });
  });
});
