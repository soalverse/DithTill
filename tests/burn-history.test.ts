// The Burn dial memory (owner ask: SMALL, deliberately not robust): coalesced
// snapshots, capped depth, params only. Reset = defaults EXCEPT aspect (the
// shared shape source) and never touches the loaded source.
import { describe, it, expect, beforeEach } from 'vitest';
import { useBurnStore, DEFAULT_PARAMS } from '../src/state/burn-store';

const s = () => useBurnStore.getState();

describe('burn dial history', () => {
  beforeEach(() => {
    s().reset();
    useBurnStore.setState({ paramsPast: [], paramsFuture: [], aspect: 'square' });
  });

  it('undo restores the previous dials; redo replays them', async () => {
    s().setParam('gamma', 1.8);
    await new Promise((r) => setTimeout(r, 450)); // past the coalesce window
    s().setParam('contrast', 2.0);
    expect(s().paramsPast.length).toBe(2);
    s().undoParams();
    expect(s().contrast).toBe(1.0);
    expect(s().gamma).toBe(1.8);
    s().undoParams();
    expect(s().gamma).toBe(1);
    s().redoParams();
    expect(s().gamma).toBe(1.8);
  });

  it('a rapid slider drag coalesces into one entry', () => {
    for (let v = 1; v <= 10; v++) s().setParam('zoom', 1 + v / 10);
    expect(s().paramsPast.length).toBe(1);
    s().undoParams();
    expect(s().zoom).toBe(1);
  });

  it('reset returns dials to defaults but keeps aspect, and is undoable', async () => {
    s().setParam('gamma', 2.2);
    await new Promise((r) => setTimeout(r, 450));
    s().setParam('palette', 'dusk');
    s().resetParams();
    expect(s().gamma).toBe(DEFAULT_PARAMS.gamma);
    expect(s().palette).toBe(DEFAULT_PARAMS.palette);
    expect(s().aspect).toBe('square'); // NOT reset — the shared shape source
    s().undoParams();
    expect(s().gamma).toBe(2.2);
    expect(s().palette).toBe('dusk');
  });

  it('the history depth is capped', async () => {
    for (let i = 0; i < 30; i++) {
      s().setParam('black', i);
      await new Promise((r) => setTimeout(r, 0));
      useBurnStore.setState({}); // no-op; keep loop simple
      // force distinct entries by bypassing the coalesce timer
      s().applyPreset({ black: i });
    }
    expect(s().paramsPast.length).toBeLessThanOrEqual(24);
  });
});
