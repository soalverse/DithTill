// E5 object-path capture (the loop-flow pass) — the pure capture module:
// frame-quantized sampling, wrap pinning, hole fill-forward, static-vs-path
// classification, and a round-trip through evaluateScene.
import { describe, it, expect } from 'vitest';
import { beginPathCapture, samplePath, finishPathCapture } from '../src/core/path-capture';
import { evaluateScene, type ObjectPathEvent } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import { SCENE_LOOK_DEFAULT, type Placement, type SceneNode } from '../src/state/scene-store';

const NO_MUTE: ReadonlySet<number> = new Set();
const RNG = makeRng(0xabc);

function place(x: number, y: number): Placement {
  return { x, y, scaleX: 1, scaleY: 1, rotationDeg: 0 };
}
function node(id: string, x: number, y: number): SceneNode {
  return {
    id,
    assetId: `asset-${id}`,
    kind: 'asset',
    z: 1,
    placement: place(x, y),
    crop: null,
    look: {},
    motion: null,
    opacity: 100,
  };
}

describe('path capture — sampling', () => {
  it('indexes samples by frame; the latest sample within a frame wins', () => {
    const cap = beginPathCapture('a', 2, 10);
    samplePath(cap, 10, 60, place(0, 0));
    samplePath(cap, 10, 60, place(1, 1)); // same frame → overwrite
    samplePath(cap, 12, 60, place(3, 3));
    expect(cap.samples[0]).toEqual(place(1, 1));
    expect(cap.samples[1]).toBeUndefined(); // hole (filled on finish)
    expect(cap.samples[2]).toEqual(place(3, 3));
  });

  it('holes fill forward on finish (hold semantics)', () => {
    const cap = beginPathCapture('a', 0, 5);
    samplePath(cap, 5, 60, place(0, 0));
    samplePath(cap, 8, 60, place(9, 9));
    const evt = finishPathCapture(cap, 60, 'op-1') as ObjectPathEvent;
    expect(evt.kind).toBe('object-path');
    expect(evt.samples).toEqual([place(0, 0), place(0, 0), place(0, 0), place(9, 9)]);
    expect(evt.startFrame).toBe(5);
    expect(evt.endFrame).toBe(8);
    expect(evt.interp).toBe('hold');
  });

  it('wrap pinning: frames past the loop end pin to F-1 as one ascending run', () => {
    const cap = beginPathCapture('a', 0, 57);
    samplePath(cap, 57, 60, place(0, 0));
    samplePath(cap, 58, 60, place(1, 1));
    samplePath(cap, 59, 60, place(2, 2));
    samplePath(cap, 0, 60, place(3, 3)); // wrapped → pins to 59
    samplePath(cap, 1, 60, place(4, 4)); // still pinned
    expect(cap.lastFrame).toBe(59);
    const evt = finishPathCapture(cap, 60, 'op-2') as ObjectPathEvent;
    expect(evt.kind).toBe('object-path');
    expect(evt.endFrame).toBe(59);
    expect(evt.samples.length).toBe(3);
    expect(evt.samples[2]).toEqual(place(4, 4)); // last write at the pinned frame wins
  });

  it('a ≤1-frame gesture becomes object-static held to the loop end', () => {
    const cap = beginPathCapture('a', 3, 20);
    samplePath(cap, 20, 60, place(4, 4));
    samplePath(cap, 21, 60, place(5, 5));
    const evt = finishPathCapture(cap, 60, 'op-3');
    expect(evt?.kind).toBe('object-static');
    if (evt?.kind === 'object-static') {
      expect(evt.placement).toEqual(place(5, 5));
      expect(evt.startFrame).toBe(20);
      expect(evt.endFrame).toBe(60);
      expect(evt.pass).toBe(3);
      expect(evt.layer).toBe(3);
    }
  });

  it('an empty capture finishes to null', () => {
    expect(finishPathCapture(beginPathCapture('a', 0, 0), 60, 'op-4')).toBeNull();
  });
});

describe('path capture — evaluateScene round-trip', () => {
  it('a finished path replays samples[i] at startFrame+i and reverts after endFrame', () => {
    const cap = beginPathCapture('a', 1, 10);
    samplePath(cap, 10, 60, place(10, 0));
    samplePath(cap, 11, 60, place(20, 0));
    samplePath(cap, 12, 60, place(30, 0));
    const evt = finishPathCapture(cap, 60, 'op-5') as ObjectPathEvent;
    const base = [node('a', 99, 99)];
    const at = (f: number) =>
      evaluateScene(base, SCENE_LOOK_DEFAULT, [evt], f, 60, null, RNG, NO_MUTE).nodes[0].placement;
    expect(at(9)).toEqual(place(99, 99)); // before → base
    expect(at(10)).toEqual(place(10, 0));
    expect(at(11)).toEqual(place(20, 0));
    expect(at(12)).toEqual(place(30, 0));
    expect(at(13)).toEqual(place(99, 99)); // after → base (next loop repeats)
  });
});
