// =============================================================================
// Halftone MCP tooling (personal AI tooling, scripts/mcp/) — proves the
// headless pipeline reuses the one dither seam and the stdio server round-trips
// end-to-end: a real client spawns the launcher, calls render_halftone, and the
// PNG lands on disk decodable and correctly sized.
// =============================================================================
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import UPNG from 'upng-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { headlessFrame, parseHexColor, renderHalftone } from '../scripts/mcp/halftone-pipeline';
import { CELL_RENDER_SCALE } from '../src/core/scene-resolver';
import { ASPECT_IDS, computeGrid } from '../src/core/dither-constants';
import { targetFrame } from '../src/ui/image-to-grid';

const decodePng = (png: Uint8Array) =>
  UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);

const decodeRgba = (png: Uint8Array): Uint8Array => new Uint8Array(UPNG.toRGBA8(decodePng(png))[0]);

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'mcp', 'halftone-server-launcher.mjs');

let dir: string;
let sourcePng: string;

/** A 320x240 left-to-right luminance gradient — full tonal range for the dots. */
async function writeGradientSource(file: string): Promise<void> {
  const w = 320;
  const h = 240;
  const raw = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = Math.round((x / (w - 1)) * 255);
      raw[o] = raw[o + 1] = raw[o + 2] = v;
      raw[o + 3] = 255;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(file);
}

/** Ink mass per horizontal half — lets the invert test see the gradient flip. */
function inkByHalf(rgba: Uint8Array, width: number): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) continue;
    const x = (i >> 2) % width;
    if (x < width / 2) left++;
    else right++;
  }
  return { left, right };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dithtill-mcp-'));
  sourcePng = path.join(dir, 'gradient.png');
  await writeGradientSource(sourcePng);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('halftone headless pipeline', () => {
  it('renders a decodable halftone PNG at grid x CELL_RENDER_SCALE', async () => {
    const res = await renderHalftone({ input: sourcePng, cellSize: 5 });
    // 'auto' aspect on a 4:3 source = the app's 480x360 landscape frame.
    expect({ targetW: res.targetW, targetH: res.targetH }).toEqual({ targetW: 480, targetH: 360 });
    const { LW, LH } = computeGrid(480, 360, 5);
    expect({ LW: res.LW, LH: res.LH }).toEqual({ LW, LH });
    expect(res.width).toBe(LW * CELL_RENDER_SCALE);
    expect(res.height).toBe(LH * CELL_RENDER_SCALE);

    const dec = decodePng(res.png);
    expect(dec.width).toBe(res.width);
    expect(dec.height).toBe(res.height);
    // The gradient must produce ink: some pixels on, and (transparent bg) some off.
    const rgba = decodeRgba(res.png);
    let on = 0;
    let off = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] > 0) on++;
      else off++;
    }
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0);
  });

  it('is deterministic', async () => {
    const a = await renderHalftone({ input: sourcePng, dotSize: 8, density: 12 });
    const b = await renderHalftone({ input: sourcePng, dotSize: 8, density: 12 });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });

  it('respects fixed aspect frames and background fill', async () => {
    const res = await renderHalftone({
      input: sourcePng,
      aspect: 'square',
      background: '#101014',
    });
    expect({ targetW: res.targetW, targetH: res.targetH }).toEqual({ targetW: 480, targetH: 480 });
    const rgba = decodeRgba(res.png);
    // Flat background => fully opaque file.
    let translucent = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) translucent++;
    expect(translucent).toBe(0);
  });

  it('moves every dial: invert flips the gradient, tone/shape/palette/ink change the render', async () => {
    const base = await renderHalftone({ input: sourcePng });
    const inverted = await renderHalftone({ input: sourcePng, invert: true });
    // Gradient is dark-left/bright-right; ink mass must flip sides under invert.
    const b = inkByHalf(decodeRgba(base.png), base.width);
    const inv = inkByHalf(decodeRgba(inverted.png), inverted.width);
    expect(b.right).toBeGreaterThan(b.left);
    expect(inv.left).toBeGreaterThan(inv.right);

    // Each dial must actually reach the engine (bytes change vs base).
    const dials: Parameters<typeof renderHalftone>[0][] = [
      { input: sourcePng, gamma: 1.8 },
      { input: sourcePng, black: 40, white: 200 },
      { input: sourcePng, contrast: 1.8 },
      { input: sourcePng, shape: 'block' },
      { input: sourcePng, palette: 'dusk' },
      { input: sourcePng, tonal: false },
    ];
    for (const opts of dials) {
      const res = await renderHalftone(opts);
      expect(Buffer.from(res.png).equals(Buffer.from(base.png))).toBe(false);
    }

    // Custom ink: the decoded art must actually contain red-dominant pixels.
    const red = await renderHalftone({ input: sourcePng, ink: '#ff0000' });
    const rgba = decodeRgba(red.png);
    let redPixels = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] > 0 && rgba[i] > 180 && rgba[i + 1] < 90 && rgba[i + 2] < 90) redPixels++;
    }
    expect(redPixels).toBeGreaterThan(0);
  });

  it('honours EXIF orientation like the app does (browsers auto-orient)', async () => {
    // Stored landscape 100x50, EXIF orientation 6 => presents as portrait 50x100.
    const rotated = path.join(dir, 'rotated.jpg');
    await sharp({ create: { width: 100, height: 50, channels: 3, background: '#808080' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(rotated);
    const res = await renderHalftone({ input: rotated });
    // 'auto' must follow the ORIENTED aspect: portrait, long edge 480.
    expect(res.targetH).toBe(480);
    expect(res.targetW).toBe(240);
  });

  it('parses hex colours and rejects malformed ones', () => {
    expect(parseHexColor('#8ab4f8')).toEqual([138, 180, 248]);
    expect(() => parseHexColor('8ab4f8')).toThrow();
    expect(() => parseHexColor('#12345')).toThrow();
  });

  it('computes auto frames from the source aspect', () => {
    expect(headlessFrame('auto', 1000, 500)).toEqual({ targetW: 480, targetH: 240 });
    expect(headlessFrame('auto', 500, 1000)).toEqual({ targetW: 240, targetH: 480 });
    expect(headlessFrame('portrait', 1000, 500)).toEqual({ targetW: 360, targetH: 480 });
  });

  it('matches the app frame math exactly (drift pin against targetFrame)', () => {
    // If PREVIEW_MAX or the frame rule ever changes in src/ui/image-to-grid.ts,
    // this pins the headless mirror to it.
    for (const aspect of ASPECT_IDS) {
      expect(headlessFrame(aspect, 1234, 777)).toEqual(targetFrame(aspect));
    }
    expect(headlessFrame('auto', 100, 100)).toEqual(targetFrame('square'));
  });
});

describe('halftone MCP server (stdio e2e)', () => {
  it('serves render_halftone over stdio and writes the PNG', async () => {
    const client = new Client({ name: 'halftone-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('render_halftone');

      const output = path.join(dir, 'e2e-render.png');
      const result = await client.callTool({
        name: 'render_halftone',
        arguments: { input: sourcePng, output, dotSize: 6, density: 14, background: '#0b0b0f' },
      });
      expect(result.isError ?? false).toBe(false);
      expect(existsSync(output)).toBe(true);
      const png = await readFile(output);
      expect(decodePng(png).width).toBeGreaterThan(0);

      // preview: true must return the render inline as image content.
      const previewed = await client.callTool({
        name: 'render_halftone',
        arguments: { input: sourcePng, output, preview: true },
      });
      expect(previewed.isError ?? false).toBe(false);
      const contents = previewed.content as { type: string; data?: string; mimeType?: string }[];
      const image = contents.find((c) => c.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      expect((image?.data ?? '').length).toBeGreaterThan(0);

      const bad = await client.callTool({
        name: 'render_halftone',
        arguments: { input: sourcePng, output: path.join(dir, 'nope.jpg') },
      });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
