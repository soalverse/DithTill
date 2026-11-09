// =============================================================================
// ONE undo ("every edit"). The canvas keeps three
// histories — the scene's (zundo: layers, look, clips, Motion, visualizers), each drawing
// layer's stroke snapshots (paint-node), and the loop's reactions + length — and this
// coordinator remembers the ORDER edits happened across all three, so Undo / Redo walk
// back and forth through them as one stack. Playback, zoom, selection and mutes are not
// edits (never recorded); recorded takes keep their own Undo take.
// =============================================================================
import { create } from 'zustand';
import { useSceneStore } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import type { AudioReactEvent, LayerLoop, TimedEvent } from '../core/loop-events';
import { paintRedo, paintUndo } from './paint-node';
import { gesture } from '../state/gesture';

/** An edit to recorded takes (the stopped eraser, Merge, removing a recording's
 *  last take), as a diff, so it undoes exactly itself and any takes recorded since stay. */
export interface TakesEdit {
  /** The events it changed or removed, as they were, each at its index then (ascending). */
  before: { at: number; event: TimedEvent }[];
  /** The events it changed or added, as they are now, each at its index now (ascending). */
  after: { at: number; event: TimedEvent }[];
  loopsBefore: Record<string, LayerLoop | null>;
  loopsAfter: Record<string, LayerLoop | null>;
}

/** The loop's undoable part: its reactions + its length. */
interface LoopSnap {
  reactions: AudioReactEvent[];
  frames: number;
  fps: number;
}
type Entry =
  | { kind: 'scene' }
  | { kind: 'paint'; assetId: string }
  | { kind: 'loop'; before: LoopSnap; after: LoopSnap; drag: number | null }
  | { kind: 'takes'; edit: TakesEdit }
  | { kind: 'group'; entries: Entry[] };

const LIMIT = 100;

const undoLog: Entry[] = [];
const redoLog: Entry[] = [];
let applying = false;

/** Undo / Redo availability for the buttons. */
export const useHistory = create<{ canUndo: boolean; canRedo: boolean }>(() => ({
  canUndo: false,
  canRedo: false,
}));
const publish = () =>
  useHistory.setState({ canUndo: undoLog.length > 0, canRedo: redoLog.length > 0 });

let groupBuf: Entry[] | null = null;

/** Listeners told after every edit, undo and redo (projects auto-save). */
const editListeners = new Set<() => void>();
export function onEdit(fn: () => void): () => void {
  editListeners.add(fn);
  return () => editListeners.delete(fn);
}
const notifyEdit = (): void => editListeners.forEach((fn) => fn());

function push(e: Entry): void {
  if (groupBuf) {
    groupBuf.push(e);
    return;
  }
  undoLog.push(e);
  if (undoLog.length > LIMIT) undoLog.shift();
  redoLog.length = 0;
  publish();
  notifyEdit();
}

/** Run `fn` as ONE undo step, however many histories it touches (e.g. Clear all). */
export function asOneStep(fn: () => void): void {
  if (groupBuf) return fn(); // already inside a group
  groupBuf = [];
  try {
    fn();
  } finally {
    const entries = groupBuf;
    groupBuf = null;
    if (entries.length === 1) push(entries[0]);
    else if (entries.length > 1) push({ kind: 'group', entries });
  }
}

/** A drawing stroke (or clear) just landed on `assetId` — one step. */
export function recordPaintStep(assetId: string): void {
  if (!applying) push({ kind: 'paint', assetId });
}

/** A stopped edit to recorded takes just landed — one step. */
export function recordTakesEdit(edit: TakesEdit): void {
  if (!applying) push({ kind: 'takes', edit });
}

function applyTakes(edit: TakesEdit, dir: 'undo' | 'redo'): void {
  const lp = useLoopStore.getState();
  const [out, back] = dir === 'undo' ? [edit.after, edit.before] : [edit.before, edit.after];
  const gone = new Set(out.map((o) => o.event.id));
  const events = lp.events.filter((e) => !gone.has(e.id));
  // Back in place, in order: stroke order is paint order.
  for (const { at, event } of back) events.splice(Math.min(at, events.length), 0, event);
  useLoopStore.setState({ events, rev: lp.rev + 1 });
  lp.setLayerLoops(dir === 'undo' ? edit.loopsBefore : edit.loopsAfter);
}

const loopSnap = (): LoopSnap => {
  const s = useLoopStore.getState();
  return { reactions: s.reactions, frames: s.meta.frames, fps: s.meta.fps };
};
const applyLoop = (snap: LoopSnap): void => {
  const lp = useLoopStore.getState();
  lp.setReactions(snap.reactions);
  if (snap.frames !== lp.meta.frames || snap.fps !== lp.meta.fps)
    lp.setLength({ frames: snap.frames, fps: snap.fps });
};

function run(entry: Entry, dir: 'undo' | 'redo'): boolean {
  const outer = applying;
  applying = true;
  try {
    if (entry.kind === 'scene') {
      const t = useSceneStore.temporal.getState();
      if ((dir === 'undo' ? t.pastStates : t.futureStates).length === 0) return false;
      if (dir === 'undo') t.undo();
      else t.redo();
    } else if (entry.kind === 'group') {
      const list = dir === 'undo' ? [...entry.entries].reverse() : entry.entries;
      let any = false;
      for (const e of list) any = run(e, dir) || any;
      return any;
    } else if (entry.kind === 'takes') {
      applyTakes(entry.edit, dir);
    } else if (entry.kind === 'paint') {
      if (dir === 'undo') paintUndo(entry.assetId);
      else paintRedo(entry.assetId);
    } else applyLoop(dir === 'undo' ? entry.before : entry.after);
    return true;
  } finally {
    applying = outer;
  }
}

/** Step back one edit, whichever history it lives in. */
export function undo(): void {
  for (let e = undoLog.pop(); e; e = undoLog.pop()) {
    if (run(e, 'undo')) {
      redoLog.push(e);
      break;
    }
  }
  publish();
  notifyEdit();
}

/** Step forward again. */
export function redo(): void {
  for (let e = redoLog.pop(); e; e = redoLog.pop()) {
    if (run(e, 'redo')) {
      undoLog.push(e);
      break;
    }
  }
  publish();
  notifyEdit();
}

/** Forget every step (opening / starting a project — undo starts fresh). */
export function resetHistory(): void {
  undoLog.length = 0;
  redoLog.length = 0;
  useSceneStore.temporal.getState().clear();
  useLoopStore.temporal.getState().clear();
  publish();
}

let inited = false;
/** Start listening (idempotent; called once from the canvas). */
export function initHistory(): void {
  if (inited) return;
  inited = true;
  // A new scene step = zundo recorded one (its past list was replaced, not by us).
  useSceneStore.temporal.subscribe((t, prev) => {
    if (
      !applying &&
      t.pastStates !== prev.pastStates &&
      t.pastStates.length > 0 &&
      t.futureStates.length === 0
    )
      push({ kind: 'scene' });
  });
  // Reactions / loop length: our own before → after steps; one per slider drag.
  let last = loopSnap();
  useLoopStore.subscribe((s) => {
    const now = loopSnap();
    const changed =
      s.reactions !== last.reactions || now.frames !== last.frames || now.fps !== last.fps;
    if (!changed) return;
    const before = last;
    last = now;
    if (applying) return;
    const top = undoLog[undoLog.length - 1];
    const drag = gesture.active ? gesture.id : null;
    if (drag !== null && top?.kind === 'loop' && top.drag === drag && redoLog.length === 0) {
      top.after = now; // the same drag — still one step
      return;
    }
    push({ kind: 'loop', before, after: now, drag });
  });
}
