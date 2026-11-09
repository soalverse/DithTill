// =============================================================================
// The canvas → print screens seam: the export walk draws through it
// (renderLoopFrameImage), its PNG / video raster is that picture exactly, the marquee
// bug stays fixed through the whole export path, and a layer's look maps to its screen.
// =============================================================================
import { describe, expect, it } from 'vitest';
import UPNG from 'upng-js';
import { renderTextRaster } from '../src/core/dot-font';
import {
  renderLoopFrameImage,
  renderLoopFramePng,
  type LoopRenderInput,
} from '../src/core/loop-render';
import { printFrameToRaster, sceneScreenLayers, screenLookOf } from '../src/core/scene-screen';
import { paletteRgbAt } from '../src/core/dither-constants';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

const text = renderTextRaster({ text: 'HELLO', size: 3, spacing: 2, align: 'center' });
const node = (patch: Partial<SceneNode>): SceneNode => ({
  id: 't',
  assetId: 'text:1',
  kind: 'text',
  z: 1,
  placement: { x: 96, y: 54, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: {},
  motion: null,
  opacity: 100,
  ...patch,
});
const input = (nodes: SceneNode[], scene = SCENE_LOOK_DEFAULT): LoopRenderInput => ({
  nodes,
  scene,
  events: [],
  frames: 240,
  seed: 1,
  dims: { w: 192, h: 108 },
  assets: new Map([['text:1', text]]),
  mutedLayers: new Set(),
  features: null,
  background: { rgb: [0, 0, 0] },
});
const lit = (rgba: Uint8ClampedArray | Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] || rgba[i + 1] || rgba[i + 2]) n++;
  return n;
};

describe('print screens through the export walk', () => {
  it("the owner's marquee lights the same dots on every exported frame", () => {
    const halftone = { ...SCENE_LOOK_DEFAULT, style: 'halftone' as const, density: 14, dotSize: 6 };
    const marquee = node({
      motion: { type: 'marquee', cycles: 1, amp: 8, ax: 1, ay: 0, phase0: 0 },
    });
    const counts = new Set<number>();
    for (let f = 96; f < 144; f += 2)
      counts.add(lit(renderLoopFrameImage(input([marquee], halftone), f, 4).rgba));
    expect(counts.size).toBe(1);
    expect([...counts][0]).toBeGreaterThan(0);
  });

  it('the PNG (and the video raster) is the drawn picture exactly', () => {
    const inp = input([node({ look: { style: 'halftone', angle: 30 } })]);
    const img = renderLoopFrameImage(inp, 0, 3);
    const png = renderLoopFramePng(inp, 0, 3);
    const dec = UPNG.decode(
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
    );
    expect(new Uint8Array(UPNG.toRGBA8(dec)[0])).toEqual(new Uint8Array(img.rgba));
  });

  it('indexing posterizes deterministically when a frame has over 256 colours', () => {
    const w = 64;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) rgba.set([i & 255, (i >> 2) & 255, (i * 7) & 255, 255], i * 4);
    const a = printFrameToRaster({ w, h: w, rgba });
    const b = printFrameToRaster({ w, h: w, rgba });
    expect(a.palette.length / 3).toBeLessThanOrEqual(256);
    expect(a.palette).toEqual(b.palette);
  });
});

describe("a layer's look → its screen", () => {
  it('inherits the canvas look, takes its own dot colour, else the canvas dot colour', () => {
    const scene = { ...SCENE_LOOK_DEFAULT, palette: 'dusk' as const, style: 'halftone' as const };
    const canvasInk = screenLookOf(scene, null).colour;
    expect(canvasInk).toEqual({ mode: 'ink', ink: paletteRgbAt('dusk', 5) });
    expect(screenLookOf(scene, 2).colour).toEqual({ mode: 'ink', ink: paletteRgbAt('dusk', 2) });
    expect(screenLookOf({ ...scene, dotInk: [9, 8, 7] }, 2).colour).toEqual({
      mode: 'ink',
      ink: [9, 8, 7],
    });
    expect(screenLookOf({ ...scene, colourMode: 'palette' }, null).colour).toEqual({
      mode: 'palette',
      palette: 'dusk',
    });
  });

  it('bottom → top, hidden layers out, text keeps its LED dots, Solid rides along', () => {
    const layers = sceneScreenLayers(
      [
        node({ id: 'top', z: 3, solid: true }),
        node({ id: 'hid', z: 2, hidden: true }),
        node({ id: 'bot', z: 1, kind: 'paint' }),
      ],
      SCENE_LOOK_DEFAULT,
      new Map([['text:1', text]]),
      null,
    );
    expect(layers.map((l) => [!!l.led, !!l.solid])).toEqual([
      [false, false],
      [true, true],
    ]);
  });
});

describe('the SVG export', () => {
  it("draws the same layers as vectors: each ink's dots, overprinting, a Solid layer's shape", async () => {
    const { printScreenSvg, SCREEN_LOOK_DEFAULT } = await import('../src/core/print-screen');
    const raster = {
      w: 4,
      h: 4,
      tones: new Uint8Array(16).fill(255),
      covered: new Uint8Array(16).fill(1),
    };
    const placement = { x: 4, y: 4, scaleX: 1, scaleY: 1, rotationDeg: 0 };
    const bits = {
      ...SCREEN_LOOK_DEFAULT,
      style: 'dither' as const,
      colour: { mode: 'ink' as const, ink: [200, 0, 0] as [number, number, number] },
    };
    const dark = printScreenSvg({
      layers: [{ raster, placement, look: bits }],
      dims: { w: 8, h: 8 },
      scale: 10,
      background: [0, 0, 0],
    });
    expect(dark).toContain('viewBox="0 0 80 80"');
    expect(dark).toContain('fill="#c80000"');
    expect(dark).toContain('mix-blend-mode:lighten');
    // Full tone, one bit per square: 16 bits.
    expect((dark.match(/fill="#c80000" d="([^"]*)"/)![1].match(/z/g) ?? []).length).toBe(16);
    const paper = printScreenSvg({
      layers: [{ raster, placement, look: bits, solid: true }],
      dims: { w: 8, h: 8 },
      scale: 10,
      background: [255, 255, 255],
    });
    expect(paper).toContain('mix-blend-mode:darken');
    expect(paper).toContain('<path fill="#ffffff" d="M'); // the Solid layer's shape, cleared
  });
});
