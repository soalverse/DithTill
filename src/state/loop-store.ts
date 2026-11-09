// =============================================================================
// Looper store (Group E/F). The loop timeline model, zundo-wrapped exactly
// like scene-store: the undo history tracks ONLY the persistent model { meta, events }.
//
// THE LOAD-BEARING SPLIT: `speed`, `transport`, `recordPass`, `mutedLayers`, `rev`,
// and the audio transients (`features`/`audioMuted`/`audioSources`/`trackName`) are
// TRANSIENT — excluded from the zundo partialize (the precedent
// of scene-store excluding selected/rev). It is therefore PHYSICALLY IMPOSSIBLE for the
// live record-time speed knob to reach the export: the export reads { meta, events }
// only, and `speed` is in neither. Everything stored is keyed by an INTEGER loop frame
// in loop-time — wall-clock never enters the model — so a loop recorded at 0.5x exports
// byte-identical to one recorded at 1x.
// =============================================================================
import { create } from 'zustand';
import { temporal } from 'zundo';
import type { AudioReactEvent, LayerLoop, LoopLengthMode, TimedEvent } from '../core/loop-events';
import type { FeatureArray } from '../core/audio-features';
import { seedFromString } from '../core/seeded-rng';
import { BEATS_PER_BAR, BPM_DEFAULT, barsToFrames, clampBpm } from '../core/tempo';

export interface LoopMeta {
  /** Frames per loop-second; constant per loop (default 30). */
  fps: number;
  /** F — the integer loop length (E6 always resolves to this). */
  frames: number;
  /** DERIVED = frames / fps * 1000 — never an independent float. */
  loopMs: number;
  /** 'bars' (J1, the default): the loop is `bars` bars at `bpm` and `frames` follows
   *  the tempo; 'fixed': `frames` as set (a song / clip length, or a loop saved before
   *  tempo existed). */
  lengthMode: LoopLengthMode;
  /** The project tempo (J1, FL Studio style). null = a loop saved before tempo existed
   *  (read as BPM_DEFAULT). */
  bpm: number | null;
  beatsPerBar: number | null;
  bars: number | null;
  /** Seconds from the start of the video to bar 1, beat 1 (Detect lines it up with the
   *  song's first downbeat). Absent = 0. */
  beatOffsetSec?: number;
  /** Locked decision 1: the WITH AUDIO / WITHOUT AUDIO sub-toggle. */
  withAudio: boolean;
  /** F1 imported audio asset id (with-audio), else null. */
  audioId: string | null;
  /** ~5ms crossfade at audio tile joins + the loop wrap (owner toggle, locked
   *  2026-07-03). Stored: it shapes the canonical buffer, so it is an export
   *  input like everything else in meta. */
  seamFade: boolean;
  /** Object-path LOOP-CLOSE blend (H-A0): ease each recorded
   *  object-path's sampled placement back toward its FIRST sample over the final ~0.5s
   *  of the loop so the wrap doesn't teleport. WYSIWYG — an export input like seamFade;
   *  applied non-destructively at evaluate time (the recorded samples are never
   *  rewritten, so mute/undo are unaffected). Default ON. */
  pathClose: boolean;
  /** §C master PRNG seed — AUTHORED, stored, undoable, identical on every export. */
  seed: number;
}

/** One audible source in the Loop-Sound MIX (locked 2026-07-03: every placed
 *  video's audio plays + an imported track layers on top; per-source mutes).
 *  Written by ui/audio-engine after decode; UI indicators read it. */
export interface AudioSourceInfo {
  /** The scene assetId for a video's audio; 'track' for the imported track. */
  id: string;
  kind: 'video' | 'track';
  label: string;
}

export type Transport = 'stopped' | 'playing' | 'recording';

// J1 (FL Studio): a new loop is 1 bar at 130 BPM, 4/4 — 55 frames ≈ 1.85 s at 30 fps.
const DEFAULT_FRAMES = barsToFrames(1, BPM_DEFAULT, 30);
export const LOOP_META_DEFAULT: LoopMeta = {
  fps: 30,
  frames: DEFAULT_FRAMES,
  loopMs: (DEFAULT_FRAMES / 30) * 1000,
  lengthMode: 'bars',
  bpm: BPM_DEFAULT,
  beatsPerBar: BEATS_PER_BAR,
  bars: 1,
  beatOffsetSec: 0,
  withAudio: false,
  audioId: null,
  seamFade: true,
  pathClose: true,
  seed: 0x1337beef,
};

/** Default overdub max-take cap (E7). */
export const MAX_TAKES = 12;

/** What a Reactivity-panel row carries (the store fills in the event scaffolding). */
export type ReactionInput = Pick<AudioReactEvent, 'nodeId' | 'band' | 'target' | 'depth'>;

// Reaction ids only need to be unique within the session (loops aren't persisted to
// disk yet); a monotonic counter avoids Math.random. Order never affects the render —
// reaction deltas accumulate additively (commutative), so the id is just a key.
let reactionSeq = 0;

/** Skip the reaction-id counter past a reopened project's `re-N` ids. */
export function reserveReactionIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const n = id.startsWith('re-') ? Number(id.slice(3)) : NaN;
    if (Number.isInteger(n) && n > reactionSeq) reactionSeq = n;
  }
}

/** A fresh timeline-event id `${prefix}N`, one past every current event's (so a
 *  reopened project's takes never collide with new ones). */
export function nextEventId(prefix: string): string {
  let max = 0;
  for (const e of useLoopStore.getState().events) {
    if (!e.id.startsWith(prefix)) continue;
    const n = Number(e.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}
// Reactions are ALWAYS-ON (the whole loop) and never a take / never muted.
const REACTION_ALWAYS_ON = Number.MAX_SAFE_INTEGER;
const REACTION_PASS = -1;

interface LoopState {
  meta: LoopMeta;
  /** The additive, pass-tagged overdub log — THE timeline. */
  events: TimedEvent[];
  /** Each recorded layer's OWN loop, by node id. It belongs to the layer's takes,
   *  so it lives here beside them (an edit Undo of the scene never takes it away); a layer
   *  without an entry loops at `meta.frames`. Saved with the project. */
  layerLoops: Record<string, LayerLoop>;
  /** The MARKED PART of the video: Play repeats just [start, end) song frames and
   *  Export can render only it. Null = the whole video. Saved with the project; marking is
   *  not an edit (never an Undo step). */
  part: { start: number; end: number } | null;
  /** Authored audio reactions (the always-on Reactivity panel). Kept
   *  SEPARATE from `events` so Clear Loop / the take counter / overdub never touch
   *  them; folded into the render/export beside `events`. Undoable + exported. */
  reactions: AudioReactEvent[];

  // ---- transient (EXCLUDED from zundo partialize) ----
  transport: Transport;
  /** 0.25..1 LIVE knob — PREVIEW ONLY, never stored, never serialized. */
  speed: number;
  /** Active overdub pass while recording (null when not). */
  recordPass: number | null;
  /** E7 live mute by layer (render filter only; not stored). */
  mutedLayers: number[];
  rev: number;
  /** THE frame-indexed FeatureArray from the canonical loop-audio mix (locked
   *  2026-07-03: the live preview reads the SAME array the export reads —
   *  features[frame], never a live AnalyserNode). Transient: recomputed from
   *  the audio sources on load, deterministic, so it never needs storing. */
  features: FeatureArray | null;
  /** Muted AUDIO sources ('track' or a video's assetId) — a mix filter, like
   *  mutedLayers is a render filter. WYSIWYG: an explicit export input. */
  audioMuted: string[];
  /** The decoded sources currently in the mix (engine-written; UI reads). */
  audioSources: AudioSourceInfo[];
  /** Imported track's display name (session-transient — never stored). */
  trackName: string | null;
  /** Loop-cue AUDIO tick on/off (the visual cue is always on during Play/Rec). A
   *  LIVE performance aid — a short click at each loop wrap, NEVER part of the
   *  Loop-Sound mix or the export. Transient (a UI preference, like speed). */
  cueSound: boolean;
  /** The Animate timeline strip is open. */
  animate: boolean;
  /** STOPPED scrub position (a loop frame) — the canvas shows that moment; null = at
   *  rest. Transient: never stored, never exported; any transport change clears it. */
  scrub: number | null;
  /** Where the next Play / Rec starts (the paused or scrubbed playhead, an ABSOLUTE frame);
   *  null = from the top. Set as the transport leaves 'stopped'. Transient. */
  resumeFrame: number | null;

  // ---- actions ----
  setTransport: (t: Transport) => void;
  setSpeed: (s: number) => void;
  /** Patch loop meta; loopMs is always re-derived from frames/fps. A patch of
   *  `frames` alone makes the length 'fixed'; in 'bars' mode the frames follow
   *  bars × tempo (J1). */
  setLength: (patch: Partial<LoopMeta>) => void;
  setWithAudio: (withAudio: boolean) => void;
  setAudioId: (id: string | null) => void;
  setSeamFade: (seamFade: boolean) => void;
  setPathClose: (pathClose: boolean) => void;
  setSeed: (seed: number) => void;
  setFeatures: (features: FeatureArray | null) => void;
  setAudioSources: (audioSources: AudioSourceInfo[]) => void;
  setTrackName: (trackName: string | null) => void;
  toggleAudioMute: (id: string) => void;
  setCueSound: (cueSound: boolean) => void;
  setAnimate: (animate: boolean) => void;
  setScrub: (scrub: number | null) => void;
  /** PAUSE: stop, but hold the playhead at `frame` — the canvas keeps
   *  showing it and Play resumes from there. */
  pause: (frame: number) => void;
  /** Mint a fresh deterministic seed (no Math.random) and store it (undoable). */
  reroll: () => void;
  /** Arm a new overdub pass: transport→recording, recordPass = maxPass+1. Returns the
   *  pass index, or null if the max-take cap is hit. */
  beginOverdub: () => number | null;
  /** Append captured events as ONE undo step (called on overdub commit). */
  commitEvents: (events: TimedEvent[]) => void;
  /** Mark a part of the video (song frames), or null for the whole video. */
  setPart: (part: { start: number; end: number } | null) => void;
  /** Set (or, with null, drop) layers' own loops. */
  setLayerLoops: (patch: Record<string, LayerLoop | null>) => void;
  /** E7 undo-last-pass = drop the highest pass (one zundo step). */
  undoLastPass: () => void;
  /** E7 toggle a layer's live mute (transient). */
  toggleMute: (layer: number) => void;
  /** Clear the TIME log (events) — NOT the scene, NOT reactions; one zundo step. */
  clearLoop: () => void;
  /** Purge ALL authored loop content — events AND reactions — in ONE zundo step (the
   *  LayersDoor Clear-all wipe, follow-up). The scene
   *  clear + track clear are the caller's own separate undo steps. */
  clearAllAuthored: () => void;
  /** Author a new reaction (Reactivity panel). Returns the new id. */
  addReaction: (r: ReactionInput) => string;
  /** Patch a reaction's band/effect/depth/target. */
  updateReaction: (id: string, patch: Partial<ReactionInput>) => void;
  removeReaction: (id: string) => void;
  /** Replace every reaction at once (the one Undo / Redo restores a list). */
  setReactions: (reactions: AudioReactEvent[]) => void;
  bump: () => void;
}

const maxPass = (events: TimedEvent[]): number => events.reduce((m, e) => Math.max(m, e.pass), -1);

/** Takes of hand moves, for the Rec cap. A recording's strokes count per recording, checked
 *  as a stroke lands, so they never block arming. */
const passCount = (events: TimedEvent[]): number => {
  const seen = new Set<number>();
  for (const e of events) if (e.kind !== 'paint-reveal') seen.add(e.pass);
  return seen.size;
};

/** How many takes a layer has. */
export function takesOn(events: readonly TimedEvent[], nodeId: string): number {
  const seen = new Set<number>();
  for (const e of events) if (e.nodeId === nodeId) seen.add(e.pass);
  return seen.size;
}

export const useLoopStore = create<LoopState>()(
  temporal(
    (set, get) => ({
      meta: { ...LOOP_META_DEFAULT },
      events: [],
      reactions: [],
      layerLoops: {},
      part: null,

      transport: 'stopped',
      speed: 1,
      recordPass: null,
      mutedLayers: [],
      rev: 0,
      features: null,
      audioMuted: [],
      audioSources: [],
      trackName: null,
      cueSound: false,
      animate: false,
      scrub: null,
      resumeFrame: null,

      setTransport: (transport) =>
        set((s) => ({
          transport,
          scrub: null,
          resumeFrame:
            s.transport === 'stopped' && transport !== 'stopped' ? s.scrub : s.resumeFrame,
          // Leaving record/play resets the active pass; entering stop keeps the log.
          recordPass: transport === 'recording' ? s.recordPass : null,
        })),

      setSpeed: (speed) => set({ speed: Math.max(0.25, Math.min(1, speed)) }),

      setLength: (patch) =>
        set((s) => {
          const meta = { ...s.meta, ...patch };
          meta.fps = Math.max(1, Math.round(meta.fps));
          // A bare frame count (a song / clip length, a test) is a fixed length.
          if (patch.frames !== undefined && patch.bars === undefined && !patch.lengthMode) {
            meta.lengthMode = 'fixed';
            meta.bars = null;
          }
          if (meta.bpm != null) meta.bpm = clampBpm(meta.bpm);
          if ((meta.lengthMode === 'bars' || meta.lengthMode === 'free') && meta.bars)
            meta.frames = barsToFrames(meta.bars, meta.bpm ?? BPM_DEFAULT, meta.fps);
          meta.frames = Math.max(1, Math.round(meta.frames));
          meta.loopMs = (meta.frames / meta.fps) * 1000; // always derived
          return { meta, rev: s.rev + 1 };
        }),

      setWithAudio: (withAudio) => set((s) => ({ meta: { ...s.meta, withAudio }, rev: s.rev + 1 })),
      setAudioId: (audioId) => set((s) => ({ meta: { ...s.meta, audioId }, rev: s.rev + 1 })),
      setSeamFade: (seamFade) => set((s) => ({ meta: { ...s.meta, seamFade }, rev: s.rev + 1 })),
      setPathClose: (pathClose) => set((s) => ({ meta: { ...s.meta, pathClose }, rev: s.rev + 1 })),
      setSeed: (seed) => set((s) => ({ meta: { ...s.meta, seed: seed | 0 }, rev: s.rev + 1 })),

      setFeatures: (features) => set({ features }),
      setAudioSources: (audioSources) => set({ audioSources }),
      setTrackName: (trackName) => set({ trackName }),
      setCueSound: (cueSound) => set({ cueSound }),
      setAnimate: (animate) => set({ animate }),
      setScrub: (scrub) => set({ scrub }),
      pause: (frame) =>
        set({ transport: 'stopped', scrub: Math.max(0, Math.floor(frame)), recordPass: null }),
      toggleAudioMute: (id) =>
        set((s) => ({
          audioMuted: s.audioMuted.includes(id)
            ? s.audioMuted.filter((m) => m !== id)
            : [...s.audioMuted, id],
        })),

      reroll: () =>
        set((s) => ({
          meta: { ...s.meta, seed: seedFromString(`reroll:${s.meta.seed}:${s.rev}`) },
          rev: s.rev + 1,
        })),

      beginOverdub: () => {
        const s = get();
        if (passCount(s.events) >= MAX_TAKES) return null; // E7 max-take cap
        const pass = maxPass(s.events) + 1;
        // Rec from a paused/scrubbed playhead starts there (like Play).
        set({
          transport: 'recording',
          recordPass: pass,
          // A pass number can come round again (an undone take): a new take is never muted.
          mutedLayers: s.mutedLayers.filter((l) => l !== pass),
          ...(s.transport === 'stopped' ? { resumeFrame: s.scrub, scrub: null } : {}),
        });
        return pass;
      },

      commitEvents: (events) => set((s) => ({ events: [...s.events, ...events], rev: s.rev + 1 })),

      setPart: (part) =>
        set({
          part:
            part && part.end - part.start >= 1
              ? { start: Math.max(0, Math.round(part.start)), end: Math.round(part.end) }
              : null,
        }),

      setLayerLoops: (patch) =>
        set((s) => {
          const layerLoops = { ...s.layerLoops };
          for (const [id, l] of Object.entries(patch)) {
            if (l) layerLoops[id] = l;
            else delete layerLoops[id];
          }
          return { layerLoops, rev: s.rev + 1 };
        }),

      undoLastPass: () =>
        set((s) => {
          const mp = maxPass(s.events);
          if (mp < 0) return {};
          return { events: s.events.filter((e) => e.pass !== mp), rev: s.rev + 1 };
        }),

      toggleMute: (layer) =>
        set((s) => ({
          mutedLayers: s.mutedLayers.includes(layer)
            ? s.mutedLayers.filter((l) => l !== layer)
            : [...s.mutedLayers, layer],
        })),

      clearLoop: () => set((s) => ({ events: [], layerLoops: {}, rev: s.rev + 1 })),

      // ONE set → ONE zundo step (undo restores events + reactions together).
      clearAllAuthored: () =>
        set((s) => ({ events: [], reactions: [], layerLoops: {}, rev: s.rev + 1 })),

      addReaction: (r) => {
        const id = `re-${++reactionSeq}`;
        set((s) => ({
          reactions: [
            ...s.reactions,
            {
              id,
              kind: 'audio-react',
              nodeId: r.nodeId,
              pass: REACTION_PASS,
              layer: REACTION_PASS,
              startFrame: 0,
              endFrame: REACTION_ALWAYS_ON,
              band: r.band,
              target: r.target,
              depth: r.depth,
            },
          ],
          rev: s.rev + 1,
        }));
        return id;
      },
      updateReaction: (id, patch) =>
        set((s) => ({
          reactions: s.reactions.map((r) => (r.id === id ? { ...r, ...patch } : r)),
          rev: s.rev + 1,
        })),
      removeReaction: (id) =>
        set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id), rev: s.rev + 1 })),
      setReactions: (reactions) => set((s) => ({ reactions, rev: s.rev + 1 })),

      bump: () => set((s) => ({ rev: s.rev + 1 })),
    }),
    {
      // Undo history tracks ONLY the persistent model. Transient knobs/transport are
      // excluded so the live speed can never reach the (history-derived) export.
      limit: 50,
      partialize: (s) => ({
        meta: s.meta,
        events: s.events,
        reactions: s.reactions,
        layerLoops: s.layerLoops,
      }),
      equality: (a, b) =>
        a.meta === b.meta &&
        a.events === b.events &&
        a.reactions === b.reactions &&
        a.layerLoops === b.layerLoops,
    },
  ),
);
