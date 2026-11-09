// =============================================================================
// DEV-ONLY: the BROWSER half of the golden parity gate.
//
// tests/loop-export-parity.test.ts pins the codec (export) decode of
// tests/fixtures/parity.mp4 to parity-golden.json. This harness checks the
// LIVE previewer path — HTMLVideoElement exact-seek → canvas grab → gridToBase
// (the exact src/ui/video-assets.ts pipeline) — against the SAME golden, so
// live == export holds transitively through one recorded truth. Loaded only in
// dev (main.tsx guards on import.meta.env.DEV); run from the console/preview:
//
//   await window.__dithtillParity()
//
// Returns { pass, frames, mismatches } and logs a summary. A mismatch here
// (with the suite green) means the BROWSER's video colour conversion drifted
// from the codec's — the live preview approximation, never the export.
// =============================================================================
import golden from '../../tests/fixtures/parity-golden.json';
import fixtureUrl from '../../tests/fixtures/parity.mp4?url';
import { tickTimeSeconds } from '../core/video-frames';
import { resolveSceneGrid, type CachedAsset, type SceneGrid } from '../core/scene-resolver';
import { quantizeContrast } from '../core/dither-constants';
import { gridToBase } from '../state/stage-store';
import { sha256Hex } from '../core/library';
import { SCENE_LOOK_DEFAULT, type SceneNode } from '../state/scene-store';

/** The golden scene shape — mirrors parityGrid in loop-export-parity.test.ts. */
function parityGrid(raster: CachedAsset): SceneGrid {
  const dims = { w: golden.sceneW, h: golden.sceneH };
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

async function gridSha(g: SceneGrid): Promise<string> {
  const bytes = new Uint8Array(g.covered.length * 3);
  bytes.set(g.covered, 0);
  bytes.set(g.pal, g.covered.length);
  bytes.set(g.idx, g.covered.length * 2);
  return sha256Hex(bytes);
}

export interface ParityResult {
  pass: boolean;
  frames: number;
  mismatches: { frame: number; got: string; want: string }[];
}

/** Seek-grab every golden tick from the fixture and compare grids to the golden. */
export async function runLiveParityCheck(): Promise<ParityResult> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const ready = new Promise<void>((res) =>
    video.addEventListener('loadeddata', () => res(), { once: true }),
  );
  video.src = fixtureUrl;
  await ready;
  if (video.videoWidth !== golden.rasterW || video.videoHeight !== golden.rasterH)
    throw new Error(
      `fixture is ${video.videoWidth}x${video.videoHeight}, golden expects ${golden.rasterW}x${golden.rasterH}`,
    );

  const canvas = document.createElement('canvas');
  canvas.width = golden.rasterW;
  canvas.height = golden.rasterH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d unavailable');

  const mismatches: ParityResult['mismatches'] = [];
  for (let k = 0; k < golden.frames; k++) {
    // The exact live pipeline: frame-exact seek → drawImage → gridToBase neutral.
    const seeked = new Promise<void>((res) =>
      video.addEventListener('seeked', () => res(), { once: true }),
    );
    video.currentTime = tickTimeSeconds(k, golden.fps, 0);
    await seeked;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const { tones, covered } = gridToBase(
      rgba,
      canvas.width,
      canvas.height,
      quantizeContrast(1),
      false,
    );
    const got = await gridSha(parityGrid({ w: canvas.width, h: canvas.height, tones, covered }));
    if (got !== golden.grids[k]) mismatches.push({ frame: k, got, want: golden.grids[k] });
  }
  video.removeAttribute('src');

  const result: ParityResult = { pass: mismatches.length === 0, frames: golden.frames, mismatches };
  console.log(
    `[dithtill parity] live seek-grab vs golden: ${result.pass ? 'PASS' : 'FAIL'} ` +
      `(${golden.frames - mismatches.length}/${golden.frames} frames identical)`,
    mismatches,
  );
  return result;
}

declare global {
  interface Window {
    __dithtillParity?: () => Promise<ParityResult>;
  }
}
window.__dithtillParity = runLiveParityCheck;
