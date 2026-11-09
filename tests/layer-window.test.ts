// =============================================================================
// The animation window: a box fixed on the canvas a layer is seen through.
// Only whole marks whose centre is inside show (pixels and SVG alike), a Solid layer
// clears only inside it, a Marquee scrolls across the window rather than the canvas, the
// live render == the export walk, and moving the layer by hand brings the window along.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { renderTextRaster } from '../src/core/dot-font';
import { evaluateScene } from '../src/core/loop-events';
import { renderLoopFrameImage } from '../src/core/loop-render';
import { makeRng } from '../src/core/seeded-rng';
import {
  SCREEN_LOOK_DEFAULT,
  printScreenSvg,
  renderPrintScreen,
  type PrintFrame,
  type ScreenLayer,
  type ScreenRaster,
} from '../src/core/print-screen';
import {
  SCENE_LOOK_DEFAULT,
  layerLookFrom,
  useSceneStore,
  type CropRect,
  type SceneNode,
} from '../src/state/scene-store';

const flat = (w: number, h: number, tone = 255): ScreenRaster => ({
  w,
  h,
  tones: new Uint8Array(w * h).fill(tone),
  covered: new Uint8Array(w * h).fill(1),
});
const layer = (patch: Partial<ScreenLayer> = {}): ScreenLayer => ({
  raster: flat(40, 20),
  placement: { x: 40, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  look: { ...SCREEN_LOOK_DEFAULT, dotSize: 16, density: 6 },
  ...patch,
});
const render = (layers: ScreenLayer[], background: [number, number, number] | null = [0, 0, 0]) =>
  renderPrintScreen({ layers, dims: { w: 80, h: 40 }, scale: 4, background });
const litCols = (fr: PrintFrame): number[] => {
  const cols: number[] = [];
  for (let x = 0; x < fr.w; x++)
    for (let y = 0; y < fr.h; y++)
      if (fr.rgba[(y * fr.w + x) * 4]) {
        cols.push(x);
        break;
      }
  return cols;
};
/** The lit pixels of each dot column (x runs of lit columns), as [start, end) runs. */
const runs = (cols: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const x of cols) {
    const last = out[out.length - 1];
    if (last && last[1] === x) last[1] = x + 1;
    else out.push([x, x + 1]);
  }
  return out;
};
const WIN: CropRect = { x: 30, y: 10, w: 20, h: 20 };

describe('the animation window', () => {
  it('shows only the marks whose centre is inside, each one whole', () => {
    const open = render([layer()]);
    const framed = render([layer({ window: WIN })]);
    expect(framed.rgba.some((v) => v > 0)).toBe(true);
    // Nothing lit far outside the window (a dot pokes out by at most its own radius).
    const cols = litCols(framed);
    const reach = 16 * 0.4; // half a 16-unit dot at scale 4 / CELL_RENDER_SCALE 10, in px
    expect(Math.min(...cols)).toBeGreaterThanOrEqual(WIN.x * 4 - reach - 1);
    expect(Math.max(...cols)).toBeLessThan((WIN.x + WIN.w) * 4 + reach + 1);
    // Every dot column inside is as wide as the same column with no window: none is sliced.
    const openRuns = runs(litCols(open));
    for (const r of runs(cols)) expect(openRuns).toContainEqual(r);
  });

  it('the SVG keeps the same marks', () => {
    const svg = (w?: CropRect) =>
      printScreenSvg({
        layers: [layer(w ? { window: w } : {})],
        dims: { w: 80, h: 40 },
        scale: 4,
        background: [0, 0, 0],
      });
    // The dots are path data grouped by colour: fewer dots, less data — but some.
    const empty = printScreenSvg({
      layers: [],
      dims: { w: 80, h: 40 },
      scale: 4,
      background: [0, 0, 0],
    });
    expect(svg(WIN).length).toBeLessThan(svg().length - 200);
    expect(svg(WIN).length).toBeGreaterThan(empty.length + 200);
  });

  it('a Solid layer clears what is under it only inside its window', () => {
    const under = layer({ raster: flat(80, 40), placement: { ...layer().placement } });
    const solid = layer({ solid: true, window: WIN, look: { ...layer().look, dotSize: 1 } });
    const fr = render([under, solid]);
    const base = render([under]);
    // Outside the window the layer below is untouched.
    for (let y = 0; y < fr.h; y++)
      for (let x = 0; x < WIN.x * 4 - 8; x++)
        expect(fr.rgba[(y * fr.w + x) * 4]).toBe(base.rgba[(y * fr.w + x) * 4]);
  });

  it('a Marquee scrolls across its window: it starts just outside the window, not the canvas', () => {
    const text = renderTextRaster({ text: 'HI', size: 1, spacing: 1, align: 'center' });
    const node: SceneNode = {
      id: 't',
      assetId: 'text',
      kind: 'text',
      z: 1,
      placement: { x: 40, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: layerLookFrom(SCENE_LOOK_DEFAULT),
      motion: { type: 'marquee', cycles: 1, amp: 0, ax: 1, ay: 0, phase0: 0 },
      opacity: 100,
      window: WIN,
    };
    const at = (frame: number) =>
      evaluateScene([node], SCENE_LOOK_DEFAULT, [], frame, 48, null, makeRng(1), new Set(), {
        dims: { w: 80, h: 40 },
        assetDims: () => ({ w: text.w, h: text.h }),
      }).nodes[0].placement.x;
    // Frame 0: its right edge sits on the window's left edge.
    expect(at(0) + text.w / 2).toBeCloseTo(WIN.x);
    // It loops seamlessly and passes through the window on the way.
    expect(at(48)).toBeCloseTo(at(0));
    const xs = Array.from({ length: 48 }, (_, f) => at(f));
    expect(xs.some((x) => x > WIN.x && x < WIN.x + WIN.w)).toBe(true);
  });

  it('the export walk draws the window exactly as the live render', () => {
    const text = renderTextRaster({ text: 'HELLO', size: 2, spacing: 1, align: 'center' });
    const node = {
      id: 't',
      assetId: 'text',
      kind: 'text',
      z: 1,
      placement: { x: 40, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      look: layerLookFrom(SCENE_LOOK_DEFAULT),
      motion: { type: 'marquee', cycles: 1, amp: 0, ax: 1, ay: 0, phase0: 0 },
      opacity: 100,
      window: WIN,
    } as SceneNode;
    const input = {
      nodes: [node],
      scene: SCENE_LOOK_DEFAULT,
      events: [],
      frames: 24,
      seed: 1,
      dims: { w: 80, h: 40 },
      assets: new Map([['text', text]]),
      mutedLayers: new Set<number>(),
      features: null,
      background: { rgb: [0, 0, 0] as [number, number, number] },
    };
    for (const f of [0, 6, 12]) {
      const img = renderLoopFrameImage(input as never, f, 4);
      // Nothing outside the window (plus a dot's reach) is lit on any frame.
      for (let y = 0; y < img.h; y++)
        for (let x = 0; x < img.w; x++)
          if (x < WIN.x * 4 - 4 || x >= (WIN.x + WIN.w) * 4 + 4)
            expect(img.rgba[(y * img.w + x) * 4]).toBe(0);
    }
  });

  it('moving the layer by hand brings its window; Duplicate offsets it too; one undo step', () => {
    const st = useSceneStore.getState();
    st.clear();
    useSceneStore.setState({
      nodes: [
        {
          id: 'n1',
          assetId: 'a',
          kind: 'paint',
          z: 1,
          placement: { x: 40, y: 20, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          crop: null,
          look: {},
          motion: null,
        } as SceneNode,
      ],
    });
    useSceneStore.temporal.getState().clear();
    st.setWindow('n1', WIN);
    st.setPlacement('n1', { x: 45, y: 17, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    expect(useSceneStore.getState().nodes[0].window).toEqual({ x: 35, y: 7, w: 20, h: 20 });
    useSceneStore.temporal.getState().undo();
    useSceneStore.temporal.getState().undo();
    expect(useSceneStore.getState().nodes[0].window).toBeUndefined();
    useSceneStore.temporal.getState().redo();
    st.setSelection(['n1']);
    st.duplicate();
    const copy = useSceneStore.getState().nodes[1];
    expect(copy.window).toEqual({ x: 34, y: 14, w: 20, h: 20 });
  });
});
