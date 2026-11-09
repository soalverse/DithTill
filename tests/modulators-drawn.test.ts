// =============================================================================
// Drawn moves (J2b, FL Studio's automation clip): a
// slider follows a line of dots drawn on a lane over the whole video. Pinned here: the line
// between dots (Smooth / Straight / Jump), holding before the first and after the last dot,
// adding / moving / deleting dots and changing a line, the value kept inside the slider,
// the line read on the ABSOLUTE frame (the export walk == the live canvas at that frame),
// switching between Beat / Sound / Drawn keeping the two values, the export shortcut
// stepping aside, and one undo step for an add + its drag.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  addDot,
  clampMod,
  drawnAt,
  hasDrawnMod,
  modEnds,
  modulate,
  moveDot,
  newDrawn,
  removeDot,
  setDotCurve,
  type DrawnMod,
  type DrawnPoint,
  type ModContext,
} from '../src/core/modulators';
import { evaluateScene } from '../src/core/loop-events';
import { fastPathEligible } from '../src/core/loop-export-plan';
import { makeRng } from '../src/core/seeded-rng';
import type { BeatClock } from '../src/core/tempo';
import { SCENE_LOOK_DEFAULT, useSceneStore, type SceneNode } from '../src/state/scene-store';
import { beginGesture, endGesture } from '../src/state/gesture';

const F = 60; // 1 bar at 120 BPM, 30 fps
const CLOCK: BeatClock = { bpm: 120, fps: 30, offsetSec: 0, frames: F, loopBeats: 4, song: true };
const dot = (f: number, v: number, curve: DrawnPoint['curve'] = 'straight'): DrawnPoint => ({
  f,
  v,
  curve,
});
const drawn = (...points: DrawnPoint[]): DrawnMod => ({ kind: 'drawn', points });
const ctx = (absFrame: number): ModContext => ({ absFrame, frames: F, features: null });

function node(patch: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'n1',
    assetId: 'a1',
    kind: 'asset',
    z: 1,
    placement: { x: 20, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    crop: null,
    look: {},
    motion: null,
    opacity: 50,
    ...patch,
  };
}

describe('the line between dots', () => {
  it('Straight runs straight, Smooth eases without overshooting, Jump holds then jumps', () => {
    expect(drawnAt([dot(0, 0), dot(100, 100)], 25)).toBe(25);
    const smooth = [dot(0, 0, 'smooth'), dot(100, 100)];
    expect(drawnAt(smooth, 0)).toBe(0);
    expect(drawnAt(smooth, 50)).toBeCloseTo(50);
    expect(drawnAt(smooth, 25)).toBeLessThan(25); // eases out of the first dot
    for (let f = 0; f <= 100; f += 5) {
      const v = drawnAt(smooth, f)!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    const jump = [dot(0, 10, 'jump'), dot(100, 90)];
    expect(drawnAt(jump, 99)).toBe(10);
    expect(drawnAt(jump, 100)).toBe(90);
  });

  it('holds the first value before the first dot and the last after the last', () => {
    const pts = [dot(30, 20), dot(60, 80)];
    expect(drawnAt(pts, 0)).toBe(20);
    expect(drawnAt(pts, 59)).toBeCloseTo(78);
    expect(drawnAt(pts, 500)).toBe(80);
    expect(drawnAt([dot(40, 33)], 0)).toBe(33);
    expect(drawnAt([], 10)).toBeNull();
  });

  it('two dots on one frame make an instant step', () => {
    const pts = [dot(0, 0), dot(50, 0), dot(50, 100), dot(100, 100)];
    expect(drawnAt(pts, 49)).toBe(0);
    expect(drawnAt(pts, 50)).toBe(100);
  });
});

describe('editing dots', () => {
  it('adds in frame order and takes the curve of the line it lands on', () => {
    const pts = [dot(0, 0, 'jump'), dot(100, 100, 'smooth')];
    const r = addDot(pts, 40, 70);
    expect(r.index).toBe(1);
    expect(r.points.map((p) => p.f)).toEqual([0, 40, 100]);
    expect(r.points[1]).toEqual({ f: 40, v: 70, curve: 'jump' });
    expect(addDot(pts, 200, 5).index).toBe(2);
    expect(addDot([], 10, 5).points).toEqual([{ f: 10, v: 5, curve: 'smooth' }]);
  });

  it("a moved dot can't pass its neighbours; a lane keeps one dot; a line's curve changes", () => {
    const pts = [dot(0, 0), dot(50, 50), dot(100, 100)];
    expect(moveDot(pts, 1, 140, 20)[1]).toMatchObject({ f: 100, v: 20 });
    expect(moveDot(pts, 1, -5, 20)[1]).toMatchObject({ f: 0 });
    expect(moveDot(pts, 0, -9, 1)[0].f).toBe(0);
    expect(removeDot(pts, 1).map((p) => p.f)).toEqual([0, 100]);
    expect(removeDot([dot(5, 5)], 0)).toHaveLength(1);
    expect(setDotCurve(pts, 1, 'jump')[1].curve).toBe('jump');
    expect(pts[1].curve).toBe('straight'); // pure: the input is untouched
  });

  it('a value stays inside the slider (whole numbers rounded)', () => {
    expect(clampMod('opacity', 140)).toBe(100);
    expect(clampMod('opacity', 33.6)).toBe(34);
    expect(clampMod('photo.gamma', 0.1)).toBe(0.4);
    expect(clampMod('photo.gamma', 1.234)).toBe(1.23);
    // modulate keeps it inside too, whatever was stored
    expect(modulate('opacity', 50, drawn(dot(0, 150)), 'k', ctx(0))).toBe(100);
    expect(modulate('opacity', 50, drawn(dot(0, 0), dot(10, 100)), 'k', ctx(3))).toBe(30);
  });
});

describe('switching drives keeps the two values', () => {
  it('a new Drawn move runs FROM at the start to TO at the end of the video', () => {
    expect(newDrawn(20, 80, 300).points).toEqual([
      { f: 0, v: 20, curve: 'smooth' },
      { f: 299, v: 80, curve: 'smooth' },
    ]);
  });
  it("a drawn line's two values are its first dot and the dot farthest from it", () => {
    expect(modEnds('opacity', drawn(dot(0, 40), dot(9, 90), dot(20, 10)), 50)).toEqual({
      from: 40,
      to: 90,
    });
    // a flat line still gives a move somewhere to go
    expect(modEnds('opacity', drawn(dot(0, 40), dot(9, 40)), 50)).toEqual({ from: 40, to: 80 });
  });
});

describe('preview == export: the line is read on the absolute frame', () => {
  const lane = drawn(dot(0, 0), dot(4 * F, 100)); // across four loops of a song
  const at = (abs: number) =>
    evaluateScene(
      [node({ mods: { opacity: lane } })],
      SCENE_LOOK_DEFAULT,
      [],
      abs % F,
      F,
      null,
      makeRng(1),
      new Set(),
      {
        absFrame: abs,
        beat: CLOCK,
      },
    );

  it('every loop is a different stretch of the line, the same at the same frame', () => {
    expect(at(0).nodes[0].opacity).toBe(0);
    expect(at(F).nodes[0].opacity).toBe(25);
    expect(at(2 * F).nodes[0].opacity).toBe(50);
    expect(at(2 * F).nodes[0].opacity).toBe(at(2 * F).nodes[0].opacity);
    expect(at(10 * F).nodes[0].opacity).toBe(100); // after the last dot it holds
    expect(at(F).modValues.get('n1|opacity')).toBe(25); // the slider's live marker
  });

  it("the canvas's Dot size and Density follow a drawn line too", () => {
    const ev = evaluateScene([], SCENE_LOOK_DEFAULT, [], 0, F, null, makeRng(1), new Set(), {
      absFrame: 2 * F,
      beat: CLOCK,
      dotDensity: 8,
      canvasMods: { dotSize: drawn(dot(0, 2), dot(4 * F, 10)), density: drawn(dot(0, 12)) },
    });
    expect(ev.scene.dotSize).toBe(6);
    expect(ev.dotDensity).toBe(12);
  });

  it('the long-export shortcut steps aside (no two loops look the same)', () => {
    const base = {
      totalFrames: 4 * F,
      frames: F,
      events: [],
      videoFrameCounts: [],
      features: null,
    };
    const mods = { opacity: lane };
    expect(hasDrawnMod([mods])).toBe(true);
    expect(fastPathEligible({ ...base, nodes: [node({ mods })] })).toBe(false);
    expect(fastPathEligible({ ...base, nodes: [node()], canvasMods: mods })).toBe(false);
    expect(fastPathEligible({ ...base, nodes: [node()] })).toBe(true);
  });
});

describe('one undo per edit', () => {
  it('adding a dot and dragging it is one step; a curve change is one step', () => {
    const st = useSceneStore.getState();
    st.clear();
    st.addNodes([{ assetId: 'x', w: 4, h: 4, cx: 10, cy: 10 }]);
    const id = useSceneStore.getState().nodes[0].id;
    const points = () => {
      const m = useSceneStore.getState().nodes[0].mods?.opacity;
      return m?.kind === 'drawn' ? m.points : [];
    };
    const save = (p: DrawnPoint[]) =>
      useSceneStore.getState().setMod(id, 'opacity', { kind: 'drawn', points: p });
    const undo = () => useSceneStore.temporal.getState().undo();

    save(newDrawn(0, 100, 120).points);
    beginGesture(); // the lane's press: add a dot, then drag it
    const added = addDot(points(), 30, 50);
    save(added.points);
    for (const f of [35, 40, 45]) save(moveDot(points(), added.index, f, 60));
    endGesture();
    expect(points().map((p) => p.f)).toEqual([0, 45, 119]);
    undo();
    expect(points().map((p) => p.f)).toEqual([0, 119]);

    save(setDotCurve(points(), 0, 'jump'));
    undo();
    expect(points()[0].curve).toBe('smooth');
  });
});
