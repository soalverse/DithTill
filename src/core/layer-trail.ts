// =============================================================================
// Trail (J5 step 2): the last effect, drawn from the layer's own recent past.
//   Echo  = fading copies of the layer where it was a moment ago (its past place and picture,
//           drawn under it, thinned like opacity so they overprint like any ink).
//   Smear = the layer's picture keeps the brightest of its recent past, fading.
// Nothing is stored in the document: the past is the frames just drawn — the live view keeps
// the frames it just showed, the export pre-rolls the frames before its first one — kept in a
// `TrailMemory` by ABSOLUTE frame. Every past frame is the pure frame render, so the export is
// a pure function of the frame (the same whatever frame the walk starts on). Integer weights.
// =============================================================================
import { applyLayerFx, FX_RANGE, type TrailKind } from './layer-fx';
import type { CachedAsset } from './scene-resolver';
import type { SceneNode } from '../state/scene-store';

/** One trailed layer at one past frame: its evaluated node and its effected picture (a copy —
 *  drawings and video frames are rewritten in place). */
export interface TrailSnap {
  node: SceneNode;
  raster: CachedAsset;
}
/** A frame's trailed layers by node id. */
export type TrailFrame = ReadonlyMap<string, TrailSnap>;
/** Past frames by absolute frame. */
export type TrailMemory = Map<number, TrailFrame>;

/** What the layer adapter reads: the frame `age` frames ago, and the tempo. */
export interface TrailSource {
  past: (age: number) => TrailFrame | undefined;
  framesPerBeat: number;
}

/** Echo copies are a quarter beat apart; at most this many copies / smear samples. */
const ECHO_SPACING_BEATS = 0.25;
const ECHO_MAX = 16;
const SMEAR_MAX = 32;

/** The past frames a trail reads (oldest last) and each one's strength (0..256). The
 *  newest copy is the strongest; Fade 100 thins the oldest to nothing. */
export function trailSamples(
  kind: TrailKind,
  lengthBeats: number,
  fade: number,
  framesPerBeat: number,
): { age: number; weight: number }[] {
  const L = Math.max(1, Math.round(lengthBeats * framesPerBeat));
  const n =
    kind === 'echo'
      ? Math.min(ECHO_MAX, Math.max(1, Math.round(lengthBeats / ECHO_SPACING_BEATS)), L)
      : Math.min(SMEAR_MAX, L);
  const f = Math.max(0, Math.min(100, fade));
  const out: { age: number; weight: number }[] = [];
  for (let k = 1; k <= n; k++) {
    const age = Math.max(1, Math.round((k * L) / n));
    if (out.length && out[out.length - 1].age === age) continue;
    out.push({ age, weight: Math.round(256 - (256 * f * k) / (100 * (n + 1))) });
  }
  return out;
}

/** Does this layer draw a trail? */
export const isTrailed = (n: SceneNode): boolean => !n.hidden && !!n.fx?.trail;

/** How many frames back the trailed layers read (0 = none). A moving Length reads as far as
 *  the longest it can be. */
export function trailReach(nodes: readonly SceneNode[], framesPerBeat: number): number {
  let reach = 0;
  for (const n of nodes) {
    const t = n.fx?.trail;
    if (!t || n.hidden) continue;
    const beats = n.mods?.['fx.trail.length'] ? FX_RANGE.trailLength.max : t.length;
    reach = Math.max(reach, Math.max(1, Math.round(beats * framesPerBeat)));
  }
  return reach;
}

function copyRaster(r: CachedAsset): CachedAsset {
  return {
    w: r.w,
    h: r.h,
    tones: r.tones.slice(),
    covered: r.covered.slice(),
    ...(r.fine ? { fine: r.fine.slice() } : {}),
    ...(r.ink ? { ink: r.ink.slice(), inks: r.inks } : {}),
    ...(r.per ? { per: r.per } : {}),
  };
}

/** This frame's trailed layers, kept for the frames after it. */
export function snapTrails(
  nodes: readonly SceneNode[],
  assets: ReadonlyMap<string, CachedAsset>,
): TrailFrame {
  const out = new Map<string, TrailSnap>();
  for (const n of nodes) {
    if (!isTrailed(n)) continue;
    const r = assets.get(n.assetId);
    if (r) out.set(n.id, { node: n, raster: copyRaster(applyLayerFx(r, n.fx)) });
  }
  return out;
}

/** Smear: each cell keeps the brightest of the picture now and its faded past pictures (a
 *  past picture of another size is skipped). Tones and coverage only. */
export function smearRaster(
  cur: CachedAsset,
  past: readonly { raster: CachedAsset; weight: number }[],
): CachedAsset {
  const { w, h } = cur;
  const tones = cur.tones.slice();
  const covered = cur.covered.slice();
  for (const p of past) {
    const r = p.raster;
    if (r.w !== w || r.h !== h) continue;
    for (let i = 0; i < w * h; i++) {
      if (!r.covered[i]) continue;
      const v = (r.tones[i] * p.weight) >> 8;
      if (!covered[i]) {
        covered[i] = 1;
        tones[i] = v;
      } else if (v > tones[i]) tones[i] = v;
    }
  }
  return { w, h, tones, covered, ...(cur.per ? { per: cur.per } : {}) };
}

/** Keep `mem` to the frames a trail can still read from `frame`. */
export function pruneTrail(mem: TrailMemory, frame: number, reach: number): void {
  for (const k of mem.keys()) if (k < frame - reach || k > frame) mem.delete(k);
}
