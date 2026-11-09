// =============================================================================
// The take: what one press of Rec records into, and each recorded layer's
// OWN loop. A layer's loop is set the first time a take draws on it or moves it, and it
// always STARTS there — at that first stroke / drag, not at the Rec press:
//   - a bar length (the Loop setting): the loop is that long;
//   - Free: the loop stays OPEN while you record (it never wraps) and closes when the take
//     ends, as long as you recorded on that layer, rounded to the nearest beat (hold Shift
//     when you stop for the exact length).
// A stroke recorded with no recording to go into makes a new RECORDING, which gets
// its bar on the song from its first stroke when the take ends: exactly what you drew for
// Free (it plays once), to the end of the video for a bar length (it repeats). A stroke into a
// picked Free recording opens it again, so it grows past its end; so does one in any recording's
// Hold stretch. Loops live in the loop store beside the takes (`layerLoops`); while a take
// is open the live canvas reads `liveLayerLoops()` + `liveNodes()`, which add the open ones.
// =============================================================================
import { useLoopStore } from '../state/loop-store';
import { useSceneStore, type SceneNode } from '../state/scene-store';
import type { LayerLoop } from '../core/loop-events';
import { clipAt, clipSpeed, layerPosAt, type TimelineClip } from '../core/timeline-edit';
import { BPM_DEFAULT, framesPerBeat, roundToBeat } from '../core/tempo';
import { liveTotalFrames, songEndFrame } from './audio-engine';

/** An open Free loop's length while it records — long enough never to wrap. */
const OPEN_FRAMES = 1e9;

interface Take {
  free: boolean;
  /** The song frame the live clock last showed. */
  nowAbs: number;
  /** Loops still open: node id → where its loop starts (layer position), the song frame it
   *  opened at, the layer position there, and the length it had (0 = a new loop). */
  open: Map<string, { offset: number; atAbs: number; fromPos: number; base: number }>;
  /** Recordings Rec made during this take: node id → its start (song frame). */
  fresh: Map<string, number>;
  /** Each layer's last recorded stamp (a loop frame): a rounded length never cuts it off. */
  lastStamp: Map<string, number>;
  pass: number | null;
}

/** What a take changed on a recording it grew: Undo take puts these back. */
export interface TakeGrowth {
  id: string;
  loop: LayerLoop;
  clips?: TimelineClip[];
  /** The loop it grew to: Undo take only applies while this is still its loop. */
  after: LayerLoop;
  /** The bar it grew to, likewise. */
  clipsAfter?: TimelineClip[];
}

/** A take's bar is part of the take, never an Undo step of its own: Undo right after a take
 *  would otherwise leave a recording with no bar, playing over the whole video. */
function setBar(id: string, clips: TimelineClip[] | undefined): void {
  const history = useSceneStore.temporal.getState();
  history.pause();
  useSceneStore.getState().setClips(id, clips);
  history.resume();
}
const growth = new Map<number, TakeGrowth[]>();
/** What take `pass` grew, for its Undo take. */
export function takeGrowth(pass: number): TakeGrowth[] {
  return growth.get(pass) ?? [];
}

let take: Take | null = null;
let shiftDown = false;

/** Rec just started: a take begins. */
function begin(): void {
  const lp = useLoopStore.getState();
  take = {
    free: lp.meta.lengthMode === 'free',
    nowAbs: 0,
    open: new Map(),
    fresh: new Map(),
    lastStamp: new Map(),
    pass: lp.recordPass,
  };
  if (lp.recordPass !== null) growth.delete(lp.recordPass); // a pass number can come round again
}

/** The take ended (Rec again, Pause, Stop or the end of the video): close its open Free
 *  loops and give its new drawings their bar on the song. */
function end(): void {
  const t = take;
  take = null;
  if (!t) return;
  const lp = useLoopStore.getState();
  const { bpm, fps } = lp.meta;
  const patch: Record<string, LayerLoop> = {};
  const scene = useSceneStore.getState();
  const grown: TakeGrowth[] = [];
  const songEnd = songEndFrame();
  for (const [id, o] of t.open) {
    const node = scene.nodes.find((n) => n.id === id);
    const clip = node?.clips && clipAt(node.clips, o.atAbs);
    const sp = clip ? clipSpeed(clip) : 1;
    const len = o.fromPos - o.offset + (t.nowAbs - o.atAbs) * sp;
    const beat = bpm ?? BPM_DEFAULT;
    let frames = roundToBeat(len, beat, fps, shiftDown);
    // Rounding down never cuts off what was drawn.
    const last = t.lastStamp.get(id);
    if (last !== undefined && frames <= last) {
      const fpb = framesPerBeat(beat, fps);
      frames = shiftDown ? last + 1 : Math.ceil(Math.ceil((last + 1) / fpb) * fpb);
    }
    // A recording never runs past the song's end (rounding included).
    if (songEnd !== null && songEnd > o.atAbs)
      frames = Math.min(frames, Math.ceil(o.fromPos - o.offset + (songEnd - o.atAbs) * sp));
    // Into a recording it had: it only gets longer if a stroke landed past its end.
    if (o.base && (last === undefined || last < o.base)) frames = o.base;
    frames = Math.max(frames, o.base);
    const prior = lp.layerLoops[id];
    patch[id] = { frames, free: true, offset: o.offset };
    if (!o.base || !node || !prior) continue;
    // A recording that grew past its bar's end takes its bar along, up to its next piece.
    const g: TakeGrowth = { id, loop: prior, after: patch[id] };
    grown.push(g);
    if (clip && frames > o.base) {
      const next = Math.min(
        Infinity,
        ...(node.clips ?? []).filter((c) => c.start > clip.start).map((c) => c.start),
      );
      const need = Math.min(next - clip.start, Math.ceil((o.offset + frames - clip.sourceIn) / sp));
      if (need > clip.duration) {
        g.clips = node.clips;
        setBar(
          id,
          node.clips?.map((c) => (c === clip ? { ...c, duration: need } : c)),
        );
        g.clipsAfter = useSceneStore.getState().nodes.find((n) => n.id === id)?.clips;
      }
    }
  }
  if (t.pass !== null && grown.length) growth.set(t.pass, grown);
  if (Object.keys(patch).length) lp.setLayerLoops(patch);
  // A new recording gets its bar from its first stroke: exactly what was drawn for Free (it
  // plays once), else to the end of the video (at least one pass of its loop). Its loop then
  // runs from the bar's start.
  const total = liveTotalFrames();
  for (const [id, start] of t.fresh) {
    if (!scene.nodes.some((n) => n.id === id)) continue;
    const loop = useLoopStore.getState().layerLoops[id];
    const L = loop?.frames ?? lp.meta.frames;
    let duration = loop?.free ? L : Math.max(total - start, L);
    if (songEnd !== null && songEnd > start) duration = Math.min(duration, songEnd - start);
    setBar(id, [{ id: `${id}-take`, start, duration, sourceIn: 0 }]);
    if (loop) {
      const rest = { ...loop };
      delete rest.offset;
      useLoopStore.getState().setLayerLoops({ [id]: rest });
    }
  }
}

/** Rec made a new recording at the playhead (`abs`, a song frame) for this take. */
export function markFreshLayer(id: string, abs: number): void {
  take?.fresh.set(id, Math.max(0, Math.round(abs)));
}

/** A stroke's frame on `id` was just recorded. */
export function noteTakeStamp(id: string, frame: number): void {
  if (take) take.lastStamp.set(id, Math.max(take.lastStamp.get(id) ?? 0, frame));
}

/** Where a recorded stroke at song frame `abs` goes: into the picked recording
 *  when the playhead is on its bar, else `node` is null = a new one, just above `above`. */
export function strokeTarget(abs: number): { node: SceneNode | null; above: string | null } {
  const s = useSceneStore.getState();
  const picked = s.nodes.filter((n) => s.selected.includes(n.id)).sort((a, b) => a.z - b.z);
  const rec = picked.find((n) => n.kind === 'recording');
  if (rec && layerPosAt(liveNodes([rec])[0].clips, abs) !== null) return { node: rec, above: null };
  return { node: null, above: picked.length ? picked[picked.length - 1].id : null };
}

/** A recording still waiting for its first stroke, made with + ▸ New recording. It has no bar,
 *  loop or takes, so that stroke treats it like one Rec just made. */
export function isEmptyRecording(n: Pick<SceneNode, 'id' | 'kind' | 'clips'>): boolean {
  if (n.kind !== 'recording' || n.clips || take?.fresh.has(n.id)) return false;
  const lp = useLoopStore.getState();
  return !lp.layerLoops[n.id] && !lp.events.some((e) => e.nodeId === n.id);
}

/** A take is about to draw on / move `node` at song frame `abs`: give it its own loop if it
 *  has none yet (an existing loop stays — later takes add on top at its length). A STROKE
 *  (`stroke`) into a recording opens its loop again where it may grow: a Free one
 *  on its drawn part, any one in its Hold stretch. Elsewhere the stroke joins the loop. */
export function claimLayer(
  node: Pick<SceneNode, 'id' | 'clips' | 'kind' | 'rec'>,
  abs: number,
  stroke = false,
): void {
  const t = take;
  if (!t) return;
  const lp = useLoopStore.getState();
  if (t.open.has(node.id)) return;
  // The loop always starts at the layer's FIRST stroke / drag of the take,
  // not at the Rec press or the song's bar 1.
  const pos = layerPosAt(node.clips, abs) ?? 0;
  const own = lp.layerLoops[node.id];
  if (own) {
    if (!stroke || node.kind !== 'recording' || node.rec?.backwards) return;
    const offset = own.offset ?? 0;
    const past = pos - offset >= own.frames;
    if (past ? node.rec?.hold : own.free)
      t.open.set(node.id, { offset, atAbs: abs, fromPos: pos, base: own.frames });
    return;
  }
  if (t.free) {
    t.open.set(node.id, { offset: pos, atAbs: abs, fromPos: pos, base: 0 });
    return;
  }
  const { frames, bars } = lp.meta;
  lp.setLayerLoops({
    [node.id]: { frames, ...(bars ? { bars } : {}), ...(pos ? { offset: pos } : {}) },
  });
}

/** The loops the LIVE canvas plays: the saved ones plus this take's open Free loops. */
export function liveLayerLoops(): Readonly<Record<string, LayerLoop>> {
  const saved = useLoopStore.getState().layerLoops;
  if (!take || take.open.size === 0) return saved;
  const out: Record<string, LayerLoop> = { ...saved };
  for (const [id, o] of take.open) out[id] = { frames: OPEN_FRAMES, free: true, offset: o.offset };
  return out;
}

/** The layers the LIVE canvas plays: while a loop is open, its bar never ends under it. */
export function liveNodes<T extends Pick<SceneNode, 'id' | 'clips'>>(nodes: T[]): T[] {
  const t = take;
  if (!t || t.open.size === 0) return nodes;
  return nodes.map((n) => {
    const o = t.open.get(n.id);
    const clip = o && n.clips && clipAt(n.clips, o.atAbs);
    if (!clip) return n;
    return {
      ...n,
      clips: n.clips?.map((c) => (c === clip ? { ...c, duration: OPEN_FRAMES } : c)),
    };
  });
}

/** Where `id`'s open Free loop started (a song frame), or null when it has none open. */
export function openLoopStart(id: string): number | null {
  return take?.open.get(id)?.atAbs ?? null;
}

/** While a Free take is open with no song to end it, the video keeps going (a looper):
 *  the song frame the live length must stay ahead of. Null when nothing is open. */
export function openTakeFrame(): number | null {
  return take && take.open.size > 0 ? take.nowAbs : null;
}

/** The live clock's song frame (SceneStage's tick). A Free take that wraps back to the
 *  start of the video ends there — its loop can't be longer than the video. */
export function noteTakeFrame(abs: number): void {
  if (!take) return;
  // A real wrap jumps back by more than a loop (or half a marked part, which may be shorter);
  // the audio clock taking over from the frame clock as playback starts can step back a few
  // frames, which is not one.
  const { meta, part } = useLoopStore.getState();
  const F = Math.max(1, meta.frames);
  const span = part ? part.end - part.start : liveTotalFrames();
  const back = Math.max(1, Math.min(F, span / 2));
  if (abs + back < take.nowAbs) {
    if (take.open.size > 0) {
      useLoopStore.getState().setTransport('playing');
      return;
    }
    take.nowAbs = abs;
    return;
  }
  take.nowAbs = Math.max(take.nowAbs, abs);
}

let inited = false;
/** Start listening (idempotent; called once from the canvas). */
export function initTake(): void {
  if (inited) return;
  inited = true;
  useLoopStore.subscribe((s, p) => {
    if (s.transport === 'recording' && p.transport !== 'recording') begin();
    else if (s.transport !== 'recording' && p.transport === 'recording') end();
  });
  // Shift held as the take ends (Rec clicked, or Space) = the exact Free length.
  const track = (e: KeyboardEvent | PointerEvent) => {
    shiftDown = e.shiftKey;
  };
  window.addEventListener('keydown', track);
  window.addEventListener('keyup', track);
  window.addEventListener('pointerdown', track);
  window.addEventListener('blur', () => {
    shiftDown = false;
  });
}
