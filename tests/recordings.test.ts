// Recordings: a brush performance is its own layer, with its own clock.
//   - recordingClock: Repeat wraps, Hold pins past the drawn part, backwards mirrors it, and a
//     held backwards recording is blank (lock 16);
//   - the held picture has no flashes; an at-rest view still shows them;
//   - a recording draws identically through the live seams and the export walk, whether a frame
//     is rendered alone or in a walk (preview == export).
import { describe, expect, it } from 'vitest';
import {
  applyPaintReveal,
  evaluateScene,
  layerClock,
  partFrame,
  recordingClock,
  type DabStamp,
  type EventPart,
  type TimedEvent,
  type LayerLoop,
  type PaintRevealEvent,
} from '../src/core/loop-events';
import { renderLoopFrameImage, type LoopRenderInput } from '../src/core/loop-render';
import { fastPathEligible } from '../src/core/loop-export-plan';
import {
  buildRecordingElement,
  orphanHashes,
  referencedHashes,
  type RecordingElementData,
} from '../src/core/library';
import { encodeElementFile, parseAnyElementFile } from '../src/core/element-file';
import { mergeRecordings, type MergeSide } from '../src/core/recording-merge';
import { drawnEnd } from '../src/core/timeline-edit';
import { makeRng } from '../src/core/seeded-rng';
import type { CachedAsset } from '../src/core/scene-resolver';
import { SCENE_LOOK_DEFAULT, type RecordingPlay, type SceneNode } from '../src/state/scene-store';
import type { TimelineClip } from '../src/core/timeline-edit';

const W = 24;
const H = 8;
const D = 8; // the drawn part: 8 frames, one dab per frame across the top row
const clip = (start: number, duration: number): TimelineClip => ({
  id: `c${start}`,
  start,
  duration,
  sourceIn: 0,
});
const recording = (rec?: RecordingPlay, clips = [clip(10, 30)]): SceneNode => ({
  id: 'r',
  assetId: 'paint:1',
  kind: 'recording',
  z: 1,
  placement: { x: W / 2, y: H / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 },
  crop: null,
  look: {},
  motion: null,
  opacity: 100,
  clips,
  ...(rec ? { rec } : {}),
});
const blank = (): CachedAsset => ({
  w: W,
  h: H,
  tones: new Uint8Array(W * H),
  covered: new Uint8Array(W * H),
});
const dab = (frame: number, x: number, y = 1): DabStamp => ({
  frame,
  x,
  y,
  r: 0.4,
  shade: 1,
  erase: false,
});
const stroke = (over: Partial<PaintRevealEvent> = {}): PaintRevealEvent => ({
  id: 'pr-1',
  kind: 'paint-reveal',
  nodeId: 'r',
  assetId: 'paint:1',
  pass: 1,
  layer: 1,
  startFrame: 0,
  endFrame: D - 1,
  stamps: Array.from({ length: D }, (_, k) => dab(k, k * 2 + 1)),
  ...over,
});
const flash = stroke({
  id: 'pr-2',
  pass: 2,
  layer: 2,
  startFrame: 2,
  endFrame: 2,
  holdFrames: 4,
  stamps: [dab(2, 3, 5)],
});
const loops: Record<string, LayerLoop> = { r: { frames: D, free: true } };

/** Covered cells on a row at song frame `abs`, through the same two seams the live canvas and
 *  the export read: evaluateScene's clocks, then applyPaintReveal. */
function row(node: SceneNode, abs: number, y = 1, events: PaintRevealEvent[] = [stroke()]): number {
  const ev = evaluateScene(
    [node],
    SCENE_LOOK_DEFAULT,
    events,
    abs % 40,
    40,
    null,
    makeRng(1),
    new Set(),
    {
      absFrame: abs,
      layerLoops: loops,
    },
  );
  const out = applyPaintReveal(
    new Map([['paint:1', blank()]]),
    events,
    abs % 40,
    40,
    new Set(),
    null,
    (id) => ev.clocks.get(id),
  ).get('paint:1')!;
  let n = 0;
  for (let x = 0; x < W; x++) if (out.covered[y * W + x]) n++;
  return n;
}

describe('recordingClock', () => {
  const at = (rec: RecordingPlay, pos: number) => {
    const c = layerClock({}, pos, 100, { frames: D })!;
    return recordingClock(c, rec);
  };

  it('Repeat, forwards: the plain clock, untouched', () => {
    expect(at({}, 3)).toEqual({ frame: 3, frames: D, pos: 3 });
    expect(at({}, 11)).toEqual({ frame: 3, frames: D, pos: 11 });
  });

  it('Hold: runs through the drawn part, then pins at its last frame', () => {
    expect(at({ hold: true }, D - 1).held).toBeUndefined();
    expect(at({ hold: true }, D)).toMatchObject({ replay: D - 1, held: true });
    expect(at({ hold: true }, 50)).toMatchObject({ replay: D - 1, held: true });
  });

  it('Backwards mirrors the drawn part on every pass', () => {
    expect(at({ backwards: true }, 0).replay).toBe(D - 1);
    expect(at({ backwards: true }, D - 1).replay).toBe(0);
    expect(at({ backwards: true }, D).replay).toBe(D - 1);
  });

  it('Backwards + Hold: blank past the drawn part (lock 16)', () => {
    expect(at({ backwards: true, hold: true }, D)).toMatchObject({ replay: -1, held: true });
  });

  it('an offset counts the drawn part from where the recording starts', () => {
    const c = layerClock({}, 12, 100, { frames: D, offset: 6 })!;
    expect(recordingClock(c, { hold: true }, 6).held).toBeUndefined();
    const past = layerClock({}, 14, 100, { frames: D, offset: 6 })!;
    expect(recordingClock(past, { hold: true }, 6).held).toBe(true);
  });
});

describe('what a recording shows at a song frame', () => {
  it('once: draws in across its bar from the first stroke', () => {
    const n = recording();
    expect(row(n, 10)).toBeGreaterThan(0);
    expect(row(n, 14)).toBeGreaterThan(row(n, 10));
    expect(row(n, 17)).toBe(row(n, 10 + D - 1));
  });

  it('Repeat: redraws from blank past its drawn part', () => {
    const n = recording();
    expect(row(n, 10 + D)).toBe(row(n, 10));
    expect(row(n, 10 + D + 4)).toBe(row(n, 14));
  });

  it('Hold: keeps the finished picture past its drawn part', () => {
    const n = recording({ hold: true });
    const finished = row(n, 10 + D - 1);
    for (const f of [10 + D, 25, 39]) expect(row(n, f)).toBe(finished);
  });

  it('the held picture has no flashes (they only flash)', () => {
    const n = recording({ hold: true });
    const events = [stroke(), flash];
    expect(row(n, 12, 5, events)).toBeGreaterThan(0); // flashing on its beat
    expect(row(n, 10 + D, 5, events)).toBe(0); // held
    expect(row(n, 10 + D, 1, events)).toBe(row(n, 10 + D - 1, 1, events)); // the picture stays
  });

  it('at rest (the sentinel, no clock) the flashes still show', () => {
    const out = applyPaintReveal(
      new Map([['paint:1', blank()]]),
      [stroke(), flash],
      Number.MAX_SAFE_INTEGER,
      40,
      new Set(),
    ).get('paint:1')!;
    expect(out.covered[5 * W + 3]).toBe(1);
  });

  it('Backwards: starts finished and un-draws itself', () => {
    const n = recording({ backwards: true });
    const forward = recording();
    expect(row(n, 10)).toBe(row(forward, 10 + D - 1));
    expect(row(n, 10 + D - 1)).toBe(row(forward, 10));
    expect(row(n, 14)).toBeLessThan(row(n, 10));
  });

  it('Backwards mirrors a flash with it', () => {
    const n = recording({ backwards: true });
    const f = [stroke(), flash];
    // Forward the flash shows at frames 2..5 of the drawn part; backwards at 2..5 mirrored.
    expect(row(n, 10 + (D - 1 - 3), 5, f)).toBe(row(recording(), 10 + 3, 5, f));
  });

  it('Backwards + Hold: blank in the held stretch', () => {
    const n = recording({ backwards: true, hold: true });
    expect(row(n, 10 + D)).toBe(0);
    expect(row(n, 39)).toBe(0);
  });

  it('off its bar: not on screen', () => {
    const ev = evaluateScene(
      [recording()],
      SCENE_LOOK_DEFAULT,
      [stroke()],
      0,
      40,
      null,
      makeRng(1),
      new Set(),
      {
        absFrame: 5,
        layerLoops: loops,
      },
    );
    expect(ev.nodes).toHaveLength(0);
  });

  it('a hand move holds still in the held stretch, and plays on a mirrored clock backwards', () => {
    const samples = Array.from({ length: D }, (_, k) => ({
      x: k,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
    }));
    const path = {
      id: 'op-1',
      kind: 'object-path' as const,
      nodeId: 'r',
      pass: 1,
      layer: 1,
      startFrame: 0,
      endFrame: D - 1,
      samples,
      interp: 'hold' as const,
    };
    const xAt = (n: SceneNode, abs: number) =>
      evaluateScene([n], SCENE_LOOK_DEFAULT, [path], abs % 40, 40, null, makeRng(1), new Set(), {
        absFrame: abs,
        layerLoops: loops,
        pathClose: true,
      }).nodes[0].placement.x;
    expect(xAt(recording({ hold: true }), 30)).toBe(D - 1); // no loop-close blend when held
    expect(xAt(recording({ backwards: true }), 10)).not.toBe(0);
  });
});

describe('a recording on the one render path (preview == export)', () => {
  const dims = { w: W, h: H };
  const input = (
    rec?: RecordingPlay,
    events: PaintRevealEvent[] = [stroke(), flash],
  ): LoopRenderInput => ({
    nodes: [recording(rec)],
    scene: SCENE_LOOK_DEFAULT,
    events,
    frames: 40,
    totalFrames: 40,
    seed: 1,
    dims,
    assets: new Map([['paint:1', blank()]]),
    mutedLayers: new Set(),
    features: null,
    layerLoops: loops,
  });
  const walk = (i: LoopRenderInput) =>
    Array.from({ length: 40 }, (_, f) => renderLoopFrameImage(i, f, 2));

  for (const [name, rec] of [
    ['once / repeat', undefined],
    ['hold', { hold: true }],
    ['backwards', { backwards: true }],
    ['backwards + hold', { backwards: true, hold: true }],
  ] as const) {
    it(`${name}: a frame alone == the same frame in a walk`, () => {
      const i = input(rec);
      const all = walk(i);
      for (const f of [0, 10, 13, 17, 18, 25, 39]) {
        const alone = renderLoopFrameImage(input(rec), f, 2);
        expect(Buffer.from(alone.rgba).equals(Buffer.from(all[f].rgba))).toBe(true);
      }
    });
  }

  it('it never takes the repeat-one-cycle fast path', () => {
    const untimed = { ...recording(), clips: undefined };
    expect(
      fastPathEligible({
        totalFrames: 80,
        frames: 40,
        events: [],
        nodes: [untimed as SceneNode],
        features: null,
        videoFrameCounts: [],
      }),
    ).toBe(false);
  });

  it('never rewrites the base raster (strokes replay onto a copy)', () => {
    const i = input({ hold: true });
    walk(i);
    expect(i.assets.get('paint:1')!.covered.every((v) => v === 0)).toBe(true);
  });
});
describe('the recording flow', () => {
  const setup = async () => {
    const {
      initTake,
      claimLayer,
      markFreshLayer,
      noteTakeFrame,
      noteTakeStamp,
      strokeTarget,
      liveNodes,
    } = await import('../src/ui/take');
    const { layerPosAt } = await import('../src/core/timeline-edit');
    const { useLoopStore, LOOP_META_DEFAULT } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo, redo } = await import('../src/ui/history');
    const { undoTake } = await import('../src/ui/recording-edit');
    (globalThis as { window?: unknown }).window ??= { addEventListener() {} };
    initTake();
    initHistory();
    useLoopStore.setState({
      meta: { ...LOOP_META_DEFAULT },
      events: [],
      layerLoops: {},
      transport: 'stopped',
      recordPass: null,
      part: null,
    });
    useSceneStore.setState({ nodes: [], selected: [] });
    resetHistory();
    const lp = useLoopStore.getState;
    const sc = useSceneStore.getState;
    const node = (id: string) => sc().nodes.find((n) => n.id === id)!;
    const rec = () => {
      lp().beginOverdub();
      return lp().recordPass ?? 0;
    };
    /** Draw `len` frames from song frame `at`: the flow SceneStage runs on a stroke. */
    const draw = (id: string, at: number, len: number, fresh = false) => {
      if (fresh) markFreshLayer(id, at);
      claimLayer(node(id), at, true);
      noteTakeFrame(at);
      noteTakeFrame(at + len);
      // A stroke into a recording it already had, up to the end of this take.
      if (!fresh) {
        const n = liveNodes([node(id)])[0];
        const pos = layerPosAt(n.clips, at + len - 1) ?? at + len - 1;
        noteTakeStamp(id, pos - (lp().layerLoops[id]?.offset ?? 0));
      }
    };
    const event = (id: string, pass: number, eid = `pr-${pass}-${id}`): PaintRevealEvent =>
      stroke({
        id: eid,
        nodeId: id,
        assetId: node(id).assetId,
        pass,
        layer: pass,
      });
    return {
      lp,
      sc,
      node,
      rec,
      draw,
      event,
      strokeTarget,
      liveNodes,
      undoTake,
      undo,
      redo,
    };
  };
  const bpm30 = { bpm: 120, fps: 30 }; // one beat = 15 frames

  it('Free: a new recording plays once; its bar is what was drawn, rounded to the beat', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 100, 62, true); // 62 frames → 60
    t.lp().setTransport('playing');
    expect(t.lp().layerLoops[id]).toMatchObject({ frames: 60, free: true });
    expect(t.lp().layerLoops[id].offset).toBeUndefined();
    expect(t.node(id).clips).toEqual([{ id: `${id}-take`, start: 100, duration: 60, sourceIn: 0 }]);
  });

  it('New recording: set up with Rec off, no bar until its first stroke starts one', async () => {
    const { isEmptyRecording } = await import('../src/ui/take');
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.sc().setLook({ style: 'halftone' });
    expect(isEmptyRecording(t.node(id))).toBe(true);
    expect(t.strokeTarget(100).node?.id).toBe(id);
    // Rec with no stroke leaves it waiting.
    t.rec();
    t.lp().setTransport('playing');
    expect(isEmptyRecording(t.node(id))).toBe(true);
    expect(t.node(id).clips).toBeUndefined();
    t.rec();
    t.draw(id, 100, 62, true);
    expect(isEmptyRecording(t.node(id))).toBe(false); // a later stroke can't move the start
    t.lp().setTransport('playing');
    expect(t.node(id).clips).toEqual([{ id: `${id}-take`, start: 100, duration: 60, sourceIn: 0 }]);
    expect(t.node(id).look).toMatchObject({ style: 'halftone' });
    expect(isEmptyRecording(t.node(id))).toBe(false);
  });

  it('moving the playhead during playback carries on from where it was let go', async () => {
    const t = await setup();
    t.lp().setTransport('playing');
    t.lp().pause(50);
    t.lp().setScrub(120);
    t.lp().setTransport('playing');
    expect(t.lp()).toMatchObject({ transport: 'playing', resumeFrame: 120, scrub: null });
  });

  it('Free from the very start of the video still gets a bar', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 0, 30, true);
    t.lp().setTransport('playing');
    expect(t.node(id).clips?.[0]).toMatchObject({ start: 0, duration: 30 });
  });

  it('a rounded length never cuts off the last stroke', async () => {
    const { noteTakeStamp } = await import('../src/ui/take');
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 100, 62, true); // would round down to 60…
    noteTakeStamp(id, 61); // …but a stamp lands at frame 61
    t.lp().setTransport('playing');
    expect(t.lp().layerLoops[id].frames).toBe(75);
  });

  it('a bar length: the loop is that long and the bar runs to the end of the video', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, bars: 1, lengthMode: 'bars' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 10, 5, true);
    t.lp().setTransport('playing');
    expect(t.lp().layerLoops[id]).toMatchObject({ frames: 60, bars: 1 });
    expect(t.lp().layerLoops[id].free).toBeUndefined();
    expect(t.node(id).clips?.[0].start).toBe(10);
    expect(t.node(id).clips?.[0].duration).toBeGreaterThanOrEqual(60);
  });

  it('a stroke past the end of a Free recording makes it longer, and takes its bar along', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 100, 60, true);
    t.lp().setTransport('playing');
    t.lp().setTransport('stopped');
    t.rec();
    t.draw(id, 130, 90); // from its position 30 to 120
    // Its bar never ends under the live stroke.
    expect(t.liveNodes([t.node(id)])[0].clips?.[0].duration).toBeGreaterThan(1e6);
    t.lp().setTransport('playing');
    expect(t.lp().layerLoops[id].frames).toBe(120);
    expect(t.node(id).clips?.[0]).toMatchObject({ start: 100, duration: 120 });
    expect(t.liveNodes([t.node(id)])[0].clips?.[0].duration).toBe(120);
  });

  it('a shorter take into a Free recording never shortens it', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 100, 60, true);
    t.lp().setTransport('stopped');
    t.rec();
    t.draw(id, 110, 15);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(60);
  });

  it('in a Repeat pass a stroke joins the loop: nothing opens, nothing grows', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 0, 60, true);
    t.lp().setTransport('stopped');
    t.sc().setClips(id, [{ id: 'c', start: 0, duration: 200, sourceIn: 0 }]);
    t.rec();
    t.draw(id, 130, 20); // its second pass
    expect(t.liveNodes([t.node(id)])[0].clips?.[0].duration).toBe(200);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(60);
  });

  it('in the Hold stretch the drawing continues: the drawn part grows, the bar stays', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 0, 60, true);
    t.lp().setTransport('stopped');
    t.sc().setClips(id, [{ id: 'c', start: 0, duration: 200, sourceIn: 0 }]);
    t.sc().setRecordingPlay(id, { hold: true });
    t.rec();
    t.draw(id, 100, 20);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(120);
    expect(t.node(id).clips?.[0].duration).toBe(200);
  });

  it('a bar-loop recording in its Hold stretch grows too, and is no longer that many bars', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, bars: 1, lengthMode: 'bars' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 0, 5, true);
    t.lp().setTransport('stopped');
    t.sc().setClips(id, [{ id: 'c', start: 0, duration: 300, sourceIn: 0 }]);
    t.sc().setRecordingPlay(id, { hold: true });
    t.rec();
    t.draw(id, 150, 30);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id]).toMatchObject({ frames: 180, free: true });
    expect(t.lp().layerLoops[id].bars).toBeUndefined();
  });

  it('where a stroke goes: a picked recording on its bar, else a new one above the pick', async () => {
    const t = await setup();
    const photo = t.sc().addImageNode('img:1', 0, 0);
    const r = t.sc().addRecordingNode('paint:1', 0, 0);
    t.sc().setClips(r, [{ id: 'c', start: 50, duration: 50, sourceIn: 0 }]);
    t.sc().setSelection([r]);
    expect(t.strokeTarget(60).node?.id).toBe(r);
    expect(t.strokeTarget(10)).toEqual({ node: null, above: r }); // off its bar
    t.sc().setSelection([photo]);
    expect(t.strokeTarget(60)).toEqual({ node: null, above: photo });
    t.sc().clearSelection();
    expect(t.strokeTarget(60)).toEqual({ node: null, above: null });
  });

  it('a new recording sits just above the picked layer', async () => {
    const t = await setup();
    const a = t.sc().addImageNode('img:1', 0, 0);
    const b = t.sc().addImageNode('img:2', 0, 0);
    const r = t.sc().addRecordingNode('paint:1', 0, 0, a);
    const order = [...t.sc().nodes].sort((x, y) => x.z - y.z).map((n) => n.id);
    expect(order).toEqual([a, r, b]);
    expect(t.sc().selected).toEqual([r]);
  });

  it('Rec arms even with 12 takes on a recording: the cap is per recording', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().commitEvents(Array.from({ length: 12 }, (_, p) => t.event(id, p)));
    const { takesOn } = await import('../src/state/loop-store');
    expect(takesOn(t.lp().events, id)).toBe(12);
    expect(t.lp().beginOverdub()).not.toBeNull();
    t.lp().setTransport('stopped');
  });

  it('Undo take on the only take removes the row; one general Undo brings both back', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 60, free: true } });
    t.lp().commitEvents([t.event(id, 0)]);
    t.undoTake();
    expect(t.sc().nodes).toHaveLength(0);
    expect(t.lp().events).toHaveLength(0);
    expect(t.lp().layerLoops[id]).toBeUndefined();
    t.undo();
    expect(t.node(id)).toBeTruthy();
    expect(t.lp().events).toHaveLength(1);
    expect(t.lp().layerLoops[id].frames).toBe(60);
    t.redo();
    expect(t.sc().nodes).toHaveLength(0);
    expect(t.lp().events).toHaveLength(0);
  });

  it('Undo take with takes left keeps the row, and shrinks what that take grew', async () => {
    const t = await setup();
    t.lp().setLength({ ...bpm30, lengthMode: 'free' });
    t.rec();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.draw(id, 100, 60, true);
    t.lp().commitEvents([t.event(id, t.lp().recordPass ?? 0)]);
    t.lp().setTransport('stopped');
    const pass = t.rec();
    t.draw(id, 130, 90);
    t.lp().commitEvents([t.event(id, pass, 'pr-second')]);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(120);
    t.undoTake();
    expect(t.node(id)).toBeTruthy();
    expect(t.lp().events).toHaveLength(1);
    expect(t.lp().layerLoops[id].frames).toBe(60);
    expect(t.node(id).clips?.[0].duration).toBe(60);
  });

  it('the stopped Eraser rubs out strokes at every moment, as one Undo step', async () => {
    const { beginRecordingErase, endRecordingErase, eraseRecordingDabs } =
      await import('../src/ui/recording-edit');
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:1', blank());
    const id = t.sc().addRecordingNode('paint:1', W / 2, H / 2);
    t.lp().commitEvents([t.event(id, 0), t.event(id, 1)]);
    const dabs = () =>
      t.lp().events.reduce((m, e) => m + (e.kind === 'paint-reveal' ? e.stamps.length : 0), 0);
    expect(dabs()).toBe(2 * D);
    beginRecordingErase();
    eraseRecordingDabs(t.node(id), 1, 1, 1, 1, 0.5); // the first dab of each take
    eraseRecordingDabs(t.node(id), 3, 1, 3, 1, 0.5); // and the second
    endRecordingErase();
    expect(dabs()).toBe(2 * (D - 2));
    t.undo();
    expect(dabs()).toBe(2 * D);
    t.redo();
    expect(dabs()).toBe(2 * (D - 2));
    t.undo();
    // A take recorded after the rub is left alone by undoing it.
    beginRecordingErase();
    eraseRecordingDabs(t.node(id), 1, 1, 1, 1, 0.5);
    endRecordingErase();
    t.lp().commitEvents([t.event(id, 2)]);
    t.undo();
    expect(t.lp().events).toHaveLength(3);
    expect(dabs()).toBe(3 * D);
  });

  it('the eraser never removes an erase dab', async () => {
    const { stampsAfterRub } = await import('../src/ui/recording-edit');
    const stamps = [dab(0, 1), { ...dab(1, 1), erase: true }];
    expect(stampsAfterRub(stamps, 1, 1, 1, 1, 2)).toEqual([stamps[1]]);
  });

  it('a stroke into a backwards recording is mirrored, so it plays where it was drawn', async () => {
    const { mirroredForBackwards } = await import('../src/ui/recording-edit');
    expect(mirroredForBackwards([dab(1, 1), dab(3, 2)], 8).map((s) => s.frame)).toEqual([4, 6]);
  });

  it('Duplicate gives the copy its own takes and loop', async () => {
    const { copyRecordingTakes } = await import('../src/ui/recording-edit');
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 60, free: true } });
    t.lp().commitEvents([t.event(id, 0)]);
    copyRecordingTakes(id, { id: 'copy', assetId: 'paint:2' });
    const c = t.lp().events.find((e) => e.nodeId === 'copy') as PaintRevealEvent;
    expect(c.assetId).toBe('paint:2');
    expect(c.pass).not.toBe(0);
    expect(t.lp().layerLoops.copy.frames).toBe(60);
    expect(new Set(t.lp().events.map((e) => e.id)).size).toBe(2);
  });
});
describe('drawnEnd: the seam + held stretch on a bar', () => {
  it('a bar that stops at its drawn part has none', () => {
    expect(drawnEnd([clip(10, 8)], { frames: 8 })).toBeNull();
  });
  it('a bar past it: the chip sits at the seam, the stretch runs to the bar end', () => {
    expect(drawnEnd([clip(10, 30)], { frames: 8 })).toEqual({
      at: 18,
      stretches: [{ a: 18, b: 40 }],
    });
  });
  it('a slower bar: the seam is further along', () => {
    const c = { ...clip(10, 30), speed: 0.5 };
    expect(drawnEnd([c], { frames: 8 })?.at).toBe(26);
  });
  it('a split piece past the seam is held all along', () => {
    const a = clip(0, 4);
    const b = { ...clip(20, 10), sourceIn: 12 };
    expect(drawnEnd([a, b], { frames: 8 })?.stretches).toEqual([{ a: 20, b: 30 }]);
  });
});

describe('partFrame: an event on a merged clock', () => {
  const part: EventPart = { at: 10, len: 8, from: 0, rate: 1, frames: 4 };
  it('off its window it is not on screen', () => {
    expect(partFrame(part, 9)).toBeNull();
    expect(partFrame(part, 18)).toBeNull();
  });
  it('in its window it runs + wraps on its own loop', () => {
    expect(partFrame(part, 10)).toEqual({ frame: 0, frames: 4, held: false });
    expect(partFrame(part, 15)).toEqual({ frame: 1, frames: 4, held: false });
  });
  it('hold pins past its loop; back mirrors; back + hold is blank', () => {
    const h = { ...part, hold: true };
    expect(partFrame(h, 15)).toEqual({ frame: 3, frames: 4, held: true });
    expect(partFrame({ ...part, back: true }, 10)?.frame).toBe(3);
    expect(partFrame({ ...h, back: true }, 15)?.frame).toBe(-1);
  });
  it('a part it already had still applies, merged again', () => {
    const inner: EventPart = { at: 2, len: 2, from: 0, rate: 1, frames: 8 };
    const outer: EventPart = { ...part, frames: 100, inner };
    expect(partFrame(outer, 11)).toBeNull(); // inner clock 1: before its window
    expect(partFrame(outer, 12)?.frame).toBe(0);
    expect(partFrame(outer, 13)?.frame).toBe(1);
    expect(partFrame(outer, 14)).toBeNull();
  });
});

describe('Merge keeps the look', () => {
  const T = 60;
  const O = stroke({ id: 'pr-o', nodeId: 'a', assetId: 'paint:a' });
  const Z = stroke({
    id: 'pr-z',
    nodeId: 'b',
    assetId: 'paint:b',
    pass: 7,
    layer: 7,
    stamps: Array.from({ length: D }, (_, k) => dab(k, k * 2 + 1, 5)),
  });
  const layer = (id: string, clips: TimelineClip[], rec?: RecordingPlay): SceneNode => ({
    ...recording(rec, clips),
    id,
    assetId: `paint:${id}`,
  });
  const side = (n: SceneNode, loop: LayerLoop, events: PaintRevealEvent[]): MergeSide => ({
    id: n.id,
    assetId: n.assetId,
    clips: n.clips,
    loop,
    rec: n.rec,
    placement: n.placement,
    raster: { w: W, h: H },
    events,
  });
  /** What's lit on the O row + Z row at a song frame. */
  const lit = (
    nodes: SceneNode[],
    events: PaintRevealEvent[],
    layerLoops: Record<string, LayerLoop>,
    abs: number,
  ) => {
    const assets = new Map(nodes.map((n) => [n.assetId, blank()] as const));
    const ev = evaluateScene(nodes, SCENE_LOOK_DEFAULT, events, 0, T, null, makeRng(1), new Set(), {
      absFrame: abs,
      layerLoops,
    });
    const shown = new Set(ev.nodes.map((n) => n.assetId));
    const out = applyPaintReveal(assets, events, 0, T, new Set(), null, (id) => ev.clocks.get(id));
    const count = (y: number) => {
      let n = 0;
      for (const id of shown) {
        const a = out.get(id)!;
        for (let x = 0; x < W; x++) if (a.covered[y * W + x]) n++;
      }
      return n;
    };
    return [count(1), count(5)];
  };

  it('first one repeats: every frame looks the same as the two did apart', () => {
    const a = layer('a', [clip(0, T)]);
    const b = layer('b', [clip(20, 15)]); // plays once, a W from 20 to 28, then shown to 35
    const la: LayerLoop = { frames: D };
    const lb: LayerLoop = { frames: 15, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, lb, [Z]), T, T, 7);
    expect(m.clip).toMatchObject({ start: 0, duration: T });
    expect(m.loop).toEqual({ frames: T, free: true });
    expect(m.rec).toEqual({ motionLoop: { frames: D, at: 0 } }); // Repeats, forwards
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    for (let f = 0; f < T; f++)
      expect(lit([merged], events, { a: m.loop }, f)).toEqual(
        lit([a, b], [O, Z], { a: la, b: lb }, f),
      );
    expect(m.joined.every((e) => e.nodeId === 'a')).toBe(true);
    expect((m.joined[0] as PaintRevealEvent).assetId).toBe('paint:a');
    expect(m.joined[0].pass).toBe(8);
  });

  it('a gap stays a gap', () => {
    const a = layer('a', [clip(0, 8)]);
    const b = layer('b', [clip(30, 8)]);
    const la: LayerLoop = { frames: 8, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, la, [Z]), T, T, 7);
    expect(m.clip).toMatchObject({ start: 0, duration: 38 });
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    for (let f = 0; f < 38; f++)
      expect(lit([merged], events, { a: m.loop }, f)).toEqual(
        lit([a, b], [O, Z], { a: la, b: la }, f),
      );
    expect(lit([merged], events, { a: m.loop }, 20)).toEqual([0, 0]);
  });

  it('a bar starting after the other: the merged bar starts at the earliest', () => {
    const a = layer('a', [clip(30, 10)]);
    const b = layer('b', [clip(5, 10)]);
    const la: LayerLoop = { frames: 10, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, la, [Z]), T, T, 7);
    expect(m.clip).toMatchObject({ start: 5, duration: 35 });
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    for (let f = 5; f < 40; f++)
      expect(lit([merged], events, { a: m.loop }, f)).toEqual(
        lit([a, b], [O, Z], { a: la, b: la }, f),
      );
  });

  it('a slower bar and a backwards one still look the same', () => {
    const a = layer('a', [{ ...clip(0, 40), speed: 0.5 }]);
    const b = layer('b', [clip(10, 20)], { backwards: true });
    const la: LayerLoop = { frames: D };
    const lb: LayerLoop = { frames: 8 };
    const m = mergeRecordings(side(a, la, [O]), side(b, lb, [Z]), T, T, 7);
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    for (let f = 0; f < 40; f++)
      expect(lit([merged], events, { a: m.loop }, f)).toEqual(
        lit([a, b], [O, Z], { a: la, b: lb }, f),
      );
  });

  it('first one holds: the other draws in when it was drawn, the drawn part grows, both stay', () => {
    const a = layer('a', [clip(0, 50)], { hold: true });
    const b = layer('b', [clip(30, 8)]);
    const la: LayerLoop = { frames: 8, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, la, [Z]), T, T, 7);
    expect(m.clip).toMatchObject({ start: 0, duration: 50 });
    expect(m.loop.frames).toBe(38); // the drawn part reaches the end of the W
    expect(m.rec.hold).toBe(true);
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    const at = (f: number) => lit([merged], events, { a: m.loop }, f);
    expect(at(4)).toEqual([expect.any(Number), 0]);
    expect(at(29)[1]).toBe(0); // not yet
    expect(at(33)[1]).toBeGreaterThan(0); // drawing in
    expect(at(33)[1]).toBeLessThan(at(37)[1]);
    expect(at(49)).toEqual(at(37)); // both held to the end of the bar
    expect(at(7)[0]).toBe(at(49)[0]); // the O stayed
  });

  it('first one holds, the other past its bar: the bar reaches the end of its drawing', () => {
    const a = layer('a', [clip(0, 20)], { hold: true });
    const b = layer('b', [clip(30, 40)]); // a loop: only its first pass joins the hold
    const m = mergeRecordings(side(a, { frames: 8 }, [O]), side(b, { frames: 8 }, [Z]), T, T, 7);
    expect(m.loop.frames).toBe(38);
    expect(m.clip.duration).toBe(38);
  });

  it('second one holds: its hold does not come along', () => {
    const a = layer('a', [clip(0, T)]);
    const b = layer('b', [clip(20, 30)], { hold: true }); // drawn 20-28, held to 50
    const la: LayerLoop = { frames: D };
    const lb: LayerLoop = { frames: 8, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, lb, [Z]), T, T, 7);
    const merged: SceneNode = { ...a, clips: [m.clip], rec: m.rec };
    const events = [...m.into, ...m.joined] as PaintRevealEvent[];
    const at = (f: number) => lit([merged], events, { a: m.loop }, f)[1];
    expect(at(27)).toBeGreaterThan(0);
    expect(at(28)).toBe(0); // gone where its drawing ended, not at 50
    expect(at(49)).toBe(0);
  });

  it('merged again: the parts it already had still apply', () => {
    const a = layer('a', [clip(0, T)]);
    const b = layer('b', [clip(20, 15)]);
    const c = layer('c', [clip(40, 10)]);
    const la: LayerLoop = { frames: D };
    const lb: LayerLoop = { frames: 15, free: true };
    const lc: LayerLoop = { frames: 10, free: true };
    const Y = stroke({
      id: 'pr-y',
      nodeId: 'c',
      assetId: 'paint:c',
      pass: 9,
      layer: 9,
      stamps: Array.from({ length: D }, (_, k) => dab(k, k * 2 + 1, 5)),
    });
    const m1 = mergeRecordings(side(a, la, [O]), side(b, lb, [Z]), T, T, 9);
    const a1: SceneNode = { ...a, clips: [m1.clip], rec: m1.rec };
    const e1 = [...m1.into, ...m1.joined] as PaintRevealEvent[];
    const m2 = mergeRecordings(side(a1, m1.loop, e1), side(c, lc, [Y]), T, T, 11);
    const merged: SceneNode = { ...a, clips: [m2.clip], rec: m2.rec };
    const events = [...m2.into, ...m2.joined] as PaintRevealEvent[];
    for (let f = 0; f < T; f++)
      expect(lit([merged], events, { a: m2.loop }, f)).toEqual(
        lit([a, b, c], [O, Z, Y], { a: la, b: lb, c: lc }, f),
      );
  });

  it('a moved recording: its strokes land in the same place on the canvas', () => {
    const a = layer('a', [clip(0, 10)]);
    const b = {
      ...layer('b', [clip(0, 10)]),
      placement: { ...a.placement, x: a.placement.x + 3 },
    };
    const la: LayerLoop = { frames: 10, free: true };
    const m = mergeRecordings(side(a, la, [O]), side(b, la, [Z]), T, T, 7);
    const s = (m.joined[0] as PaintRevealEvent).stamps[0];
    expect(s.x).toBe(Z.stamps[0].x + 3);
    expect(s.y).toBe(Z.stamps[0].y);
  });

  it('its hand moves and effects stay behind', () => {
    const a = layer('a', [clip(0, 10)]);
    const b = layer('b', [clip(0, 10)]);
    const move: TimedEvent = {
      id: 'op',
      kind: 'object-static',
      nodeId: 'b',
      pass: 7,
      layer: 7,
      startFrame: 0,
      endFrame: 9,
      placement: a.placement,
    };
    const la: LayerLoop = { frames: 10, free: true };
    const m = mergeRecordings(side(a, la, []), { ...side(b, la, [Z]), events: [Z, move] }, T, T, 7);
    expect(m.joined.map((e) => e.id)).toEqual(['pr-z']);
  });

  it('a merge in the app is one Undo step, and undoes exactly', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo, redo } = await import('../src/ui/history');
    const { mergeRecordingInto } = await import('../src/ui/recording-edit');
    const { setAsset } = await import('../src/ui/scene-assets');
    initHistory();
    useSceneStore.setState({ nodes: [], selected: [] });
    useLoopStore.setState({ events: [], layerLoops: {} });
    resetHistory();
    setAsset('paint:a', blank());
    setAsset('paint:b', blank());
    const s = useSceneStore.getState;
    const lp = useLoopStore.getState;
    const a = s().addRecordingNode('paint:a', W / 2, H / 2);
    const b = s().addRecordingNode('paint:b', W / 2, H / 2);
    s().setClips(a, [clip(0, 20)]);
    s().setClips(b, [clip(10, 20)]);
    lp().setLayerLoops({ [a]: { frames: 8 }, [b]: { frames: 20, free: true } });
    lp().commitEvents([
      { ...O, nodeId: a },
      { ...Z, nodeId: b, assetId: 'paint:b' },
    ]);
    const before = {
      events: lp().events,
      loops: lp().layerLoops,
      nodes: s().nodes.map((n) => n.id),
      clips: s().nodes.find((n) => n.id === a)?.clips,
    };
    mergeRecordingInto(a, b);
    expect(s().nodes.map((n) => n.id)).toEqual([a]);
    expect(s().selected).toEqual([a]);
    expect(lp().events.every((e) => e.nodeId === a)).toBe(true);
    expect(lp().layerLoops[b]).toBeUndefined();
    const after = lp().events;
    undo();
    expect(lp().events).toEqual(before.events);
    expect(lp().layerLoops).toEqual(before.loops);
    expect(
      s()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual([...before.nodes].sort());
    expect(s().nodes.find((n) => n.id === a)?.clips).toEqual(before.clips);
    redo();
    expect(lp().events).toEqual(after);
    expect(s().nodes.map((n) => n.id)).toEqual([a]);
  });
});

describe('Keep as drawing', () => {
  const setup = async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo } = await import('../src/ui/history');
    const { keepAsDrawing, finishedPicture } = await import('../src/ui/recording-edit');
    const { setAsset, getAssetCache } = await import('../src/ui/scene-assets');
    initHistory();
    useSceneStore.setState({ nodes: [], selected: [] });
    useLoopStore.setState({ events: [], layerLoops: {}, mutedLayers: [] });
    resetHistory();
    setAsset('paint:9', blank());
    const s = useSceneStore.getState;
    const lp = useLoopStore.getState;
    const id = s().addRecordingNode('paint:9', W / 2, H / 2);
    lp().setLayerLoops({ [id]: { frames: 8, free: true } });
    lp().commitEvents([
      stroke({ nodeId: id, assetId: 'paint:9' }),
      stroke({
        id: 'pr-f',
        nodeId: id,
        assetId: 'paint:9',
        holdFrames: 4,
        stamps: [dab(0, 3, 5)],
      }),
    ]);
    return { s, lp, id, keepAsDrawing, finishedPicture, undo, getAssetCache };
  };

  it('starts where it finishes, runs to the end of the video, just above it', async () => {
    const t = await setup();
    t.s().setClips(t.id, [clip(30, 8)]);
    t.keepAsDrawing(t.id);
    const nodes = [...t.s().nodes].sort((a, b) => a.z - b.z);
    expect(nodes.map((n) => n.kind)).toEqual(['recording', 'paint']);
    const clips = nodes[1].clips!;
    expect(clips[0].start).toBe(38); // the bar stops where its drawing does: there is no seam…
    expect(clips[0].duration).toBeGreaterThan(0); // …and the drawing still gets a bar
    expect(t.s().selected).toEqual([nodes[1].id]);
    t.undo();
    expect(t.s().nodes.map((n) => n.kind)).toEqual(['recording']);
  });

  it('with its bar dragged longer it starts at the seam', async () => {
    const t = await setup();
    t.s().setClips(t.id, [clip(30, 30)]);
    t.keepAsDrawing(t.id);
    const d = t.s().nodes.find((n) => n.kind === 'paint')!;
    expect(d.clips![0].start).toBe(38);
  });

  it('Play backwards: the mirror, from the start of the video to where it starts', async () => {
    const t = await setup();
    t.s().setClips(t.id, [clip(30, 8)]);
    t.s().setRecordingPlay(t.id, { backwards: true });
    t.keepAsDrawing(t.id);
    const d = t.s().nodes.find((n) => n.kind === 'paint')!;
    expect(d.clips).toEqual([{ id: `${d.id}-kept`, start: 0, duration: 30, sourceIn: 0 }]);
  });

  it('the picture: lasting strokes of the unmuted takes, no flashes', async () => {
    const t = await setup();
    const n = t.s().nodes[0];
    const pic = t.finishedPicture(n)!;
    expect(pic.covered[1 * W + 1]).toBe(1);
    expect(pic.covered[5 * W + 3]).toBe(0);
    t.lp().toggleMute(1);
    expect(t.finishedPicture(n)!.covered[1 * W + 1]).toBe(0);
    t.lp().toggleMute(1);
    expect(
      t
        .getAssetCache()
        .get('paint:9')!
        .covered.every((v) => v === 0),
    ).toBe(true);
  });
});
describe('review regressions', () => {
  const setup = async () => {
    const take = await import('../src/ui/take');
    const { useLoopStore, LOOP_META_DEFAULT } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo } = await import('../src/ui/history');
    const edit = await import('../src/ui/recording-edit');
    (globalThis as { window?: unknown }).window ??= { addEventListener() {} };
    take.initTake();
    initHistory();
    useLoopStore.setState({
      meta: { ...LOOP_META_DEFAULT, bpm: 120, fps: 30, lengthMode: 'free' },
      events: [],
      layerLoops: {},
      mutedLayers: [],
      transport: 'stopped',
      recordPass: null,
      part: null,
    });
    useSceneStore.setState({ nodes: [], selected: [] });
    resetHistory();
    return {
      ...take,
      ...edit,
      undo,
      lp: useLoopStore.getState,
      sc: useSceneStore.getState,
      store: useLoopStore,
    };
  };

  it('Undo take never restores a growth from an older take with the same pass number', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 30, free: true } });
    t.sc().setClips(id, [clip(0, 30)]);
    t.lp().beginOverdub();
    const pass = t.lp().recordPass ?? 0;
    t.claimLayer(t.sc().nodes[0], 10, true);
    t.noteTakeFrame(10);
    t.noteTakeFrame(70);
    t.noteTakeStamp(id, 69);
    t.lp().commitEvents([stroke({ id: 'pr-a', nodeId: id, pass, layer: pass })]);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(75);
    // Another project (or an edit) changes its loop: the old growth no longer applies.
    t.lp().setLayerLoops({ [id]: { frames: 40, free: true } });
    t.lp().commitEvents([stroke({ id: 'pr-b', nodeId: id, pass: pass - 1, layer: pass - 1 })]);
    t.undoTake(id);
    expect(t.lp().layerLoops[id].frames).toBe(40);
  });

  it('growing a split piece stops at the next piece', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 30, free: true } });
    const a = clip(0, 20);
    const b = { ...clip(40, 10), sourceIn: 20 };
    t.sc().setClips(id, [a, b]);
    t.lp().beginOverdub();
    t.claimLayer(t.sc().nodes[0], 10, true);
    t.noteTakeFrame(10);
    t.noteTakeFrame(100);
    t.noteTakeStamp(id, 99);
    t.lp().setTransport('stopped');
    const clips = t.sc().nodes[0].clips!;
    expect(clips[0].duration).toBe(40); // up to the next piece, no further
    expect(clips[1].start).toBe(40);
  });

  it('a muted take stays muted through Merge and Duplicate', async () => {
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:a', blank());
    setAsset('paint:b', blank());
    const a = t.sc().addRecordingNode('paint:a', W / 2, H / 2);
    const b = t.sc().addRecordingNode('paint:b', W / 2, H / 2);
    t.sc().setClips(a, [clip(0, 20)]);
    t.sc().setClips(b, [clip(0, 20)]);
    t.lp().setLayerLoops({
      [a]: { frames: 20, free: true },
      [b]: { frames: 20, free: true },
    });
    t.lp().commitEvents([
      stroke({ id: 'pr-1', nodeId: a, assetId: 'paint:a', pass: 0, layer: 0 }),
      stroke({ id: 'pr-2', nodeId: b, assetId: 'paint:b', pass: 1, layer: 1 }),
    ]);
    t.lp().toggleMute(1);
    t.copyRecordingTakes(b, { id: 'copy', assetId: 'paint:b' });
    const copied = t.lp().events.find((e) => e.nodeId === 'copy')!;
    expect(t.lp().mutedLayers).toContain(copied.layer);
    t.mergeRecordingInto(a, b);
    const joined = t.lp().events.find((e) => e.id === 'pr-2')!;
    expect(joined.nodeId).toBe(a);
    expect(joined.layer).not.toBe(1);
    expect(t.lp().mutedLayers).toContain(joined.layer);
  });

  it('Keep as drawing on a recording with no bar starts where it finishes', async () => {
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:9', blank());
    const id = t.sc().addRecordingNode('paint:9', W / 2, H / 2);
    t.lp().setLayerLoops({ [id]: { frames: 8, free: true } });
    t.lp().commitEvents([stroke({ nodeId: id, assetId: 'paint:9' })]);
    t.keepAsDrawing(id);
    expect(t.sc().nodes.find((n) => n.kind === 'paint')?.clips?.[0].start).toBe(8);
  });

  it('a saved muted take comes back muted', async () => {
    const t = await setup();
    const { useSceneStore } = await import('../src/state/scene-store');
    useSceneStore.setState({ pixel: 2.5 });
    const data: RecordingElementData = {
      events: [stroke({ pass: 3, layer: 3 })],
      muted: [3],
      loop: { frames: D, free: true },
      clips: [clip(0, D)],
      layer: {
        look: {},
        opacity: 100,
        placement: { x: W / 2, y: H / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 },
        crop: null,
        motion: null,
        window: { x: 0, y: 0, w: W, h: H },
      },
      canvas: { w: W, h: H },
    };
    const { record } = await buildRecordingElement({
      data,
      png: new Uint8Array([1]),
      thumbnail: 'x',
      w: W,
      h: H,
      aspect: 'landscape',
      cell: 5,
      palette: 'two',
      matrix: 8,
      fps: 30,
      createdAt: 1,
    });
    const id = t.placeRecording(record, data);
    const e = t.lp().events.find((x) => x.nodeId === id)!;
    expect(t.lp().mutedLayers).toContain(e.layer);
    // Its window scales with it (Pixel 5 → 2.5 = twice the squares).
    expect(t.sc().nodes.find((n) => n.id === id)?.window?.w).toBe(W * 2);
  });
});
describe('a saved recording', () => {
  const data: RecordingElementData = {
    events: [stroke({ nodeId: 'r', assetId: 'paint:1', pass: 3, layer: 3 })],
    loop: { frames: D, free: true },
    clips: [clip(0, 20)],
    layer: {
      look: { dotSize: 7 },
      opacity: 60,
      placement: { x: W / 2, y: H / 2, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      crop: null,
      motion: null,
      rec: { hold: true, backwards: true },
    },
    canvas: { w: W, h: H },
  };
  const build = () =>
    buildRecordingElement({
      data,
      png: new Uint8Array([1, 2, 3]),
      thumbnail: 'data:image/png;base64,AA==',
      w: W,
      h: H,
      aspect: 'landscape',
      cell: 2.5,
      palette: 'two',
      matrix: 8,
      fps: 30,
      createdAt: 1,
      name: 'Recording 1',
    });

  it('an identical save has the same id; different strokes do not', async () => {
    const a = await build();
    const b = await build();
    expect(a.record.id).toBe(b.record.id);
    const c = await buildRecordingElement({
      data: { ...data, loop: { frames: D + 1, free: true } },
      png: new Uint8Array([1, 2, 3]),
      thumbnail: 'x',
      w: W,
      h: H,
      aspect: 'landscape',
      cell: 2.5,
      palette: 'two',
      matrix: 8,
      fps: 30,
      createdAt: 1,
    });
    expect(c.record.id).not.toBe(a.record.id);
    expect(a.record.frames).toBe(20);
  });

  it('its blobs are named by the record, so they save, bundle and clean up together', async () => {
    const { record, blobs } = await build();
    expect(referencedHashes(record).sort()).toEqual(blobs.map((b) => b.hash).sort());
    expect(orphanHashes(record, [])).toHaveLength(2);
  });

  it('the element file round-trips a recording, and rejects a tampered one', async () => {
    const built = await build();
    const text = encodeElementFile(built);
    const back = await parseAnyElementFile(text);
    expect(back.record).toEqual(built.record);
    const json = JSON.parse(text);
    json.record.frames = 1;
    json.record.dataHash = 'f'.repeat(64);
    await expect(parseAnyElementFile(JSON.stringify(json))).rejects.toThrow(/does not carry/);
  });

  it('placing it: a recording again, on top, with its takes its own, bar at the start', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo, redo } = await import('../src/ui/history');
    const { placeRecording } = await import('../src/ui/recording-edit');
    initHistory();
    useSceneStore.setState({ nodes: [], selected: [], pixel: 2.5 });
    useLoopStore.setState({ events: [], layerLoops: {} });
    resetHistory();
    const s = useSceneStore.getState;
    const lp = useLoopStore.getState;
    const photo = s().addImageNode('img:1', 0, 0);
    const { record } = await build();
    const id = placeRecording(record, data);
    const n = s().nodes.find((x) => x.id === id)!;
    expect(n.kind).toBe('recording');
    expect(n.z).toBeGreaterThan(s().nodes.find((x) => x.id === photo)!.z);
    expect(n.look.dotSize).toBe(7);
    expect(n.opacity).toBe(60);
    expect(n.rec).toEqual({ hold: true, backwards: true });
    expect(n.clips?.[0].start).toBe(0);
    expect(n.clips?.[0].duration).toBe(20);
    expect(lp().layerLoops[id]).toEqual({ frames: D, free: true });
    const e = lp().events[0] as PaintRevealEvent;
    expect(e.nodeId).toBe(id);
    expect(e.assetId).toBe(n.assetId);
    expect(e.stamps).toEqual(stroke().stamps);
    expect(s().selected).toEqual([id]);

    undo();
    expect(s().nodes.map((x) => x.id)).toEqual([photo]);
    expect(lp().events).toHaveLength(0);
    expect(lp().layerLoops[id]).toBeUndefined();
    redo();
    expect(s().nodes).toHaveLength(2);
    expect(lp().events).toHaveLength(1);
  });

  it('placing it twice: two recordings with separate takes', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { placeRecording } = await import('../src/ui/recording-edit');
    useSceneStore.setState({ nodes: [], selected: [], pixel: 2.5 });
    useLoopStore.setState({ events: [], layerLoops: {} });
    const { record } = await build();
    const a = placeRecording(record, data);
    const b = placeRecording(record, data);
    const ev = useLoopStore.getState().events;
    expect(ev.find((e) => e.nodeId === a)?.pass).not.toBe(ev.find((e) => e.nodeId === b)?.pass);
    expect(new Set(ev.map((e) => e.id)).size).toBe(2);
  });

  it('a bar-length recording runs to the end of the video', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { placeRecording } = await import('../src/ui/recording-edit');
    useSceneStore.setState({ nodes: [], selected: [], pixel: 2.5 });
    useLoopStore.setState({ events: [], layerLoops: {} });
    const { record } = await build();
    const id = placeRecording(record, {
      ...data,
      loop: { frames: D, bars: 1 },
    });
    const n = useSceneStore.getState().nodes.find((x) => x.id === id)!;
    expect(n.clips?.[0].duration).toBeGreaterThanOrEqual(20);
  });

  it('placed on a canvas at another Pixel, its strokes keep their size', async () => {
    const { useLoopStore } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { placeRecording } = await import('../src/ui/recording-edit');
    useSceneStore.setState({ nodes: [], selected: [], pixel: 5 });
    useLoopStore.setState({ events: [], layerLoops: {} });
    const { record } = await build();
    const id = placeRecording(record, data);
    const n = useSceneStore.getState().nodes.find((x) => x.id === id)!;
    expect(n.placement.scaleX).toBe(0.5);
    useSceneStore.setState({ pixel: 2.5 });
  });
});
describe('adversarial review regressions', () => {
  const setup = async () => {
    const take = await import('../src/ui/take');
    const { useLoopStore, LOOP_META_DEFAULT } = await import('../src/state/loop-store');
    const { useSceneStore } = await import('../src/state/scene-store');
    const { initHistory, resetHistory, undo } = await import('../src/ui/history');
    const edit = await import('../src/ui/recording-edit');
    (globalThis as { window?: unknown }).window ??= { addEventListener() {} };
    take.initTake();
    initHistory();
    useLoopStore.setState({
      meta: { ...LOOP_META_DEFAULT, bpm: 120, fps: 30, lengthMode: 'free' },
      events: [],
      layerLoops: {},
      mutedLayers: [],
      transport: 'stopped',
      recordPass: null,
      part: null,
    });
    useSceneStore.setState({ nodes: [], selected: [] });
    resetHistory();
    return {
      ...take,
      ...edit,
      undo,
      lp: useLoopStore.getState,
      sc: useSceneStore.getState,
    };
  };

  it('a stroke inside a Free recording, then waiting past its end, does not make it longer', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 60, free: true } });
    t.sc().setClips(id, [clip(0, 60)]);
    t.lp().beginOverdub();
    t.claimLayer(t.sc().nodes[0], 10, true);
    t.noteTakeStamp(id, 20);
    t.noteTakeFrame(10);
    t.noteTakeFrame(200);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(60);
    expect(t.sc().nodes[0].clips?.[0].duration).toBe(60);
  });

  it('a new Free recording still runs to the Rec press, past its last stroke', async () => {
    const t = await setup();
    t.lp().beginOverdub();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.markFreshLayer(id, 0);
    t.claimLayer(t.sc().nodes[0], 0, true);
    t.noteTakeStamp(id, 30);
    t.noteTakeFrame(0);
    t.noteTakeFrame(210);
    t.lp().setTransport('stopped');
    expect(t.lp().layerLoops[id].frames).toBe(210);
  });

  it('a take ends at the wrap when the loop is as long as the video (Track, then Free)', async () => {
    const t = await setup();
    t.lp().setLength({ frames: 90 });
    t.lp().setLength({ lengthMode: 'free' });
    t.lp().setPart({ start: 0, end: 90 }); // a video exactly the loop long
    t.lp().beginOverdub();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.markFreshLayer(id, 40);
    t.claimLayer(t.sc().nodes[0], 40, true);
    t.noteTakeFrame(40);
    t.noteTakeFrame(89);
    t.noteTakeFrame(0); // back to the top
    expect(t.lp().transport).toBe('playing');
    t.lp().setTransport('stopped');
  });

  it('the first plain Undo after a take removes the row, never just its bar', async () => {
    const t = await setup();
    t.lp().beginOverdub();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.markFreshLayer(id, 30);
    t.claimLayer(t.sc().nodes[0], 30, true);
    t.noteTakeFrame(30);
    t.noteTakeFrame(60);
    t.lp().setTransport('stopped');
    expect(t.sc().nodes[0].clips?.[0].start).toBe(30);
    t.undo();
    expect(t.sc().nodes).toHaveLength(0);
  });

  it('Undo take skips a take of a layer that is gone', async () => {
    const t = await setup();
    const a = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().commitEvents([
      stroke({ id: 'pr-a', nodeId: a, pass: 0, layer: 0 }),
      stroke({ id: 'pr-dead', nodeId: 'gone', pass: 5, layer: 5 }),
      stroke({ id: 'pr-a2', nodeId: a, pass: 1, layer: 1 }),
    ]);
    t.undoTake();
    expect(
      t
        .lp()
        .events.map((e) => e.id)
        .sort(),
    ).toEqual(['pr-a', 'pr-dead']);
  });

  it('Undo take is undone by Undo, in order, with a rub before it', async () => {
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:1', blank());
    const id = t.sc().addRecordingNode('paint:1', W / 2, H / 2);
    t.lp().commitEvents([
      stroke({ id: 'pr-a', nodeId: id, pass: 0, layer: 0 }),
      stroke({ id: 'pr-b', nodeId: id, pass: 1, layer: 1 }),
    ]);
    t.beginRecordingErase();
    t.eraseRecordingDabs(t.sc().nodes[0], 1, 1, 1, 1, 0.5);
    t.endRecordingErase();
    t.undoTake(id); // removes take 1
    expect(t.lp().events.map((e) => e.id)).toEqual(['pr-a']);
    t.undo(); // back comes take 1, as rubbed
    expect(t.lp().events.map((e) => e.id)).toEqual(['pr-a', 'pr-b']);
    t.undo(); // the rub
    const b = t.lp().events[1] as PaintRevealEvent;
    expect(b.stamps).toHaveLength(D);
  });

  it('Undo take leaves a bar you dragged since alone', async () => {
    const t = await setup();
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 30, free: true } });
    t.sc().setClips(id, [clip(0, 30)]);
    t.lp().beginOverdub();
    const pass = t.lp().recordPass ?? 0;
    t.claimLayer(t.sc().nodes[0], 10, true);
    t.noteTakeFrame(10);
    t.noteTakeFrame(70);
    t.noteTakeStamp(id, 69);
    t.lp().commitEvents([stroke({ id: 'pr-g', nodeId: id, pass, layer: pass })]);
    t.lp().setTransport('stopped');
    t.sc().setClips(id, [clip(0, 200)]);
    t.lp().commitEvents([stroke({ id: 'pr-0', nodeId: id, pass: pass - 1, layer: pass - 1 })]);
    t.undoTake(id);
    expect(t.sc().nodes[0].clips?.[0].duration).toBe(200);
    expect(t.lp().layerLoops[id].frames).toBe(30);
  });

  it('a new take is never muted by a stale mute on its number', async () => {
    const t = await setup();
    t.lp().toggleMute(0);
    t.lp().beginOverdub();
    expect(t.lp().mutedLayers).not.toContain(t.lp().recordPass);
    t.lp().setTransport('stopped');
  });

  it('merged, split and merged again: event ids stay unique', () => {
    const O = stroke({
      id: 'pr-5',
      nodeId: 'a',
      assetId: 'paint:a',
      pass: 0,
      layer: 0,
    });
    const side = (id: string, clips: TimelineClip[], events: PaintRevealEvent[]): MergeSide => ({
      id,
      assetId: `paint:${id}`,
      clips,
      loop: { frames: 10, free: true },
      placement: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 },
      raster: { w: W, h: H },
      events,
    });
    const m1 = mergeRecordings(
      side('a', [clip(0, 10), clip(20, 10)], [O]),
      side('b', [clip(40, 10)], []),
      40,
      60,
      0,
    );
    expect(m1.into.map((e) => e.id)).toEqual(['pr-5', 'pr-5.1']);
    const m2 = mergeRecordings(
      side('a', [clip(0, 10), clip(20, 10)], m1.into as PaintRevealEvent[]),
      side('b', [clip(40, 10)], []),
      40,
      60,
      0,
    );
    const ids = m2.into.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('a Motion keeps its speed after a merge lengthens the loop', () => {
    const motion = {
      type: 'bob',
      cycles: 1,
      amp: 5,
      ax: 0,
      ay: 1,
      phase0: 0,
    } as const;
    const a = { ...recording(undefined, [clip(0, 80)]), motion };
    const yAt = (n: SceneNode, loop: LayerLoop, abs: number) =>
      evaluateScene([n], SCENE_LOOK_DEFAULT, [], abs % 40, 40, null, makeRng(1), new Set(), {
        absFrame: abs,
        layerLoops: { r: loop },
      }).nodes[0].placement.y;
    const merged: SceneNode = {
      ...a,
      rec: { motionLoop: { frames: 8, at: 0 } },
    };
    for (const f of [0, 3, 9, 25, 70])
      expect(yAt(merged, { frames: 80, free: true }, f)).toBeCloseTo(yAt(a, { frames: 8 }, f), 6);
  });

  it('the kept drawing stands where the recording does, with its Look', async () => {
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:7', blank());
    const id = t.sc().addRecordingNode('paint:7', W / 2, H / 2);
    t.lp().setLayerLoops({ [id]: { frames: 8, free: true } });
    t.sc().setClips(id, [clip(0, 8)]);
    t.lp().commitEvents([stroke({ nodeId: id, assetId: 'paint:7' })]);
    const moved = { x: 3, y: 4, scaleX: 2, scaleY: 2, rotationDeg: 30 };
    t.sc().setPlacement(id, moved);
    t.sc().setOpacity([id], 40);
    t.keepAsDrawing(id);
    const d = t.sc().nodes.find((n) => n.kind === 'paint')!;
    expect(d.placement).toEqual(moved);
    expect(d.opacity).toBe(40);
  });

  it('the finished picture of a merged recording is its last moment, as Hold shows it', async () => {
    const { setAsset } = await import('../src/ui/scene-assets');
    const t = await setup();
    setAsset('paint:8', blank());
    const id = t.sc().addRecordingNode('paint:8', W / 2, H / 2);
    t.lp().setLayerLoops({ [id]: { frames: 30, free: true } });
    const part: EventPart = { at: 0, len: 8, from: 0, rate: 1, frames: 8 };
    t.lp().commitEvents([stroke({ nodeId: id, assetId: 'paint:8', part })]); // gone by frame 8
    expect(t.finishedPicture(t.sc().nodes[0])!.covered.every((v) => v === 0)).toBe(true);
  });

  it('Clear removes the recording rows with the takes, and one Undo brings them back', async () => {
    const t = await setup();
    const photo = t.sc().addImageNode('img:1', 0, 0);
    const id = t.sc().addRecordingNode('paint:1', 0, 0);
    t.lp().setLayerLoops({ [id]: { frames: 60, free: true } });
    t.lp().commitEvents([stroke({ id: 'pr-c', nodeId: id })]);
    t.clearTakes();
    expect(t.sc().nodes.map((n) => n.id)).toEqual([photo]);
    expect(t.lp().events).toHaveLength(0);
    expect(t.lp().layerLoops).toEqual({});
    t.undo();
    expect(t.sc().nodes.map((n) => n.id)).toEqual([photo, id]);
    expect(t.lp().events.map((e) => e.id)).toEqual(['pr-c']);
    expect(t.lp().layerLoops[id].frames).toBe(60);
  });

  it('Clear with no recording is the plain clear: other layers stay, no Undo step', async () => {
    const t = await setup();
    const photo = t.sc().addImageNode('img:1', 0, 0);
    t.lp().commitEvents([
      {
        id: 'op',
        kind: 'object-static',
        nodeId: photo,
        pass: 0,
        layer: 0,
        startFrame: 0,
        endFrame: 1,
        placement: t.sc().nodes[0].placement,
      },
    ]);
    t.clearTakes();
    expect(t.sc().nodes).toHaveLength(1);
    expect(t.lp().events).toHaveLength(0);
  });

  it('a tampered recording file with missing numbers is refused', async () => {
    const built = await buildRecordingElement({
      data: {
        events: [],
        loop: { frames: 8, free: true },
        clips: [clip(0, 8)],
        layer: {
          look: {},
          opacity: 100,
          placement: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 },
          crop: null,
          motion: null,
        },
        canvas: { w: W, h: H },
      },
      png: new Uint8Array([1]),
      thumbnail: 'data:image/png;base64,AA==',
      w: W,
      h: H,
      aspect: 'landscape',
      cell: 2.5,
      palette: 'two',
      matrix: 8,
      fps: 30,
      createdAt: 1,
    });
    const json = JSON.parse(encodeElementFile(built));
    json.record.cell = 'lots';
    await expect(parseAnyElementFile(JSON.stringify(json))).rejects.toThrow(/bad recording/);
  });
});
