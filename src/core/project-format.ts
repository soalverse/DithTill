// =============================================================================
// The PROJECT format. PURE: types,
// the versioned envelope + migrations, the one-file `.dithtill` container, and the
// silly project-name generator. No DOM, no stores, no storage.
//
// - **Versioning.** A project document is JSON in an envelope:
//     { format: 'dithtill.project', schemaVersion: N, generator, project: {...} }
//   Older documents are upgraded on load by a chain of single-step migrations
//   (MIGRATIONS[0] = v1→v2, …) on the JSON, so each historical shape needs one small
//   function. NEWER documents are refused (never half-read and later overwritten).
// - **Media** lives beside the document as content-addressed blobs (SHA-256 hex →
//   bytes); the document only names hashes, so shared media is stored once.
// - **`.dithtill` file** = one self-contained file: magic + the JSON + every blob.
// =============================================================================
import { paletteLength, type AspectId } from './dither-constants';
import type { Swatch } from './color';
import type { AssetRecord } from './library';
import type { AudioReactEvent, LayerLoop, TimedEvent } from './loop-events';
import type { Detail, Look, MotionDescriptor, SceneNode } from '../state/scene-store';
import { LAYER_LOOK_KEYS, LOOK_SCREEN_DEFAULT, screenLookFromCellStyle } from './print-screen';
import type { LoopMeta } from '../state/loop-store';
import type { ModMap } from './modulators';
import type { LayerFx } from './layer-fx';

export const PROJECT_FORMAT = 'dithtill.project';

/** One single-step upgrade of a project document's JSON (vN → vN+1). */
export type ProjectMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** v1 → v2 is MIGRATIONS[0], and so on. Append only; never edit a shipped step. */
export const MIGRATIONS: readonly ProjectMigration[] = [
  // v1 → v2: the Look gains each layer's own screen (style, shape, density,
  // angle, dotsTurn, bitSize, colourMode) — the canvas look takes them from the canvas-wide
  // cell style + density it was drawn with, a dithered multi-shade palette keeps its shades;
  // the project gains its Detail (Normal = today).
  (doc) => {
    const project = doc.project as { canvas: Record<string, unknown> };
    const c = project.canvas;
    const scene = { ...LOOK_SCREEN_DEFAULT, ...(c.scene as Look) };
    const screen = screenLookFromCellStyle(
      String(c.cellStyle ?? 'square'),
      typeof c.dotDensity === 'number' ? c.dotDensity : LOOK_SCREEN_DEFAULT.density,
    );
    const next: Look = { ...scene, ...screen };
    if (next.style === 'dither' && paletteLength(next.palette) > 2) next.colourMode = 'palette';
    return { ...doc, project: { ...project, canvas: { ...c, scene: next, detail: 'normal' } } };
  },
  // v2 → v3: the canvas look is the one truth for Style / Shape / Density, so
  // the canvas-wide copies go (the look took them in v2).
  (doc) => {
    const project = doc.project as { canvas: Record<string, unknown> };
    const canvas = { ...project.canvas };
    delete canvas.cellStyle;
    delete canvas.dotDensity;
    return { ...doc, project: { ...project, canvas } };
  },
  // v3 → v4: every layer keeps its own look — a layer takes the canvas look's
  // layer fields it was showing (its own overrides on top); the canvas look becomes the look
  // new layers start with.
  (doc) => {
    const project = doc.project as { canvas: { scene: Look; nodes: SceneNode[] } };
    const { scene, nodes } = project.canvas;
    const own: Partial<Look> = {};
    for (const k of LAYER_LOOK_KEYS) (own as Record<string, unknown>)[k] = scene[k];
    return {
      ...doc,
      project: {
        ...project,
        canvas: {
          ...project.canvas,
          nodes: nodes.map((n) => ({ ...n, look: { ...own, ...n.look } })),
        },
      },
    };
  },
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length + 1;

/** A drawing layer's raster (`paint:` asset), by blob hash. */
export interface PaintMedia {
  assetId: string;
  /** Picture values per canvas square (the Detail it was drawn at); absent = 1. */
  per?: number;
  w: number;
  h: number;
  tones: string;
  covered: string;
  fine?: string;
}

/** A photo layer's source file + its cut-out masks (`img:` asset). */
export interface ImageMedia {
  assetId: string;
  mime: string;
  bytes: string;
  /** Mask planes by key (ImageLayerParams.matte). */
  masks: { key: string; alpha: string }[];
}

/** A Library-shaped record the canvas uses (an imported video, a placed element). */
export interface RecordMedia {
  record: AssetRecord;
  /** Every blob hash the record names. */
  blobs: string[];
  /** A video's full source length (what its Trim can reach). */
  durationSec?: number;
}

export interface ProjectBody {
  /** The project's name (also on its store record; files carry it here). */
  name: string;
  canvas: {
    nodes: SceneNode[];
    scene: Look;
    background: Swatch;
    dotInk: Swatch;
    pixel: number;
    aspect: AspectId;
    /** The canvas's modulators (J2); absent in projects saved before them = none. */
    canvasMods?: ModMap;
    /** The Whole canvas Motion; absent = none. */
    canvasMotion?: MotionDescriptor;
    /** The Whole canvas effects (J5); absent = none. */
    canvasFx?: LayerFx;
    /** How finely every layer keeps its picture. */
    detail: Detail;
  };
  loop: {
    meta: LoopMeta;
    events: TimedEvent[];
    reactions: AudioReactEvent[];
    /** Each recorded layer's own loop; absent = none. */
    layerLoops?: Record<string, LayerLoop>;
    /** The marked part, song frames; absent = the whole video. */
    part?: { start: number; end: number };
    mutedLayers: number[];
    audioMuted: string[];
    animate: boolean;
  };
  media: {
    paints: PaintMedia[];
    images: ImageMedia[];
    records: RecordMedia[];
    track: { name: string; bytes: string } | null;
  };
}

export interface ProjectDoc {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  generator: string;
  project: ProjectBody;
}

export class ProjectFormatError extends Error {}

export function makeProjectDoc(project: ProjectBody, generator: string): ProjectDoc {
  return { format: PROJECT_FORMAT, schemaVersion: SCHEMA_VERSION, generator, project };
}

/** Every blob hash a project names (what must be stored / bundled with it). */
export function projectBlobHashes(p: ProjectBody): string[] {
  const out = new Set<string>();
  for (const m of p.media.paints) {
    out.add(m.tones);
    out.add(m.covered);
    if (m.fine) out.add(m.fine);
  }
  for (const m of p.media.images) {
    out.add(m.bytes);
    for (const k of m.masks) out.add(k.alpha);
  }
  for (const r of p.media.records) for (const h of r.blobs) out.add(h);
  if (p.media.track) out.add(p.media.track.bytes);
  return [...out];
}

/**
 * Parse + upgrade a project document (JSON value) to the current schema. Throws a
 * ProjectFormatError for a foreign or too-new document.
 */
export function upgradeProjectDoc(raw: unknown): ProjectDoc {
  if (typeof raw !== 'object' || raw === null) throw new ProjectFormatError('Not a project');
  let doc = raw as Record<string, unknown>;
  if (doc.format !== PROJECT_FORMAT) throw new ProjectFormatError('Not a DithTill project');
  const v = doc.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw new ProjectFormatError('Unknown project version');
  if (v > SCHEMA_VERSION)
    throw new ProjectFormatError(
      'This project was made by a newer DithTill — update the app to open it',
    );
  for (let at = v; at < SCHEMA_VERSION; at++) {
    doc = { ...MIGRATIONS[at - 1](doc), schemaVersion: at + 1 };
  }
  const body = doc.project as ProjectBody | undefined;
  if (!body || !body.canvas || !body.loop || !body.media)
    throw new ProjectFormatError('The project file is damaged');
  return doc as unknown as ProjectDoc;
}

// ---- the .dithtill container ------------------------------------------------------
//
//   "DITHTILL" (8) · u32 LE container version (=1) · u32 LE JSON length · JSON (UTF-8)
//   · then per blob: u32 LE hash length · hash (ASCII) · u32 LE byte length · bytes
// The JSON is the project document; blobs are its media by hash. Little-endian u32
// lengths cap one blob at 4 GiB — far past any canvas.

const MAGIC = 'DITHTILL';
const CONTAINER_VERSION = 1;

export function encodeProjectFile(
  doc: ProjectDoc,
  blobs: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const enc = new TextEncoder();
  const json = enc.encode(JSON.stringify(doc));
  const hashes = projectBlobHashes(doc.project);
  let size = 8 + 4 + 4 + json.length;
  const parts: { h: Uint8Array; b: Uint8Array }[] = [];
  for (const hash of hashes) {
    const b = blobs.get(hash);
    if (!b) throw new ProjectFormatError(`Missing media ${hash.slice(0, 12)}…`);
    const h = enc.encode(hash);
    parts.push({ h, b });
    size += 4 + h.length + 4 + b.length;
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  view.setUint32(8, CONTAINER_VERSION, true);
  view.setUint32(12, json.length, true);
  out.set(json, 16);
  let o = 16 + json.length;
  for (const { h, b } of parts) {
    view.setUint32(o, h.length, true);
    out.set(h, o + 4);
    o += 4 + h.length;
    view.setUint32(o, b.length, true);
    out.set(b, o + 4);
    o += 4 + b.length;
  }
  return out;
}

export function decodeProjectFile(bytes: Uint8Array): {
  doc: ProjectDoc;
  blobs: Map<string, Uint8Array>;
} {
  const dec = new TextDecoder();
  if (bytes.length < 16 || dec.decode(bytes.subarray(0, 8)) !== MAGIC)
    throw new ProjectFormatError('Not a .dithtill project file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cv = view.getUint32(8, true);
  if (cv > CONTAINER_VERSION)
    throw new ProjectFormatError(
      'This project file was made by a newer DithTill — update the app to open it',
    );
  const jsonLen = view.getUint32(12, true);
  if (16 + jsonLen > bytes.length) throw new ProjectFormatError('The project file is damaged');
  let raw: unknown;
  try {
    raw = JSON.parse(dec.decode(bytes.subarray(16, 16 + jsonLen)));
  } catch {
    throw new ProjectFormatError('The project file is damaged');
  }
  const doc = upgradeProjectDoc(raw);
  const blobs = new Map<string, Uint8Array>();
  let o = 16 + jsonLen;
  while (o < bytes.length) {
    if (o + 4 > bytes.length) throw new ProjectFormatError('The project file is damaged');
    const hl = view.getUint32(o, true);
    if (o + 4 + hl + 4 > bytes.length) throw new ProjectFormatError('The project file is damaged');
    const hash = dec.decode(bytes.subarray(o + 4, o + 4 + hl));
    o += 4 + hl;
    const bl = view.getUint32(o, true);
    if (o + 4 + bl > bytes.length) throw new ProjectFormatError('The project file is damaged');
    blobs.set(hash, bytes.slice(o + 4, o + 4 + bl));
    o += 4 + bl;
  }
  for (const h of projectBlobHashes(doc.project))
    if (!blobs.has(h)) throw new ProjectFormatError('The project file is missing media');
  return { doc, blobs };
}

// ---- silly names ("like Suno") -------------------------------------

const ADJECTIVES = [
  'Wobbly',
  'Static',
  'Velvet',
  'Fuzzy',
  'Crunchy',
  'Sleepy',
  'Neon',
  'Grumpy',
  'Glitchy',
  'Dizzy',
  'Mellow',
  'Spicy',
  'Cosmic',
  'Soggy',
  'Rusty',
  'Jolly',
  'Sneaky',
  'Bouncy',
  'Frosty',
  'Lumpy',
  'Sparkly',
  'Wonky',
  'Gloomy',
  'Zesty',
  'Tiny',
  'Giant',
  'Moody',
  'Fizzy',
  'Sticky',
  'Hollow',
  'Lunar',
  'Electric',
  'Pixel',
  'Murky',
  'Squeaky',
  'Dusty',
  'Feral',
  'Gentle',
  'Haunted',
  'Lazy',
  'Noisy',
  'Polite',
  'Quiet',
  'Rowdy',
  'Shiny',
  'Snoozy',
  'Twitchy',
  'Woolly',
  'Breezy',
  'Chunky',
  'Dreamy',
  'Fluffy',
  'Gooey',
  'Jittery',
  'Loopy',
  'Plucky',
  'Salty',
  'Toasty',
  'Vivid',
  'Wandering',
] as const;

const NOUNS = [
  'Moon',
  'Pancake',
  'Gremlin',
  'Comet',
  'Toaster',
  'Waltz',
  'Pickle',
  'Lighthouse',
  'Noodle',
  'Cassette',
  'Walrus',
  'Meteor',
  'Teapot',
  'Cactus',
  'Disco',
  'Lantern',
  'Penguin',
  'Satellite',
  'Biscuit',
  'Thunder',
  'Jellyfish',
  'Marble',
  'Raccoon',
  'Rocket',
  'Sardine',
  'Volcano',
  'Waffle',
  'Zeppelin',
  'Ghost',
  'Goblin',
  'Hamster',
  'Igloo',
  'Kazoo',
  'Llama',
  'Mango',
  'Nebula',
  'Orbit',
  'Pigeon',
  'Quasar',
  'Radio',
  'Sprout',
  'Tadpole',
  'Ukulele',
  'Vortex',
  'Wizard',
  'Yeti',
  'Bassline',
  'Crumpet',
  'Dumpling',
  'Echo',
  'Fern',
  'Gumball',
  'Hiccup',
  'Lobster',
  'Mixtape',
  'Nugget',
  'Omelette',
  'Phosphor',
  'Snail',
  'Tumbleweed',
] as const;

/** A two-word silly name ("Wobbly Moon") — `rand` returns [0, 1). Avoids `taken` names
 *  when it can (tries a few draws, then appends a number). */
export function sillyProjectName(
  rand: () => number,
  taken: ReadonlySet<string> = new Set(),
): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length) % list.length];
  let name = '';
  for (let i = 0; i < 12; i++) {
    name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!taken.has(name)) return name;
  }
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

/** The highest numeric suffix among `ids` of the form `${prefix}${n}` (0 if none) — lets
 *  each id counter skip past a reopened project's ids. */
export function maxIdSuffix(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}
