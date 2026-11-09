// =============================================================================
// The loop export END TO END through the codec: platform/loop-export walks
// the pure renderer straight into the real encoder (the committed wasm build — the
// same Rust the desktop runs natively), and the file is read back through the codec's
// own decoder. Covers MP4 + sound, GIF, the D4 cycle-repeat long export, and the D3
// long walk with a placed video (exact frames decoded in tiles, two-clock advance).
// =============================================================================
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoopRenderInput } from '../src/core/loop-render';
import { renderLoopFrameRaster } from '../src/core/loop-render';
import type { CachedAsset } from '../src/core/scene-resolver';
import type { VideoAssetRecord } from '../src/core/library';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../src/state/scene-store';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const h = vi.hoisted(() => ({
  saved: [] as { name: string; bytes: Uint8Array; mime: string }[],
}));

vi.mock('../src/platform/codec', async () => {
  const { createWasmCodec } = await import('../src/platform/codec-wasm');
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const codec = createWasmCodec(
    nodeFs.readFileSync(nodePath.join(process.cwd(), 'src', 'platform', 'dithtill-codec.wasm')),
  );
  return { getCodec: () => codec };
});
vi.mock('../src/platform/save-png', () => ({
  saveBytesToDisk: async (bytes: Uint8Array, name: string, mime: string) => {
    h.saved.push({ name, bytes, mime });
    return name;
  },
}));

const { exportLoop } = await import('../src/platform/loop-export');
const { getCodec } = await import('../src/platform/codec');

/** A deterministic tone raster (diagonal ramp), fully covered. */
function ramp(w: number, hh: number): CachedAsset {
  const tones = new Uint8Array(w * hh);
  for (let i = 0; i < tones.length; i++) tones[i] = (i * 7) % 256;
  return { w, h: hh, tones, covered: new Uint8Array(w * hh).fill(1) };
}

function spinScene(frames: number): Omit<LoopRenderInput, 'videoRasterAt'> {
  const node: SceneNode = {
    id: 'a',
    assetId: 'asset-a',
    kind: 'asset',
    z: 1,
    placement: { x: 24, y: 13, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: { type: 'spin', cycles: 1, amp: 1, ax: 1, ay: 1, phase0: 0 },
    opacity: 100,
  };
  return {
    nodes: [node],
    scene: SCENE_LOOK_DEFAULT,
    events: [],
    frames,
    seed: 7,
    dims: { w: 48, h: 27 },
    assets: new Map([['asset-a', ramp(20, 14)]]),
    mutedLayers: new Set(),
    features: null,
  };
}

/** The expected RGB of a rendered frame (palette, alpha over black — the MP4 rule). */
function expectedRgb(input: LoopRenderInput, f: number): { w: number; h: number; rgb: Uint8Array } {
  const r = renderLoopFrameRaster(input, f);
  const { width: w, height: hh } = r.buf;
  const rgb = new Uint8Array(w * hh * 3);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < w; x++) {
      const i = r.buf.get(x, y);
      const a = r.trns[i] ?? 255;
      for (let c = 0; c < 3; c++)
        rgb[(y * w + x) * 3 + c] = Math.round((r.palette[i * 3 + c] * a) / 255);
    }
  return { w, h: hh, rgb };
}

const meanErr = (rgba: Uint8Array, rgb: Uint8Array, n: number): number => {
  let e = 0;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) e += Math.abs(rgba[i * 4 + c] - rgb[i * 3 + c]);
  return e / (n * 3);
};

/** Count the image descriptors in a GIF (one per frame). */
function gifFrames(b: Uint8Array): number {
  let p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
  let frames = 0;
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) break;
    if (t === 0x21) {
      p += 2;
      while (b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else if (t === 0x2c) {
      frames++;
      const packed = b[p + 9];
      p += 10 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0) + 1;
      while (b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else throw new Error(`bad GIF block 0x${t.toString(16)} at ${p}`);
  }
  return frames;
}

describe('loop export through the codec (end to end)', () => {
  it('MP4: every frame decodes back to the rendered frame, with the loop sound in sync', async () => {
    h.saved.length = 0;
    const render = spinScene(12);
    const n = 48_000;
    const tone = Float32Array.from(
      { length: n },
      (_, i) => 0.4 * Math.sin((i * 2 * Math.PI * 330) / 48_000),
    );
    const name = await exportLoop({
      render,
      fps: 12,
      videos: [],
      audio: { sources: [{ pcm: { left: tone, right: tone }, clipSamples: n }], seamFade: false },
      format: 'mp4',
    });
    expect(name).toBe('dithtill-loop.mp4');
    const { bytes, mime } = h.saved[0];
    expect(mime).toBe('video/mp4');
    const codec = await getCodec();
    const video = await codec.openVideo(bytes);
    const info = await video.info();
    expect(info.frames).toBe(12);
    const exp0 = expectedRgb(render, 0);
    expect([info.width, info.height]).toEqual([exp0.w, exp0.h]);
    const px = await video.decode(0, 99, 0, 12, info.width, info.height);
    const size = info.width * info.height;
    for (let f = 0; f < 12; f++) {
      const want = expectedRgb(render, f).rgb;
      expect(meanErr(px.subarray(f * size * 4), want, size), `frame ${f}`).toBeLessThan(6);
    }
    await video.close();
    const pcm = await codec.decodeAudio(bytes, null, null, 48_000);
    expect(pcm).not.toBeNull();
    // 12 frames @ 12 fps = 1 s of sound (AAC frames pad by < one frame).
    expect(Math.abs(pcm!.left.length - 48_000)).toBeLessThan(2048);
  }, 60_000);

  it('the page gets a turn between frames, so progress paints and Cancel lands', async () => {
    const input = {
      render: spinScene(12),
      fps: 12,
      videos: [],
      audio: null,
      format: 'gif' as const,
    };
    let turns = 0;
    const seen: number[] = [];
    const ticker = setInterval(() => turns++, 0);
    await exportLoop(input, { onProgress: () => seen.push(turns) });
    clearInterval(ticker);
    expect(seen.at(-1)!).toBeGreaterThan(seen[0]);

    const cancel = new AbortController();
    let frames = 0;
    setTimeout(() => cancel.abort(), 0);
    await expect(
      exportLoop(input, { signal: cancel.signal, onProgress: () => frames++ }),
    ).rejects.toThrow('cancelled');
    expect(frames).toBeLessThan(12);
  }, 60_000);

  it('GIF: one image per loop frame, looping, silent', async () => {
    h.saved.length = 0;
    await exportLoop({ render: spinScene(12), fps: 12, videos: [], audio: null, format: 'gif' });
    const { bytes, mime, name } = h.saved[0];
    expect([name, mime]).toEqual(['dithtill-loop.gif', 'image/gif']);
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
    expect(new TextDecoder().decode(bytes)).toContain('NETSCAPE2.0');
    expect(gifFrames(bytes)).toBe(12);
  }, 60_000);

  it('a long cycle-identical export renders one cycle and repeats it to T (D4)', async () => {
    h.saved.length = 0;
    const render = { ...spinScene(12), totalFrames: 30 };
    await exportLoop({ render, fps: 12, videos: [], audio: null, format: 'mp4' });
    const codec = await getCodec();
    const video = await codec.openVideo(h.saved[0].bytes);
    const info = await video.info();
    expect(info.frames).toBe(30);
    const px = await video.decode(0, 99, 0, 30, info.width, info.height);
    const fsz = info.width * info.height * 4;
    for (const f of [12, 15, 29]) {
      const base = f % 12;
      // Our side is exact: f renders the same raster as its cycle frame…
      const rf = renderLoopFrameRaster(render, f);
      const rb = renderLoopFrameRaster(render, base);
      let same = rf.buf.width === rb.buf.width && rf.buf.height === rb.buf.height;
      for (let y = 0; same && y < rf.buf.height; y++)
        for (let x = 0; x < rf.buf.width; x++)
          if (rf.buf.get(x, y) !== rb.buf.get(x, y)) same = false;
      expect(same).toBe(true);
      expect(Buffer.from(rf.palette).equals(Buffer.from(rb.palette))).toBe(true);
      // …and the encoder is handed it for both; H.264 is lossy, so
      // the decoded pictures match to within the codec's rounding, not byte for byte.
      let e = 0;
      for (let i = 0; i < fsz; i++)
        if (i % 4 !== 3) e += Math.abs(px[f * fsz + i] - px[base * fsz + i]);
      expect(e / ((fsz / 4) * 3), `frame ${f} == cycle frame ${base}`).toBeLessThan(0.5);
    }
    await video.close();
  }, 60_000);

  it('a placed video exports its exact frames, advancing past the loop (D3 + two clocks)', async () => {
    h.saved.length = 0;
    // The golden parity clip: a white bar moving 8px per frame across 192x108, 24 frames.
    const bytes = new Uint8Array(
      fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'parity.mp4')),
    );
    const rec = {
      w: 192,
      h: 108,
      fps: 30,
      frameCount: 24,
      inSeconds: 0,
      outSeconds: 0.8,
    } as unknown as VideoAssetRecord;
    const node: SceneNode = {
      id: 'v',
      assetId: 'video',
      kind: 'asset',
      z: 1,
      placement: { x: 96, y: 54, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: {},
      motion: null,
      opacity: 100,
    };
    const empty: CachedAsset = {
      w: 192,
      h: 108,
      tones: new Uint8Array(192 * 108),
      covered: new Uint8Array(192 * 108),
    };
    const render: Omit<LoopRenderInput, 'videoRasterAt'> = {
      nodes: [node],
      scene: SCENE_LOOK_DEFAULT,
      events: [],
      frames: 12,
      totalFrames: 24, // past the 12-frame loop: the outlasting clip keeps advancing
      seed: 1,
      dims: { w: 192, h: 108 },
      assets: new Map([['video', empty]]),
      mutedLayers: new Set(),
      features: null,
    };
    await exportLoop({
      render,
      fps: 30,
      videos: [{ assetId: 'video', rec, bytes, rasterLong: 192 }],
      audio: null,
      format: 'mp4',
    });
    const codec = await getCodec();
    const video = await codec.openVideo(h.saved[0].bytes);
    const info = await video.info();
    expect(info.frames).toBe(24);
    const px = await video.decode(0, 99, 0, 24, info.width, info.height);
    const scale = info.width / 192;
    for (let f = 0; f < 24; f++) {
      // Centroid of the bright pixels in the bar's rows (top 90 lattice rows).
      let sum = 0;
      let count = 0;
      const base = f * info.width * info.height * 4;
      for (let y = 0; y < 80 * scale; y += 4)
        for (let x = 0; x < info.width; x++)
          if (px[base + (y * info.width + x) * 4] > 160) {
            sum += x;
            count++;
          }
      // bar = lattice x ∈ [8f, 8f+16), clipped at the 192-wide frame edge
      const want = ((f * 8 + Math.min(f * 8 + 16, 192)) / 2) * scale;
      expect(count, `frame ${f} has a bar`).toBeGreaterThan(0);
      expect(Math.abs(sum / count - want), `frame ${f} bar position`).toBeLessThan(scale * 2);
    }
    await video.close();
  }, 60_000);
});
