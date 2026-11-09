// Reaction presets (shared by the layer panel + the Reactivity panel): bands, effects and
// their cycle helpers, and the default new reaction.
import type { AudioReactEvent } from '../core/loop-events';
import type { ReactionInput } from '../state/loop-store';

export type Band = AudioReactEvent['band'];
export type Target = AudioReactEvent['target'];

export const BANDS: { value: Band; label: string }[] = [
  { value: 'low', label: 'Bass' },
  { value: 'mid', label: 'Mid' },
  { value: 'high', label: 'Treble' },
  { value: 'onset', label: 'Beat' },
];

export type EffectKey =
  | 'pulse'
  | 'bounce'
  | 'shake'
  | 'flash'
  | 'dotSize'
  | 'contrast'
  | 'brightness'
  | 'palette'
  | 'invert'
  | 'matrixStep';
/** Moves first (the art itself moves to the music), then the looks. */
export const EFFECTS: { key: EffectKey; label: string; target: Target }[] = [
  { key: 'pulse', label: 'Pulse', target: { kind: 'pulse' } },
  { key: 'bounce', label: 'Bounce', target: { kind: 'bounce' } },
  { key: 'shake', label: 'Shake', target: { kind: 'shake' } },
  { key: 'flash', label: 'Flash', target: { kind: 'flash' } },
  { key: 'dotSize', label: 'Dot size', target: { kind: 'dotSize' } },
  { key: 'contrast', label: 'Contrast', target: { kind: 'look', key: 'contrast' } },
  { key: 'brightness', label: 'Brightness', target: { kind: 'look', key: 'brightness' } },
  { key: 'palette', label: 'Palette', target: { kind: 'palette' } },
  { key: 'invert', label: 'Invert', target: { kind: 'invert' } },
  { key: 'matrixStep', label: 'Coarser', target: { kind: 'matrixStep' } },
];

export const bandLabel = (b: Band): string => BANDS.find((x) => x.value === b)?.label ?? b;
export const nextBand = (b: Band): Band =>
  BANDS[(BANDS.findIndex((x) => x.value === b) + 1) % BANDS.length].value;
export const effectKeyOf = (t: Target): EffectKey => (t.kind === 'look' ? t.key : t.kind);

export const DEFAULT_REACTION: Omit<ReactionInput, 'nodeId'> = {
  band: 'low',
  target: { kind: 'pulse' },
  depth: 0.6,
};
