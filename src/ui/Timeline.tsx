import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useLoopStore, MAX_TAKES, takesOn } from '../state/loop-store';
import { clearTakes, keepAsDrawing, mergeRecordingInto, undoTake } from './recording-edit';
import { saveRecordingToLibrary } from './record-actions';
import { useSceneStore, type SceneNode } from '../state/scene-store';
import { liveTakes, type TimedEvent } from '../core/loop-events';
import {
  clearTrack,
  detectSongTempo,
  liveAbsFrame,
  liveTotalFrames,
  sourceLevel,
  trackFrames,
  trackPeaks,
} from './audio-engine';
import { loadSong } from './load-image';
import { isEmptyRecording, liveLayerLoops, openLoopStart } from './take';
import { isVideoAsset } from './video-assets';
import { findRecord } from './session-assets';
import {
  clipEnd,
  deleteClip,
  duplicateClip,
  drawnEnd,
  loopMarks,
  moveClip,
  clipSpeed,
  sourceOut,
  rateStretch,
  setFades,
  setSpeed,
  slip,
  snapFrame,
  splitAt,
  trim,
  type MediaLen,
  type TimelineClip,
} from '../core/timeline-edit';
import { layerKind, layerNames } from './layer-names';
import { notifyBanner } from '../state/notify-store';
import { LayerMenu, type LayerMenuAt } from './LayerMenu';
import { MoveMark } from './MovesList';
import { DrawnLane } from './DrawnLane';
import { asOneStep } from './history';
import { openMove, paramInfo, timelineSpan, toggleLaneFold, useLaneFold } from './moves';
import { MOD_RANGE, modKey, type DrawnPoint, type ModMap, type ModParam } from '../core/modulators';
import {
  BEATS_PER_BAR,
  BPM_DEFAULT,
  BPM_MAX,
  BPM_MIN,
  LOOP_BARS,
  barsToFrames,
  beatFrames,
  clampBpm,
  framesPerBeat,
  tapTempo,
} from '../core/tempo';

/** Pointer capture, best-effort (a capture can be refused, e.g. for a stale pointer). */
const capture = (e: { currentTarget: Element; pointerId: number }) => {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* the drag still works while the pointer stays over the element */
  }
};

/** Loop-length stops (seconds) — the hardware-looper model: set the length, then record. */
/** Ruler label steps in BARS (J1 — the ruler counts bars, like FL's playlist). */
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const ARM_MS = 2500;
/** The timeline ends this many px short of the right edge, so its last mark + label
 *  always fit — matches .tl-hpad's padding. */
const TL_END_INSET = 40;
/** Timeline zoom steps: 1 = the whole video fits. */
const ZOOMS = [1, 2, 4, 8, 16, 32] as const;

/** A small bin (clear every take). */
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6.6 6.5v5M9.4 6.5v5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** A small metronome (the loop-start click). */
function MetronomeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.6 1.8h4.8L13 14.2H3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 11.5l3.6-7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 11.5h8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** A small magnifying glass with − or + (the timeline zoom buttons). */
function MagIcon({ plus }: { plus: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 10l4.3 4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.3 6.5h4.4" stroke="currentColor" strokeWidth="1.5" />
      {plus && <path d="M6.5 4.3v4.4" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

/** A small drop-down in the timeline bar (tuck the rarely used controls
 *  away so the bar stays short and never changes shape). Fixed-positioned so the strip
 *  can't clip it; a click elsewhere closes it. A pick-list passes children as a function
 *  to get `close` (it shuts once a choice is made). */
function BarPop({
  label,
  title,
  aria,
  disabled,
  children,
}: {
  label: string;
  title: string;
  aria: string;
  disabled?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setAt(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [at]);
  return (
    <span className="tl-pop-wrap" ref={wrap}>
      <button
        type="button"
        className={`deck-load${at ? ' is-on' : ''}`}
        aria-haspopup="true"
        aria-expanded={!!at}
        aria-label={aria}
        title={title}
        disabled={disabled}
        onClick={(e) => {
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          // Opens UP from the bar: the strip sits at the bottom of the window.
          setAt({ left: r.left, bottom: window.innerHeight - r.top + 6 });
        }}
      >
        {label}
      </button>
      {at && (
        <span className="export-menu-pop tl-pop" role="group" aria-label={aria} style={at}>
          {typeof children === 'function' ? children(() => setAt(null)) : children}
        </span>
      )}
    </span>
  );
}

/** A lane's range at its head: the slider's top value over its bottom one (owner
 *  2026-10-22), so a dot's height reads as a number. */
function LaneRange({ param, node }: { param: ModParam; node: SceneNode | undefined }) {
  const info = paramInfo(param, node);
  const r = MOD_RANGE[param];
  return (
    <span className="tl-lane-range" aria-hidden="true">
      <span>{info.format(r.max * info.scale)}</span>
      <span>{info.format(r.min * info.scale)}</span>
    </span>
  );
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** A layer's recorded takes on its own row: one block per pass it took part in. */
function takeBlocks(events: TimedEvent[], nodeId: string, loopFrames?: number) {
  const by = new Map<number, { layer: number; a: number; b: number }>();
  for (const e of events) {
    if (e.nodeId !== nodeId) continue;
    // On a merged recording a take plays in its part's window.
    const a = e.part ? e.part.at : e.startFrame;
    const b = e.part ? Math.min(e.part.at + e.part.len, loopFrames ?? Infinity) : e.endFrame;
    const t = by.get(e.pass);
    if (t) {
      t.a = Math.min(t.a, a);
      t.b = Math.max(t.b, b);
    } else by.set(e.pass, { layer: e.layer, a, b });
  }
  return [...by.entries()].sort((x, y) => x[0] - y[0]);
}

/**
 * The ANIMATE timeline (a simple Movie-Maker-style
 * strip along the bottom). Transport (Rec · Play · time · Length · Speed · Takes · Sound
 * · Song · Beat), a seconds ruler with a playhead you can drag to scrub while stopped,
 * and ONE ROW PER LAYER in the Layers order: video clips with draggable trim edges,
 * recorded takes (click to mute), motion bands, and the song with its waveform. Audio
 * rows carry a mute + a live level meter. Layer timing (in/out, split) is step 3b.
 */
export function Timeline() {
  const transport = useLoopStore((s) => s.transport);
  const meta = useLoopStore((s) => s.meta);
  const speed = useLoopStore((s) => s.speed);
  const events = useLoopStore((s) => s.events);
  const mutedLayers = useLoopStore((s) => s.mutedLayers);
  const trackName = useLoopStore((s) => s.trackName);
  const audioMuted = useLoopStore((s) => s.audioMuted);
  const cueSound = useLoopStore((s) => s.cueSound);
  const scrub = useLoopStore((s) => s.scrub);
  const nodes = useSceneStore((s) => s.nodes);
  const selected = useSceneStore((s) => s.selected);
  const canvasMods = useSceneStore((s) => s.canvasMods);
  const folded = useLaneFold((s) => s.folded);
  const layerLoops = useLoopStore((s) => s.layerLoops);
  const part = useLoopStore((s) => s.part);
  const lp = useLoopStore.getState();

  const F = Math.max(1, meta.frames);
  // THE VIDEO: as long as the song, else the end of the last layer bar (the loop
  // at least) — what plays through and what the export covers. Re-read every render; song /
  // sound / mute / layer changes all re-render the strip.
  const videoF = timelineSpan();
  const songF = trackName ? trackFrames(meta.fps) : null;
  const songOn = songF != null && meta.withAudio && !audioMuted.includes('track');
  const videoWhy = songOn && songF === videoF ? ' (the track)' : videoF > F ? ' (the layers)' : '';
  const secs = F / meta.fps;
  const playing = transport !== 'stopped';
  const recording = transport === 'recording';
  const stack = [...nodes].sort((a, b) => b.z - a.z); // top layer first, like Layers
  const names = layerNames(nodes);
  const takes = liveTakes(events, new Set(nodes.map((n) => n.id)));
  const hasTakes = takes.length > 0;

  // ---- Length stops (+ a "Clip" stop for the first video, as before) ----
  const clipFrames = (() => {
    for (const n of nodes) {
      if (!isVideoAsset(n.assetId)) continue;
      const rec = findRecord(n.assetId);
      if (rec && rec.kind === 'video') return rec.frameCount;
    }
    return null;
  })();
  // J1 (FL Studio): the loop is measured in BARS at the project tempo, plus a "Clip" and
  // a "Song" stop (fixed lengths). "4 bars · 7.4 s".
  const bpm = meta.bpm ?? BPM_DEFAULT;
  const stops: { frames: number; label: string; bars: number | null; free?: boolean }[] =
    LOOP_BARS.map((b) => ({
      frames: barsToFrames(b, bpm, meta.fps),
      label: `${b} bar${b === 1 ? '' : 's'}`,
      bars: b,
    }));
  if (clipFrames != null && !stops.some((st) => st.frames === clipFrames))
    stops.push({ frames: clipFrames, label: 'Clip', bars: null });
  if (songF != null && !stops.some((st) => st.frames === songF))
    stops.push({ frames: songF, label: 'Track', bars: null });
  stops.sort((a, b) => a.frames - b.frames);
  // FREE sits below the shortest: a new recording is as long as you record it.
  stops.unshift({ frames: 0, label: 'Free', bars: null, free: true });
  const curStop =
    meta.lengthMode === 'free'
      ? 0
      : meta.lengthMode === 'bars' && meta.bars
        ? stops.findIndex((st) => st.bars === meta.bars)
        : stops.findIndex((st) => !st.free && st.bars === null && st.frames === F);
  const lengthLabel =
    curStop === 0
      ? 'Free'
      : curStop >= 0 && stops[curStop].bars !== null
        ? `${stops[curStop].label} · ${+secs.toFixed(1)}s`
        : curStop >= 0
          ? stops[curStop].label
          : `${+secs.toFixed(1)}s`;
  // The Loop setting is the length NEW recordings use: a recorded layer keeps its
  // own, so it only waits while a take is recording.
  const lengthLocked = recording;
  const pickStop = (next: (typeof stops)[number]) => {
    if (lengthLocked) return;
    // Layers recorded before they had their own loop keep the length they were made at.
    const loops = lp.layerLoops;
    const pin: Record<string, { frames: number; bars?: number }> = {};
    for (const e of events)
      if (e.nodeId && !loops[e.nodeId] && nodes.some((n) => n.id === e.nodeId))
        pin[e.nodeId] = { frames: F, ...(meta.bars ? { bars: meta.bars } : {}) };
    if (Object.keys(pin).length) lp.setLayerLoops(pin);
    if (next.free) lp.setLength({ lengthMode: 'free' });
    else if (next.bars !== null) lp.setLength({ lengthMode: 'bars', bars: next.bars });
    else lp.setLength({ frames: next.frames });
  };
  const stepLength = (d: number) => {
    // From an off-stop length (a loop made before tempo), − / + go to the stop below /
    // above it. The list WRAPS: + past the last stop comes back to Free,
    // − below Free goes to the last.
    const n = stops.length;
    let i: number;
    if (curStop >= 0) i = curStop + d;
    else if (d > 0) i = stops.findIndex((st) => !st.free && st.frames > F);
    else i = stops.map((st) => st.free || st.frames < F).lastIndexOf(true);
    if (curStop < 0 && i < 0) i = d > 0 ? 0 : n - 1;
    pickStop(stops[((i % n) + n) % n]);
  };
  // The Loop pick-list (0.1.0 list): Free · the bars · Clip · Track.
  const pickList = [
    ...stops.filter((st) => st.free || st.bars !== null),
    ...stops.filter((st) => !st.free && st.bars === null),
  ];
  // Tempo (J1): changing it re-times a bars loop, so it locks with the loop length.
  const tempoLocked = (hasTakes || recording) && meta.lengthMode !== 'fixed';
  const setBpm = (v: number) => {
    if (tempoLocked || !Number.isFinite(v)) return;
    lp.setLength({ bpm: Math.round(clampBpm(v) * 100) / 100 });
  };
  const taps = useRef<number[]>([]);
  const onTap = (at: number) => {
    taps.current = [...taps.current, at].slice(-16);
    const t = tapTempo(taps.current);
    if (t != null) setBpm(t);
  };
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const onDetect = () => {
    setDetecting(true);
    // Let "Detecting…" paint before the analysis runs.
    window.setTimeout(() => {
      void detectSongTempo().finally(() => setDetecting(false));
    }, 30);
  };

  const toggleRecord = () => {
    if (recording) lp.setTransport('playing');
    else if (lp.beginOverdub() === null)
      notifyBanner('Max takes reached — undo a take or clear the loop');
  };
  const [armClear, setArmClear] = useState(false);
  const clearTimer = useRef(0);
  const onClear = () => {
    if (!armClear) {
      setArmClear(true);
      clearTimer.current = window.setTimeout(() => setArmClear(false), ARM_MS);
      return;
    }
    window.clearTimeout(clearTimer.current);
    setArmClear(false);
    clearTakes();
    notifyBanner('Takes cleared');
  };
  const songInput = useRef<HTMLInputElement>(null);

  // ---- Playhead + meters: driven per animation frame (no React re-render) ----
  const lanesRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const loopRef = useRef<HTMLSpanElement>(null);
  const loopFollow = useRef<{ id: string | null } | null>(null);
  const meterRefs = useRef(new Map<string, HTMLSpanElement>());
  const spanRef = useRef(F);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const st = useLoopStore.getState();
      const Fs = Math.max(1, st.meta.frames);
      const span = spanRef.current;
      const frame = st.transport !== 'stopped' ? liveAbsFrame() % span : (st.scrub ?? 0) % span;
      if (headRef.current) headRef.current.style.left = `${(frame / span) * 100}%`;
      // max(): at the very start the handle would be cut in half by the ruler's edge.
      if (gripRef.current) gripRef.current.style.left = `max(6px, ${(frame / span) * 100}%)`;
      // The loop bracket while the picked layer has no loop saved: hidden, unless an open Free
      // take is making one (it grows from the take's start to the playhead).
      const lf = loopFollow.current;
      if (loopRef.current && lf) {
        const open = lf.id ? openLoopStart(lf.id) : null;
        loopRef.current.style.display = open === null ? 'none' : '';
        if (open !== null) {
          const a = open % span;
          loopRef.current.style.left = `${(a / span) * 100}%`;
          loopRef.current.style.width = `${(Math.min(Math.max(0, frame - a), span - a) / span) * 100}%`;
        }
      }
      if (timeRef.current)
        timeRef.current.textContent = `${fmtTime(frame / st.meta.fps)} / ${fmtTime(Math.max(Fs, liveTotalFrames()) / st.meta.fps)}`;
      meterRefs.current.forEach((el, id) => {
        const on = st.transport !== 'stopped' && st.meta.withAudio && !st.audioMuted.includes(id);
        el.style.transform = `scaleX(${on ? sourceLevel(id, frame) : 0})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- Scrub: press on the ruler / an empty lane spot while stopped, drag to move ----
  const frameAt = (clientX: number): number => {
    const r = lanesRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.min(span - 1, Math.floor(t * span));
  };
  const scrubbing = useRef(false);
  const onScrubDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (playing || e.button !== 0) return;
    scrubbing.current = true;
    capture(e);
    lp.setScrub(frameAt(e.clientX));
  };
  const onScrubMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) lp.setScrub(frameAt(e.clientX));
  };
  const onScrubUp = () => {
    scrubbing.current = false;
  };
  // THE MARKED PART: drag along the ruler to mark a stretch (snapping to beats;
  // Shift = free); Play then repeats just it, and Export can render only it. A plain click
  // still moves the playhead. Marking is not an edit (never an Undo step).
  const rulerPress = useRef<{ x: number; f0: number; marking: boolean } | null>(null);
  const [partDraft, setPartDraft] = useState<{ start: number; end: number } | null>(null);
  const snapBeat = (f: number, free: boolean): number => {
    if (free) return f;
    let best = f;
    let d = Infinity;
    for (const b of beatFrames(bpm, meta.fps, meta.beatOffsetSec ?? 0, span)) {
      const k = Math.abs(b.frame - f);
      if (k < d) [best, d] = [b.frame, k];
    }
    return best;
  };
  // The playhead's handle: drag it to move the playhead. Grabbed during playback it follows the
  // drag, then Play carries on from where it was let go (the paused-playhead path).
  const gripResume = useRef(false);
  const onGripDown = (e: RPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || recording) return;
    e.stopPropagation(); // not a press on the ruler (that would mark a part)
    capture(e);
    gripResume.current = playing;
    if (playing) lp.pause(liveAbsFrame());
    scrubbing.current = true;
    lp.setScrub(frameAt(e.clientX));
  };
  const onGripMove = (e: RPointerEvent<HTMLSpanElement>) => {
    if (scrubbing.current) lp.setScrub(frameAt(e.clientX));
  };
  const onGripUp = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    if (gripResume.current) lp.setTransport('playing');
    gripResume.current = false;
  };
  const onRulerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    capture(e);
    rulerPress.current = { x: e.clientX, f0: frameAt(e.clientX), marking: false };
    onScrubDown(e);
  };
  const onRulerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = rulerPress.current;
    if (!p) return;
    if (!p.marking && Math.abs(e.clientX - p.x) > 5) {
      p.marking = true;
      scrubbing.current = false;
    }
    if (!p.marking) return onScrubMove(e);
    const a = snapBeat(p.f0, e.shiftKey);
    const b = snapBeat(frameAt(e.clientX), e.shiftKey);
    setPartDraft({ start: Math.min(a, b), end: Math.max(a, b) });
  };
  const onRulerUp = () => {
    const p = rulerPress.current;
    rulerPress.current = null;
    onScrubUp();
    // A plain click during playback jumps there and keeps playing.
    if (p && !p.marking && transport === 'playing') {
      lp.pause(liveAbsFrame());
      lp.setScrub(p.f0);
      lp.setTransport('playing');
    }
    if (p?.marking && partDraft && partDraft.end - partDraft.start >= 1) {
      lp.setPart(partDraft);
      notifyBanner('Part marked — Play repeats it · ✕ on it to clear');
    }
    setPartDraft(null);
  };
  const shownPart = partDraft ?? part;

  // ---- CLIPS: every row is a TRACK of clips, edited with FilmCraft's
  // algebra (core/timeline-edit): drag a clip = move (never overwrites), drag an edge =
  // trim, Alt-drag = slip (which part of a video shows), snapping to the playhead, clip
  // edges, whole seconds and the loop end (hold Shift to place freely). Every gesture
  // commits ONE undo step at release; the strip only drafts while you drag.
  const mediaOf = (n: SceneNode): MediaLen => {
    const rec = findRecord(n.assetId);
    return rec && rec.kind === 'video' ? rec.frameCount : null;
  };
  const clipsOf = (n: SceneNode): TimelineClip[] =>
    n.clips ?? [{ id: `${n.id}:c0`, start: 0, duration: videoF, sourceIn: 0 }];
  const newClipId = (n: SceneNode): string => {
    const have = new Set(clipsOf(n).map((c) => c.id));
    let k = have.size;
    while (have.has(`${n.id}:c${k}`)) k++;
    return `${n.id}:c${k}`;
  };
  const commit = (n: SceneNode, clips: TimelineClip[]) => {
    useSceneStore.getState().setClips(n.id, clips);
  };

  // The strip spans the VIDEO — with no song, plus some room after its end, so
  // dragging a bar out there makes the video longer. Stable while dragging (the draft only
  // commits at release). A drawn lane (J2b) spans the video itself (timelineSpan).
  const span = songOn ? videoF : videoF + Math.max(F, Math.round(videoF * 0.25));
  useEffect(() => {
    spanRef.current = span;
  }, [span]);

  // ---- Zoom: the ruler + lanes widen by `zoom` inside a horizontal
  // scroller; the ruler follows the lanes' scroll. Positions stay % of span, so every
  // drag/scrub/clip computation is unchanged. Zooming keeps the view's centre in place.
  const [zoom, setZoom] = useState<number>(1);
  const rulerWin = useRef<HTMLDivElement>(null);
  const laneWin = useRef<HTMLDivElement>(null);
  const keepCentre = useRef<number | null>(null);
  const [laneW, setLaneW] = useState(600);
  useEffect(() => {
    const el = laneWin.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const zoomBy = (d: number) => {
    const i = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))];
    if (next === zoom) return;
    const el = laneWin.current;
    keepCentre.current = el ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : null;
    setZoom(next);
  };
  useLayoutEffect(() => {
    const el = laneWin.current;
    const c = keepCentre.current;
    keepCentre.current = null;
    if (!el || c === null) return;
    el.scrollLeft = c * el.scrollWidth - el.clientWidth / 2;
    if (rulerWin.current) rulerWin.current.scrollLeft = el.scrollLeft;
  }, [zoom]);
  const pxPerSec = (laneW * zoom - TL_END_INSET) / Math.max(1e-6, span / meta.fps);
  // The ruler counts BARS from bar 1 (J1); the label step keeps numbers apart at this zoom.
  const barSec = (BEATS_PER_BAR * 60) / bpm;
  const barStep = BAR_STEPS.find((b) => b * barSec * pxPerSec >= 36) ?? 256;
  const barTicks = beatFrames(bpm, meta.fps, meta.beatOffsetSec ?? 0, span).filter(
    (b) => b.beat % (BEATS_PER_BAR * barStep) === 0,
  );

  const [sel, setSel] = useState<{ nodeId: string; clipId: string } | null>(null);
  const [draft, setDraft] = useState<{ nodeId: string; clips: TimelineClip[] } | null>(null);
  // The live draft also sits in a ref, written in the move handler itself, so a fast
  // release never commits a stale position (a render may not have happened yet).
  const draftRef = useRef<{ nodeId: string; clips: TimelineClip[] } | null>(null);
  const gRef = useRef<{
    kind: 'move' | 'in' | 'out' | 'slip' | 'stretchIn' | 'stretchOut' | 'fadeIn' | 'fadeOut';
    node: SceneNode;
    clipId: string;
    x0: number;
    base: TimelineClip[];
    fpp: number;
    moved: boolean;
  } | null>(null);
  const snapTargets = (nodeId: string, clipId: string): number[] => {
    const t = [0, F];
    if (scrub !== null) t.push(scrub);
    // Snap to the beat grid (J1, FL Studio); Shift places freely.
    for (const b of beatFrames(bpm, meta.fps, meta.beatOffsetSec ?? 0, span)) t.push(b.frame);
    for (const n of stack)
      for (const c of clipsOf(n))
        if (!(n.id === nodeId && c.id === clipId)) t.push(c.start, clipEnd(c));
    return t;
  };
  const onClipDown = (
    e: RPointerEvent<HTMLElement>,
    n: SceneNode,
    c: TimelineClip,
    kind: 'move' | 'in' | 'out' | 'fadeIn' | 'fadeOut',
  ) => {
    if (playing || e.button !== 0) return;
    e.stopPropagation();
    capture(e);
    setSel({ nodeId: n.id, clipId: c.id });
    useSceneStore.getState().setSelection([n.id]);
    const r = lanesRef.current?.getBoundingClientRect();
    gRef.current = {
      // Alt-drag the body = slip; Ctrl-drag an edge = rate stretch (same media, new speed)
      kind:
        kind === 'move' && e.altKey && mediaOf(n) !== null
          ? 'slip'
          : (kind === 'in' || kind === 'out') && (e.ctrlKey || e.metaKey)
            ? kind === 'in'
              ? 'stretchIn'
              : 'stretchOut'
            : kind,
      node: n,
      clipId: c.id,
      x0: e.clientX,
      base: clipsOf(n),
      fpp: r && r.width ? span / r.width : 0,
      moved: false,
    };
  };
  const onClipMove = (e: RPointerEvent<HTMLElement>) => {
    const g = gRef.current;
    if (!g) return;
    if (!g.moved && Math.abs(e.clientX - g.x0) < 3) return;
    g.moved = true;
    const dx = Math.round((e.clientX - g.x0) * g.fpp);
    const media = mediaOf(g.node);
    const c0 = g.base.find((c) => c.id === g.clipId);
    if (!c0) return;
    const thr = Math.max(1, Math.round(6 * g.fpp));
    const targets = e.shiftKey ? [] : snapTargets(g.node.id, g.clipId);
    let clips: TimelineClip[];
    if (g.kind === 'move') {
      const want = c0.start + dx;
      const byStart = snapFrame(want, targets, thr);
      const byEnd = snapFrame(want + c0.duration, targets, thr) - c0.duration;
      clips = moveClip(g.base, g.clipId, byStart !== want ? byStart : byEnd, span).clips;
    } else if (g.kind === 'in') {
      const t = snapFrame(c0.start + dx, targets, thr);
      clips = trim(g.base, g.clipId, 'in', t - c0.start, media, span).clips;
    } else if (g.kind === 'out') {
      const t = snapFrame(clipEnd(c0) + dx, targets, thr);
      clips = trim(g.base, g.clipId, 'out', t - clipEnd(c0), media, span).clips;
    } else if (g.kind === 'stretchIn') {
      const t = snapFrame(c0.start + dx, targets, thr);
      clips = rateStretch(g.base, g.clipId, 'in', t - c0.start, span).clips;
    } else if (g.kind === 'stretchOut') {
      const t = snapFrame(clipEnd(c0) + dx, targets, thr);
      clips = rateStretch(g.base, g.clipId, 'out', t - clipEnd(c0), span).clips;
    } else if (g.kind === 'fadeIn') {
      clips = setFades(g.base, g.clipId, (c0.fadeIn ?? 0) + dx, c0.fadeOut ?? 0);
    } else if (g.kind === 'fadeOut') {
      clips = setFades(g.base, g.clipId, c0.fadeIn ?? 0, (c0.fadeOut ?? 0) - dx);
    } else {
      clips = slip(g.base, g.clipId, -dx, media).clips; // drag right → the picture slides right
    }
    const next = { nodeId: g.node.id, clips };
    draftRef.current = next;
    setDraft(next);
  };
  const onClipUp = () => {
    const g = gRef.current;
    gRef.current = null;
    const d = draftRef.current;
    draftRef.current = null;
    if (g?.moved && d && d.nodeId === g.node.id) commit(g.node, d.clips);
    setDraft(null);
  };

  // ---- Clip actions: Split (at the playhead), Duplicate, Delete, Reset timing ----
  const selNode = sel
    ? nodes.find((n) => n.id === sel.nodeId)
    : selected.length === 1
      ? nodes.find((n) => n.id === selected[0])
      : undefined;
  const selClipValid = !!(sel && selNode && clipsOf(selNode).some((c) => c.id === sel.clipId));
  const doSplit = (n: SceneNode | undefined = selNode, t: number = scrub ?? 0) => {
    if (!n) return notifyBanner('Select a layer, then put the playhead where to cut');
    const r = splitAt(clipsOf(n), t, newClipId(n));
    if (!r) return notifyBanner('The playhead isn’t inside a clip on that layer');
    commit(n, r.clips);
    setSel({ nodeId: n.id, clipId: r.rightId });
  };
  const doDelete = (n: SceneNode | undefined = selNode, clipId = sel?.clipId) => {
    if (!n || !clipId) return;
    commit(n, deleteClip(clipsOf(n), clipId));
    setSel(null);
  };
  const doDuplicate = (n: SceneNode | undefined = selNode, clipId = sel?.clipId) => {
    if (!n || !clipId) return;
    const id = newClipId(n);
    const next = duplicateClip(clipsOf(n), clipId, id, span);
    if (!next)
      return notifyBanner('No room right after that clip — make a gap or lengthen the loop');
    commit(n, next);
    setSel({ nodeId: n.id, clipId: id });
  };
  const [clipMenu, setClipMenu] = useState<{
    nodeId: string;
    clipId: string;
    frame: number;
    x: number;
    y: number;
  } | null>(null);

  // Keys while the strip is open: S = split at the playhead, Delete = delete the clip.
  const keysRef = useRef({ doSplit, doDelete, playing, selClipValid });
  useEffect(() => {
    keysRef.current = { doSplit, doDelete, playing, selClipValid };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = keysRef.current;
      if (k.playing) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        k.doSplit();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && k.selClipValid) {
        e.preventDefault();
        k.doDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Row drag-reorder (same rule as the Layers list) ----
  const [rowDrag, setRowDrag] = useState<{ id: string; over: number } | null>(null);
  const rowPress = useRef<{ id: string; y: number; moved: boolean } | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<LayerMenuAt | null>(null);
  const slotAt = (clientY: number): number => {
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>('[data-slot]') ?? [];
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (clientY < b.top + b.height / 2) return Number(r.dataset.slot);
    }
    return stack.length - 1;
  };

  // ---- Drawn lanes (J2b): a thin lane per drawn setting under its row (the canvas's under
  // a "Whole canvas" row); a ▾ on the row folds them. A lane's name opens it in Animate.
  const beatSnaps = beatFrames(bpm, meta.fps, meta.beatOffsetSec ?? 0, span).map((b) => b.frame);
  const drawnOf = (mods: ModMap | undefined): [ModParam, readonly DrawnPoint[]][] =>
    (Object.keys(mods ?? {}) as ModParam[]).flatMap((p) => {
      const m = mods?.[p];
      return m?.kind === 'drawn' ? [[p, m.points] as [ModParam, readonly DrawnPoint[]]] : [];
    });
  const canvasLanes = drawnOf(canvasMods);
  const foldBtn = (id: string) => {
    const shut = folded.includes(id);
    return (
      <button
        type="button"
        className="tl-fold"
        aria-expanded={!shut}
        title={shut ? 'Show its drawn lanes' : 'Fold its drawn lanes away'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggleLaneFold(id);
        }}
      >
        {shut ? '▸' : '▾'}
      </button>
    );
  };
  const laneHeads = (nodeId: string, node: SceneNode | undefined, lanes: [ModParam, unknown][]) =>
    folded.includes(nodeId)
      ? null
      : lanes.map(([p]) => (
          <div
            key={`lane:${p}`}
            data-lane={modKey(nodeId, p)}
            className="tl-name tl-name--auto"
            title="This setting follows its timeline lane — click to open it in Animate"
            onClick={() => {
              const st = useSceneStore.getState();
              if (nodeId) st.setSelection([nodeId]);
              else st.clearSelection();
              openMove(`mod:${p}`, true);
            }}
          >
            <span className="tl-name-txt">{paramInfo(p, node).label}</span>
            <LaneRange param={p} node={node} />
          </div>
        ));
  const laneRows = (
    nodeId: string,
    node: SceneNode | undefined,
    lanes: [ModParam, readonly DrawnPoint[]][],
  ) =>
    folded.includes(nodeId)
      ? null
      : lanes.map(([p, points]) => (
          <DrawnLane
            key={`lane:${p}`}
            nodeId={nodeId}
            node={node}
            param={p}
            points={points}
            span={span}
            beats={beatSnaps}
            fps={meta.fps}
          />
        ));

  // The song's waveform over the whole span (cheap: ~6k samples per second).
  const peaks = trackName ? trackPeaks(120, span / meta.fps) : null;

  const speaker = (id: string, label: string) => {
    // Sound is one switch under the hood (meta.withAudio); with no master button on the
    // strip, a row reads muted while it's off and its click turns sound on for this row.
    const muted = !meta.withAudio || audioMuted.includes(id);
    return (
      <button
        type="button"
        className={`tl-spk${muted ? ' is-muted' : ''}`}
        aria-pressed={muted}
        title={muted ? `Unmute ${label}` : `Mute ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!meta.withAudio) {
            lp.setWithAudio(true);
            if (audioMuted.includes(id)) lp.toggleAudioMute(id);
          } else lp.toggleAudioMute(id);
        }}
      >
        {muted ? '🔇' : '🔊'}
        <span
          className="tl-meter"
          ref={(el) => {
            if (el) meterRefs.current.set(id, el);
            else meterRefs.current.delete(id);
          }}
        />
      </button>
    );
  };

  const pct = (frames: number) => `${Math.min(100, Math.max(0, (frames / span) * 100))}%`;

  // The loop bracket on the ruler: the PICKED layer's loop — its first
  // pass, a tick at every repeat. With no loop it is hidden, except while
  // an open Free take makes one, which the per-frame tick draws.
  const picked = selected.length === 1 ? nodes.find((n) => n.id === selected[0]) : undefined;
  const pickedLoop = picked ? layerLoops[picked.id] : undefined;
  const passes = picked && pickedLoop ? loopMarks(clipsOf(picked), pickedLoop, F, []).passes : [];
  const firstPass = passes.find((p) => p.first) ?? passes[0];
  const followId = firstPass ? undefined : (picked?.id ?? null);
  useEffect(() => {
    loopFollow.current = followId === undefined ? null : { id: followId };
    if (loopRef.current) loopRef.current.style.display = followId === undefined ? '' : 'none';
  }, [followId]);
  const loopTag = pickedLoop
    ? pickedLoop.bars
      ? `${pickedLoop.bars} bar${pickedLoop.bars === 1 ? '' : 's'}`
      : `${+(pickedLoop.frames / meta.fps).toFixed(1)}s`
    : lengthLabel.split(' · ')[0];

  return (
    <div className="tl" role="region" aria-label="Animate timeline">
      {menu && <LayerMenu at={menu} onClose={() => setMenu(null)} />}
      {clipMenu && (
        <ClipMenu
          at={clipMenu}
          onClose={() => setClipMenu(null)}
          onSplit={() => {
            const n = nodes.find((x) => x.id === clipMenu.nodeId);
            doSplit(n, clipMenu.frame);
          }}
          onDuplicate={() =>
            doDuplicate(
              nodes.find((x) => x.id === clipMenu.nodeId),
              clipMenu.clipId,
            )
          }
          onDelete={() =>
            doDelete(
              nodes.find((x) => x.id === clipMenu.nodeId),
              clipMenu.clipId,
            )
          }
          canSpeed={(() => {
            const n = nodes.find((x) => x.id === clipMenu.nodeId);
            return !!n && mediaOf(n) !== null;
          })()}
          onSpeed={(sp) => {
            const n = nodes.find((x) => x.id === clipMenu.nodeId);
            if (n) commit(n, setSpeed(clipsOf(n), clipMenu.clipId, sp, span));
          }}
          onClearFades={() => {
            const n = nodes.find((x) => x.id === clipMenu.nodeId);
            if (n) commit(n, setFades(clipsOf(n), clipMenu.clipId, 0, 0));
          }}
          onReset={() => {
            useSceneStore.getState().setClips(clipMenu.nodeId, undefined);
            setSel(null);
          }}
          takes={takeBlocks(events, clipMenu.nodeId).map(([pass, t], i) => ({
            label: `take ${
              nodes.find((x) => x.id === clipMenu.nodeId)?.kind === 'recording'
                ? i + 1
                : takes.indexOf(pass) + 1
            }`,
            muted: mutedLayers.includes(t.layer),
            onToggle: () => lp.toggleMute(t.layer),
          }))}
          recording={(() => {
            const n = nodes.find((x) => x.id === clipMenu.nodeId);
            if (n?.kind !== 'recording') return undefined;
            return {
              others: nodes
                .filter((x) => x.kind === 'recording' && x.id !== n.id && !isEmptyRecording(x))
                .map((x) => ({ id: x.id, name: names.get(x.id) ?? 'Recording' })),
              backwards: !!n.rec?.backwards,
              onMerge: (other: string) => mergeRecordingInto(n.id, other),
              onBackwards: () =>
                useSceneStore.getState().setRecordingPlay(n.id, { backwards: !n.rec?.backwards }),
              onKeep: () => keepAsDrawing(n.id),
              onSave: () => void saveRecordingToLibrary(n.id, names.get(n.id) ?? 'Recording'),
              onUndoTake: () => undoTake(n.id),
              canUndoTake: !recording && takeBlocks(events, n.id).length > 0,
              locked: recording,
            };
          })()}
        />
      )}
      <div className="tl-bar">
        <button
          type="button"
          className={`deck-load tl-rec${recording ? ' is-arm' : ''}`}
          aria-pressed={recording}
          title={
            recording
              ? 'Finish this take (keeps playing)'
              : 'Record a take: draw, or drag a layer, while the loop plays'
          }
          aria-label={recording ? 'Finish this take' : 'Record a take'}
          onClick={toggleRecord}
        >
          {recording ? '● REC' : '●'}
        </button>
        <button
          type="button"
          className={`deck-load${playing ? ' is-on' : ''}`}
          aria-pressed={playing}
          disabled={nodes.length === 0}
          title={playing ? 'Pause — the playhead stays where it is' : 'Play from the playhead'}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => (playing ? lp.pause(liveAbsFrame()) : lp.setTransport('playing'))}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="deck-load tl-step"
          title="Back to the start"
          aria-label="Back to the start"
          onClick={() => (playing ? lp.setTransport('stopped') : lp.setScrub(null))}
        >
          ⏮
        </button>
        <span
          className="tl-time"
          ref={timeRef}
          title={`Playhead / the whole video${videoWhy}: as long as the track, or the last layer's bar when there is no track`}
        >
          0:00.0 / {fmtTime(videoF / meta.fps)}
        </span>
        <span className="tl-sep" />
        <span
          className="tl-lbl"
          title="The project tempo in beats per minute (BPM), like FL Studio's"
        >
          Tempo
        </span>
        <input
          className="tl-bpm"
          type="number"
          inputMode="decimal"
          aria-label="Tempo in BPM"
          title={
            tempoLocked
              ? 'The tempo is fixed once takes exist (it would re-time the loop)'
              : 'Type a tempo, or scroll / use the arrow keys'
          }
          min={BPM_MIN}
          max={BPM_MAX}
          step={1}
          disabled={tempoLocked}
          value={bpmDraft ?? String(+bpm.toFixed(2))}
          onChange={(e) => setBpmDraft(e.target.value)}
          onBlur={() => {
            if (bpmDraft !== null) setBpm(Number(bpmDraft));
            setBpmDraft(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setBpmDraft(null);
              e.currentTarget.blur();
            }
          }}
        />
        <BarPop
          label="▾"
          title={
            recording
              ? 'Finish the take first'
              : 'Set the tempo by tapping, or detect it from the track'
          }
          aria="Tempo options"
          disabled={recording}
        >
          <button
            type="button"
            className="deck-load"
            disabled={tempoLocked}
            title="Tap tempo: click in time with the beat (a few taps)"
            onClick={(e) => onTap(e.timeStamp)}
          >
            Tap
          </button>
          {trackName && (
            <button
              type="button"
              className="deck-load"
              disabled={tempoLocked || detecting}
              title="Detect the track's tempo and line bar 1 up with its first beat"
              onClick={onDetect}
            >
              {detecting ? 'Detecting…' : 'Detect'}
            </button>
          )}
        </BarPop>
        <span className="tl-sep" />
        <span
          className="tl-lbl"
          title={`The loop a new recording repeats, in bars (1 beat = ${(framesPerBeat(bpm, meta.fps) / meta.fps).toFixed(2)} s). Free: as long as you record, to the nearest beat (hold Shift as you stop for exact). A recorded layer keeps its own loop.`}
        >
          Loop
        </span>
        <button
          type="button"
          className="deck-load tl-step"
          disabled={lengthLocked}
          title={
            lengthLocked ? 'Finish the take to change the loop' : 'Shorter loop for new recordings'
          }
          onClick={() => stepLength(-1)}
        >
          −
        </button>
        <BarPop
          label={`${lengthLabel} ▾`}
          title={lengthLocked ? 'Finish the take to change the loop' : 'Pick the loop length'}
          aria="Loop length"
          disabled={lengthLocked}
        >
          {(close) =>
            pickList.map((st) => {
              const on = st === stops[curStop];
              return (
                <button
                  key={st.label}
                  type="button"
                  className={`deck-load${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    pickStop(st);
                    close();
                  }}
                >
                  {st.label}
                </button>
              );
            })
          }
        </BarPop>
        <button
          type="button"
          className="deck-load tl-step"
          disabled={lengthLocked}
          title={
            lengthLocked ? 'Finish the take to change the loop' : 'Longer loop for new recordings'
          }
          onClick={() => stepLength(1)}
        >
          +
        </button>
        <span className="tl-sep" />
        <button
          type="button"
          className="deck-load"
          disabled={playing || !selNode}
          title="Split the selected layer's clip at the playhead (S) · right-click a clip to duplicate or delete it"
          aria-label="Split at the playhead"
          onClick={() => doSplit()}
        >
          ✂
        </button>
        <span className="tl-sep" />
        <button
          type="button"
          className="deck-load"
          title={
            trackName
              ? `Track: ${trackName} — click to replace`
              : 'Add a track under the loop (this session)'
          }
          aria-label={trackName ? 'Replace the track' : 'Add a track'}
          disabled={recording}
          onClick={() => songInput.current?.click()}
        >
          {trackName ? '♪' : '♪+'}
        </button>
        <input
          ref={songInput}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            void loadSong(file);
          }}
        />
        <BarPop
          label={hasTakes ? `Recording · ${takes.length} ▾` : 'Recording ▾'}
          title="While you record: slow-mo, the metronome, and your takes"
          aria="Recording options"
        >
          <div className="tl-pop-row">
            <span
              className="tl-lbl"
              title="Record-time speed: slow the loop down while you perform. Export always plays at full speed."
            >
              Slow-mo
            </span>
            <button
              type="button"
              className="deck-load tl-step"
              disabled={speed <= 0.25}
              onClick={() => lp.setSpeed(speed - 0.05)}
            >
              −
            </button>
            <span className="tl-val">{speed.toFixed(2)}×</span>
            <button
              type="button"
              className="deck-load tl-step"
              disabled={speed >= 1}
              onClick={() => lp.setSpeed(speed + 0.05)}
            >
              +
            </button>
          </div>
          <div className="tl-pop-row">
            <span className="tl-lbl">
              Takes {picked?.kind === 'recording' ? takesOn(events, picked.id) : takes.length}/
              {MAX_TAKES}
            </span>
            <button
              type="button"
              className="deck-load"
              disabled={!hasTakes || recording}
              title="Undo the last take"
              aria-label="Undo the last take"
              onClick={() => undoTake()}
            >
              ↶
            </button>
            <button
              type="button"
              className={`deck-load${armClear ? ' is-arm' : ''}`}
              disabled={!hasTakes || recording}
              title="Clear every take (click twice)"
              aria-label="Clear every take"
              onClick={onClear}
            >
              {armClear ? 'Sure?' : <TrashIcon />}
            </button>
          </div>
          <div className="tl-pop-row">
            <span className="tl-lbl">Metronome</span>
            <button
              type="button"
              className={`deck-load${cueSound ? ' is-on' : ''}`}
              aria-pressed={cueSound}
              title="Metronome: a click each time the loop starts over while playing or recording, to help you time takes (not in the export)"
              aria-label="Metronome"
              onClick={() => lp.setCueSound(!cueSound)}
            >
              <MetronomeIcon />
            </button>
          </div>
        </BarPop>
        <span className="tl-zoom">
          <button
            type="button"
            className="deck-load tl-step"
            disabled={zoom === ZOOMS[0]}
            title="Zoom out (see more of the video)"
            aria-label="Zoom out"
            onClick={() => zoomBy(-1)}
          >
            <MagIcon plus={false} />
          </button>
          <button
            type="button"
            className="deck-load tl-step"
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            title="Zoom in (finer timing)"
            aria-label="Zoom in"
            onClick={() => zoomBy(1)}
          >
            <MagIcon plus />
          </button>
        </span>
        <button
          type="button"
          className="scr-chip tl-close"
          title="Close the timeline"
          onClick={() => {
            lp.setScrub(null);
            lp.setAnimate(false);
          }}
        >
          ✕
        </button>
      </div>

      <div className="tl-grid">
        <div className="tl-head" />
        <div className="tl-hwin" ref={rulerWin}>
          <div className="tl-hpad" style={{ width: `${zoom * 100}%` }}>
            <div
              className="tl-ruler"
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              title="Click to move the playhead · drag along it to mark a part (Play repeats it; Shift = no snapping)"
            >
              <span
                className={`tl-grip${!playing && scrub === null ? ' is-rest' : ''}${recording ? ' is-off' : ''}`}
                ref={gripRef}
                title="Drag to move the playhead"
                onPointerDown={onGripDown}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onPointerCancel={onGripUp}
              />
              {shownPart && (
                <span
                  className="tl-part"
                  style={{
                    left: pct(shownPart.start),
                    width: pct(shownPart.end - shownPart.start),
                  }}
                >
                  {!partDraft && (
                    <button
                      type="button"
                      className="tl-part-x"
                      title="Clear the marked part (play the whole video)"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => lp.setPart(null)}
                    >
                      ✕
                    </button>
                  )}
                </span>
              )}
              {span > videoF && (
                <span className="tl-end-mark" style={{ left: pct(videoF) }}>
                  end
                </span>
              )}
              <span
                className="tl-loop"
                ref={loopRef}
                style={
                  firstPass && {
                    left: pct(firstPass.at),
                    width: pct(Math.min(firstPass.len, span - firstPass.at)),
                  }
                }
              >
                <span className="tl-loop-txt">Loop {loopTag}</span>
              </span>
              {passes.map(
                (p) =>
                  p !== firstPass &&
                  p.at < span && (
                    <span key={p.at} className="tl-loop-tick" style={{ left: pct(p.at) }} />
                  ),
              )}
              {barTicks.map((b) => (
                <span key={b.beat} className="tl-tick" style={{ left: pct(b.frame) }}>
                  {b.beat / BEATS_PER_BAR + 1}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="tl-rows" ref={rowsRef}>
        <div className="tl-grid">
          <div className="tl-heads">
            {trackName && (
              <div className="tl-name tl-name--song">
                <span>♪ Track</span>
                {speaker('track', 'the track')}
                <button
                  type="button"
                  className="tl-spk"
                  title="Remove the track"
                  onClick={() => {
                    clearTrack();
                    notifyBanner('Track removed');
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            {canvasLanes.length > 0 && (
              <>
                <div
                  className="tl-name tl-name--canvas"
                  title="The whole canvas's timeline lanes (Dot size, Density)"
                >
                  {foldBtn('')}
                  <span className="tl-name-txt">Whole canvas</span>
                  <button
                    type="button"
                    className="tl-spk"
                    title="Remove the whole canvas's timeline lanes (Undo brings them back)"
                    onClick={() =>
                      asOneStep(() => {
                        for (const [p] of canvasLanes) useSceneStore.getState().setMod('', p, null);
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
                {laneHeads('', undefined, canvasLanes)}
              </>
            )}
            {stack.map((n, i) => {
              const isSel = selected.includes(n.id);
              const drag = rowDrag?.id === n.id;
              const drop = rowDrag && !drag && rowDrag.over === i;
              const lanes = drawnOf(n.mods);
              return (
                <Fragment key={n.id}>
                  <div
                    data-slot={i}
                    className={`tl-name${n.kind === 'recording' ? ' is-rec' : ''}${isSel ? ' is-sel' : ''}${drag ? ' is-drag' : ''}${drop ? ' is-drop' : ''}${n.hidden ? ' is-hidden' : ''}`}
                    title="Select · drag up or down to reorder · right-click for Hide / Duplicate / Delete"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        nodeId: n.id,
                        name: names.get(n.id) ?? 'Layer',
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    onPointerDown={(e) => {
                      if (playing || e.button !== 0) return;
                      rowPress.current = { id: n.id, y: e.clientY, moved: false };
                      capture(e);
                    }}
                    onPointerMove={(e) => {
                      const p = rowPress.current;
                      if (!p || (!p.moved && Math.abs(e.clientY - p.y) < 5)) return;
                      p.moved = true;
                      setRowDrag({ id: p.id, over: slotAt(e.clientY) });
                    }}
                    onPointerUp={() => {
                      const p = rowPress.current;
                      rowPress.current = null;
                      if (p?.moved && rowDrag) {
                        useSceneStore
                          .getState()
                          .moveLayer(rowDrag.id, stack.length - 1 - rowDrag.over);
                      } else if (p) useSceneStore.getState().setSelection([n.id]);
                      setRowDrag(null);
                    }}
                  >
                    {lanes.length > 0 && foldBtn(n.id)}
                    <span className="tl-name-txt">
                      {n.kind === 'recording' && '● '}
                      {names.get(n.id)}
                      <MoveMark node={n} />
                    </span>
                    {isVideoAsset(n.assetId) && speaker(n.assetId, `${names.get(n.id)}'s sound`)}
                  </div>
                  {laneHeads(n.id, n, lanes)}
                </Fragment>
              );
            })}
          </div>

          <div
            className="tl-hwin tl-hwin--scroll"
            ref={laneWin}
            onScroll={(e) => {
              if (rulerWin.current) rulerWin.current.scrollLeft = e.currentTarget.scrollLeft;
            }}
          >
            <div className="tl-hpad" style={{ width: `${zoom * 100}%` }}>
              <div
                className="tl-lanes"
                ref={lanesRef}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
              >
                {trackName && (
                  <div className="tl-lane">
                    <div className="tl-wave">
                      {(peaks ?? []).map((p, k) => (
                        <i key={k} style={{ height: `${Math.max(6, p * 100)}%` }} />
                      ))}
                    </div>
                  </div>
                )}
                {canvasLanes.length > 0 && (
                  <>
                    <div className="tl-lane" />
                    {laneRows('', undefined, canvasLanes)}
                  </>
                )}
                {stack.map((n) => {
                  const kind = layerKind(n);
                  const isRec = kind === 'recording';
                  const ownLoop = layerLoops[n.id];
                  // A recording playing backwards shows its takes where they now play.
                  const blocks = takeBlocks(events, n.id, ownLoop?.frames).map(
                    ([pass, t]) =>
                      [
                        pass,
                        isRec && n.rec?.backwards && ownLoop
                          ? {
                              ...t,
                              a: ownLoop.frames - 1 - t.b,
                              b: ownLoop.frames - 1 - t.a,
                            }
                          : t,
                      ] as const,
                  );
                  // A recording waiting for its first stroke has no bar yet.
                  const clips =
                    draft && draft.nodeId === n.id
                      ? draft.clips
                      : isEmptyRecording(n)
                        ? []
                        : clipsOf(n);
                  const seam = isRec && ownLoop ? drawnEnd(clips, ownLoop) : null;
                  const holding = !!seam && !!n.rec?.hold;
                  // While a take is open its strokes run past any loop it had (ui/take).
                  let marks = loopMarks(
                    clips,
                    recording ? liveLayerLoops()[n.id] : ownLoop,
                    F,
                    blocks,
                  );
                  // In the Hold stretch nothing repeats: only the first pass is marked.
                  if (holding && seam)
                    marks = {
                      ...marks,
                      reps: marks.reps.filter((f) => f < seam.at),
                      takes: marks.takes.filter((m) => m.a < seam.at),
                    };
                  const media = mediaOf(n);
                  return (
                    <Fragment key={n.id}>
                      <div className={`tl-lane${selected.includes(n.id) ? ' is-sel' : ''}`}>
                        {clips.map((c) => {
                          const isSel = sel?.nodeId === n.id && sel.clipId === c.id;
                          const sec = (f: number) => (f / meta.fps).toFixed(1);
                          const label =
                            media !== null
                              ? `${sec(c.sourceIn)}s – ${sec(sourceOut(c))}s`
                              : `${sec(c.start)}s – ${sec(clipEnd(c))}s`;
                          return (
                            <div
                              key={c.id}
                              className={`tl-clip tl-clip--${isRec ? 'rec' : media !== null ? 'video' : 'still'}${isSel ? ' is-sel' : ''}`}
                              style={{ left: pct(c.start), width: pct(c.duration) }}
                              title={
                                media !== null
                                  ? 'Drag to move · drag an edge to make it longer or shorter (past the end it plays again) · Ctrl-drag an edge to change its speed · Alt-drag to slip which part shows · the small top dots fade in/out · right-click for takes and more'
                                  : 'Drag to move · drag an edge to make it longer or shorter (its loop repeats) · Ctrl-drag an edge to make its loop slower or faster · the small top dots fade in/out · right-click for takes and more'
                              }
                              onPointerDown={(e) => onClipDown(e, n, c, 'move')}
                              onPointerMove={onClipMove}
                              onPointerUp={onClipUp}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSel({ nodeId: n.id, clipId: c.id });
                                setClipMenu({
                                  nodeId: n.id,
                                  clipId: c.id,
                                  frame: frameAt(e.clientX),
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
                              <span
                                className="tl-trim tl-trim--a"
                                onPointerDown={(e) => onClipDown(e, n, c, 'in')}
                                onPointerMove={onClipMove}
                                onPointerUp={onClipUp}
                              />
                              {!!c.fadeIn && (
                                <span
                                  className="tl-fade-wedge tl-fade-wedge--a"
                                  style={{ width: `${(c.fadeIn / c.duration) * 100}%` }}
                                />
                              )}
                              {!!c.fadeOut && (
                                <span
                                  className="tl-fade-wedge tl-fade-wedge--b"
                                  style={{ width: `${(c.fadeOut / c.duration) * 100}%` }}
                                />
                              )}
                              <span
                                className="tl-fade tl-fade--a"
                                style={{
                                  left: `calc(${((c.fadeIn ?? 0) / c.duration) * 100}% + 8px)`,
                                }}
                                title="Drag right to fade in"
                                onPointerDown={(e) => onClipDown(e, n, c, 'fadeIn')}
                                onPointerMove={onClipMove}
                                onPointerUp={onClipUp}
                              />
                              <span
                                className="tl-fade tl-fade--b"
                                style={{
                                  right: `calc(${((c.fadeOut ?? 0) / c.duration) * 100}% + 8px)`,
                                }}
                                title="Drag left to fade out"
                                onPointerDown={(e) => onClipDown(e, n, c, 'fadeOut')}
                                onPointerMove={onClipMove}
                                onPointerUp={onClipUp}
                              />
                              <span className="tl-clip-txt">
                                {clipSpeed(c) !== 1 && (
                                  <b className="tl-speed">{+clipSpeed(c).toFixed(2)}× </b>
                                )}
                                {kind === 'photo' || kind === 'drawing' || kind === 'element'
                                  ? `${n.motion ? `Motion · ${n.motion.type} · ` : ''}${label}`
                                  : label}
                              </span>
                              <span
                                className="tl-trim tl-trim--b"
                                onPointerDown={(e) => onClipDown(e, n, c, 'out')}
                                onPointerMove={onClipMove}
                                onPointerUp={onClipUp}
                              />
                            </div>
                          );
                        })}
                        {holding &&
                          seam?.stretches.map((s) => (
                            <span
                              key={`h${s.a}`}
                              className="tl-held"
                              style={{ left: pct(s.a), width: pct(s.b - s.a) }}
                            />
                          ))}
                        {marks.reps.map((f) => (
                          <span key={`r${f}`} className="tl-rep" style={{ left: pct(f) }} />
                        ))}
                        {marks.takes.map((m, k) => (
                          <span
                            key={`t${m.pass}:${m.a}:${k}`}
                            className={`tl-take-mark${isRec ? ' is-rec' : ''}${mutedLayers.includes(m.layer) ? ' is-muted' : ''}`}
                            style={{ left: pct(m.a), width: `max(2px, ${pct(m.b - m.a)})` }}
                          />
                        ))}
                        {seam && (
                          <button
                            type="button"
                            className="tl-seam-chip"
                            style={{ left: pct(seam.at) }}
                            disabled={playing}
                            title={
                              holding
                                ? 'Past its drawing it holds the finished picture: click to repeat'
                                : 'Past its drawing it repeats from blank: click to hold the finished picture'
                            }
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              useSceneStore.getState().setRecordingPlay(n.id, { hold: !holding });
                            }}
                          >
                            {holding ? '▬ HOLD' : '⟳ REPEAT'}
                          </button>
                        )}
                      </div>
                      {laneRows(n.id, n, drawnOf(n.mods))}
                    </Fragment>
                  );
                })}
                {shownPart && (
                  <div
                    className="tl-part-band"
                    style={{
                      left: pct(shownPart.start),
                      width: pct(shownPart.end - shownPart.start),
                    }}
                  />
                )}
                {span > videoF && <div className="tl-after" style={{ left: pct(videoF) }} />}
                <div
                  className={`tl-head-line${!playing && scrub === null ? ' is-rest' : ''}`}
                  ref={headRef}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Right-click on a clip: Split here · Duplicate · Delete clip · Reset timing (the layer
 *  back to always-on). Closes on any click elsewhere or Escape. */
function ClipMenu({
  at,
  onClose,
  onSplit,
  onDuplicate,
  onDelete,
  onReset,
  canSpeed,
  onSpeed,
  onClearFades,
  takes,
  recording,
}: {
  at: { x: number; y: number };
  onClose: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onReset: () => void;
  canSpeed: boolean;
  onSpeed: (speed: number) => void;
  onClearFades: () => void;
  /** The layer's recorded takes (muting lives here, not on separate blocks). */
  takes: { label: string; muted: boolean; onToggle: () => void }[];
  /** A recording's own edits; absent on every other layer. */
  recording?: {
    others: { id: string; name: string }[];
    backwards: boolean;
    onMerge: (other: string) => void;
    onBackwards: () => void;
    onKeep: () => void;
    onSave: () => void;
    onUndoTake: () => void;
    canUndoTake: boolean;
    /** Mid-take its own edits wait: the take is still writing to it. */
    locked: boolean;
  };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [merging, setMerging] = useState(false);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  // Keep the whole menu on screen: open upward when it would run past the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 4)
      el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
  }, [at, takes.length, merging]);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      ref={ref}
      className="layer-menu"
      role="menu"
      aria-label="Clip options"
      style={{
        left: Math.min(at.x, window.innerWidth - 180),
        top: at.y,
      }}
    >
      <span className="layer-menu-title">Clip</span>
      <button type="button" role="menuitem" onClick={act(onSplit)}>
        Split here
      </button>
      <button type="button" role="menuitem" onClick={act(onDuplicate)}>
        Duplicate
      </button>
      <button type="button" role="menuitem" className="layer-menu-danger" onClick={act(onDelete)}>
        Delete clip
      </button>
      {canSpeed && (
        <div className="layer-menu-row" role="group" aria-label="Clip speed">
          <span>Speed</span>
          {[0.25, 0.5, 1, 2, 4].map((sp) => (
            <button key={sp} type="button" role="menuitem" onClick={act(() => onSpeed(sp))}>
              {sp}×
            </button>
          ))}
        </div>
      )}
      <button type="button" role="menuitem" onClick={act(onClearFades)}>
        Clear fades
      </button>
      <button type="button" role="menuitem" onClick={act(onReset)}>
        Reset timing
      </button>
      {takes.length > 0 && <span className="layer-menu-title">Takes</span>}
      {takes.map((t) => (
        <button key={t.label} type="button" role="menuitem" onClick={act(t.onToggle)}>
          {t.muted ? `Unmute ${t.label}` : `Mute ${t.label}`}
        </button>
      ))}
      {recording && (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={!recording.canUndoTake}
            onClick={act(recording.onUndoTake)}
          >
            Undo take
          </button>
          <span className="layer-menu-title">Recording</span>
          <button
            type="button"
            role="menuitem"
            aria-expanded={merging}
            disabled={recording.locked || recording.others.length === 0}
            title={
              recording.locked
                ? 'Finish the take first'
                : recording.others.length === 0
                  ? 'There is no other recording'
                  : undefined
            }
            onClick={() => setMerging((m) => !m)}
          >
            Merge with ▸
          </button>
          {merging &&
            recording.others.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                className="layer-menu-sub"
                onClick={act(() => recording.onMerge(o.id))}
              >
                {o.name}
              </button>
            ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={recording.backwards}
            disabled={recording.locked}
            title={recording.locked ? 'Finish the take first' : undefined}
            onClick={act(recording.onBackwards)}
          >
            {recording.backwards ? '✓ Play backwards' : 'Play backwards'}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={recording.locked}
            title={recording.locked ? 'Finish the take first' : undefined}
            onClick={act(recording.onKeep)}
          >
            Keep as drawing
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={recording.locked}
            title={recording.locked ? 'Finish the take first' : undefined}
            onClick={act(recording.onSave)}
          >
            Save to Library
          </button>
        </>
      )}
    </div>
  );
}
