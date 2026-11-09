// =============================================================================
// Bounded-tile decode planning (P8) — the PURE half
// of the export's video decoder. Long clips are never decoded whole: the codec
// decodes TILES of a few dozen frames, each one call (platform/loop-export). Tiles
// partition the trim window's frame list exactly — every frame in exactly one tile —
// and tile size never changes the decoded frames (tests/loop-export-parity.test.ts).
// =============================================================================

/** One decode tile: source frames [start, end) of the scanned pts list. */
export interface DecodeTile {
  /** Index of the first source frame in this tile (into the scanned pts list). */
  start: number;
  /** One past the last source frame in this tile. */
  end: number;
  /** Exact trim window [trimStart, trimEnd) in ABSOLUTE source seconds. */
  trimStart: number;
  trimEnd: number;
}

/** Plan bounded decode tiles over a scanned pts list. Tile boundaries sit at
 *  midpoints between neighbouring frame pts (strictly inside the gap), except
 *  the outer edges which reuse the scan's own [inSeconds, outSeconds) window —
 *  so the tiles PARTITION the scan exactly: every frame in exactly one tile. */
export function planFrameTiles(
  ptsSeconds: readonly number[],
  tileFrames: number,
  inSeconds: number,
  outSeconds: number,
): DecodeTile[] {
  const n = ptsSeconds.length;
  const T = Math.max(1, tileFrames | 0);
  const tiles: DecodeTile[] = [];
  for (let s = 0; s < n; s += T) {
    const e = Math.min(n, s + T);
    const trimStart = s === 0 ? inSeconds : (ptsSeconds[s - 1] + ptsSeconds[s]) / 2;
    const trimEnd = e === n ? outSeconds : (ptsSeconds[e - 1] + ptsSeconds[e]) / 2;
    tiles.push({ start: s, end: e, trimStart, trimEnd });
  }
  return tiles;
}
