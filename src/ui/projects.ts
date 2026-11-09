// =============================================================================
// PROJECTS. The whole editable
// canvas — layers, drawings, look, clips, takes, motion, reactions, visualizers, the
// song, loop length — saves itself as a project inside the app (projectStore: this
// device's storage, desktop + web alike) and reopens exactly; undo starts fresh.
//
//   - ALWAYS auto-save: every edit (history.onEdit) and every non-undo change (takes,
//     mutes, the song, aspect…) marks the project dirty; it saves ~1.5 s after the last
//     change (never mid-playback — it waits for Stop) and on leaving the page. The app
//     reopens the last project. A blank new canvas only becomes a project on its first
//     edit, so launching never litters empty projects.
//   - Media travels INSIDE the project (content-addressed, stored once): original
//     photo / video / song files, drawing rasters, cut-out masks. Visualizers and the
//     song analysis are regenerated on open.
//   - Recovery: the store keeps earlier saves; a project that won't open falls back to
//     its newest good version.
//   - Files: Save as file / Open file (.dithtill = one self-contained file).
// =============================================================================
import { create } from 'zustand';
import { useSceneStore, reserveNodeIds, hasDrawnRaster } from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { LOOP_META_DEFAULT, reserveReactionIds, useLoopStore } from '../state/loop-store';
import { notifyBanner, notifyConfirm } from '../state/notify-store';
import {
  decodeProjectFile,
  encodeProjectFile,
  makeProjectDoc,
  projectBlobHashes,
  sillyProjectName,
  type ImageMedia,
  type PaintMedia,
  type ProjectBody,
  type ProjectDoc,
  type RecordMedia,
} from '../core/project-format';
import { sha256Hex, type AssetRecord } from '../core/library';
import { renderStillPng } from '../core/loop-render';
import { projectStore, type ProjectMeta, type ProjectRecord } from '../platform/project-db';
import { saveBytesToDisk } from '../platform/save-png';
import { getAssetCache, ensureAssets } from './scene-assets';
import {
  findRecord,
  getAssetBytes,
  registerSessionAsset,
  registerSessionBlob,
  sessionDuration,
} from './session-assets';
import { photoMask, photoSourceBytes, restorePhoto } from './image-layers';
import { restorePaintAsset } from './paint-node';
import { restoreVisualizerAsset } from './visualizer-node';
// Text layers redraw from their config whenever the nodes change (a reopened project too).
import './text-node';
import { clearTrack, currentTrackFile, importTrack } from './audio-engine';
import { onEdit, resetHistory } from './history';
import { currentSceneBackground, resolveCurrentScene, restingAssets } from './record-actions';
import { sweepSceneAssets } from './scene-gc';

const GENERATOR = 'DithTill';
/** localStorage: the project the app reopens. */
const CURRENT_KEY = 'dithtill:project';
/** Quiet time after the last change before an auto-save. */
const SAVE_DELAY_MS = 1500;

export interface ProjectsState {
  /** The open project's id; null = a fresh canvas not saved yet (becomes a project on
   *  its first edit). */
  currentId: string | null;
  /** The open project's name (a fresh canvas already has its silly name). */
  name: string;
  list: ProjectMeta[];
  /** Bytes of project media on this device. */
  bytesUsed: number;
  ready: boolean;
}

export const useProjects = create<ProjectsState>(() => ({
  currentId: null,
  name: '',
  list: [],
  bytesUsed: 0,
  ready: false,
}));

const random = (): number => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
};
const freshName = (): string =>
  sillyProjectName(random, new Set(useProjects.getState().list.map((p) => p.name)));

const storageGet = (): string | null => {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
};
const storageSet = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* best effort */
  }
};

// ---- capture ---------------------------------------------------------------------------

const hashCache = new WeakMap<Uint8Array, string>();
async function hashOf(b: Uint8Array): Promise<string> {
  const have = hashCache.get(b);
  if (have) return have;
  const h = await sha256Hex(b);
  hashCache.set(b, h);
  return h;
}

/** Every `…Hash` a record names (tones, covered, png, fine, ink, video). */
const recordHashes = (rec: AssetRecord): string[] =>
  Object.entries(rec)
    .filter(([k, v]) => k.endsWith('Hash') && typeof v === 'string' && v)
    .map(([, v]) => v as string);

/** The whole editable canvas as a project body + its media blobs. */
export async function captureProject(
  name: string,
): Promise<{ body: ProjectBody; blobs: Map<string, Uint8Array> }> {
  const scene = useSceneStore.getState();
  const burn = useBurnStore.getState();
  const loop = useLoopStore.getState();
  const cache = getAssetCache();
  const blobs = new Map<string, Uint8Array>();
  const put = async (b: Uint8Array): Promise<string> => {
    const h = await hashOf(b);
    blobs.set(h, b);
    return h;
  };

  const paints: PaintMedia[] = [];
  const images = new Map<string, ImageMedia>();
  const records: RecordMedia[] = [];
  const seen = new Set<string>();
  for (const n of scene.nodes) {
    if (n.kind === 'image') {
      let img = images.get(n.assetId);
      if (!img) {
        const src = await photoSourceBytes(n.assetId);
        if (!src) continue;
        img = { assetId: n.assetId, mime: src.mime, bytes: await put(src.bytes), masks: [] };
        images.set(n.assetId, img);
      }
      // Duplicated photos share a source but may carry different cut-outs.
      const key = n.image?.matte;
      const mask = key ? photoMask(key) : undefined;
      if (key && mask && !img.masks.some((m) => m.key === key))
        img.masks.push({ key, alpha: await put(mask) });
      continue;
    }
    if (seen.has(n.assetId)) continue;
    seen.add(n.assetId);
    if (hasDrawnRaster(n)) {
      const a = cache.get(n.assetId);
      if (!a) continue;
      // Strokes rewrite these planes in place — save copies.
      paints.push({
        assetId: n.assetId,
        ...(a.per && a.per !== 1 ? { per: a.per } : {}),
        w: a.w,
        h: a.h,
        tones: await put(a.tones.slice()),
        covered: await put(a.covered.slice()),
        ...(a.fine && a.fine.some((v) => v !== 0) ? { fine: await put(a.fine.slice()) } : {}),
      });
    } else if (n.kind === 'asset') {
      const rec = findRecord(n.assetId);
      if (!rec) continue;
      const hashes = recordHashes(rec);
      for (const h of hashes) {
        const b = await getAssetBytes(h);
        if (!b) throw new Error(`a layer's media is missing (${h.slice(0, 8)})`);
        blobs.set(h, b);
      }
      const dur = rec.kind === 'video' ? sessionDuration(rec.videoHash) : undefined;
      records.push({
        record: rec,
        blobs: hashes,
        ...(dur !== undefined ? { durationSec: dur } : {}),
      });
    }
    // Visualizers regenerate from their settings (node.viz) — no media.
  }
  const song = currentTrackFile();
  const body: ProjectBody = {
    name,
    canvas: {
      nodes: scene.nodes,
      scene: scene.scene,
      background: scene.background,
      dotInk: scene.dotInk,
      pixel: scene.pixel,
      aspect: burn.aspect,
      ...(Object.keys(scene.canvasMods).length ? { canvasMods: scene.canvasMods } : {}),
      ...(scene.canvasMotion ? { canvasMotion: scene.canvasMotion } : {}),
      ...(scene.canvasFx ? { canvasFx: scene.canvasFx } : {}),
      detail: scene.detail,
    },
    loop: {
      meta: loop.meta,
      events: loop.events,
      reactions: loop.reactions,
      ...(Object.keys(loop.layerLoops).length ? { layerLoops: loop.layerLoops } : {}),
      ...(loop.part ? { part: loop.part } : {}),
      mutedLayers: loop.mutedLayers,
      audioMuted: loop.audioMuted,
      animate: loop.animate,
    },
    media: {
      paints,
      images: [...images.values()],
      records,
      track: song ? { name: song.name, bytes: await put(song.bytes) } : null,
    },
  };
  return { body, blobs };
}

/** A small PNG of the canvas for the project card ('' for an empty canvas). */
async function thumbnail(): Promise<string> {
  const grid = await resolveCurrentScene();
  if (!grid) return '';
  // The card shows the canvas as the glass does (print screens), small.
  const s = useSceneStore.getState();
  const png = renderStillPng(
    {
      nodes: s.nodes,
      scene: s.scene,
      dims: { w: grid.w, h: grid.h },
      assets: restingAssets(),
      background: currentSceneBackground() ?? null,
      dotInk: s.dotInk,
      canvasFx: s.canvasFx,
    },
    2,
  );
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000)
    bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

// ---- restore ---------------------------------------------------------------------------

/** Suppresses dirty-marking while a project is being loaded / the canvas reset. */
let quiet = 0;

/** Wipe the canvas to a blank new one (no undo — a project switch, not an edit). */
function resetCanvas(): void {
  quiet++;
  try {
    const lp = useLoopStore.getState();
    if (lp.transport !== 'stopped') lp.setTransport('stopped');
    const s0 = useSceneStore.getInitialState();
    useSceneStore.setState({
      nodes: [],
      scene: s0.scene,
      background: s0.background,
      dotInk: s0.dotInk,
      pixel: s0.pixel,
      canvasMods: s0.canvasMods,
      canvasMotion: s0.canvasMotion,
      canvasFx: s0.canvasFx,
      detail: s0.detail,
      selected: [],
      cropId: null,
      rev: useSceneStore.getState().rev + 1,
    });
    const b0 = useBurnStore.getInitialState();
    useBurnStore.setState({ aspect: b0.aspect });
    useLoopStore.setState({
      meta: { ...LOOP_META_DEFAULT },
      events: [],
      reactions: [],
      layerLoops: {},
      part: null,
      mutedLayers: [],
      audioMuted: [],
      animate: false,
      scrub: null,
      resumeFrame: null,
      rev: useLoopStore.getState().rev + 1,
    });
    clearTrack();
    resetHistory();
    sweepSceneAssets();
  } finally {
    quiet--;
  }
}

/** Load a project body onto the canvas. Fetches every blob FIRST, so a damaged project
 *  throws before the current canvas is touched. */
async function applyProject(
  body: ProjectBody,
  getBlob: (hash: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
  const blob = new Map<string, Uint8Array>();
  for (const h of projectBlobHashes(body)) {
    const b = await getBlob(h);
    if (!b) throw new Error('the project is missing some of its media');
    blob.set(h, b);
  }
  const at = (h: string): Uint8Array => blob.get(h) as Uint8Array;

  resetCanvas();
  quiet++;
  try {
    // The Detail first: photos and videos below render at it.
    useSceneStore.setState({ detail: body.canvas.detail ?? 'normal' });
    // 1. Media first, under the SAVED ids, so the nodes find them when they arrive.
    for (const r of body.media.records) {
      const [first, ...rest] = r.blobs;
      if (!first) continue;
      const videoHash = r.record.kind === 'video' ? r.record.videoHash : first;
      registerSessionAsset(r.record, { hash: videoHash, data: at(videoHash) }, r.durationSec);
      for (const h of [first, ...rest]) registerSessionBlob(h, at(h));
    }
    for (const p of body.media.paints)
      restorePaintAsset(p.assetId, {
        w: p.w,
        h: p.h,
        tones: at(p.tones).slice(),
        covered: at(p.covered).slice(),
        ...(p.fine ? { fine: at(p.fine).slice() } : {}),
        ...(p.per ? { per: p.per } : {}),
      });
    for (const im of body.media.images)
      await restorePhoto(
        im.assetId,
        { bytes: at(im.bytes), mime: im.mime },
        im.masks.map((m) => ({ key: m.key, alpha: at(m.alpha) })),
      );

    // 2. The canvas + loop state (look/aspect first, so layers render at the right grid).
    const c = body.canvas;
    useBurnStore.setState({ aspect: c.aspect });
    useLoopStore.setState({
      meta: { ...LOOP_META_DEFAULT, ...body.loop.meta },
      // Strokes recorded into a drawing before are dropped, not converted.
      events: body.loop.events.filter(
        (e) =>
          e.kind !== 'paint-reveal' ||
          body.canvas.nodes.some((n) => n.id === e.nodeId && n.kind === 'recording'),
      ),
      reactions: body.loop.reactions,
      layerLoops: body.loop.layerLoops ?? {},
      part: body.loop.part ?? null,
      mutedLayers: body.loop.mutedLayers,
      audioMuted: body.loop.audioMuted,
      animate: body.loop.animate,
      rev: useLoopStore.getState().rev + 1,
    });
    reserveReactionIds(body.loop.reactions.map((r) => r.id));
    for (const n of c.nodes) if (n.kind === 'visualizer') restoreVisualizerAsset(n);
    reserveNodeIds(c.nodes.map((n) => n.id));
    useSceneStore.setState({
      nodes: c.nodes,
      scene: c.scene,
      background: c.background,
      dotInk: c.dotInk,
      pixel: c.pixel,
      canvasMods: c.canvasMods ?? {},
      canvasMotion: c.canvasMotion ?? null,
      canvasFx: c.canvasFx ?? null,
      detail: c.detail ?? 'normal',
      selected: [],
      cropId: null,
      rev: useSceneStore.getState().rev + 1,
    });
    // Library elements + videos build their rasters / players from the records.
    await ensureAssets(c.nodes.filter((n) => n.kind === 'asset').map((n) => n.assetId));
    useSceneStore.getState().bump();
    resetHistory();
  } finally {
    quiet--;
  }
  // 3. The song decodes in the background (the mix + analysis follow it).
  if (body.media.track) void importTrack(body.media.track.name, at(body.media.track.bytes));
}

// ---- auto-save -------------------------------------------------------------------------

let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

function markDirty(): void {
  if (quiet > 0 || !useProjects.getState().ready) return;
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

/** Save now if anything changed (serialised: saves never overlap). */
export function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  chain = chain.then(saveIfDirty, saveIfDirty);
  return chain;
}

async function saveIfDirty(): Promise<void> {
  if (!dirty) return;
  // Never mid-performance: wait for Stop (the transport subscription re-flushes).
  if (useLoopStore.getState().transport !== 'stopped') return;
  const st = useProjects.getState();
  // A blank canvas that was never a project stays one (no empty projects on launch).
  if (!st.currentId && useSceneStore.getState().nodes.length === 0 && !currentTrackFile()) {
    dirty = false;
    return;
  }
  dirty = false;
  try {
    const { body, blobs } = await captureProject(st.name);
    const now = Date.now();
    const id = st.currentId ?? crypto.randomUUID();
    const prev = st.list.find((p) => p.id === id);
    const rec: ProjectRecord = {
      id,
      name: st.name,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      thumbnail: await thumbnail(),
      bytes: mediaBytes(body, blobs),
      doc: makeProjectDoc(body, GENERATOR),
    };
    await projectStore().save(rec, blobs);
    if (!st.currentId) {
      useProjects.setState({ currentId: id });
      storageSet(id);
    }
    await refreshList();
  } catch (e) {
    dirty = true; // try again on the next change
    console.error('Project auto-save failed:', e);
  }
}

/** Bytes of the media a project body names. */
const mediaBytes = (body: ProjectBody, blobs: ReadonlyMap<string, Uint8Array>): number =>
  projectBlobHashes(body).reduce((n, h) => n + (blobs.get(h)?.byteLength ?? 0), 0);

export async function refreshList(): Promise<void> {
  const store = projectStore();
  const [list, bytesUsed] = await Promise.all([store.list(), store.bytesUsed()]);
  useProjects.setState({ list, bytesUsed });
}

// ---- actions ---------------------------------------------------------------------------

/** Start a fresh canvas (the current project is saved first). */
export async function newProject(): Promise<void> {
  await flush();
  resetCanvas();
  dirty = false;
  useProjects.setState({ currentId: null, name: freshName() });
  storageSet(null);
}

/** Open a saved project; falls back to its newest good version if the latest save
 *  can't be opened. */
export async function openProject(id: string): Promise<boolean> {
  await flush();
  const store = projectStore();
  const rec = await store.get(id);
  if (!rec) {
    void notifyConfirm('That project could not be found', 'Open failed');
    return false;
  }
  const getBlob = (h: string): Promise<Uint8Array | undefined> => store.getBlob(h);
  const candidates: ProjectDoc[] = [rec.doc, ...(await store.versions(id)).map((v) => v.doc)];
  for (let i = 0; i < candidates.length; i++) {
    try {
      await applyProject(candidates[i].project, getBlob);
      dirty = false;
      useProjects.setState({ currentId: id, name: rec.name });
      storageSet(id);
      if (i > 0) {
        notifyBanner('The latest save could not be opened — opened an earlier version');
        dirty = true; // make the recovered state the latest save
        void flush();
      }
      return true;
    } catch (e) {
      console.error(`Project ${id} (version ${i}) failed to open:`, e);
    }
  }
  void notifyConfirm('That project could not be opened', 'Open failed');
  return false;
}

/** Rename a project (the open one too). */
export async function renameProject(id: string | null, name: string): Promise<void> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  const st = useProjects.getState();
  if (id === null || id === st.currentId) useProjects.setState({ name: clean });
  if (id) await projectStore().rename(id, clean);
  await refreshList();
}

/** Copy a project (its media is shared, not duplicated). */
export async function duplicateProject(id: string): Promise<void> {
  if (id === useProjects.getState().currentId) await flush();
  const store = projectStore();
  const rec = await store.get(id);
  if (!rec) return;
  const now = Date.now();
  const name = `${rec.name} copy`;
  await store.save(
    {
      ...rec,
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      doc: { ...rec.doc, project: { ...rec.doc.project, name } },
    },
    new Map(),
  );
  await refreshList();
  notifyBanner(`Duplicated as "${name}"`);
}

/** Delete a project (and any media no other project uses). Deleting the open one
 *  starts a fresh canvas. */
export async function deleteProject(id: string): Promise<void> {
  const open = id === useProjects.getState().currentId;
  if (open) {
    if (timer) clearTimeout(timer);
    dirty = false;
  }
  await chain;
  await projectStore().delete(id);
  if (open) {
    resetCanvas();
    useProjects.setState({ currentId: null, name: freshName() });
    storageSet(null);
  }
  await refreshList();
}

/** A name made safe as a file name (no path or reserved characters). */
const safeFileBase = (name: string, fallback: string): string =>
  name.replace(/[\\/:*?"<>|]+/g, '').trim() || fallback;

const fileName = (name: string): string => `${safeFileBase(name, 'project')}.dithtill`;

/** The open project's name as an export file name — exports are named after it. */
export const exportBaseName = (): string => safeFileBase(useProjects.getState().name, 'dithtill');

/** Save a project (default: the open one) as one self-contained .dithtill file. */
export async function saveProjectFile(id?: string): Promise<void> {
  const st = useProjects.getState();
  try {
    let doc: ProjectDoc;
    let blobs: Map<string, Uint8Array>;
    let name: string;
    if (!id || id === st.currentId) {
      const cap = await captureProject(st.name);
      doc = makeProjectDoc(cap.body, GENERATOR);
      blobs = cap.blobs;
      name = st.name;
    } else {
      const store = projectStore();
      const rec = await store.get(id);
      if (!rec) return;
      doc = rec.doc;
      name = rec.name;
      blobs = new Map();
      for (const h of projectBlobHashes(doc.project)) {
        const b = await store.getBlob(h);
        if (b) blobs.set(h, b);
      }
    }
    const saved = await saveBytesToDisk(
      encodeProjectFile(doc, blobs),
      fileName(name),
      'application/x-dithtill',
    );
    if (saved) notifyBanner(`Saved ${fileName(name)}`);
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Save failed');
  }
}

/** Open a .dithtill file: it becomes a project in the app, then opens. */
export async function openProjectFile(file: File): Promise<void> {
  try {
    const { doc, blobs } = decodeProjectFile(new Uint8Array(await file.arrayBuffer()));
    const taken = new Set(useProjects.getState().list.map((p) => p.name));
    let name = doc.project.name || freshName();
    for (let n = 2; taken.has(name); n++) name = `${doc.project.name} ${n}`;
    const now = Date.now();
    const id = crypto.randomUUID();
    await projectStore().save(
      {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        thumbnail: '',
        bytes: mediaBytes(doc.project, blobs),
        doc: { ...doc, project: { ...doc.project, name } },
      },
      blobs,
    );
    await refreshList();
    if (await openProject(id)) {
      // The card gets its thumbnail on the first save of the opened canvas.
      dirty = true;
      void flush();
    }
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Open failed');
  }
}

// ---- start-up --------------------------------------------------------------------------

let inited = false;

/** Reopen the last project and start auto-saving (idempotent; called once at start). */
export async function initProjects(): Promise<void> {
  if (inited) return;
  inited = true;
  await refreshList().catch(() => {});
  const last = storageGet();
  useProjects.setState({ name: freshName() });
  if (last && useProjects.getState().list.some((p) => p.id === last)) await openProject(last);
  useProjects.setState({ ready: true });

  // Every edit (layers, strokes, look, clips, motion, reactions, visualizers, loop
  // length, undo/redo) + the changes that aren't undo steps.
  onEdit(markDirty);
  useSceneStore.subscribe((s, p) => {
    if (
      s.nodes !== p.nodes ||
      s.scene !== p.scene ||
      s.background !== p.background ||
      s.dotInk !== p.dotInk ||
      s.pixel !== p.pixel ||
      s.canvasMods !== p.canvasMods ||
      s.canvasMotion !== p.canvasMotion ||
      s.canvasFx !== p.canvasFx
    )
      markDirty();
  });
  useLoopStore.subscribe((s, p) => {
    if (s.transport === 'stopped' && p.transport !== 'stopped' && dirty) void flush();
    if (
      s.meta !== p.meta ||
      s.events !== p.events ||
      s.reactions !== p.reactions ||
      s.layerLoops !== p.layerLoops ||
      s.part !== p.part ||
      s.mutedLayers !== p.mutedLayers ||
      s.audioMuted !== p.audioMuted ||
      s.animate !== p.animate ||
      s.trackName !== p.trackName
    )
      markDirty();
  });
  useBurnStore.subscribe((s, p) => {
    if (s.aspect !== p.aspect || s.cellStyle !== p.cellStyle || s.dotDensity !== p.dotDensity)
      markDirty();
  });
  // Leaving the page / hiding the app: save straight away.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
  }
}
