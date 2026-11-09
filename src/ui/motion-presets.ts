// Motion presets (shared by the layer panel + the old loop column) — the coded-motion set
// (P3 + H-A0): type list, labels, per-type default amp + direction, noise types, speed bounds.
import type { MotionDescriptor } from '../state/scene-store';
import { BEAT_LENGTHS, BEATS_PER_BAR } from '../core/tempo';

// Procedural motion (P3 + the H-A0 coded-motion set) — the cycle button in the loop
// column advances through these; motion is a loop-time performance (plays WITH the loop;
// at rest the scene is still). 'none' = no motion (null); the rest map to
// MotionDescriptor.type. Growing the option list never adds a deck row (one cycle button),
// so the 378px reserve is untouched.
export const MOTION_TYPES = [
  'none',
  'drift',
  'bob',
  'parallax',
  'blink',
  'marquee',
  'twinkle',
  'spin',
  'pendulum',
  'bounce',
  'shake',
  'pulse',
] as const;
export type MotionTypeOpt = (typeof MOTION_TYPES)[number];
export type MotionType = Exclude<MotionTypeOpt, 'none'>;

// 'parallax' shows as "Orbit" (it traces an ellipse) — friendlier than the internal
// type name; the type string stays 'parallax' (no duplicate type, no test churn).
export const MOTION_LABELS: Record<MotionType, string> = {
  drift: 'Drift',
  bob: 'Bob',
  parallax: 'Orbit',
  blink: 'Blink',
  marquee: 'Marquee',
  twinkle: 'Twinkle',
  spin: 'Spin',
  // "Swing", not "Pendulum": the only label long enough to wrap inside the ~54px
  // cycle button and grow the deck (owner hit the shift 2026-07-09). The type
  // string stays 'pendulum'.
  pendulum: 'Swing',
  bounce: 'Bounce',
  shake: 'Shake',
  pulse: 'Pulse',
};

// Amp means different things per type (cells / degrees / %), so switching type resets
// amp to a sensible default rather than carrying it over. The DIRECTIONAL types
// (marquee/drift/bounce) then edit amp via the on-glass arrow's dragged LENGTH; the
// noise types (twinkle/shake) edit it via the deck ± stepper (intensity); the rest
// keep this default (blink/pulse depth = default-only for now, owner-flagged).
export const DEFAULT_AMP: Record<MotionType, number> = {
  drift: 8, // cells (arrow length)
  bob: 8, // cells
  parallax: 8, // cells (orbit radius)
  blink: 8, // normalised (clamps to full dark)
  marquee: 8, // extra off-glass clearance cells (arrow length)
  twinkle: 8, // normalised intensity (± stepper; ≥8 = hard flash, 1 = soft shimmer)
  spin: 1, // UNUSED — spin's speed is `cycles` (the ± stepper)
  pendulum: 20, // swing degrees
  bounce: 8, // cells (arrow length)
  shake: 6, // cells of jitter (± stepper)
  pulse: 15, // % scale swing
};

// The noise types have no periodic speed — their ± stepper adjusts amp (intensity).
export const NOISE_TYPES: ReadonlySet<string> = new Set(['twinkle', 'shake']);
/** Motion speed bounds (integer cycles per loop — any whole number closes the wrap). */
export const SPEED_MIN = 1;
export const SPEED_MAX = 8;
/** Every Speed the slider offers, slowest first: ⅛×, ¼×, ½× (one cycle every 8 / 4 / 2
 *  loops) then 1×…8× per loop. */
export const SPEED_STEPS: readonly number[] = [
  1 / 8,
  1 / 4,
  1 / 2,
  ...Array.from({ length: SPEED_MAX - SPEED_MIN + 1 }, (_, i) => SPEED_MIN + i),
];
/** The slider position of a motion's `cycles` (the nearest step). */
export function speedStep(cycles: number): number {
  let best = 0;
  for (let i = 1; i < SPEED_STEPS.length; i++)
    if (Math.abs(SPEED_STEPS[i] - cycles) < Math.abs(SPEED_STEPS[best] - cycles)) best = i;
  return best;
}
/** "⅛×", "½×", "3×". */
export function speedLabel(cycles: number): string {
  const frac: Record<number, string> = { 0.125: '⅛', 0.25: '¼', 0.5: '½' };
  return `${frac[cycles] ?? String(cycles)}×`;
}

// Per-type default DIRECTION (ax, ay). Marquee scrolls horizontally (owner-locked);
// bounce's axis points at its "floor" (down). The on-glass direction arrow
// (SceneStage) rewrites these to any angle for the directional types; the
// non-directional types keep the neutral (1, 1) per-axis weights.
export const DEFAULT_DIR: Partial<Record<MotionType, { ax: number; ay: number }>> = {
  marquee: { ax: 1, ay: 0 },
  bounce: { ax: 0, ay: 1 },
};

/** TEMPO-SYNCED Speed (J1, FL Studio style): the slider's steps as one cycle's length in
 *  beats, SLOWEST first (8 bars … ¼ beat), so dragging right speeds it up as before. */
export const BEAT_STEPS: readonly number[] = [...BEAT_LENGTHS].reverse();
/** The slider position nearest a cycle length in beats (compared on a log scale). */
export function beatStep(beats: number): number {
  let best = 0;
  const d = (b: number) => Math.abs(Math.log2(b) - Math.log2(Math.max(1e-6, beats)));
  for (let i = 1; i < BEAT_STEPS.length; i++) if (d(BEAT_STEPS[i]) < d(BEAT_STEPS[best])) best = i;
  return best;
}
/** A new motion's cycle length: a marquee crosses in 4 bars, the rest repeat each bar. */
export const DEFAULT_BEATS: Partial<Record<MotionType, number>> = {
  marquee: 4 * BEATS_PER_BAR,
};

/** A fresh motion of `type` with its per-type defaults (speed in beats — J1 — default amp
 *  + direction; the noise types have no speed). */
export function newMotion(type: MotionType): MotionDescriptor {
  return {
    type,
    cycles: 1,
    ...(NOISE_TYPES.has(type) ? {} : { beats: DEFAULT_BEATS[type] ?? BEATS_PER_BAR }),
    amp: DEFAULT_AMP[type],
    ...(DEFAULT_DIR[type] ?? { ax: 1, ay: 1 }),
    phase0: 0,
  };
}
