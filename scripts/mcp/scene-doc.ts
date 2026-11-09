// =============================================================================
// The headless SCENE DOC (AI-3 — personal AI tooling, NOT app code).
// The app's Record scene is in-memory only (SceneRecord = backlog), so the MCP
// suite owns a versioned scene JSON: nodes carry the app's EXACT shapes
// (SceneNode placement/look/motion — scene-store.ts is the type truth), and
// export_loop assembles the app's own LoopRenderInput and walks integer frames
// through renderLoopFramePng — the same pure pipe the desktop exporter drives —
// then encodes with the app's codec (wasm). When SceneRecord lands, the app can
// adopt this format (the shapes already match).
//
// Deliberately explicit: placing an element NEVER restyles the scene (the app's
// empty-scene look adoption is a UI convenience; a tool wants create_scene's
// params to rule). Deliberately off the hot fields: per-element pixel/cellSize
// (the in-flight scene-resolution pass) are not authored here in v1.
// =============================================================================
import { LOOK_SCREEN_DEFAULT, screenLookFromCellStyle } from '../../src/core/print-screen';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  sceneDims,
  SCENE_LOOK_DEFAULT,
  type Look,
  type MotionDescriptor,
  type Placement,
  type SceneNode,
} from '../../src/state/scene-store';
import {
  ASPECT_IDS,
  PALETTE_IDS,
  PATTERN_IDS,
  type AspectId,
  type PaletteId,
  type PatternId,
} from '../../src/core/dither-constants';
import {
  HALFTONE_DENSITY_DEFAULT,
  HALFTONE_DENSITY_MAX,
  HALFTONE_DENSITY_MIN,
  type CellStyle,
} from '../../src/core/cell-style';
import type { Rgb } from '../../src/core/color';
import type { CachedAsset, SceneBackground } from '../../src/core/scene-resolver';
import { renderLoopFrameRaster, type LoopRenderInput } from '../../src/core/loop-render';
import { codecFrame } from '../../src/platform/codec-wasm';
import { parseElementFile } from '../../src/core/element-file';
import { parseHexColor } from './halftone-pipeline';
import { LOOK_CELL_STYLES } from './element-pipeline';
import {
  containerForPath,
  nodeCodec,
  FPS_DEFAULT,
  FPS_MAX,
  FPS_MIN,
  FRAMES_MAX,
  type FramesVideoResult,
} from './animation';

export const SCENE_DOC_FORMAT = 'dithtill-scene';
export const SCENE_DOC_VERSION = 1;

/** One placed element in the doc: the app's SceneNode fields + the element
 *  file it resolves from (self-contained — export needs no Library). */
export interface SceneDocNode {
  id: string;
  elementFile: string;
  elementId: string;
  z: number;
  placement: Placement;
  look: Partial<Look>;
  motion: MotionDescriptor | null;
  opacity: number;
}

export interface SceneDoc {
  format: typeof SCENE_DOC_FORMAT;
  version: number;
  aspect: AspectId;
  /** Scene-wide look defaults (nodes override a subset, the app's model). */
  scene: Look;
  /** Flat canvas background [r,g,b] or null = transparent. */
  background: Rgb | null;
  /** Halftone dot ink [r,g,b] or null = the palette's brightest shade. */
  dotInk: Rgb | null;
  cellStyle: CellStyle;
  dotDensity: number;
  frames: number;
  fps: number;
  seed: number;
  nodes: SceneDocNode[];
}

// The motion vocabulary — the app's exact types + per-type defaults
// (ui/LoopTransport.tsx DEFAULT_AMP / DEFAULT_DIR / SPEED bounds).
export const MOTION_TYPES = [
  'drift',
  'bob',
  'parallax',
  'blink',
  'marquee',
  'twinkle',
  'spin',
  'pendulum',
  'bounce',
  'shake',
  'pulse',
] as const;
export type MotionType = (typeof MOTION_TYPES)[number];
export const MOTION_CYCLES_MIN = 1;
export const MOTION_CYCLES_MAX = 8;
const DEFAULT_AMP: Record<MotionType, number> = {
  drift: 8,
  bob: 8,
  parallax: 8,
  blink: 8,
  marquee: 8,
  twinkle: 8,
  spin: 1,
  pendulum: 20,
  bounce: 8,
  shake: 6,
  pulse: 15,
};
const DEFAULT_DIR: Partial<Record<MotionType, { ax: number; ay: number }>> = {
  marquee: { ax: 1, ay: 0 },
  bounce: { ax: 0, ay: 1 },
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---- create / load / save ---------------------------------------------------

export interface CreateSceneOptions {
  aspect?: AspectId; // default 'square'
  frames?: number; // default 36
  fps?: number; // default FPS_DEFAULT
  seed?: number; // default the app's LOOP_META_DEFAULT seed
  palette?: PaletteId; // scene Look default
  matrix?: PatternId;
  background?: string; // '#rrggbb'; omitted = transparent
  dotInk?: string; // '#rrggbb'; omitted = palette brightest
  cellStyle?: (typeof LOOK_CELL_STYLES)[number]; // default 'square'
  dotDensity?: number;
}

/** Build a fresh scene doc (validated), not yet written. */
export function createSceneDoc(opts: CreateSceneOptions): SceneDoc {
  const aspect = opts.aspect ?? 'square';
  if (!ASPECT_IDS.includes(aspect)) throw new Error(`unknown aspect '${aspect}'`);
  const frames = Math.round(opts.frames ?? 36);
  if (frames < 1 || frames > FRAMES_MAX) {
    throw new Error(`frames must be 1–${FRAMES_MAX}, got ${opts.frames}`);
  }
  const fps = Math.round(opts.fps ?? FPS_DEFAULT);
  if (fps < FPS_MIN || fps > FPS_MAX) throw new Error(`fps must be ${FPS_MIN}–${FPS_MAX}`);
  const palette = opts.palette ?? SCENE_LOOK_DEFAULT.palette;
  if (!PALETTE_IDS.includes(palette)) throw new Error(`unknown palette '${palette}'`);
  const matrix = opts.matrix ?? SCENE_LOOK_DEFAULT.matrix;
  if (!PATTERN_IDS.includes(matrix)) throw new Error(`unknown matrix '${matrix}'`);
  const cellStyle = opts.cellStyle ?? 'square';
  if (!LOOK_CELL_STYLES.includes(cellStyle)) {
    throw new Error(`cellStyle must be one of ${LOOK_CELL_STYLES.join('/')}`);
  }
  return {
    format: SCENE_DOC_FORMAT,
    version: SCENE_DOC_VERSION,
    aspect,
    scene: { ...SCENE_LOOK_DEFAULT, palette, matrix },
    background: opts.background ? parseHexColor(opts.background) : null,
    dotInk: opts.dotInk ? parseHexColor(opts.dotInk) : null,
    cellStyle,
    dotDensity: clamp(
      Math.round(opts.dotDensity ?? HALFTONE_DENSITY_DEFAULT),
      HALFTONE_DENSITY_MIN,
      HALFTONE_DENSITY_MAX,
    ),
    frames,
    fps,
    seed: 0x1337beef, // LOOP_META_DEFAULT's seed — one deterministic default
    ...(opts.seed !== undefined ? { seed: opts.seed >>> 0 } : {}),
    nodes: [],
  };
}

export async function loadSceneDoc(file: string): Promise<SceneDoc> {
  let doc: SceneDoc;
  try {
    doc = JSON.parse(await readFile(file, 'utf8')) as SceneDoc;
  } catch (err) {
    throw new Error(`could not read scene '${file}': ${(err as Error).message}`, { cause: err });
  }
  if (doc?.format !== SCENE_DOC_FORMAT) throw new Error(`not a ${SCENE_DOC_FORMAT} file: ${file}`);
  if (doc.version !== SCENE_DOC_VERSION) {
    throw new Error(`unsupported scene version ${doc.version} (expected ${SCENE_DOC_VERSION})`);
  }
  if (!Array.isArray(doc.nodes)) throw new Error('scene: nodes must be an array');
  return doc;
}

export async function saveSceneDoc(file: string, doc: SceneDoc): Promise<void> {
  await writeFile(file, JSON.stringify(doc, null, 1));
}

// ---- place_element ----------------------------------------------------------

export interface PlaceElementOptions {
  elementFile: string;
  /** Centre as a FRACTION of the scene (0..1 each); default dead centre. */
  nx?: number;
  ny?: number;
  /** Uniform scale on the element's native doc-cell footprint (default 1). */
  scale?: number;
  rotationDeg?: number; // default 0
  opacity?: number; // integer percent 0..100, default 100
}

export interface PlacedNodeInfo {
  nodeId: string;
  elementId: string;
  w: number;
  h: number;
  placement: Placement;
}

/** Place an element file into the doc — mirrors the app's dropFromLibrary node
 *  mapping (palette/matrix from the record; dotSize/dotGrow ride the node's
 *  look when the element carries a v4 blob). Returns the new node's info. */
export async function placeElement(
  doc: SceneDoc,
  opts: PlaceElementOptions,
): Promise<PlacedNodeInfo> {
  const { record } = await parseElementFile(await readFile(opts.elementFile, 'utf8'));
  const dims = sceneDims(doc.aspect);
  const nx = clamp(opts.nx ?? 0.5, 0, 1);
  const ny = clamp(opts.ny ?? 0.5, 0, 1);
  const scale = clamp(opts.scale ?? 1, 0.05, 20);
  const placement: Placement = {
    x: nx * dims.w,
    y: ny * dims.h,
    scaleX: scale,
    scaleY: scale,
    rotationDeg: opts.rotationDeg ?? 0,
  };
  const look: Partial<Look> = {
    palette: record.palette,
    matrix: record.matrix,
    ...(record.look ? { dotSize: record.look.dotSize, dotGrow: record.look.dotGrow } : {}),
  };
  const nextN = doc.nodes.reduce((m, n) => Math.max(m, Number(/^n(\d+)$/.exec(n.id)?.[1] ?? 0)), 0);
  const z = doc.nodes.reduce((m, n) => Math.max(m, n.z), 0) + 1;
  const node: SceneDocNode = {
    id: `n${nextN + 1}`,
    elementFile: path.resolve(opts.elementFile),
    elementId: record.id,
    z,
    placement,
    look,
    motion: null,
    opacity: clamp(Math.round(opts.opacity ?? 100), 0, 100),
  };
  doc.nodes.push(node);
  return { nodeId: node.id, elementId: record.id, w: record.w, h: record.h, placement };
}

// ---- set_motion ---------------------------------------------------------------

export interface SetMotionOptions {
  nodeId: string;
  /** One of the app's 11 motion types, or 'none' to clear. */
  type: MotionType | 'none';
  /** Integer cycles per loop, 1..8 — the SPEED; any whole number closes the
   *  wrap seamlessly (frame 0 == frame F). */
  cycles?: number;
  /** Amplitude in per-type units (cells / degrees / % / intensity). */
  amp?: number;
  /** Direction in degrees (0 = right, 90 = down) for the directional types. */
  directionDeg?: number;
  /** Static phase offset in turns 0..1. */
  phase0?: number;
}

export function setNodeMotion(doc: SceneDoc, opts: SetMotionOptions): MotionDescriptor | null {
  const node = doc.nodes.find((n) => n.id === opts.nodeId);
  if (!node) {
    const have = doc.nodes.map((n) => n.id).join(', ') || '(scene is empty)';
    throw new Error(`no node '${opts.nodeId}' in the scene — nodes: ${have}`);
  }
  if (opts.type === 'none') {
    node.motion = null;
    return null;
  }
  if (!MOTION_TYPES.includes(opts.type)) {
    throw new Error(`unknown motion '${opts.type}' (valid: ${MOTION_TYPES.join(', ')}, none)`);
  }
  const dir =
    opts.directionDeg !== undefined
      ? {
          ax: Math.cos((opts.directionDeg * Math.PI) / 180),
          ay: Math.sin((opts.directionDeg * Math.PI) / 180),
        }
      : (DEFAULT_DIR[opts.type] ?? { ax: 1, ay: 1 });
  const motion: MotionDescriptor = {
    type: opts.type,
    cycles: clamp(Math.round(opts.cycles ?? 1), MOTION_CYCLES_MIN, MOTION_CYCLES_MAX),
    amp: Math.max(0, opts.amp ?? DEFAULT_AMP[opts.type]),
    ax: dir.ax,
    ay: dir.ay,
    phase0: clamp(opts.phase0 ?? 0, 0, 1),
  };
  node.motion = motion;
  return motion;
}

// ---- export_loop --------------------------------------------------------------

export interface ExportLoopOptions {
  sceneFile: string;
  /** Output path; the extension picks .mp4 / .gif (the app's codec). */
  output: string;
  /** Override the doc's fps for this export only. */
  fps?: number;
}

export interface ExportLoopResult extends FramesVideoResult {
  width: number;
  height: number;
  nodes: number;
}

/** Assemble the doc into the app's LoopRenderInput (assets loaded + verified
 *  from the element files) — exported for the determinism tests. */
export async function sceneToRenderInput(doc: SceneDoc): Promise<LoopRenderInput> {
  if (doc.nodes.length === 0) throw new Error('scene is empty — place_element first');
  const assets = new Map<string, CachedAsset>();
  for (const n of doc.nodes) {
    if (assets.has(n.elementId)) continue;
    const { record, blobs } = await parseElementFile(await readFile(n.elementFile, 'utf8'));
    if (record.id !== n.elementId) {
      throw new Error(
        `node ${n.id}: element file ${n.elementFile} now holds a different element ` +
          `(${record.id.slice(0, 12)}… vs the placed ${n.elementId.slice(0, 12)}…)`,
      );
    }
    const byHash = new Map(blobs.map((b) => [b.hash, b.bytes]));
    assets.set(n.elementId, {
      w: record.w,
      h: record.h,
      tones: new Uint8Array(byHash.get(record.tonesHash) as Uint8Array),
      covered: new Uint8Array(byHash.get(record.coveredHash) as Uint8Array),
      ...(record.fineHash && byHash.get(record.fineHash)
        ? { fine: new Uint8Array(byHash.get(record.fineHash) as Uint8Array) }
        : {}),
    });
  }
  const nodes: SceneNode[] = doc.nodes.map((n) => ({
    id: n.id,
    assetId: n.elementId,
    kind: 'asset',
    z: n.z,
    placement: n.placement,
    crop: null,
    look: n.look,
    motion: n.motion,
    opacity: n.opacity,
  }));
  const background: SceneBackground | null = doc.background ? { rgb: doc.background } : null;
  return {
    nodes,
    // The doc's scene-wide cell style + density become the canvas look's own screen;
    // every element inherits it, as before.
    scene: {
      ...LOOK_SCREEN_DEFAULT,
      ...doc.scene,
      ...screenLookFromCellStyle(doc.cellStyle, doc.dotDensity),
    },
    events: [],
    frames: doc.frames,
    seed: doc.seed,
    dims: sceneDims(doc.aspect),
    assets,
    mutedLayers: new Set<number>(),
    features: null,
    background,
    dotInk: doc.dotInk,
    pathClose: false,
  };
}

/** Walk the doc's integer frames through the pure renderer straight into the app's
 *  codec. Deterministic: same doc + elements → same video. */
export async function exportLoopFromScene(opts: ExportLoopOptions): Promise<ExportLoopResult> {
  const doc = await loadSceneDoc(opts.sceneFile);
  const fps = Math.round(opts.fps ?? doc.fps);
  if (fps < FPS_MIN || fps > FPS_MAX)
    throw new Error(`fps must be ${FPS_MIN}–${FPS_MAX}, got ${fps}`);
  const container = containerForPath(opts.output);
  if (!container) throw new Error(`output must end in .mp4 or .gif, got '${opts.output}'`);
  const input = await sceneToRenderInput(doc);
  const codec = await nodeCodec();
  let enc: Awaited<ReturnType<typeof codec.createEncoder>> | null = null;
  try {
    for (let f = 0; f < input.frames; f++) {
      const frame = codecFrame(renderLoopFrameRaster(input, f));
      enc ??= await codec.createEncoder({
        container,
        width: frame.width,
        height: frame.height,
        fps,
      });
      await enc.pushFrame(frame);
    }
    const out = (await enc!.finish())!;
    enc = null;
    await mkdir(path.dirname(opts.output), { recursive: true });
    await writeFile(opts.output, out);
    // Output px dims are dims × the export scale; report the scene lattice instead (the
    // useful number here).
    return {
      container,
      frames: input.frames,
      fps,
      seconds: input.frames / fps,
      bytes: out.length,
      width: input.dims.w,
      height: input.dims.h,
      nodes: doc.nodes.length,
    };
  } finally {
    await enc?.abort();
  }
}
