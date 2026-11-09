// =============================================================================
// The LIVE audio engine (P6 v13, as amended 2026-07-03). Three jobs,
// nothing else: DECODE the Loop-Sound sources, PLAY the canonical mix, and
// ANCHOR the loop clock. All audio MATH lives in core/loop-audio (pure) — this
// module is the Web-Audio shell around it.
//
//  - The Loop Sound is the MIX (locked): every placed video's audio (trimmed to
//    its clip window, tiled modulo its clip length — exactly like its frames) +
//    an imported session-transient track on top, minus the audio-muted sources.
//  - Live reactions read the pre-analyzed features[frame] (loop-store), computed
//    HERE from the same mix — never a live AnalyserNode. Preview == export.
//  - The speed knob drives AudioBufferSourceNode.playbackRate (tape-style pitch
//    drop at <1×, locked — never muted); re-anchoring on each change keeps
//    enginePhase() exact, and SceneStage's rAF adopts that phase as the master
//    clock whenever audio is playing.
//
// The deterministic export NEVER imports this module (the lint enforces it) —
// v15 rebuilds the same canonical buffer from the same pure inputs instead.
// =============================================================================
import {
  AUDIO_RATE,
  audioSourceKey,
  clipSampleCount,
  frameClipsToSamples,
  type LoopAudioSource,
  type SampleClip,
  type StereoPcm,
} from '../core/loop-audio';
import { liveTotalFrames as coreLiveTotalFrames } from '../core/export-length';
import { motionPeriodFrames } from '../core/loop-events';
import { BEATS_PER_BAR, BPM_DEFAULT, type BeatClock } from '../core/tempo';
import { detectTempo } from '../core/tempo-detect';
import { notifyBanner } from '../state/notify-store';
import { layerTick } from '../core/video-frames';
import { analyzeLoopAudio } from '../engine-cpu/loop-audio-client';
import { decodeAudioPcm } from '../platform/audio-decode';
import { useLoopStore, type AudioSourceInfo } from '../state/loop-store';
import { useSceneStore } from '../state/scene-store';
import { findRecord, getAssetBytes } from './session-assets';
import { openTakeFrame } from './take';

interface EngineSource extends LoopAudioSource {
  info: AudioSourceInfo;
}

/** Decoded per-video audio, keyed by (source hash + TRIM window) — NOT videoHash
 *  alone: the decoded PCM is trimmed to [inSeconds, outSeconds), and two Library
 *  variants of one source (same bytes, different trim) share a videoHash but are
 *  distinct clips with distinct audio. Keying by the trim mirrors the frame cache
 *  (video-assets keys by rec.id) and keeps the live mix == a deterministic export
 *  recompute. Look-only variants (same trim, different palette) still dedupe. */
// The song + decoded clip audio live on ONE window-wide object, like the playhead below: a
// dev hot-reload can leave two copies of this module running, and a copy that couldn't see
// the song would rebuild the mix without it and wipe every reaction (owner report).
const shared: {
  track: { name: string; pcm: StereoPcm; bytes?: Uint8Array } | null;
  videoPcm: Map<string, StereoPcm | null>;
} = ((
  globalThis as unknown as {
    __dtAudio?: {
      track: { name: string; pcm: StereoPcm; bytes?: Uint8Array } | null;
      videoPcm: Map<string, StereoPcm | null>;
    };
  }
).__dtAudio ??= { track: null, videoPcm: new Map() });
const videoPcm = shared.videoPcm;

let ctx: AudioContext | null = null;
let srcNode: AudioBufferSourceNode | null = null;
let mix: StereoPcm | null = null;
// TWO CLOCKS. The playing buffer covers T_live (the live absolute cycle,
// coreLiveTotalFrames) and loops there; the anchor tracks the ABSOLUTE phase in
// [0,1) over that whole buffer. absPhase(t) = (anchorAbsPhase + (t − anchorTime) ·
// rate / totalSec) mod 1. The LOOP phase enginePhase() derives from it (existing
// callers unchanged); engineAbsFrame() gives the absolute frame the visuals adopt.
// When T_live == F (no track, no outlasting clip) totalFrames == loopFrames and both
// accessors are byte-identical to before.
let totalSec = 1; // T_live / fps — the buffer duration
let loopFrames = 1; // F
let totalFrames = 1; // T_live
let anchorTime = 0;
let anchorAbsPhase = 0;
let rate = 1;
let playing = false;
let syncSeq = 0;
let trackSeq = 0;
let inited = false;
// SceneStage publishes its live rAF phase here each tick (publishLoopPhase) so the
// engine can resume audio at the CURRENT ABSOLUTE position — not snap to 0 — when
// audio is enabled or un-muted mid-play.
let externalAbsPhase = 0;

const ensureCtx = (): AudioContext => (ctx ??= new AudioContext());

/** The stretch the buffer repeats, in seconds: the MARKED PART, else the
 *  whole video. */
function regionSec(): { a: number; b: number } {
  const part = useLoopStore.getState().part;
  const fps = Math.max(1, totalFrames / totalSec);
  if (!part) return { a: 0, b: totalSec };
  const a = Math.min(Math.max(0, part.start / fps), totalSec);
  const b = Math.min(Math.max(a + 1 / fps, part.end / fps), totalSec);
  return b > a ? { a, b } : { a: 0, b: totalSec };
}

/** The raw ABSOLUTE buffer phase in [0,1) over the whole T_live buffer, or null when
 *  audio isn't running. Past the end of the repeated stretch (the marked part, else the
 *  whole video) it wraps to its start — exactly the buffer source's own loopStart /
 *  loopEnd. The two public accessors + the resume/re-anchor paths all read from this one
 *  anchor so they can never drift. */
function currentAbsPhase(): number | null {
  if (!playing || !srcNode || !ctx) return null;
  let sec = anchorAbsPhase * totalSec + (ctx.currentTime - anchorTime) * rate;
  const { a, b } = regionSec();
  if (sec >= b) sec = a + ((sec - a) % (b - a));
  return (((sec / totalSec) % 1) + 1) % 1;
}

/** The audio-master LOOP phase in [0,1), or null when audio isn't running (the rAF
 *  clock stays the owner then). SceneStage adopts this each tick. Derived from the
 *  absolute phase: absFrame = absPhase · T_live, loop phase = (absFrame / F) mod 1.
 *  When T_live == F this equals the absolute phase, byte-identical to before. */
export function enginePhase(): number | null {
  const abs = currentAbsPhase();
  if (abs == null) return null;
  const p = (abs * totalFrames) / Math.max(1, loopFrames);
  return ((p % 1) + 1) % 1;
}

/** The audio-master ABSOLUTE frame in [0, T_live), or null when audio isn't running.
 *  The visuals adopt this while the mix plays so the live preview shows the same
 *  absolute stretch the export renders (K1 — preview == export). */
export function engineAbsFrame(): number | null {
  const abs = currentAbsPhase();
  if (abs == null) return null;
  return Math.min(totalFrames - 1, Math.floor(abs * totalFrames));
}

function stopSource(): void {
  if (srcNode) {
    try {
      srcNode.stop();
    } catch {
      /* already stopped */
    }
    srcNode.disconnect();
    srcNode = null;
  }
}

/** (Re)start playback of the current mix at `absPhase` (of the whole T_live buffer,
 *  [0,1)). The buffer loops at T_live, so playback wraps there. */
function startSource(absPhase: number): void {
  stopSource();
  if (!mix || mix.left.length === 0) return;
  const ac = ensureCtx();
  void ac.resume();
  const buf = ac.createBuffer(2, mix.left.length, AUDIO_RATE);
  // copyToChannel wants an ArrayBuffer-backed view; our planar arrays are.
  buf.copyToChannel(mix.left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(mix.right as Float32Array<ArrayBuffer>, 1);
  const node = ac.createBufferSource();
  node.buffer = buf;
  node.loop = true;
  // The marked part repeats on its own; a start outside it begins at its start.
  const { a, b } = regionSec();
  node.loopStart = a;
  node.loopEnd = b;
  let at = (((absPhase % 1) + 1) % 1) * totalSec;
  if (at < a || at >= b) at = a;
  node.playbackRate.value = rate;
  node.connect(ac.destination);
  node.start(0, at);
  srcNode = node;
  anchorTime = ac.currentTime;
  anchorAbsPhase = at / totalSec;
}

/** Gather the CURRENT Loop-Sound sources (decoded + trimmed, cache-backed) — the
 *  ONE list builder `resync` (live) and `exportAudioInputs` (v15 export) share,
 *  so the exported mix can never drift from the live one. Decodes fill the
 *  videoPcm cache; repeat calls are cache hits. */
async function gatherSources(): Promise<EngineSource[]> {
  const nodes = useSceneStore.getState().nodes;
  const sources: EngineSource[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.assetId)) continue;
    seen.add(n.assetId);
    const rec = findRecord(n.assetId);
    if (!rec || rec.kind !== 'video') continue;
    const pcmKey = audioSourceKey(rec.videoHash, rec.inSeconds, rec.outSeconds);
    if (!videoPcm.has(pcmKey)) {
      const bytes = await getAssetBytes(rec.videoHash); // source-addressed (session or Library)
      videoPcm.set(
        pcmKey,
        bytes ? await decodeAudioPcm(bytes, rec.inSeconds, rec.outSeconds) : null,
      );
    }
    const pcm = videoPcm.get(pcmKey);
    if (!pcm) continue; // silent clip
    sources.push({
      pcm,
      clipSamples: clipSampleCount(rec.frameCount, rec.fps),
      // A TIMED layer (3b) sounds only inside its clips — the picture's own timing.
      ...(n.clips ? { clips: frameClipsToSamples(n.clips, rec.fps) } : {}),
      info: { id: n.assetId, kind: 'video', label: 'video' },
    });
  }
  if (shared.track)
    sources.push({
      pcm: shared.track.pcm,
      clipSamples: shared.track.pcm.left.length,
      info: { id: 'track', kind: 'track', label: shared.track.name },
    });
  return sources;
}

/** The v15 export's audio inputs: the UNMUTED Loop-Sound sources as PLAIN DATA
 *  (pcm + tile length) + the stored seam-fade flag, or null when Loop Sound is
 *  off / everything is muted / silent. The deterministic exporter rebuilds the
 *  canonical mix from these — it never imports this module (the lint). */
export async function exportAudioInputs(): Promise<{
  sources: { pcm: StereoPcm; clipSamples: number; clips?: SampleClip[] }[];
  seamFade: boolean;
} | null> {
  const loop = useLoopStore.getState();
  if (!loop.meta.withAudio) return null;
  const sources = await gatherSources();
  const unmuted = sources.filter((s) => !loop.audioMuted.includes(s.info.id));
  if (unmuted.length === 0) return null;
  return {
    sources: unmuted.map(({ pcm, clipSamples, clips }) => ({
      pcm,
      clipSamples,
      ...(clips ? { clips } : {}),
    })),
    seamFade: loop.meta.seamFade,
  };
}

/** Rebuild the mix + features from the current sources/mutes/meta. Async (decode
 *  runs the codec); a sequence guard drops superseded runs. */
async function resync(): Promise<void> {
  const seq = ++syncSeq;
  const loop = useLoopStore.getState();
  const { withAudio, frames, fps, seamFade } = loop.meta;

  if (!withAudio) {
    stopSource();
    playing = false;
    if (loop.features !== null) loop.setFeatures(null);
    if (loop.audioSources.length) loop.setAudioSources([]);
    return;
  }

  // 1. Decode every placed video's audio once via the ONE shared gatherer (also
  //    the v15 export's). A superseded resync bails after the await — its
  //    decodes stay in the cache, so nothing is wasted.
  const sources = await gatherSources();
  if (seq !== syncSeq) return;

  const cur = useLoopStore.getState();
  const infos = sources.map((s) => s.info);
  if (JSON.stringify(infos) !== JSON.stringify(cur.audioSources)) cur.setAudioSources(infos);

  // 2. The canonical mix of the UNMUTED sources (post-mute — WYSIWYG), then the
  //    features from that same mix. No sources → silence, no features. TWO CLOCKS:
  //    the mix + features now cover T_live (the live absolute cycle),
  //    computed from the SAME scene/track the visuals read (liveTotalFrames), so the
  //    features array indexes ABSOLUTE frames and reactivity tracks the whole track /
  //    outlasting clip live. T_live == F (no track, no outlasting clip) collapses
  //    every call to today's F-length buffer, byte-identical.
  const unmuted = sources.filter((s) => !cur.audioMuted.includes(s.info.id));
  const tLive = liveTotalFrames();
  // Capture the current absolute position on the OLD clock before re-anchoring, so a
  // resync mid-play resumes at the same fractional spot in the buffer.
  const resumeAbs = playing ? currentAbsPhase() : null;
  loopFrames = Math.max(1, frames);
  totalFrames = Math.max(1, tLive);
  totalSec = Math.max(1e-6, totalFrames / Math.max(1, fps));
  if (unmuted.length === 0) {
    mix = null;
    stopSource();
    if (cur.features !== null) cur.setFeatures(null);
    return;
  }
  // The HEAVY step (buildLoopAudioMix + preAnalyze) runs OFF the main thread (F6):
  // with T_live in the thousands of frames it costs seconds, and doing it inline froze
  // the UI on every audio toggle. The worker runs the SAME pure core functions, so the
  // mix/features are byte-identical (no behaviour change). A newer resync during the
  // await supersedes this one via syncSeq — drop the stale result.
  const analysis = await analyzeLoopAudio({
    sources: unmuted.map(({ pcm, clipSamples, clips }) => ({
      pcm,
      clipSamples,
      ...(clips ? { clips } : {}),
    })),
    frames,
    fps,
    seamFade,
    rate: AUDIO_RATE,
    totalFrames: tLive,
  });
  if (seq !== syncSeq) return;
  mix = analysis.mix;
  cur.setFeatures(analysis.features);

  // 3. If the loop is running, swap the buffer in at the CURRENT ABSOLUTE position —
  //    from the engine's own clock if already anchored, else from SceneStage's
  //    published absolute phase (audio enabled / un-muted mid-play must not snap the
  //    visual to 0).
  if (playing) startSource(resumeAbs ?? externalAbsPhase);
  else if (cur.transport !== 'stopped') {
    playing = true;
    startSource(externalAbsPhase);
  }
}

/** The imported track's length in frames — ceil(trackSamples / AUDIO_RATE · fps),
 *  the track's EXACT length (the export picker's "Track" option); null when no track
 *  is imported. An absolute-timeline source: it advances across the whole export. */
export function trackFrames(fps: number): number | null {
  if (!shared.track) return null;
  return Math.ceil((shared.track.pcm.left.length / AUDIO_RATE) * Math.max(1, fps));
}

/** T_live — the LIVE absolute cycle length in frames (K1/K2). Max over the absolute-
 *  timeline sources (each rounded UP to a multiple of F): every untimed video whose
 *  footage OUTLASTS the loop (visual — mute-independent), the end of every layer's last
 *  clip on the song and, when Loop Sound is on, an imported track that isn't
 *  audio-muted. No such source → F (today, byte-identical).
 *  Computed synchronously from the scene + Library records so the visuals (SceneStage)
 *  and the audio buffer (resync) share one T_live. */
export function liveTotalFrames(): number {
  const loop = useLoopStore.getState();
  const { frames: F, fps, withAudio } = loop.meta;
  const abs: number[] = [];
  const nodes = useSceneStore.getState().nodes;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.assetId)) continue;
    seen.add(n.assetId);
    const rec = findRecord(n.assetId);
    if (rec && rec.kind === 'video' && rec.frameCount > F && !n.clips) abs.push(rec.frameCount);
  }
  // Every layer's bar sits on the song: the video lasts at least to the end of
  // the last one.
  for (const n of nodes) for (const c of n.clips ?? []) abs.push(c.start + c.duration);
  // An untimed layer with its own loop covers at least one pass of it (it repeats over the
  // whole video, so where the loop starts doesn't lengthen it).
  for (const n of nodes) {
    const l = loop.layerLoops[n.id];
    if (l && !n.clips) abs.push(l.frames);
  }
  let songF: number | null = null;
  if (withAudio && !loop.audioMuted.includes('track')) {
    songF = trackFrames(fps);
    if (songF != null) abs.push(songF);
  }
  // A Free take still recording with no song to end it keeps the video going (a looper).
  const open = openTakeFrame();
  if (open != null && songF == null) abs.push(open + F);
  // Slow motions and long Waves stretch the live clock to whole trips.
  const { canvasMods, canvasMotion } = useSceneStore.getState();
  return coreLiveTotalFrames(
    F,
    abs,
    motionPeriodFrames(F, nodes, loop.events, beatClock(), canvasMods, canvasMotion),
  );
}

/** The frame the song ends on, when one is in the mix: nothing recorded runs past it. */
export function songEndFrame(): number | null {
  const { meta, audioMuted } = useLoopStore.getState();
  if (!meta.withAudio || audioMuted.includes('track')) return null;
  return trackFrames(Math.max(1, meta.fps));
}

/** FL's "Detect tempo" (J1): read the loaded song's tempo and line bar 1 up with its
 *  first downbeat — one undo step. Returns false (and says so) when there's no clear beat. */
export async function detectSongTempo(): Promise<boolean> {
  const t = shared.track;
  if (!t) return false;
  const est = detectTempo(t.pcm.left, t.pcm.right, AUDIO_RATE);
  if (!est || est.confidence < 1.15) {
    notifyBanner("Couldn't find a clear beat in this track — type or tap the tempo instead");
    return false;
  }
  useLoopStore.getState().setLength({ bpm: est.bpm, beatOffsetSec: est.offsetSec });
  notifyBanner(`Tempo ${est.bpm} BPM — bar 1 lined up with the track`);
  return true;
}

/** The project's beat clock (J1) from the loop meta — the song sets the time when one is
 *  loaded, else the loop does (core/tempo). The live canvas and the export both build it
 *  here, so a tempo-synced motion previews exactly as it exports. */
export function beatClock(): BeatClock {
  const m = useLoopStore.getState().meta;
  return {
    bpm: m.bpm ?? BPM_DEFAULT,
    fps: m.fps,
    offsetSec: m.beatOffsetSec ?? 0,
    frames: Math.max(1, m.frames),
    loopBeats:
      (m.lengthMode === 'bars' || m.lengthMode === 'free') && m.bars
        ? m.bars * BEATS_PER_BAR
        : null,
    song: !!shared.track,
  };
}

/** Import the canvas's song. Its original bytes are kept beside the decoded PCM so a
 *  project stores the file, not the samples. A monotonic guard drops a
 *  superseded decode so two rapid imports can't land out of order. */
export async function importTrack(name: string, bytes: Uint8Array): Promise<boolean> {
  const seq = ++trackSeq;
  const pcm = await decodeAudioPcm(bytes);
  if (seq !== trackSeq) return false; // a newer import (or a clear) superseded this
  if (!pcm) return false;
  shared.track = { name, pcm, bytes };
  useLoopStore.getState().setTrackName(name);
  void resync();
  return true;
}

/** The song's name + original file bytes (projects store these), or null. */
export function currentTrackFile(): { name: string; bytes: Uint8Array } | null {
  const t = shared.track;
  return t?.bytes ? { name: t.name, bytes: t.bytes } : null;
}

/** Remove the imported track from the mix (also supersedes any in-flight import so
 *  a slow decode can't resurrect a just-cleared track). */
export function clearTrack(): void {
  trackSeq++;
  shared.track = null;
  useLoopStore.getState().setTrackName(null);
  void resync();
}

/** SceneStage publishes its current rAF phase here every tick — both the LOOP phase
 *  (unused by the engine today, kept for call-site symmetry) and the ABSOLUTE phase
 *  in [0,1) over the T_live buffer, so the engine can resume mid-play at the same
 *  absolute stretch the visuals show (K1). `absPhase` defaults to `phase` so the
 *  T_live == F case (and the Stop reset) publishes the loop phase unchanged. */
export function publishLoopPhase(phase: number, absPhase: number = phase): void {
  externalAbsPhase = ((absPhase % 1) + 1) % 1;
  livePhase.abs = externalAbsPhase;
  livePhase.loop = ((phase % 1) + 1) % 1;
}

// The playhead's live position lives on ONE window-wide object, so a dev hot-reload that
// re-creates this module can never leave the timeline reading a stale copy (owner report).
const livePhase: { abs: number; loop: number } = ((
  globalThis as unknown as { __dtLivePhase?: { abs: number; loop: number } }
).__dtLivePhase ??= { abs: 0, loop: 0 });
/** The live ABSOLUTE frame the visuals are showing — the timeline playhead (a clip
 *  longer than the loop keeps advancing across loop passes). */
export function liveAbsFrame(): number {
  return Math.floor(livePhase.abs * Math.max(1, liveTotalFrames()));
}

/** The imported song's peak envelope over the first `seconds` (one value 0..1 per
 *  bucket) — the timeline strip draws it as the song row's waveform. Null without a song. */
export function trackPeaks(buckets: number, seconds: number): number[] | null {
  if (!shared.track) return null;
  const { left, right } = shared.track.pcm;
  const n = left.length;
  // Buckets cover the REQUESTED span; past the song's end they read silent (0).
  const per = Math.max(1, Math.floor((seconds * AUDIO_RATE) / buckets));
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const end = Math.min(n, (b + 1) * per);
    for (let i = b * per; i < end; i += 16) {
      const v = Math.abs(left[i]) + Math.abs(right[i]);
      if (v > peak) peak = v;
    }
    out.push(Math.min(1, peak / 2));
  }
  return out;
}

/** One source's loudness (0..1, RMS) around absolute frame `absFrame` — the timeline
 *  strip's level meter. Reads the SAME decoded PCM the mix is built from;
 *  'track' is the imported song, otherwise a video layer's asset id. 0 when unknown. */
export function sourceLevel(id: string, absFrame: number): number {
  const loop = useLoopStore.getState();
  const fps = Math.max(1, loop.meta.fps);
  let pcm: StereoPcm | null | undefined;
  let start: number;
  if (id === 'track') {
    pcm = shared.track?.pcm;
    start = Math.floor((absFrame / fps) * AUDIO_RATE);
  } else {
    const rec = findRecord(id);
    if (!rec || rec.kind !== 'video') return 0;
    pcm = videoPcm.get(audioSourceKey(rec.videoHash, rec.inSeconds, rec.outSeconds));
    const node = useSceneStore.getState().nodes.find((n) => n.assetId === id);
    const tick = layerTick(node?.clips, absFrame, rec.frameCount);
    if (tick === null) return 0; // off at this moment
    start = Math.floor((tick / rec.fps) * AUDIO_RATE);
  }
  if (!pcm || pcm.left.length === 0) return 0;
  const n = pcm.left.length;
  const win = Math.floor(AUDIO_RATE / fps);
  let sum = 0;
  for (let i = 0; i < win; i++) {
    const j = (((start + i) % n) + n) % n;
    const v = (pcm.left[j] + pcm.right[j]) * 0.5;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / win) * 2.5);
}

/** A short LIVE cue click at a loop boundary (the visual pulse's audio twin). A
 *  transient oscillator on the shared context — NEVER the canonical mix, so it
 *  can't reach the export. `accent` = the downbeat (loop start), a touch higher +
 *  louder than an ordinary tick. */
export function playCueTick(accent: boolean): void {
  const ac = ensureCtx();
  void ac.resume();
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = accent ? 1320 : 880;
  const peak = accent ? 0.28 : 0.16;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

// ---- GC accessors (W6 / P9): evict decoded PCM for unreachable sources -------
// The videoPcm cache grows one entry per (source hash + trim window) ever placed;
// a long Record session that adds/removes many clips accumulates decoded audio that
// nothing plays anymore. The reachability sweep (ui/scene-gc) computes which source
// keys are still reachable from the scene ∪ its zundo history and evicts the rest.
// The single AudioContext / srcNode / imported track are each ONE reused reference
// (not per-source), so they don't accumulate — only videoPcm needs bounding.

/** The decoded-PCM cache keys currently held (one per reachable-or-stale source). */
export function audioPcmKeys(): string[] {
  return [...videoPcm.keys()];
}

/** Evict decoded PCM whose key is NOT in `keep`. A `keep` set is the reachable
 *  source keys (audioSourceKey per in-scene / in-history video). Returns the freed
 *  keys + approximate bytes (Float32 stereo). A null entry (silent/failed decode)
 *  frees 0 bytes but is still dropped so it can be re-attempted later. */
export function evictAudioPcm(keep: ReadonlySet<string>): { keys: string[]; bytes: number } {
  const freed: string[] = [];
  let bytes = 0;
  for (const key of [...videoPcm.keys()]) {
    if (keep.has(key)) continue;
    const pcm = videoPcm.get(key);
    if (pcm) bytes += (pcm.left.length + pcm.right.length) * 4;
    videoPcm.delete(key);
    freed.push(key);
  }
  return { keys: freed, bytes };
}

/** TEST SEAM (W6): seed a decoded-PCM entry so the headless GC test can prove
 *  eviction without a live decode (which needs the codec). App code never
 *  calls this — the engine fills videoPcm through resync's decode path. */
export function _seedAudioPcmForTest(key: string, pcm: StereoPcm | null): void {
  videoPcm.set(key, pcm);
}

/** Wire the engine to the stores. Idempotent; called from SceneStage mount. */
export function initAudioEngine(): void {
  if (inited) return;
  inited = true;

  useLoopStore.subscribe((s, prev) => {
    // Transport: start/stop playback with the loop (phase 0 on start, matching
    // SceneStage's phase reset on stop).
    if (s.transport !== prev.transport) {
      if (s.transport === 'stopped') {
        playing = false;
        stopSource();
      } else if (prev.transport === 'stopped' && s.meta.withAudio) {
        playing = true;
        // Resume from the paused / scrubbed playhead (absolute frame), else the top.
        startSource(s.resumeFrame !== null ? s.resumeFrame / Math.max(1, liveTotalFrames()) : 0);
      }
    }
    // Speed: tape-style playbackRate follow (locked) — re-anchor so the phase
    // math stays exact through the change.
    if (s.speed !== prev.speed && srcNode && ctx) {
      anchorAbsPhase = currentAbsPhase() ?? 0;
      anchorTime = ctx.currentTime;
      rate = s.speed;
      srcNode.playbackRate.value = s.speed;
    } else if (s.speed !== prev.speed) {
      rate = s.speed;
    }
    // Mix inputs: the toggle, the fade, the loop length, the mutes.
    if (
      s.meta.withAudio !== prev.meta.withAudio ||
      s.meta.seamFade !== prev.meta.seamFade ||
      s.meta.frames !== prev.meta.frames ||
      s.meta.fps !== prev.meta.fps ||
      s.audioMuted !== prev.audioMuted ||
      s.layerLoops !== prev.layerLoops
    )
      void resync();
    // A new marked part while playing: carry on from here inside it.
    else if (s.part !== prev.part && playing && srcNode) startSource(currentAbsPhase() ?? 0);
  });

  // Scene changes (a video placed/removed) change the source set.
  useSceneStore.subscribe((s, prev) => {
    if (s.nodes !== prev.nodes) void resync();
  });

  rate = useLoopStore.getState().speed;
  void resync();
}
