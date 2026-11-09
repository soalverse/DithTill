// =============================================================================
// The LIVE values of moving sliders (J2) — what each moving slider's glowing
// marker shows while the canvas plays — and the frame playing (a Sound move's level bar).
// The render publishes them per frame (from evaluateScene); a slider subscribes to its own
// key. Display only: never saved, never an edit, never read by the export.
// =============================================================================
import { useSyncExternalStore } from 'react';

let values: ReadonlyMap<string, number> = new Map();
let frame: number | undefined;
const listeners = new Set<() => void>();

/** The render's per-frame values + its absolute frame (null = at rest: every slider shows
 *  its own value and the level bars stop). */
export function publishModValues(next: ReadonlyMap<string, number> | null, abs?: number): void {
  const v = next ?? new Map<string, number>();
  const f = next ? abs : undefined;
  if (v.size === 0 && values.size === 0 && f === frame) return;
  values = v;
  frame = f;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The live value of one moving slider (by modKey), or undefined at rest. */
export function useModValue(key: string | undefined): number | undefined {
  return useSyncExternalStore(subscribe, () => (key ? values.get(key) : undefined));
}

/** The absolute frame playing, or undefined at rest. */
export function useLiveFrame(): number | undefined {
  return useSyncExternalStore(subscribe, () => frame);
}
