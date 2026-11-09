// =============================================================================
// preview == export — the #1 invariant (SCOPE.md §7).
//
// The GPU preview and the CPU export must produce identical palette indices for
// every cell. Both obey the integer formula in src/core/dither-constants.ts.
// This suite proves it WITHOUT a GPU by re-deriving the shader's exact integer
// arithmetic in TS — including GLSL int '/' (truncate-toward-zero) plus the
// floor-division correction — and asserting it equals the CPU reference on
// every cell across the full parameter matrix (zero diffs).
//
// The remaining gap (a real driver executing dither.frag.glsl) is a documented
// CI follow-up via headless-gl or Playwright; because every decisive op is
// integer in `highp int`, on-GPU divergence is structurally impossible once
// this algorithmic parity holds.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  MATRICES,
  MATRIX_IDS,
  quantizeCell,
  quantizeContrast,
  computeGrid,
  paletteLength,
  type MatrixId,
  type PaletteId,
} from '../src/core/dither-constants';
import { ditherIndices } from '../src/core/dither-cpu';

// ---- Faithful TS port of dither.frag.glsl's integer ops ---------------------
function truncDiv(num: number, den: number): number {
  return Math.trunc(num / den); // GLSL int '/' truncates toward zero
}
function glslFloorDivPos(num: number, den: number): number {
  let q = truncDiv(num, den);
  const r = num - q * den;
  if (r !== 0 && num < 0) q -= 1; // correct to true floor for negatives
  return q;
}
interface Cell {
  R: number;
  G: number;
  B: number;
  x: number;
  y: number;
  N: number;
  CT: number;
  matrix: MatrixId;
  invert?: boolean;
}
function bayerAt(m: Exclude<MatrixId, 'none'>, x: number, y: number): number {
  const { side: n, table } = MATRICES[m];
  return table[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
}
function glslQuantize(a: Cell): number {
  const S = 65280;
  const H = 32640;
  const lumI = 77 * a.R + 150 * a.G + 29 * a.B;
  let lumC = glslFloorDivPos((lumI - H) * a.CT, 4096) + H;
  if (a.invert) lumC = S - lumC;
  let num: number;
  let den: number;
  if (a.matrix === 'none') {
    num = lumC * (a.N - 1) + H;
    den = S;
  } else {
    const n = MATRICES[a.matrix].side;
    const D = n * n; // the uMatrixDen uniform
    num = lumC * (a.N - 1) * D + bayerAt(a.matrix, a.x, a.y) * S;
    den = S * D;
  }
  let idx = glslFloorDivPos(num, den);
  if (idx < 0) idx = 0;
  else if (idx > a.N - 1) idx = a.N - 1;
  return idx;
}

// ---- Old float64 prototype expression — kept ONLY to lock the intentional
//      divergence at exact-half ties (src/lab + scripts/render-dither-video.cjs).
function prototypeQuantize(a: {
  R: number;
  G: number;
  B: number;
  x: number;
  y: number;
  N: number;
  contrast: number;
  matrix: MatrixId;
}): number {
  let lum = (0.299 * a.R + 0.587 * a.G + 0.114 * a.B) / 255;
  lum = (lum - 0.5) * a.contrast + 0.5;
  let pos = lum * (a.N - 1);
  if (a.matrix !== 'none') {
    const n = MATRICES[a.matrix].side;
    pos += bayerAt(a.matrix, a.x, a.y) / (n * n) - 0.5;
  }
  let idx = Math.round(pos);
  if (idx < 0) idx = 0;
  else if (idx > a.N - 1) idx = a.N - 1;
  return idx;
}

const PALETTE_N: Record<PaletteId, number> = {
  dusk: 6,
  clay: 6,
  cream: 6,
  two: 2,
  sepia: 6,
  grey: 6,
  paper: 6,
};

describe('quantizeCell — golden worked examples (integer canonical)', () => {
  it('R=G=B=51, N=6, ct=1, matrix=2, (0,0) -> 1', () => {
    expect(
      quantizeCell({ R: 51, G: 51, B: 51, x: 0, y: 0, N: 6, CT: quantizeContrast(1), matrix: 2 }),
    ).toBe(1);
  });
  it('R=G=B=102, N=6, ct=2, matrix=none -> 2', () => {
    expect(
      quantizeCell({
        R: 102,
        G: 102,
        B: 102,
        x: 0,
        y: 0,
        N: 6,
        CT: quantizeContrast(2),
        matrix: 'none',
      }),
    ).toBe(2);
  });
});

describe('GPU(int) == CPU parity — zero cell diffs across the stress matrix', () => {
  const cells: Array<{ R: number; G: number; B: number; x: number; y: number }> = [];
  // full luminance ramp 0..255 over a 16x16 tile -> hits every quant boundary
  // for every registered screen (16 covers the largest table side).
  for (let v = 0; v <= 255; v++)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) cells.push({ R: v, G: v, B: v, x, y });
  // a chromatic block too
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) cells.push({ R: 200, G: 30, B: 120, x, y });

  // 30s: ~2s in isolation, but the full parallel suite's CPU contention has
  // tripped the 5s default (the same flake class e669de1 fixed for the ffmpeg
  // golden-parity tests).
  it('glslQuantize matches quantizeCell on every (cell, params) combo', { timeout: 30_000 }, () => {
    const matrices: MatrixId[] = MATRIX_IDS; // every registered screen + 'none'
    const palettes: PaletteId[] = ['dusk', 'clay', 'cream', 'two', 'sepia', 'grey', 'paper'];
    const contrasts = [0.5, 1.0, 2.0, 3.5];
    const inverts = [false, true];
    let diffs = 0;
    let firstDiff: string | null = null;
    for (const matrix of matrices)
      for (const p of palettes) {
        const N = PALETTE_N[p];
        for (const c of contrasts) {
          const CT = quantizeContrast(c);
          for (const invert of inverts)
            for (const cell of cells) {
              const a: Cell = { ...cell, N, CT, matrix, invert };
              const cpu = quantizeCell(a);
              const gpu = glslQuantize(a);
              if (cpu !== gpu) {
                diffs++;
                firstDiff ??= `matrix=${matrix} pal=${p} ct=${c} inv=${invert} cell=${JSON.stringify(cell)} cpu=${cpu} gpu=${gpu}`;
              }
            }
        }
      }
    expect(firstDiff).toBeNull();
    expect(diffs).toBe(0);
  });
});

describe('the matrix registry (Group G screens are structurally sound)', () => {
  it('every table is a permutation of 0..n*n-1 with side <= 16 (R8UI cap)', () => {
    for (const [id, m] of Object.entries(MATRICES)) {
      expect(m.side, `${id} side`).toBeLessThanOrEqual(16);
      expect(m.table.length, `${id} length`).toBe(m.side * m.side);
      const seen = new Set([...m.table]);
      expect(seen.size, `${id} distinct values`).toBe(m.side * m.side);
      for (const v of m.table) {
        expect(v, `${id} value range`).toBeGreaterThanOrEqual(0);
        expect(v, `${id} value range`).toBeLessThan(m.side * m.side);
      }
    }
  });

  it('the blue-noise build is deterministic across runs (locked like a literal)', () => {
    // The table is built at module load from a fixed seed; a second import in
    // the same process returns the same object, so lock a content fingerprint
    // instead: any change to the generator re-triggers this snapshot.
    const fnv = [...MATRICES.blue.table].reduce(
      (h, v) => (Math.imul(h ^ v, 0x01000193) >>> 0) >>> 0,
      0x811c9dc5,
    );
    expect({ side: MATRICES.blue.side, fnv }).toMatchSnapshot();
  });
});

describe('intentional divergence from the float64 prototype is locked', () => {
  it('integer canonical rounds the other way at exact-half ties', () => {
    expect(
      quantizeCell({ R: 51, G: 51, B: 51, x: 0, y: 0, N: 6, CT: quantizeContrast(1), matrix: 2 }),
    ).toBe(1);
    expect(
      prototypeQuantize({ R: 51, G: 51, B: 51, x: 0, y: 0, N: 6, contrast: 1, matrix: 2 }),
    ).toBe(0);
    expect(
      quantizeCell({
        R: 102,
        G: 102,
        B: 102,
        x: 0,
        y: 0,
        N: 6,
        CT: quantizeContrast(2),
        matrix: 'none',
      }),
    ).toBe(2);
    expect(
      prototypeQuantize({ R: 102, G: 102, B: 102, x: 0, y: 0, N: 6, contrast: 2, matrix: 'none' }),
    ).toBe(1);
  });
});

describe('real reference image — tests/fixtures/Final.png', () => {
  it('CPU export == GPU(int) preview on the actual burn target (zero diffs) + stable snapshot', async () => {
    const imgPath = fileURLToPath(new URL('./fixtures/Final.png', import.meta.url));
    const cellSize = 5;
    const outW = 512;
    const outH = 512;
    const { LW, LH } = computeGrid(outW, outH, cellSize);

    // ONE shared downscale -> identical bytes to both engines (isolates the
    // dither math from the downscale step, which has its own single rule).
    const { data } = await sharp(imgPath)
      .removeAlpha()
      .resize(LW, LH, { kernel: 'nearest', fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const grid = new Uint8Array(LW * LH * 4);
    for (let p = 0; p < LW * LH; p++) {
      grid[p * 4] = data[p * 3];
      grid[p * 4 + 1] = data[p * 3 + 1];
      grid[p * 4 + 2] = data[p * 3 + 2];
      grid[p * 4 + 3] = 255;
    }

    const opts = { palette: 'dusk' as PaletteId, matrix: 8 as MatrixId, contrast: 1.0 };
    const cpu = ditherIndices(grid, LW, LH, opts);
    const N = paletteLength(opts.palette);
    const CT = quantizeContrast(opts.contrast);

    let diffs = 0;
    for (let y = 0; y < LH; y++)
      for (let x = 0; x < LW; x++) {
        const i = (y * LW + x) * 4;
        const gpu = glslQuantize({
          R: grid[i],
          G: grid[i + 1],
          B: grid[i + 2],
          x,
          y,
          N,
          CT,
          matrix: opts.matrix,
        });
        if (gpu !== cpu[y * LW + x]) diffs++;
      }
    expect(diffs).toBe(0);

    // regression lock on the actual index histogram
    const hist = new Array(N).fill(0);
    for (const v of cpu) hist[v]++;
    expect({ LW, LH, hist }).toMatchSnapshot();
  });
});
