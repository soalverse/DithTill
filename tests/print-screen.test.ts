// =============================================================================
// Print screens: every layer draws its own screen anchored to it, and
// inks overprint. Pins the owner's marquee bug (the word blanked every few frames on
// the screen-fixed lattice), the anchor (moving = an exact shift), upright vs turning
// screens, overprint on dark / light / transparent, Solid, opacity thinning, Palette
// mode, text's LED dots, and determinism.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { renderTextRaster } from '../src/core/dot-font';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import { paletteRgbAt } from '../src/core/dither-constants';
import {
  SCREEN_LOOK_DEFAULT,
  isLightBackground,
  renderPrintScreen,
  type PrintFrame,
  type ScreenLayer,
  type ScreenLook,
  type ScreenRaster,
} from '../src/core/print-screen';
import type { Rgb } from '../src/core/color';
import type { Placement, SceneNode } from '../src/state/scene-store';
import { SCENE_LOOK_DEFAULT } from '../src/state/scene-store';

const look = (patch: Partial<ScreenLook>): ScreenLook => ({ ...SCREEN_LOOK_DEFAULT, ...patch });
const place = (x: number, y: number, extra: Partial<Placement> = {}): Placement => ({
  x,
  y,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  ...extra,
});
/** A w×h raster: fully covered, tone from `fn` (default a left→right ramp). */
function raster(
  w: number,
  h: number,
  fn: (x: number, y: number) => number = (x) => (x * 255) / (w - 1),
): ScreenRaster {
  const tones = new Uint8Array(w * h);
  const covered = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tones[y * w + x] = Math.round(fn(x, y));
  return { w, h, tones, covered };
}
const BLACK: Rgb = [0, 0, 0];
const lit = (fr: PrintFrame): number => {
  let n = 0;
  for (let i = 0; i < fr.w * fr.h; i++)
    if (fr.rgba[i * 4] || fr.rgba[i * 4 + 1] || fr.rgba[i * 4 + 2]) n++;
  return n;
};
const px = (fr: PrintFrame, x: number, y: number): number[] => {
  const o = (y * fr.w + x) * 4;
  return [fr.rgba[o], fr.rgba[o + 1], fr.rgba[o + 2], fr.rgba[o + 3]];
};
/** Frame `b` equals frame `a` shifted by (dx, dy) px, wherever both are inside. */
function shifted(a: PrintFrame, b: PrintFrame, dx: number, dy: number): boolean {
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const x2 = x + dx;
      const y2 = y + dy;
      if (x2 < 0 || y2 < 0 || x2 >= b.w || y2 >= b.h) continue;
      for (let c = 0; c < 4; c++)
        if (a.rgba[(y * a.w + x) * 4 + c] !== b.rgba[(y2 * b.w + x2) * 4 + c]) return false;
    }
  }
  return true;
}
const frame = (layers: ScreenLayer[], dims = { w: 48, h: 24 }, background: Rgb | null = BLACK) =>
  renderPrintScreen({ layers, dims, scale: 10, background });

describe('the marquee never blinks (the owner bug)', () => {
  it("the owner's HELLO (Size 3, Spacing 2, Halftone, Density 14) lights every dot on every frame", () => {
    const text = renderTextRaster({ text: 'HELLO', size: 3, spacing: 2, align: 'center' });
    const node = {
      id: 't',
      kind: 'text',
      assetId: 'text:1',
      z: 1,
      placement: place(96, 54),
      look: {},
      crop: null,
      motion: { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 },
    } as unknown as SceneNode;
    const dims = { w: 192, h: 108 };
    const counts = new Set<number>();
    // The frames the old screen-fixed lattice blanked (f101, f104, f106, …) included.
    for (let f = 96; f < 144; f++) {
      const ev = evaluateScene(
        [node],
        SCENE_LOOK_DEFAULT,
        [],
        f,
        240,
        null,
        makeRng(1),
        new Set(),
        {
          dims,
          assetDims: () => text,
        },
      );
      const n = ev.nodes[0];
      const fr = renderPrintScreen({
        layers: [
          {
            raster: text,
            placement: n.placement,
            look: look({ density: 14, dotSize: 6 }),
            led: true,
          },
        ],
        dims,
        scale: 10,
        background: BLACK,
      });
      counts.add(lit(fr));
    }
    // Fully on the glass the whole time: the same dots every frame, and never zero.
    expect(counts.size).toBe(1);
    expect([...counts][0]).toBeGreaterThan(0);
  });

  it('each letter dot is its own dot: a text layer lights one dot per covered cell', () => {
    const text = renderTextRaster({ text: 'I', size: 2, spacing: 1, align: 'center' });
    const dots = text.covered.reduce((a, b) => a + b, 0);
    const one = frame([
      {
        raster: { w: 1, h: 1, tones: Uint8Array.of(255), covered: Uint8Array.of(1) },
        placement: place(4.5, 4.5),
        look: look({ dotSize: 6 }),
        led: true,
      },
    ]);
    const all = frame([
      { raster: text, placement: place(24, 12), look: look({ dotSize: 6 }), led: true },
    ]);
    expect(lit(all)).toBe(lit(one) * dots);
  });
});

describe('the anchor: moving a layer shifts it exactly', () => {
  const photo = raster(20, 12, (x, y) => 40 + ((x * 11 + y * 7) % 200));
  for (const [name, lk] of [
    ['halftone (angled screen)', look({ angle: 30, density: 14 })],
    ['halftone, Tonal off', look({ tonal: false, pattern: 4 })],
    ['dither', look({ style: 'dither', bitSize: 5, pattern: 4 })],
    [
      'dither, Palette',
      look({ style: 'dither', bitSize: 5, colour: { mode: 'palette', palette: 'dusk' } }),
    ],
  ] as const) {
    it(`${name}: whole-pixel moves are an exact shift, fractional ones snap`, () => {
      const a = frame([{ raster: photo, placement: place(20, 12), look: lk }], undefined, null);
      const b = frame([{ raster: photo, placement: place(23.7, 10.4), look: lk }], undefined, null);
      expect(lit(a)).toBeGreaterThan(0);
      expect(shifted(a, b, 37, -16)).toBe(true);
    });
  }
});

describe('turning and growing', () => {
  const flat = raster(30, 30, () => 140);
  // A window well inside the layer, away from its edges.
  const inner = (fr: PrintFrame) => {
    const out: number[] = [];
    for (let y = 100; y < 140; y++) for (let x = 220; x < 260; x++) out.push(...px(fr, x, y));
    return out.join(',');
  };
  const at = (lk: ScreenLook, extra: Partial<Placement>) =>
    frame([{ raster: flat, placement: place(24, 12, extra), look: lk }]);

  it('default: the dots stay upright at their size while the layer turns or grows', () => {
    const lk = look({ density: 12 });
    const base = inner(at(lk, {}));
    expect(inner(at(lk, { rotationDeg: 30 }))).toBe(base);
    expect(inner(at(lk, { scaleX: 1.5, scaleY: 1.5 }))).toBe(base);
  });

  it('"Dots turn + grow": the screen turns and grows with the layer', () => {
    const lk = look({ density: 12, dotsTurn: true });
    const base = inner(at(lk, {}));
    expect(base).toBe(inner(at(look({ density: 12 }), {}))); // unturned = the same screen
    expect(inner(at(lk, { rotationDeg: 30 }))).not.toBe(base);
    expect(inner(at(lk, { scaleX: 1.5, scaleY: 1.5 }))).not.toBe(base);
  });
});

describe('inks overprint', () => {
  const full = raster(10, 10, () => 255);
  const red: Rgb = [200, 0, 0];
  const blue: Rgb = [0, 0, 200];
  const ink = (c: Rgb) => look({ style: 'dither', bitSize: 10, colour: { mode: 'ink', ink: c } });
  const pair = (bg: Rgb | null, solidTop = false) =>
    frame(
      [
        { raster: full, placement: place(10, 10), look: ink(red) },
        { raster: full, placement: place(15, 10), look: ink(blue), solid: solidTop },
      ],
      { w: 30, h: 20 },
      bg,
    );

  it('dark background: lighter where they meet', () => {
    const fr = pair(BLACK);
    expect(px(fr, 125, 100)).toEqual([200, 0, 200, 255]); // overlap
    expect(px(fr, 70, 100)).toEqual([200, 0, 0, 255]); // red alone
  });

  it('light background: darker where they meet, like ink on paper', () => {
    expect(isLightBackground([240, 232, 210])).toBe(true);
    expect(isLightBackground(BLACK)).toBe(false);
    const fr = pair([255, 255, 255]);
    expect(px(fr, 125, 100)).toEqual([0, 0, 0, 255]);
    expect(px(fr, 70, 100)).toEqual([200, 0, 0, 255]);
  });

  it('transparent background mixes like a dark one and stays see-through elsewhere', () => {
    const fr = pair(null);
    expect(px(fr, 125, 100)).toEqual([200, 0, 200, 255]);
    expect(px(fr, 5, 5)).toEqual([0, 0, 0, 0]);
  });

  it('Solid: the top layer blocks what is under its shape', () => {
    const fr = pair(BLACK, true);
    expect(px(fr, 125, 100)).toEqual([0, 0, 200, 255]);
    // A Solid layer with no ink still clears what's under it.
    const dark = frame(
      [
        { raster: full, placement: place(10, 10), look: ink(red) },
        { raster: raster(10, 10, () => 0), placement: place(15, 10), look: ink(blue), solid: true },
      ],
      { w: 30, h: 20 },
    );
    expect(px(dark, 125, 100)).toEqual([0, 0, 0, 255]);
    expect(px(dark, 70, 100)).toEqual([200, 0, 0, 255]);
  });
});

describe('opacity = fewer / smaller dots', () => {
  const photo = raster(30, 16, (x, y) => 60 + ((x * 13 + y * 5) % 180));
  for (const lk of [look({ density: 12 }), look({ style: 'dither', bitSize: 4 })]) {
    it(`${lk.style}: thins out, every dot keeps its full colour, 0% = gone`, () => {
      const counts = [100, 60, 25, 0].map((o) => {
        const fr = frame(
          [
            {
              raster: photo,
              placement: place(24, 12),
              look: { ...lk, shape: 'square' },
              opacity: o,
            },
          ],
          undefined,
          null,
        );
        // Full-coverage pixels keep the ink's exact colour.
        for (let i = 0; i < fr.w * fr.h; i++)
          if (fr.rgba[i * 4 + 3] === 255)
            expect([fr.rgba[i * 4], fr.rgba[i * 4 + 1], fr.rgba[i * 4 + 2]]).toEqual([
              244, 244, 244,
            ]);
        return lit(fr);
      });
      expect(counts[0]).toBeGreaterThan(counts[1]);
      expect(counts[1]).toBeGreaterThan(counts[2]);
      expect(counts[3]).toBe(0);
    });
  }
});

describe('colour', () => {
  it("Palette mode dithers between the palette's shades (never its darkest)", () => {
    const fr = frame([
      {
        raster: raster(40, 20),
        placement: place(24, 12),
        look: look({ style: 'dither', bitSize: 5, colour: { mode: 'palette', palette: 'dusk' } }),
      },
    ]);
    const shades = new Set([1, 2, 3, 4, 5].map((i) => paletteRgbAt('dusk', i).join(',')));
    const seen = new Set<string>();
    for (let i = 0; i < fr.w * fr.h; i++) {
      const c = `${fr.rgba[i * 4]},${fr.rgba[i * 4 + 1]},${fr.rgba[i * 4 + 2]}`;
      if (c !== '0,0,0') seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(2);
    for (const c of seen) expect(shades.has(c)).toBe(true);
  });
});

describe('determinism', () => {
  it('the same input renders the same bytes', () => {
    const layers: ScreenLayer[] = [
      {
        raster: raster(24, 16),
        placement: place(18, 11, { rotationDeg: 17 }),
        look: look({ angle: 15 }),
      },
      {
        raster: raster(12, 12, (x, y) => (x + y) * 10),
        placement: place(30, 12),
        look: look({ style: 'dither', dotsTurn: true }),
        opacity: 70,
      },
    ];
    expect(frame(layers).rgba).toEqual(frame(layers).rgba);
  });
});

describe('a picture rewritten in place shows the new picture (owner bug: the brush drew nothing)', () => {
  it('a brush stroke / the next video frame lands in the same array and appears on the next frame', () => {
    const r = raster(20, 20, () => 0);
    r.covered.fill(0);
    const layers: ScreenLayer[] = [
      { raster: r, placement: place(24, 12), look: look({ style: 'dither' }) },
    ];
    expect(lit(frame(layers))).toBe(0);
    // Paint into the SAME arrays, as the brush and the video previewer do.
    for (let i = 0; i < 40; i++) {
      r.tones[i] = 255;
      r.covered[i] = 1;
    }
    expect(lit(frame(layers))).toBeGreaterThan(0);
  });
});
