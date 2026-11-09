// THE GOLDEN PARITY GATE — suite-enforced with the
// REAL export decoder: the codec wasm (the same Rust the desktop runs natively).
// tests/fixtures/parity.mp4 (grayscale, raster-sized — see
// src-tauri/codec/examples/make_parity_fixture.rs) is decoded through the SAME pure rules
// the export uses (frame times → selectFrameForTicks → bounded tiles → gridToBase neutral →
// resolveSceneGrid) and every frame's dithered grid must equal
// tests/fixtures/parity-golden.json cell-for-cell. The dev-only browser harness
// (src/ui/dev-parity.ts) checks the LIVE seek-grab path against the SAME golden, so
// live == export holds transitively through one recorded truth.
//
// Any drift — a codec change, a colour-conversion change, a selection or tiling bug — is
// a RED BUILD, not a wrong export.
//
// Regenerate the golden (only after an intentional dither/conversion change):
//   UPDATE_GOLDEN=1 npx vitest run tests/loop-export-parity.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createWasmCodec } from '../src/platform/codec-wasm';
import { planFrameTiles } from '../src/core/video-decode';
import { selectFrameForTicks } from '../src/core/video-frames';
import { resolveSceneGrid, type CachedAsset, type SceneGrid } from '../src/core/scene-resolver';
import { quantizeContrast } from '../src/core/dither-constants';
import { gridToBase } from '../src/state/stage-store';
import { SCENE_LOOK_DEFAULT, sceneDims, type SceneNode } from '../src/state/scene-store';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'parity.mp4');
const GOLDEN = path.join(ROOT, 'tests', 'fixtures', 'parity-golden.json');

// The fixture's ground truth (see scripts/make-parity-fixture.mjs).
const FPS = 30;
const FRAMES = 24;
const IN_S = 0;
const OUT_S = FRAMES / FPS;

const codec = createWasmCodec(
  fs.readFileSync(path.join(ROOT, 'src', 'platform', 'dithtill-codec.wasm')),
);

/** The export decoder, verbatim in miniature: frame times, plan tiles of `tileFrames`,
 *  decode each bounded tile, convert with the ONE conversion truth (gridToBase at
 *  neutral treatment). Returns a raster per source frame. */
async function decodeAll(tileFrames: number): Promise<{ pts: number[]; rasters: CachedAsset[] }> {
  const video = await (await codec).openVideo(fs.readFileSync(FIXTURE));
  try {
    const pts = await video.frameTimes(IN_S, OUT_S);
    const info = await video.info();
    const rasters: CachedAsset[] = [];
    for (const tile of planFrameTiles(pts, tileFrames, IN_S, OUT_S)) {
      const n = tile.end - tile.start;
      // The fixture IS raster-sized (192x108) → a scale-free decode, exact gate.
      const rgba = await video.decode(IN_S, OUT_S, tile.start, n, info.width, info.height);
      const size = info.width * info.height * 4;
      expect(rgba.length, `tile ${tile.start}..${tile.end} frame count`).toBe(n * size);
      for (let k = 0; k < n; k++) {
        const { tones, covered } = gridToBase(
          rgba.subarray(k * size, (k + 1) * size),
          info.width,
          info.height,
          quantizeContrast(1),
          false,
        );
        rasters.push({ w: info.width, h: info.height, tones, covered });
      }
    }
    return { pts, rasters };
  } finally {
    await video.close();
  }
}

/** The golden scene: ONE full-glass video node on the landscape lattice — the
 *  same shape src/ui/dev-parity.ts resolves in the browser. */
function parityGrid(raster: CachedAsset): SceneGrid {
  const dims = sceneDims('landscape');
  const node: SceneNode = {
    id: 'v',
    assetId: 'video',
    kind: 'asset',
    z: 1,
    placement: { x: dims.w / 2, y: dims.h / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: null,
    opacity: 100,
  };
  return resolveSceneGrid({
    nodes: [node],
    scene: SCENE_LOOK_DEFAULT,
    dims,
    assets: new Map([['video', raster]]),
  });
}

const gridSha = (g: SceneGrid): string =>
  createHash('sha256').update(g.covered).update(g.pal).update(g.idx).digest('hex');

describe('golden parity gate (the codec decoder)', () => {
  it('bounded-segment decode reproduces the committed golden grids cell-for-cell', async () => {
    const { pts, rasters } = await decodeAll(7);
    expect(pts.length).toBe(FRAMES);
    // Perfect 30fps fixture → the pure selection is the identity mapping.
    const sel = selectFrameForTicks(pts, FRAMES, FPS, IN_S);
    expect([...sel]).toEqual(Array.from({ length: FRAMES }, (_, i) => i));

    const dims = sceneDims('landscape');
    const hashes = Array.from({ length: FRAMES }, (_, k) => gridSha(parityGrid(rasters[sel[k]])));
    const golden = {
      fixture: 'parity.mp4',
      fps: FPS,
      frames: FRAMES,
      rasterW: rasters[0].w,
      rasterH: rasters[0].h,
      sceneW: dims.w,
      sceneH: dims.h,
      grids: hashes,
    };
    if (process.env.UPDATE_GOLDEN) {
      fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
      console.log(`golden updated: ${GOLDEN}`);
      return;
    }
    expect(fs.existsSync(GOLDEN), 'golden missing — run with UPDATE_GOLDEN=1').toBe(true);
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as typeof golden;
    expect(golden.rasterW).toBe(want.rasterW);
    expect(golden.rasterH).toBe(want.rasterH);
    for (let k = 0; k < FRAMES; k++) expect(hashes[k], `frame ${k}`).toBe(want.grids[k]);
  }, 30_000);

  it('tile size never changes the decode (segment-boundary invariance)', async () => {
    const small = (await decodeAll(5)).rasters;
    const whole = (await decodeAll(FRAMES)).rasters;
    expect(small.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) {
      expect(
        Buffer.from(small[i].tones).equals(Buffer.from(whole[i].tones)),
        `frame ${i} tones`,
      ).toBe(true);
      expect(
        Buffer.from(small[i].covered).equals(Buffer.from(whole[i].covered)),
        `frame ${i} covered`,
      ).toBe(true);
    }
  }, 30_000); // two full decodes — headroom under the parallel suite
});
