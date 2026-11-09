// The flat canvas background. Contracts: the background is
// CHROME — the exact palette colour where nothing covers, never dithered, and
// omitting it keeps every path byte-identical to before; its TONE is what the
// opacity "over" stack bottoms out on; bakes content-ify it.
import { describe, it, expect } from 'vitest';
import UPNG from 'upng-js';
import { paletteRgbAt, paletteToneAt, PALETTES, PALETTE_IDS } from '../src/core/dither-constants';
import { encodeCompositePng, type Composite } from '../src/core/composite';
import { resolveSceneGrid, type CachedAsset } from '../src/core/scene-resolver';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

const decodeRgba = (png: Uint8Array): Uint8Array => {
  const dec = UPNG.decode(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(UPNG.toRGBA8(dec)[0]);
};

function halfComposite(): Composite {
  // Left half covered (tone ramp), right half empty.
  const w = 8;
  const h = 4;
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w / 2; x++) {
      covered[y * w + x] = 1;
      tones[y * w + x] = x * 60;
    }
  return { w, h, tones, covered };
}

function sceneWith(opacity: number, bgTone?: number, dotSize?: number, dotGrow?: boolean) {
  const assets = new Map<string, CachedAsset>([
    ['a', { w: 6, h: 6, tones: new Uint8Array(36).fill(200), covered: new Uint8Array(36).fill(1) }],
  ]);
  const nodes: SceneNode[] = [
    {
      id: '1',
      assetId: 'a',
      kind: 'asset',
      z: 1,
      placement: { x: 10, y: 8, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: {},
      motion: null,
      opacity,
    },
  ];
  // Size + Tonal are per-element — set them on the scene default so they bake into the grid.
  const scene = { ...SCENE_LOOK_DEFAULT };
  if (dotSize !== undefined) scene.dotSize = dotSize;
  if (dotGrow !== undefined) scene.dotGrow = dotGrow;
  return resolveSceneGrid({
    nodes,
    scene,
    dims: { w: 20, h: 16 },
    assets,
    backgroundTone: bgTone,
  });
}

describe('flat canvas background', () => {
  it('paletteToneAt is the integer luma of the exact palette colour', () => {
    for (const p of PALETTE_IDS) {
      const N = PALETTES[p].length / 3;
      for (let i = 0; i < N; i++) {
        const [r, g, b] = paletteRgbAt(p, i);
        expect(paletteToneAt(p, i)).toBe((77 * r + 150 * g + 29 * b) >> 8);
      }
      // Clamped outside the ramp (a pick survives switching to a shorter palette).
      expect(paletteRgbAt(p, 99)).toEqual(paletteRgbAt(p, N - 1));
      expect(paletteRgbAt(p, -5)).toEqual(paletteRgbAt(p, 0));
    }
  });

  it('composite PNG: uncovered cells become the EXACT flat colour, fully opaque; no bg = unchanged', () => {
    const c = halfComposite();
    const plain = encodeCompositePng(c, 'dusk', 8, 1);
    const sameAsBefore = encodeCompositePng(c, 'dusk', 8, 1, null);
    expect(sameAsBefore).toEqual(plain); // null = byte-identical legacy path

    const withBg = decodeRgba(encodeCompositePng(c, 'dusk', 8, 1, 2));
    const [r, g, b] = paletteRgbAt('dusk', 2);
    for (let y = 0; y < c.h; y++)
      for (let x = c.w / 2; x < c.w; x++) {
        const o = (y * c.w + x) * 4;
        expect([withBg[o], withBg[o + 1], withBg[o + 2], withBg[o + 3]]).toEqual([r, g, b, 255]);
      }
    // Covered cells unchanged vs the transparent export.
    const plainRgba = decodeRgba(plain);
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w / 2; x++) {
        const o = (y * c.w + x) * 4;
        expect(withBg.slice(o, o + 3)).toEqual(plainRgba.slice(o, o + 3));
      }
  });

  it('resolver: the over stack bottoms out on the background tone, or PAPER without one', () => {
    const ci = 8 * 20 + 10; // centre cell under the element
    const noBg = sceneWith(50);
    expect(noBg.tones[ci]).toBe(228); // fades toward paper (255) — ink density
    const withBg = sceneWith(50, 40);
    expect(withBg.covered[ci]).toBe(1);
    expect(withBg.tones[ci]).toBe(120); // (200*128 + 40*128) / 256
    const faint = sceneWith(45, 40);
    expect(faint.covered[ci]).toBe(1);
    // Cells NO element touches stay uncovered in the resolver (bg is chrome,
    // painted at the render/encode layer) — the faded style keeps transparency.
    expect(withBg.covered[0]).toBe(0);
    expect(noBg.covered[0]).toBe(0);
  });
});

describe('per-element Size + Tonal bake into the grid', () => {
  it("a node's look override sets that element's cells' dSize/dGrow; others inherit the scene", () => {
    const mk = (): CachedAsset => ({
      w: 4,
      h: 4,
      tones: new Uint8Array(16).fill(180),
      covered: new Uint8Array(16).fill(1),
    });
    const assets = new Map<string, CachedAsset>([
      ['a', mk()],
      ['b', mk()],
    ]);
    const nodes: SceneNode[] = [
      {
        id: '1',
        assetId: 'a',
        kind: 'asset',
        z: 1,
        placement: { x: 4, y: 8, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        crop: null,
        look: {}, // inherits the scene default
        motion: null,
        opacity: 100,
      },
      {
        id: '2',
        assetId: 'b',
        kind: 'asset',
        z: 2,
        placement: { x: 14, y: 8, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        crop: null,
        look: { dotSize: 28, dotGrow: false }, // per-element override
        motion: null,
        opacity: 100,
      },
    ];
    const grid = resolveSceneGrid({
      nodes,
      scene: { ...SCENE_LOOK_DEFAULT, dotSize: 6, dotGrow: true },
      dims: { w: 20, h: 16 },
      assets,
    });
    // Under element A (no override) → the scene default: size 6, grow on.
    const ai = 8 * 20 + 4;
    expect(grid.covered[ai]).toBe(1);
    expect(grid.dSize[ai]).toBe(6);
    expect(grid.dGrow[ai]).toBe(1);
    // Under element B (override) → its own: size 28, grow off — independent of A.
    const bi = 8 * 20 + 14;
    expect(grid.covered[bi]).toBe(1);
    expect(grid.dSize[bi]).toBe(28);
    expect(grid.dGrow[bi]).toBe(0);
  });
});
