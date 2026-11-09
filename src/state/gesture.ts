// A drag in progress (a slider being dragged) — every change it makes is ONE undo step.
// The slider marks the start and end; the scene history (zundo
// handleSet) and the one-history coordinator read it to record only the first change.
export const gesture = {
  /** A drag is in progress. */
  active: false,
  /** Bumped per drag, so a history entry knows which drag it came from. */
  id: 0,
  /** The scene history already recorded this drag's starting state. */
  sceneRecorded: false,
};

export function beginGesture(): void {
  gesture.active = true;
  gesture.id += 1;
  gesture.sceneRecorded = false;
  // Safety net: any release anywhere ends the drag, so history can never stay paused.
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', endGesture, { once: true });
    window.addEventListener('pointercancel', endGesture, { once: true });
  }
}

export function endGesture(): void {
  gesture.active = false;
}
