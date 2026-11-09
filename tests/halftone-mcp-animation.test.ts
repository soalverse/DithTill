// =============================================================================
// AI-2 animation tools (personal AI tooling, scripts/mcp/animation.ts) — the
// frame-set renderer + the frames->video exporter (the app's codec, wasm). Pins the locked
// kickoff decisions (frame naming, fps/frame ceilings, extension-picks-format),
// proves the byte-stability the fixed blue-noise lattice guarantees (unchanged
// source regions render identically across frames), and round-trips both tools
// over stdio through the real MCP server. The encode e2e runs everywhere (the codec
// wasm is committed — no binary to fetch).
// =============================================================================
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import UPNG from 'upng-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  exportFramesVideo,
  FPS_DEFAULT,
  FPS_MAX,
  FPS_MIN,
  FRAME_FILE_RE,
  frameFileName,
  FRAMES_MAX,
  framesPattern,
  renderHalftoneFrames,
} from '../scripts/mcp/animation';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'mcp', 'halftone-server-launcher.mjs');

let dir: string;
/** Three 320x240 sources: identical left half (a vertical gradient), a bright
 *  square at a different spot in the RIGHT half per frame — the moving part. */
const sources: string[] = [];

async function writeMovingSquareSource(file: string, squareX: number): Promise<void> {
  const w = 320;
  const h = 240;
  const raw = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = Math.round((y / (h - 1)) * 255);
      raw[o] = raw[o + 1] = raw[o + 2] = v;
      raw[o + 3] = 255;
    }
  }
  // A 40px white square in the right half, x position per frame.
  for (let y = 100; y < 140; y++) {
    for (let x = squareX; x < squareX + 40; x++) {
      const o = (y * w + x) * 4;
      raw[o] = raw[o + 1] = raw[o + 2] = 255;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(file);
}

const decodeRgba = (png: Uint8Array): { rgba: Uint8Array; width: number; height: number } => {
  const img = UPNG.decode(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
  );
  return { rgba: new Uint8Array(UPNG.toRGBA8(img)[0]), width: img.width, height: img.height };
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dithtill-mcp-anim-'));
  for (const [i, squareX] of [200, 240, 270].entries()) {
    const file = path.join(dir, `src-${i + 1}.png`);
    await writeMovingSquareSource(file, squareX);
    sources.push(file);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderHalftoneFrames', () => {
  it('writes the loop exporter naming (frame_000001.png…) with one grid across frames', async () => {
    const out = path.join(dir, 'frames-basic');
    const res = await renderHalftoneFrames({ inputs: sources, outputDir: out, cellSize: 8 });
    expect(res.frames).toBe(3);
    expect(res.pattern).toBe(framesPattern(out));
    const files = readdirSync(out).filter((f) => FRAME_FILE_RE.test(f));
    expect(files.sort()).toEqual(['frame_000001.png', 'frame_000002.png', 'frame_000003.png']);
    for (const f of files) {
      const dec = decodeRgba(await readFile(path.join(out, f)));
      expect({ w: dec.width, h: dec.height }).toEqual({ w: res.width, h: res.height });
    }
  });

  it('is deterministic and byte-stable: identical sources render identical PNGs', async () => {
    const out = path.join(dir, 'frames-stable');
    await renderHalftoneFrames({
      inputs: [sources[0], sources[0]],
      outputDir: out,
      cellSize: 8,
    });
    const a = await readFile(path.join(out, frameFileName(1)));
    const b = await readFile(path.join(out, frameFileName(2)));
    expect(a.equals(b)).toBe(true);
  });

  it('unchanged source regions are byte-stable across frames (the fixed lattice)', async () => {
    const out = path.join(dir, 'frames-region');
    const res = await renderHalftoneFrames({
      inputs: sources,
      outputDir: out,
      cellSize: 8,
      background: '#0a0a0c',
    });
    const f1 = decodeRgba(await readFile(path.join(out, frameFileName(1))));
    const f3 = decodeRgba(await readFile(path.join(out, frameFileName(3))));
    // The sources differ only in the right half — every output pixel in the
    // LEFT 40% must be byte-identical (dots can straddle cells near an edit,
    // so stay clear of the centre), and the right half must actually differ.
    const cut = Math.floor(res.width * 0.4);
    let leftDiff = 0;
    let rightDiff = 0;
    for (let y = 0; y < res.height; y++) {
      for (let x = 0; x < res.width; x++) {
        const o = (y * res.width + x) * 4;
        const same =
          f1.rgba[o] === f3.rgba[o] &&
          f1.rgba[o + 1] === f3.rgba[o + 1] &&
          f1.rgba[o + 2] === f3.rgba[o + 2] &&
          f1.rgba[o + 3] === f3.rgba[o + 3];
        if (same) continue;
        if (x < cut) leftDiff++;
        else rightDiff++;
      }
    }
    expect(leftDiff).toBe(0);
    expect(rightDiff).toBeGreaterThan(0);
  });

  it('refuses over-ceiling jobs before touching the disk', async () => {
    const out = path.join(dir, 'frames-capped');
    const tooMany = Array.from({ length: FRAMES_MAX + 1 }, () => sources[0]);
    await expect(renderHalftoneFrames({ inputs: tooMany, outputDir: out })).rejects.toThrow(
      /900-frame ceiling/,
    );
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a mixed-aspect batch under 'auto' before rendering anything", async () => {
    const portrait = path.join(dir, 'portrait-src.png');
    await sharp({ create: { width: 240, height: 320, channels: 4, background: '#888888' } })
      .png()
      .toFile(portrait);
    const out = path.join(dir, 'frames-mixed');
    await expect(
      renderHalftoneFrames({ inputs: [sources[0], portrait], outputDir: out }),
    ).rejects.toThrow(/must share one aspect/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses when outputDir holds stale frames past the new set', async () => {
    const out = path.join(dir, 'frames-stale');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, frameFileName(5)), Uint8Array.of(0));
    await expect(renderHalftoneFrames({ inputs: sources, outputDir: out })).rejects.toThrow(
      /clean the directory/,
    );
  });
});

describe('exportFramesVideo (validation — no binary needed)', () => {
  it('pins the locked ceilings', () => {
    expect({ FRAMES_MAX, FPS_MIN, FPS_MAX, FPS_DEFAULT }).toEqual({
      FRAMES_MAX: 900,
      FPS_MIN: 1,
      FPS_MAX: 60,
      FPS_DEFAULT: 12,
    });
  });

  it('rejects an out-of-range fps and an unknown extension', async () => {
    const frames = path.join(dir, 'frames-basic');
    await expect(
      exportFramesVideo({ framesDir: frames, output: path.join(dir, 'x.mp4'), fps: 0 }),
    ).rejects.toThrow(/fps must be 1–60/);
    await expect(
      exportFramesVideo({ framesDir: frames, output: path.join(dir, 'x.mp4'), fps: 61 }),
    ).rejects.toThrow(/fps must be 1–60/);
    await expect(
      exportFramesVideo({ framesDir: frames, output: path.join(dir, 'x.mov') }),
    ).rejects.toThrow(/must end in \.mp4 or \.gif/);
    await expect(
      exportFramesVideo({ framesDir: frames, output: path.join(dir, 'x.webm') }),
    ).rejects.toThrow(/must end in \.mp4 or \.gif/);
  });

  it('rejects an empty / missing / non-contiguous frames directory', async () => {
    const empty = path.join(dir, 'frames-empty');
    await mkdir(empty, { recursive: true });
    await expect(
      exportFramesVideo({ framesDir: empty, output: path.join(dir, 'x.gif') }),
    ).rejects.toThrow(/no frame_000001\.png-style frames/);
    await expect(
      exportFramesVideo({ framesDir: path.join(dir, 'nope'), output: path.join(dir, 'x.gif') }),
    ).rejects.toThrow(/framesDir not found/);

    const gappy = path.join(dir, 'frames-gappy');
    await mkdir(gappy, { recursive: true });
    await writeFile(path.join(gappy, frameFileName(1)), Uint8Array.of(0));
    await writeFile(path.join(gappy, frameFileName(3)), Uint8Array.of(0));
    await expect(
      exportFramesVideo({ framesDir: gappy, output: path.join(dir, 'x.gif') }),
    ).rejects.toThrow(/missing frame_000002\.png/);
  });
});

describe('exportFramesVideo (the codec e2e)', () => {
  it('encodes MP4 + GIF from a rendered frame set', async () => {
    const frames = path.join(dir, 'frames-encode');
    await renderHalftoneFrames({
      inputs: sources,
      outputDir: frames,
      cellSize: 10,
      background: '#0a0a0c',
    });

    const mp4 = path.join(dir, 'loop.mp4');
    const mp4Res = await exportFramesVideo({ framesDir: frames, output: mp4, fps: 6 });
    expect(mp4Res).toMatchObject({ container: 'mp4', frames: 3, fps: 6 });
    expect(mp4Res.seconds).toBeCloseTo(0.5);
    // MP4 brand box lands in the first bytes: '....ftyp'.
    expect((await readFile(mp4)).subarray(4, 8).toString('ascii')).toBe('ftyp');

    const gif = path.join(dir, 'loop.gif');
    const gifRes = await exportFramesVideo({ framesDir: frames, output: gif });
    expect(gifRes).toMatchObject({ container: 'gif', frames: 3, fps: FPS_DEFAULT });
    expect((await readFile(gif)).subarray(0, 6).toString('ascii')).toBe('GIF89a');
    // Nothing extra lands in the caller's framesDir.
    expect(readdirSync(frames).sort()).toEqual([
      'frame_000001.png',
      'frame_000002.png',
      'frame_000003.png',
    ]);
  }, 60_000);
});

describe('animation tools over stdio (MCP server e2e)', () => {
  it('serves render_halftone_frames + export_frames_video end to end', async () => {
    const client = new Client({ name: 'halftone-anim-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [LAUNCHER] });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('render_halftone_frames');
      expect(tools).toContain('export_frames_video');

      const framesDir = path.join(dir, 'frames-stdio');
      const rendered = await client.callTool({
        name: 'render_halftone_frames',
        arguments: { inputs: sources, outputDir: framesDir, cellSize: 10 },
      });
      expect(rendered.isError ?? false).toBe(false);
      expect(existsSync(path.join(framesDir, frameFileName(3)))).toBe(true);

      // Tool-level refusal surfaces as isError text, not a protocol crash.
      const bad = await client.callTool({
        name: 'export_frames_video',
        arguments: { framesDir, output: path.join(dir, 'nope.mov') },
      });
      expect(bad.isError).toBe(true);

      const out = path.join(dir, 'stdio-loop.gif');
      const encoded = await client.callTool({
        name: 'export_frames_video',
        arguments: { framesDir, output: out, fps: 6 },
      });
      expect(encoded.isError ?? false).toBe(false);
      expect(existsSync(out)).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
