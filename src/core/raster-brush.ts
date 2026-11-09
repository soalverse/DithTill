// =============================================================================
// Shared 1-bit-tone brush geometry — the SINGLE dab/line stamp, used by BOTH the
// Draw canvas (draw-store) and the Record paint layer (draw-in-Record / E4). It
// operates on any { w, h, tones, covered } raster: a Draw doc OR a Record paint
// node's CachedAsset. The brush only ever writes PRE-dither TONES (0..255) + the
// covered flag; the dither happens LATER at the doc cell (Draw) or the SCENE-global
// cell (Record, via resolveSceneGrid + quantizeCell). So the one dither truth and
// preview == export are untouched — a stroke is just a new tone source.
// =============================================================================

/** Any paintable raster: a Draw doc or a Record paint node's CachedAsset. */
export interface BrushTarget {
  w: number;
  h: number;
  tones: Uint8Array;
  covered: Uint8Array;
}

export type BrushTool = 'brush' | 'eraser';

export interface BrushOpts {
  tool: BrushTool;
  /** Radius in TARGET cells. */
  size: number;
  /** Tone (0..1) painted into covered cells; ignored by the eraser. */
  shade: number;
}

/** Stamp one circular dab of `opts.size` cells radius at (cx, cy) into `t`. */
export function stampDab(t: BrushTarget, cx: number, cy: number, opts: BrushOpts): void {
  const g = Math.round(opts.shade * 255);
  const radius = opts.size;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(t.w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(t.h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * t.w + x;
      if (opts.tool === 'eraser') {
        t.covered[i] = 0;
      } else {
        t.covered[i] = 1;
        t.tones[i] = g;
      }
    }
  }
}

/** Stamp a gap-free line of dabs from (x0,y0) to (x1,y1) into `t`. A click is
 *  x0==x1 && y0==y1. Step spacing follows the brush size (half-radius) so a fast
 *  drag never leaves gaps — identical to the original Draw stroke walk. */
export function stampLine(
  t: BrushTarget,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: BrushOpts,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.5, opts.size / 2)));
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    stampDab(t, x0 + dx * u, y0 + dy * u, opts);
  }
}
