// =============================================================================
// Error-diffusion dithers (J4). Pins the definition (golden snapshots of every
// recipe), that the grain carries the tone, that a layer's shape is a wall, that the CPU
// reference and the print screens share one pass, that moving a diffusion layer shifts its
// bits exactly (no crawl, even sliding out of the frame), and that the pattern saves.
// =============================================================================
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DIFFUSION,
  DIFFUSION_IDS,
  LUMA_SCALE,
  PATTERN_IDS,
  diffuseLums,
  isDiffusion,
  orderedPattern,
} from '../src/core/dither-constants';
import { ditherIndices } from '../src/core/dither-cpu';
import {
  SCREEN_LOOK_DEFAULT,
  renderPrintScreen,
  type PrintFrame,
  type ScreenLayer,
  type ScreenLook,
  type ScreenRaster,
} from '../src/core/print-screen';
import type { Rgb } from '../src/core/color';
import { encodeCompositePng } from '../src/core/composite';
import { buildElement } from '../src/core/library';
import { encodeElementFile, parseElementFile } from '../src/core/element-file';
import { createSceneDoc } from '../scripts/mcp/scene-doc';

const S = LUMA_SCALE;
const ramp = (w: number, h: number) => {
  const l = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) l[y * w + x] = Math.round(((x + y * 0.37) / (w + h * 0.37)) * S);
  return l;
};
const all = (n: number) => new Uint8Array(n).fill(1);
const hash = (a: Uint8Array) => createHash('sha256').update(a).digest('hex').slice(0, 16);

describe('the recipes', () => {
  it('are the five locked ones, after the threshold tables in the Pattern list', () => {
    expect(DIFFUSION_IDS).toEqual(['floyd', 'atkinson', 'jarvis', 'stucki', 'sierra']);
    expect(PATTERN_IDS.slice(-5)).toEqual(DIFFUSION_IDS);
    expect(PATTERN_IDS.filter(isDiffusion)).toEqual(DIFFUSION_IDS);
    expect(orderedPattern('floyd')).toBe('blue');
    expect(orderedPattern(8)).toBe(8);
  });

  it('weights sum to the divisor (Atkinson passes 6/8 on purpose) and only look forward', () => {
    for (const id of DIFFUSION_IDS) {
      const { div, taps } = DIFFUSION[id];
      const sum = taps.reduce((s, t) => s + t[2], 0);
      expect(sum).toBe(id === 'atkinson' ? 6 : div);
      for (const [dx, dy] of taps) expect(dy > 0 || (dy === 0 && dx > 0)).toBe(true);
    }
  });

  it('golden: every recipe on a fixed ramp (changing one re-triggers this)', () => {
    const w = 48;
    const h = 32;
    const out: Record<string, string> = {};
    for (const id of DIFFUSION_IDS)
      for (const N of [2, 6])
        out[`${id}.N${N}`] = hash(diffuseLums(ramp(w, h), all(w * h), w, h, N, id));
    // An odd starting row flips the serpentine direction (the anchor keeps it per layer).
    out['floyd.N2.j1'] = hash(diffuseLums(ramp(w, h), all(w * h), w, h, 2, 'floyd', 1));
    expect(out).toMatchSnapshot();
  });

  it('is deterministic (same input, same bits)', () => {
    const a = diffuseLums(ramp(40, 30), all(1200), 40, 30, 2, 'jarvis', 7);
    const b = diffuseLums(ramp(40, 30), all(1200), 40, 30, 2, 'jarvis', 7);
    expect(a).toEqual(b);
  });
});

describe('the grain carries the tone', () => {
  for (const id of DIFFUSION_IDS)
    it(`${id}: a flat grey lights about its share of bits (very dark and light too)`, () => {
      const w = 64;
      const h = 64;
      for (const t of [0.03, 0.25, 0.5, 0.75, 0.97]) {
        const l = new Int32Array(w * h).fill(Math.round(t * S));
        const on = diffuseLums(l, all(w * h), w, h, 2, id).reduce((s, v) => s + v, 0);
        // Atkinson drops a quarter of its error: it pushes tones towards the ends.
        const tol = id === 'atkinson' ? 0.12 : 0.02;
        expect(Math.abs(on / (w * h) - t)).toBeLessThan(tol);
      }
      // Black stays black, white stays white.
      const black = diffuseLums(new Int32Array(64), all(64), 8, 8, 2, id);
      expect(black.every((v) => v === 0)).toBe(true);
      const white = diffuseLums(new Int32Array(64).fill(S), all(64), 8, 8, 2, id);
      expect(white.every((v) => v === 1)).toBe(true);
    });

  it('Palette mode uses every shade of a 6-shade ramp', () => {
    const out = diffuseLums(ramp(60, 20), all(1200), 60, 20, 6, 'floyd');
    expect(new Set(out)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });
});

describe("a layer's shape is a wall", () => {
  it('masked cells take no ink, and error never crosses a 2-wide gap', () => {
    const w = 20;
    const h = 10;
    const mask = all(w * h);
    for (let y = 0; y < h; y++) mask[y * w + 9] = mask[y * w + 10] = 0;
    const a = new Int32Array(w * h).fill(S / 2);
    const b = Int32Array.from(a);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < 9; x++) b[y * w + x] = (x * 7919 + y * 104729) % S;
    for (const id of DIFFUSION_IDS) {
      const oa = diffuseLums(a, mask, w, h, 2, id);
      const ob = diffuseLums(b, mask, w, h, 2, id);
      for (let y = 0; y < h; y++) {
        expect(oa[y * w + 9] + oa[y * w + 10]).toBe(0);
        for (let x = 11; x < w; x++) expect(ob[y * w + x]).toBe(oa[y * w + x]);
      }
    }
  });
});

describe('the CPU reference runs the same pass', () => {
  it('ditherIndices on a grey grid == diffuseLums on its lumas', () => {
    const w = 32;
    const h = 24;
    const rgba = new Uint8Array(w * h * 4);
    const lums = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const t = (i * 37) % 256;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = t;
      rgba[i * 4 + 3] = 255;
      lums[i] = 256 * t; // grey RGB t → lumI = 256·t exactly
    }
    for (const id of DIFFUSION_IDS) {
      const ref = ditherIndices(rgba, w, h, { palette: 'two', matrix: id, contrast: 1 });
      expect(ref).toEqual(diffuseLums(lums, all(w * h), w, h, 2, id));
      const dusk = ditherIndices(rgba, w, h, { palette: 'dusk', matrix: id, contrast: 1 });
      expect(dusk).toEqual(diffuseLums(lums, all(w * h), w, h, 6, id));
    }
  });
});

// ---- on the print screens ------------------------------------------------------------

const BLACK: Rgb = [0, 0, 0];
const look = (patch: Partial<ScreenLook>): ScreenLook => ({
  ...SCREEN_LOOK_DEFAULT,
  style: 'dither',
  pattern: 'floyd',
  ...patch,
});
function raster(w: number, h: number, fn: (x: number, y: number) => number): ScreenRaster {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tones[y * w + x] = Math.round(fn(x, y));
  return { w, h, tones, covered };
}
const photo = raster(30, 20, (x, y) => 128 + 100 * Math.sin(x / 4) * Math.cos(y / 3));
const layer = (x: number, y: number, l: Partial<ScreenLook> = {}, r = photo): ScreenLayer => ({
  raster: r,
  placement: { x, y, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  look: look(l),
});
const frame = (layers: ScreenLayer[]) =>
  renderPrintScreen({ layers, dims: { w: 40, h: 30 }, scale: 10, background: BLACK });
/** Frame `b` equals frame `a` shifted by (dx, dy) px, wherever both are inside. */
function shifted(a: PrintFrame, b: PrintFrame, dx: number, dy: number): boolean {
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const x2 = x + dx;
      const y2 = y + dy;
      if (x2 < 0 || y2 < 0 || x2 >= b.w || y2 >= b.h) continue;
      for (let c = 0; c < 4; c++)
        if (a.rgba[(y * a.w + x) * 4 + c] !== b.rgba[(y2 * b.w + x2) * 4 + c]) return false;
    }
  return true;
}
const lit = (f: PrintFrame) => {
  let n = 0;
  for (let i = 0; i < f.w * f.h; i++) if (f.rgba[i * 4]) n++;
  return n;
};

describe('diffusion on the print screens', () => {
  it('draws a dither layer with every recipe; Halftone reads the stand-in (J6 decides)', () => {
    for (const id of DIFFUSION_IDS)
      expect(lit(frame([layer(20, 15, { pattern: id })]))).toBeGreaterThan(0);
    const ht = frame([layer(20, 15, { style: 'halftone', pattern: 'floyd', tonal: false })]);
    const htBlue = frame([layer(20, 15, { style: 'halftone', pattern: 'blue', tonal: false })]);
    expect(ht.rgba).toEqual(htBlue.rgba);
  });

  for (const pattern of DIFFUSION_IDS)
    it(`moving a ${pattern} layer shifts its bits exactly, out of the frame too`, () => {
      const a = frame([layer(20, 15, { pattern })]);
      for (const [dx, dy] of [
        [0.3, 0],
        [3.7, -1.2],
        [-12.5, 0],
        [14, 9],
      ] as const) {
        const b = frame([layer(20 + dx, 15 + dy, { pattern })]);
        const px = Math.round((20 + dx) * 10) - 200;
        const py = Math.round((15 + dy) * 10) - 150;
        expect(shifted(a, b, px, py)).toBe(true);
      }
    });

  it('a Palette-mode layer diffuses between the shades', () => {
    const fr = frame([layer(20, 15, { colour: { mode: 'palette', palette: 'dusk' } })]);
    const colours = new Set<number>();
    for (let i = 0; i < fr.w * fr.h; i++)
      colours.add((fr.rgba[i * 4] << 16) | (fr.rgba[i * 4 + 1] << 8) | fr.rgba[i * 4 + 2]);
    expect(colours.size).toBeGreaterThan(3);
  });
});

describe('the pattern travels', () => {
  it('a Library element file with a diffusion pattern round-trips and verifies', async () => {
    const composite = {
      w: 4,
      h: 4,
      tones: new Uint8Array(16).fill(120),
      covered: new Uint8Array(16).fill(1),
    };
    const built = await buildElement({
      composite,
      png: encodeCompositePng(composite, 'two', 'blue', 2),
      thumbnail: 'data:image/png;base64,dGh1bWI=',
      source: 'record',
      aspect: 'square',
      palette: 'two',
      matrix: 'atkinson',
      createdAt: 1_752_500_000_000,
    });
    const parsed = await parseElementFile(encodeElementFile(built));
    expect(parsed.record.matrix).toBe('atkinson');
  });

  it("the AI tools' scene file takes a diffusion pattern and refuses an unknown one", () => {
    expect(createSceneDoc({ matrix: 'floyd' }).scene.matrix).toBe('floyd');
    expect(() => createSceneDoc({ matrix: 'burkes' as never })).toThrow(/unknown matrix/);
  });
});
