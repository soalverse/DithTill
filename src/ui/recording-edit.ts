// =============================================================================
// Recordings: the edits on a recording's strokes. A recording IS its strokes (timed
// events in the loop store, keyed to its node), so these edit the event log, each as ONE undo
// step through ui/history.ts (a diff, so takes recorded since are left alone).
// =============================================================================
import {
  applyPaintReveal,
  type DabStamp,
  type LayerLoop,
  type TimedEvent,
} from '../core/loop-events';
import { mergeRecordings, passRenumber, type MergeSide } from '../core/recording-merge';
import { sceneToElementCell } from '../core/scene-affine';
import type { CachedAsset } from '../core/scene-resolver';
import { clipEnd, drawnEnd } from '../core/timeline-edit';
import { nextEventId, useLoopStore } from '../state/loop-store';
import { useBurnStore } from '../state/burn-store';
import { sceneDimsAt, useSceneStore, type SceneNode } from '../state/scene-store';
import type { RecordingAssetRecord, RecordingElementData } from '../core/library';
import { liveTotalFrames } from './audio-engine';
import { asOneStep, recordTakesEdit, type TakesEdit } from './history';
import { notifyBanner } from '../state/notify-store';
import { createBakedLayer, createRecordingFromRaster } from './paint-node';
import { getAssetCache } from './scene-assets';
import { takeGrowth, type TakeGrowth } from './take';

/** `events` as a recording's own takes: new ids, new passes, keyed to `node`. */
function takesCopy(
  events: readonly TimedEvent[],
  node: Pick<SceneNode, 'id' | 'assetId'>,
): { copies: TimedEvent[]; passes: ReadonlyMap<number, number> } {
  const lp = useLoopStore.getState();
  const { next, passes } = passRenumber(lp.events.reduce((m, e) => Math.max(m, e.pass), -1));
  let seq = Number(nextEventId('pr-').slice(3));
  const copies = events.map((e): TimedEvent => {
    const pass = next(e.pass);
    const base = { ...e, id: `pr-${seq++}`, nodeId: node.id, pass, layer: pass };
    return base.kind === 'paint-reveal' ? { ...base, assetId: node.assetId } : base;
  });
  return { copies, passes };
}

/** Takes renumbered from a muted take stay muted. */
function keepMutes(passes: ReadonlyMap<number, number>, muted?: readonly number[]): void {
  const lp = useLoopStore.getState();
  const was = muted ?? lp.mutedLayers;
  const add = [...passes].filter(([from]) => was.includes(from)).map(([, to]) => to);
  if (add.length) useLoopStore.setState({ mutedLayers: [...lp.mutedLayers, ...add] });
}

/** Give `clone` a copy of `sourceId`'s takes and loop, as takes of its own (new passes, so a
 *  mute on one leaves the other). Part of a Duplicate, so not a step of its own. */
export function copyRecordingTakes(
  sourceId: string,
  clone: Pick<SceneNode, 'id' | 'assetId'>,
): void {
  const lp = useLoopStore.getState();
  const { copies, passes } = takesCopy(
    lp.events.filter((e) => e.nodeId === sourceId),
    clone,
  );
  if (copies.length) lp.commitEvents(copies);
  keepMutes(passes);
  const loop: LayerLoop | undefined = lp.layerLoops[sourceId];
  if (loop) lp.setLayerLoops({ [clone.id]: { ...loop } });
}

/** A stroke recorded into a backwards recording, mirrored so it plays where it was drawn. */
export function mirroredForBackwards(stamps: readonly DabStamp[], frames: number): DabStamp[] {
  return stamps.map((s) => ({ ...s, frame: Math.max(0, frames - 1 - s.frame) })).reverse();
}

/** How far a point is from a segment. */
function toSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = dx * dx + dy * dy;
  const u = len > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len)) : 0;
  return Math.hypot(px - (x0 + u * dx), py - (y0 + u * dy));
}

/** The dabs a rub leaves: every drawn dab whose middle is under the eraser goes; erase dabs
 *  stay (they only ever rubbed out earlier strokes). Pure. */
export function stampsAfterRub(
  stamps: readonly DabStamp[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): DabStamp[] {
  return stamps.filter((s) => s.erase || toSegment(s.x, s.y, x0, y0, x1, y1) > radius + s.r / 2);
}

let rubStart: TimedEvent[] | null = null;

/** Stopped, the Eraser goes down on a picked recording. */
export function beginRecordingErase(): void {
  rubStart = useLoopStore.getState().events;
}

/** Rub out `node`'s strokes under a segment of the eraser, in scene cells, at every moment. */
export function eraseRecordingDabs(
  node: SceneNode,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  size: number,
): void {
  const asset = getAssetCache().get(node.assetId);
  if (!asset) return;
  const per = asset.per ?? 1;
  const a = sceneToElementCell(node.placement, asset.w, asset.h, sx0, sy0, per);
  const b = sceneToElementCell(node.placement, asset.w, asset.h, sx1, sy1, per);
  const sc = (Math.abs(node.placement.scaleX) + Math.abs(node.placement.scaleY)) / 2 || 1;
  const radius = (size * per) / sc;
  const lp = useLoopStore.getState();
  let changed = false;
  const events: TimedEvent[] = [];
  for (const e of lp.events) {
    if (e.kind !== 'paint-reveal' || e.nodeId !== node.id) {
      events.push(e);
      continue;
    }
    const stamps = stampsAfterRub(e.stamps, a.x, a.y, b.x, b.y, radius);
    if (stamps.length === e.stamps.length) events.push(e);
    else {
      changed = true;
      if (stamps.length) events.push({ ...e, stamps });
    }
  }
  if (changed) useLoopStore.setState({ events, rev: lp.rev + 1 });
}

/** The Eraser came up: everything it rubbed out is one Undo step. */
export function endRecordingErase(): void {
  const start = rubStart;
  rubStart = null;
  if (!start) return;
  const now = useLoopStore.getState().events;
  if (now === start) return;
  recordTakesEdit(takesDiff(start, now));
}

/** The diff between two event logs (the same ids in the same order, some changed or gone). */
export function takesDiff(from: readonly TimedEvent[], to: readonly TimedEvent[]): TakesEdit {
  const toById = new Map(to.map((e) => [e.id, e]));
  const fromById = new Map(from.map((e) => [e.id, e]));
  const before: TakesEdit['before'] = [];
  const after: TakesEdit['after'] = [];
  from.forEach((event, at) => {
    if (toById.get(event.id) !== event) before.push({ at, event });
  });
  to.forEach((event, at) => {
    if (fromById.get(event.id) !== event) after.push({ at, event });
  });
  return { before, after, loopsBefore: {}, loopsAfter: {} };
}

/** Undo the last take (of `nodeId` alone, from its bar's menu). A recording it was the only
 *  take of goes with it (its row too), one general Undo step that brings it back; a recording
 *  it grew shrinks back. */
export function undoTake(nodeId?: string): void {
  const lp = useLoopStore.getState();
  const scene = useSceneStore.getState();
  const live = new Set(scene.nodes.map((n) => n.id));
  // The ↶ button: a deleted layer's take (Undo can bring it back) isn't the one you see.
  const mine = (e: TimedEvent) =>
    nodeId ? e.nodeId === nodeId : e.nodeId === '' || live.has(e.nodeId);
  const pass = lp.events.reduce((m, e) => (mine(e) ? Math.max(m, e.pass) : m), -1);
  if (pass < 0) return;
  const gone = (e: TimedEvent) => mine(e) && e.pass === pass;
  const emptied = scene.nodes.filter(
    (n) =>
      n.kind === 'recording' &&
      lp.events.some((e) => e.nodeId === n.id && gone(e)) &&
      !lp.events.some((e) => e.nodeId === n.id && !gone(e)),
  );
  const events = lp.events.filter((e) => !gone(e));
  const edit = takesDiff(lp.events, events);
  for (const n of emptied) {
    edit.loopsBefore[n.id] = lp.layerLoops[n.id] ?? null;
    edit.loopsAfter[n.id] = null;
  }
  // What it grew shrinks back, unless you've since changed that loop or bar yourself.
  const barsBack: TakeGrowth[] = [];
  for (const g of takeGrowth(pass)) {
    if ((nodeId && g.id !== nodeId) || lp.layerLoops[g.id] !== g.after) continue;
    edit.loopsBefore[g.id] = g.after;
    edit.loopsAfter[g.id] = g.loop;
    if (g.clipsAfter && scene.nodes.find((n) => n.id === g.id)?.clips === g.clipsAfter)
      barsBack.push(g);
  }
  asOneStep(() => {
    useLoopStore.setState({ events, rev: lp.rev + 1 });
    lp.setLayerLoops(edit.loopsAfter);
    recordTakesEdit(edit);
    for (const g of barsBack) scene.setClips(g.id, g.clips);
    if (emptied.length) scene.remove(emptied.map((n) => n.id));
  });
}

/** The timeline's Clear: every take goes, and a recording is its takes, so its row goes too (lock
 *  22), one Undo step that brings them back. With no recording it is the plain clear. */
export function clearTakes(): void {
  const lp = useLoopStore.getState();
  const scene = useSceneStore.getState();
  const rows = scene.nodes.filter((n) => n.kind === 'recording').map((n) => n.id);
  if (rows.length === 0) {
    lp.clearLoop();
    return;
  }
  const edit = takesDiff(lp.events, []);
  for (const [id, loop] of Object.entries(lp.layerLoops)) {
    edit.loopsBefore[id] = loop;
    edit.loopsAfter[id] = null;
  }
  asOneStep(() => {
    lp.clearLoop();
    recordTakesEdit(edit);
    scene.remove(rows);
  });
}

const sideOf = (n: SceneNode, events: readonly TimedEvent[]): MergeSide | null => {
  const raster = getAssetCache().get(n.assetId);
  if (!raster) return null;
  const loop = useLoopStore.getState().layerLoops[n.id];
  return {
    id: n.id,
    assetId: n.assetId,
    ...(n.clips ? { clips: n.clips } : {}),
    ...(loop ? { loop } : {}),
    ...(n.rec ? { rec: n.rec } : {}),
    placement: n.placement,
    raster: { w: raster.w, h: raster.h, ...(raster.per ? { per: raster.per } : {}) },
    events: events.filter((e) => e.nodeId === n.id),
  };
};

/** Merge `otherId` into `intoId`: one recording that looks the same as the
 *  two did apart; `intoId` keeps its row, Look, fades and hand moves. One Undo step. */
export function mergeRecordingInto(intoId: string, otherId: string): void {
  const scene = useSceneStore.getState();
  const lp = useLoopStore.getState();
  const a = scene.nodes.find((n) => n.id === intoId);
  const b = scene.nodes.find((n) => n.id === otherId);
  if (!a || !b || a.kind !== 'recording' || b.kind !== 'recording') return;
  const into = sideOf(a, lp.events);
  const other = sideOf(b, lp.events);
  if (!into || !other) return;
  const top = lp.events.reduce((m, e) => Math.max(m, e.pass), -1);
  const m = mergeRecordings(into, other, Math.max(1, lp.meta.frames), liveTotalFrames(), top);
  const events: TimedEvent[] = [];
  let placed = false;
  for (const e of lp.events) {
    if (e.nodeId === otherId) continue;
    if (e.nodeId !== intoId) events.push(e);
    else if (!placed) {
      placed = true;
      events.push(...m.into);
    }
  }
  if (!placed) events.push(...m.into);
  events.push(...m.joined);
  const edit = takesDiff(lp.events, events);
  edit.loopsBefore = {
    [intoId]: lp.layerLoops[intoId] ?? null,
    [otherId]: lp.layerLoops[otherId] ?? null,
  };
  edit.loopsAfter = { [intoId]: m.loop, [otherId]: null };
  asOneStep(() => {
    useLoopStore.setState({ events, rev: lp.rev + 1 });
    lp.setLayerLoops(edit.loopsAfter);
    recordTakesEdit(edit);
    keepMutes(m.passes);
    scene.setMergedRecording(intoId, m.clip, m.rec);
    useSceneStore.getState().remove([otherId]);
    useSceneStore.getState().setSelection([intoId]);
  });
}

/** A recording's finished picture as a raster: its lasting strokes of the unmuted takes, in the
 *  order they were recorded; flashes aren't in it. */
export function finishedPicture(n: SceneNode): CachedAsset | null {
  const cache = getAssetCache();
  if (!cache.get(n.assetId)) return null;
  const lp = useLoopStore.getState();
  // The last moment of its drawn part, held: the replay Hold shows, forwards.
  const D = lp.layerLoops[n.id]?.frames ?? Number.MAX_SAFE_INTEGER;
  const own = lp.events.filter((e) => e.nodeId === n.id);
  const raster = applyPaintReveal(cache, own, D - 1, D, new Set(lp.mutedLayers), null, () => ({
    frame: D - 1,
    frames: D,
    replay: D - 1,
    held: true,
  })).get(n.assetId);
  const base = cache.get(n.assetId)!;
  return raster && raster !== base
    ? raster
    : { ...base, tones: base.tones.slice(), covered: base.covered.slice() };
}

/** A saved recording back on the canvas, as a recording, on top: its
 *  takes its own, its bar at the start of the video. One Undo step. */
export function placeRecording(rec: RecordingAssetRecord, data: RecordingElementData): string {
  const scene = useSceneStore.getState();
  const lp = useLoopStore.getState();
  const dims = sceneDimsAt(useBurnStore.getState().aspect, scene.pixel);
  // Its strokes keep their size on the canvas, as a saved element does (its Pixel over this one).
  const s = rec.cell / scene.pixel;
  const p = data.layer.placement;
  const placement = {
    ...p,
    x: dims.w / 2 + (p.x - data.canvas.w / 2) * s,
    y: dims.h / 2 + (p.y - data.canvas.h / 2) * s,
    scaleX: p.scaleX * s,
    scaleY: p.scaleY * s,
  };
  const shift = (w: NonNullable<SceneNode['window']>) => ({
    x: dims.w / 2 + (w.x - data.canvas.w / 2) * s,
    y: dims.h / 2 + (w.y - data.canvas.h / 2) * s,
    w: w.w * s,
    h: w.h * s,
  });
  const end = liveTotalFrames();
  // A bar length runs to the end of the video, repeating; Free keeps the bar it was saved with.
  const clips = data.loop.free
    ? data.clips
    : data.clips.map((c, i) =>
        i === data.clips.length - 1 ? { ...c, duration: Math.max(c.duration, end - c.start) } : c,
      );
  let id = '';
  asOneStep(() => {
    id = createRecordingFromRaster(rec.w, rec.h, rec.per ?? 1, placement);
    useSceneStore.setState((st) => ({
      nodes: st.nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              look: data.layer.look,
              opacity: data.layer.opacity,
              crop: data.layer.crop,
              motion: data.layer.motion,
              clips: clips.map((c, i) => ({ ...c, id: `${id}-bar${i}` })),
              ...(data.layer.rec ? { rec: data.layer.rec } : {}),
              ...(data.layer.solid ? { solid: data.layer.solid } : {}),
              ...(data.layer.fx ? { fx: data.layer.fx } : {}),
              ...(data.layer.mods ? { mods: data.layer.mods } : {}),
              ...(data.layer.window ? { window: shift(data.layer.window) } : {}),
            }
          : n,
      ),
      rev: st.rev + 1,
    }));
    const assetId = useSceneStore.getState().nodes.find((n) => n.id === id)?.assetId ?? '';
    const { copies, passes } = takesCopy(data.events, { id, assetId });
    keepMutes(passes, data.muted ?? []);
    const events = [...lp.events, ...copies];
    const edit = takesDiff(lp.events, events);
    edit.loopsBefore = { [id]: null };
    edit.loopsAfter = { [id]: data.loop };
    useLoopStore.setState({ events, rev: lp.rev + 1 });
    lp.setLayerLoops(edit.loopsAfter);
    recordTakesEdit(edit);
  });
  return id;
}

/** Keep as drawing: the finished picture as a new still Drawing just above
 *  the recording, from where it finishes to the end of the video. Playing backwards it is the
 *  mirror: from the start of the video to where the recording starts. One Undo step. */
export function keepAsDrawing(id: string): void {
  const scene = useSceneStore.getState();
  const lp = useLoopStore.getState();
  const n = scene.nodes.find((x) => x.id === id);
  if (!n || n.kind !== 'recording') return;
  const picture = finishedPicture(n);
  if (!picture) return;
  // A recording with no bar is on for the whole video.
  const clips = n.clips ?? [{ id: 'all', start: 0, duration: liveTotalFrames(), sourceIn: 0 }];
  const barStart = clips.length ? Math.min(...clips.map((c) => c.start)) : 0;
  let start: number;
  let duration: number;
  if (n.rec?.backwards) {
    if (barStart <= 0) {
      notifyBanner('It starts at the very beginning: move it later first');
      return;
    }
    start = 0;
    duration = barStart;
  } else {
    const loop = lp.layerLoops[id];
    const seam = loop && drawnEnd(clips, loop);
    start = seam ? seam.at : clips.length ? Math.max(...clips.map(clipEnd)) : 0;
    // With nothing after it the video ends here: the drawing still gets one Loop length.
    duration = Math.max(liveTotalFrames() - start, Math.max(1, lp.meta.frames));
  }
  asOneStep(() => {
    const d = createBakedLayer(picture, id);
    // It stands in for the recording: the same place and Look, so nothing jumps.
    useSceneStore.setState((st) => ({
      nodes: st.nodes.map((x) =>
        x.id === d
          ? {
              ...x,
              placement: n.placement,
              crop: n.crop,
              look: n.look,
              opacity: n.opacity,
              motion: n.motion,
              clips: [{ id: `${d}-kept`, start, duration, sourceIn: 0 }],
              ...(n.solid ? { solid: n.solid } : {}),
              ...(n.fx ? { fx: n.fx } : {}),
              ...(n.mods ? { mods: n.mods } : {}),
              ...(n.window ? { window: n.window } : {}),
            }
          : x,
      ),
      rev: st.rev + 1,
    }));
  });
}
