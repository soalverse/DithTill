// =============================================================================
// Scene <-> element affine (Record). A node places its element raster at a centre
// (cx,cy) in scene cells, scaled + rotated about that centre. The resolver samples
// FORWARD (scene cell -> element cell) per output cell; the Record brush needs the
// SAME inverse map to land a glass pointer in the element's raster. Keeping the math
// here, pure and tested, guarantees brush-paint and resolver-sample agree (so a
// stroke at scene (sx,sy) covers exactly scene cell (sx,sy)). The resolver inlines
// the identical formula in its hot per-cell loop for speed (see scene-resolver.ts).
// =============================================================================

export interface AffinePlacement {
  x: number; // element centre, scene cells
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
}

/**
 * Map a SCENE-cell point (sx,sy) to the element's raster cell (continuous), via the
 * inverse of place+scale+rotate about the element centre — the exact inverse of the
 * resolver's forward sample. Element origin is the raster centre (w/2, h/2).
 */
export function sceneToElementCell(
  p: AffinePlacement,
  assetW: number,
  assetH: number,
  sx: number,
  sy: number,
  /** Picture values per canvas square (Detail; default 1). */
  per = 1,
): { x: number; y: number } {
  const rad = (-p.rotationDeg * Math.PI) / 180; // inverse rotation
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const isx = per / (p.scaleX || 1e-6);
  const isy = per / (p.scaleY || 1e-6);
  const dx = sx - p.x;
  const dy = sy - p.y;
  return {
    x: assetW / 2 + (dx * cos - dy * sin) * isx,
    y: assetH / 2 + (dx * sin + dy * cos) * isy,
  };
}
