// =============================================================================
// Dep-free radix-2 FFT (P6/P7) — the analysis half of the visualizer.
// PURE math, zero deps, no Web Audio: the deterministic export path must never
// depend on an AnalyserNode (whose smoothing/rounding is engine-defined), so the
// offline pre-analysis (audio-features.preAnalyze) runs THIS fixed, in-repo
// transform over PCM decoded at a pinned rate — same bytes in, same features out,
// on every machine. Iterative in-place Cooley–Tukey; Float64 throughout so the
// magnitudes are as reproducible as IEEE-754 allows.
// =============================================================================

/** Is n a power of two (and at least 2)? */
export function isPow2(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** In-place iterative radix-2 complex FFT over (re, im). Length must be a power
 *  of two. No scaling is applied (the forward transform's raw sums). */
export function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || !isPow2(n)) throw new Error(`fft: length ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Butterflies, doubling the sub-transform length each stage.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** Magnitude spectrum of a real signal: |X[k]| for k = 0..N/2 (inclusive Nyquist),
 *  so the result has N/2 + 1 bins. `samples` is copied, never mutated. */
export function magnitudeSpectrum(samples: ArrayLike<number>): Float64Array {
  const n = samples.length;
  if (!isPow2(n)) throw new Error(`fft: window ${n} is not a power of two`);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i];
  fftComplex(re, im);
  const half = n >> 1;
  const out = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}

/** The Hann window value at index i of an n-sample window (periodic form — the
 *  right shape for overlapping STFT analysis frames). */
export function hann(i: number, n: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
}
