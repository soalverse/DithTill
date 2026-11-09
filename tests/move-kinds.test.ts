// =============================================================================
// Two kinds of move + one When switch: a Move it that hits on
// the sound is the SAME move as its looping Motion — one name, whichever When it has.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { EFFECTS } from '../src/ui/react-presets';
import { MOTION_LABELS } from '../src/ui/motion-presets';

describe('one name per move', () => {
  it('Pulse / Bounce / Shake on the sound share their Motion’s name', () => {
    for (const k of ['pulse', 'bounce', 'shake'] as const)
      expect(EFFECTS.find((e) => e.key === k)?.label).toBe(MOTION_LABELS[k]);
  });

  it('no two sound hits share a name', () => {
    const labels = EFFECTS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
