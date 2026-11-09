// The Look's style math — the Density → spacing mapping and the
// anti-aliased dot edges the print screens draw with.
import { describe, it, expect } from 'vitest';
import {
  halftoneSpacing,
  HALFTONE_DENSITY_MIN,
  HALFTONE_DENSITY_MAX,
  ROUND_AA_LEVELS,
  roundCoverageLevel,
  squareCoverageLevel,
  isHalftoneStyle,
} from '../src/core/cell-style';

describe('roundCoverageLevel — the AA rim that makes a TRUE circle (not an octagon)', () => {
  it('full inside → max level, well outside → 0, and a graded 1px rim between', () => {
    const r = 10;
    expect(roundCoverageLevel(0, r)).toBe(ROUND_AA_LEVELS); // centre = solid
    expect(roundCoverageLevel(r - 2, r)).toBe(ROUND_AA_LEVELS); // comfortably inside
    expect(roundCoverageLevel(r + 2, r)).toBe(0); // comfortably outside
    // The rim itself is a GRADIENT — intermediate levels exist (this is the anti-alias).
    const rim = roundCoverageLevel(r, r); // dist == r → half-covered
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(ROUND_AA_LEVELS);
    // monotonic across the rim
    expect(roundCoverageLevel(r - 0.4, r)).toBeGreaterThanOrEqual(roundCoverageLevel(r + 0.4, r));
  });
});

describe('squareCoverageLevel — the SQUARE Halftone shape, AA sides', () => {
  it('full inside → max, outside either axis → 0, corners fade on both axes', () => {
    const r = 10;
    expect(squareCoverageLevel(0, 0, r)).toBe(ROUND_AA_LEVELS); // centre solid
    expect(squareCoverageLevel(r - 2, r - 2, r)).toBe(ROUND_AA_LEVELS); // inside the block
    expect(squareCoverageLevel(r + 2, 0, r)).toBe(0); // past the right side
    expect(squareCoverageLevel(0, r + 2, r)).toBe(0); // past the bottom
    // A pixel straddling one side is partially covered (AA on the straight edge).
    const edge = squareCoverageLevel(r, 0, r);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(ROUND_AA_LEVELS);
    // At the same offset a SQUARE covers at least as much as a CIRCLE (corners included).
    expect(squareCoverageLevel(r * 0.7, r * 0.7, r)).toBeGreaterThan(
      roundCoverageLevel(Math.hypot(r * 0.7, r * 0.7), r),
    );
  });
});

describe('isHalftoneStyle', () => {
  it('true for both Halftone shapes (round / block), false for the dither styles', () => {
    expect(isHalftoneStyle('round')).toBe(true);
    expect(isHalftoneStyle('block')).toBe(true);
    expect(isHalftoneStyle('square')).toBe(false);
    expect(isHalftoneStyle('dot')).toBe(false);
    expect(isHalftoneStyle('halftone')).toBe(false);
  });
});

describe('halftoneSpacing — Density knob: sparse (wide spacing) → cluster (tight)', () => {
  it('min density = the widest spacing, max density = the tightest, monotonically', () => {
    const sparse = halftoneSpacing(HALFTONE_DENSITY_MIN);
    const dense = halftoneSpacing(HALFTONE_DENSITY_MAX);
    expect(sparse).toBeGreaterThan(dense); // fewer, farther-apart dots when sparse
    expect(dense).toBeGreaterThanOrEqual(1);
    // monotonic: more density → smaller (or equal) spacing
    for (let d = HALFTONE_DENSITY_MIN; d < HALFTONE_DENSITY_MAX; d++) {
      expect(halftoneSpacing(d)).toBeGreaterThanOrEqual(halftoneSpacing(d + 1));
    }
    // clamps out of range
    expect(halftoneSpacing(-5)).toBe(sparse);
    expect(halftoneSpacing(999)).toBe(dense);
  });
});
