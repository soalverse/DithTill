// =============================================================================
// Each layer keeps its own look. A Whole canvas move moves every layer
// together; a layer's own Dot size / Density / Bit size move moves just that layer; the
// movable sliders follow the layer's own style; an older project's layers keep the look
// they were showing.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { evaluateScene } from '../src/core/loop-events';
import { makeRng } from '../src/core/seeded-rng';
import type { WaveMod } from '../src/core/modulators';
import { PROJECT_FORMAT, upgradeProjectDoc } from '../src/core/project-format';
import { SCENE_LOOK_DEFAULT, layerLookFrom, type SceneNode } from '../src/state/scene-store';
import { movableParams } from '../src/ui/moves';

const wave = (from: number, to: number): WaveMod => ({
  kind: 'wave',
  shape: 'rampUp',
  beats: 4,
  from,
  to,
});
const layer = (id: string, look: SceneNode['look'], mods?: SceneNode['mods']): SceneNode => ({
  id,
  assetId: id,
  kind: 'paint',
  z: 1,
  placement: { x: 10, y: 10, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: { ...layerLookFrom(SCENE_LOOK_DEFAULT), ...look },
  motion: null,
  opacity: 100,
  ...(mods ? { mods } : {}),
});
const at = (nodes: SceneNode[], canvasMods = {}, frame = 30) =>
  evaluateScene(nodes, SCENE_LOOK_DEFAULT, [], frame, 48, null, makeRng(1), new Set(), {
    canvasMods,
    dotDensity: SCENE_LOOK_DEFAULT.density,
  }).nodes;

describe('moves on a layer of its own look', () => {
  it('a Whole canvas Dot size move moves every layer together', () => {
    const out = at([layer('a', { dotSize: 4 }), layer('b', { dotSize: 18 })], {
      dotSize: wave(6, 30),
    });
    expect(out[0].look.dotSize).toBe(out[1].look.dotSize);
    expect(out[0].look.dotSize).not.toBe(4);
  });

  it("a layer's own Dot size / Bit size move moves just that layer", () => {
    const out = at([
      layer('a', { dotSize: 4 }, { dotSize: wave(4, 30) }),
      layer('b', { dotSize: 18 }),
      layer('c', { style: 'dither', bitSize: 10 }, { bitSize: wave(10, 40) }),
    ]);
    expect(out[0].look.dotSize).not.toBe(4);
    expect(out[1].look.dotSize).toBe(18);
    expect(out[2].look.bitSize).toBeGreaterThan(10);
  });

  it('the sliders that can move follow the layer’s own style', () => {
    expect(movableParams(layer('h', { style: 'halftone' }), true).slice(0, 2)).toEqual([
      'dotSize',
      'density',
    ]);
    expect(movableParams(layer('d', { style: 'dither' }), false)[0]).toBe('bitSize');
    // Every look can drift its grain (J6).
    expect(movableParams(undefined, false)).toEqual(['bitSize', 'drift']);
  });
});

describe('older projects', () => {
  it("v3 → v4: each layer keeps the look it was showing (the canvas's, its own on top)", () => {
    const scene = {
      ...SCENE_LOOK_DEFAULT,
      style: 'halftone' as const,
      dotSize: 12,
      palette: 'dusk' as const,
    };
    const doc = {
      format: PROJECT_FORMAT,
      schemaVersion: 3,
      generator: 'old',
      project: {
        name: 'Old',
        canvas: {
          nodes: [{ ...layer('a', {}), look: { matrix: 4 } }],
          scene,
          background: null,
          dotInk: null,
          pixel: 2.5,
          aspect: 'landscape',
          detail: 'normal',
        },
        loop: {
          meta: {},
          events: [],
          reactions: [],
          mutedLayers: [],
          audioMuted: [],
          animate: false,
        },
        media: { paints: [], images: [], records: [], track: null },
      },
    };
    const n = upgradeProjectDoc(doc).project.canvas.nodes[0];
    expect(n.look).toMatchObject({ style: 'halftone', dotSize: 12, palette: 'dusk', matrix: 4 });
  });
});
