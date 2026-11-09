// =============================================================================
// Record actions (Record / increment 3) — the browser-side glue:
// drop Library elements into the scene, export the flattened scene as a still
// PNG, and save the flattened scene back into the Library as a new element
// (closing the ecosystem loop — a scene becomes a reusable element). All three
// go through the ONE resolver (resolveSceneGrid) so they match the live preview.
// =============================================================================
import { useSceneStore, sceneDimsAt, type Look, type LookOverride } from '../state/scene-store';
import { screenLookFromCellStyle } from '../core/print-screen';
import type { AssetRecord, ElementScreen } from '../core/library';
import { useBurnStore } from '../state/burn-store';
import { useLoopStore } from '../state/loop-store';
import { applyPaintReveal } from '../core/loop-events';
import type { CachedAsset } from '../core/scene-resolver';
import { bytesToBase64 } from '../core/element-file';
import {
  buildRecordingElement,
  type RecordingAssetRecord,
  type RecordingElementData,
} from '../core/library';
import { getAssetBytes } from './session-assets';
import { finishedPicture, placeRecording } from './recording-edit';
import { useModeStore } from '../state/mode-store';
import { useLibraryStore } from '../state/library-store';
import {
  resolveSceneGrid,
  sceneToneComposite,
  sceneBackgroundRgb,
  sceneBackgroundTone,
  type SceneBackground,
  type SceneGrid,
} from '../core/scene-resolver';
import { PALETTES, PALETTE_IDS } from '../core/dither-constants';
import { ensureAssets, getAssetCache } from './scene-assets';
import { renderStillPng, renderStillSvg } from '../core/loop-render';
import { applyCanvasFx } from '../core/canvas-fx';
import { findRecord } from './session-assets';
import { reframeCropCells } from './image-to-grid';
import { isHalftoneStyle } from '../core/cell-style';
import { savePngToDisk, saveSvgToDisk } from '../platform/save-png';
import { notifyBanner, notifyConfirm, folderName } from '../state/notify-store';

/** The live scene dims at the current scene resolution (Pixel) — the shared shape source
 *  sized by the scene-store Pixel setting (scene-resolution pass). */
export function currentSceneDims(): { w: number; h: number } {
  return sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel);
}

const THUMB_SRC_SCALE = 2;

/** The scene's flat canvas background in
 *  encode/render form: a preset shade tracks the scene palette; a custom RGB pins. */
export function currentSceneBackground(): SceneBackground | undefined {
  const s = useSceneStore.getState();
  if (s.background === null) return undefined;
  return Array.isArray(s.background)
    ? { rgb: s.background }
    : { palette: s.scene.palette, index: s.background };
}

/** The rasters as the canvas shows them at rest: recorded strokes are timed events, so a still
 *  picture (PNG, SVG, a saved canvas, a project card) draws them in the way the glass does. */
export function restingAssets(): Map<string, CachedAsset> {
  const lp = useLoopStore.getState();
  return applyPaintReveal(
    getAssetCache(),
    lp.events,
    Number.MAX_SAFE_INTEGER,
    Math.max(1, lp.meta.frames),
    new Set(lp.mutedLayers),
  );
}

/** Resolve the current scene (assets loaded) to a grid, or null if empty. */
export async function resolveCurrentScene(): Promise<SceneGrid | null> {
  const store = useSceneStore.getState();
  if (store.nodes.length === 0) return null;
  await ensureAssets(store.nodes.map((n) => n.assetId));
  const dims = currentSceneDims();
  const bg = currentSceneBackground();
  // The Whole canvas effects (J5) as the glass shows them.
  const fx = applyCanvasFx(store.nodes, restingAssets(), dims, store.canvasFx);
  return resolveSceneGrid({
    nodes: fx.nodes,
    scene: store.scene,
    dims,
    assets: fx.assets,
    backgroundTone: bg ? sceneBackgroundTone(bg) : undefined,
  });
}

/** Drop selected Library elements into the Record scene as separate nodes (staggered
 *  so they don't perfectly overlap), select them, and switch to Record. */
export async function dropFromLibrary(allIds: string[]): Promise<void> {
  if (allIds.length === 0) return;
  // A saved recording comes back as a recording, its bar at the start.
  const assetIds: string[] = [];
  const recordings: RecordingAssetRecord[] = [];
  for (const id of allIds) {
    const rec = findRecord(id);
    if (rec?.kind === 'recording') recordings.push(rec);
    else assetIds.push(id);
  }
  // After the elements: a drop into an empty scene is what sets its look (below).
  const placeRecordings = async (): Promise<number> => {
    let placed = 0;
    for (const rec of recordings) {
      const bytes = await getAssetBytes(rec.dataHash);
      if (!bytes) continue;
      try {
        placeRecording(rec, JSON.parse(new TextDecoder().decode(bytes)) as RecordingElementData);
        placed++;
      } catch {
        notifyBanner('That recording could not be loaded');
      }
    }
    return placed;
  };
  if (assetIds.length === 0) {
    const placed = await placeRecordings();
    if (placed) {
      useModeStore.getState().setMode('canvas');
      notifyBanner(placed === 1 ? 'Added to canvas' : `Added ${placed} to canvas`);
    }
    return;
  }
  await ensureAssets(assetIds);
  const cache = getAssetCache();
  // The FIRST drop into an EMPTY scene establishes the scene-wide look (below); a drop
  // into a scene that already has nodes never yanks the whole scene's style.
  const sceneWasEmpty = useSceneStore.getState().nodes.length === 0;

  //'s "the FIRST video placed SETS the loop length" rule is SUPERSEDED:
  // placing a video NEVER re-times the
  // loop. Under the two-clock model (K1/K2, already live) a clip longer than the
  // loop plays ABSOLUTELY underneath while the authoring loop stays short; a shorter
  // clip tiles per cycle. The user still chooses "Clip" explicitly on the length
  // stepper (LoopTransport). With no length-set here, placing a video can never
  // orphan takes, so the old takes-exist refusal guard is gone too — which also
  // fixes the false 'Loop has takes' the owner hit (a deleted layer's events are
  // filtered non-destructively while that guard read the RAW event count — F3).
  const dropIds = assetIds;

  // SCENE-WIDE look establishment (v4, §8.B + scene-resolution pass): only into an EMPTY
  // scene, from the first dropped element that carries a v4 look. cellStyle + dotDensity
  // are the DEVICE globals (burn-store); dotInk + background are the scene Swatches; a
  // non-default producing Pixel is ADOPTED as the scene resolution so the lattice matches
  // the lattice the element was burned at. Done BEFORE placement so specs use the adopted
  // dims. A NON-empty scene never touches these — a later drop can't restyle the scene.
  // (Per-element cellStyle is the separate gated W5 item; do NOT add it here.)
  if (sceneWasEmpty) {
    // The seed is the first dropped element carrying a v4 look — COMPOSITE OR VIDEO (videos
    // are the owner's primary medium, so a fine-burned clip's producing resolution + style
    // must establish the empty scene too, not just a still). Both record kinds now hold the
    // same optional `look` blob.
    const seedRec = dropIds
      .map((id) => findRecord(id))
      .find((e): e is AssetRecord => Boolean(e?.look));
    if (seedRec?.look) {
      useSceneStore
        .getState()
        .setSceneLook(screenLookFromCellStyle(seedRec.look.cellStyle, seedRec.look.dotDensity));
      useSceneStore.getState().setDotInk(seedRec.look.dotInk);
      useSceneStore.getState().setBackground(seedRec.look.background);
      // A PRESENT cellSize is a deliberate producing Pixel (the save site already omitted its
      // own default) → adopt it. This is what lets a scene deliberately saved at Pixel 5 (==
      // Burn's default value) re-adopt 5 instead of silently reverting to the scene default.
      if (seedRec.look.cellSize !== undefined) {
        useSceneStore.getState().setScenePixel(seedRec.look.cellSize);
      }
    }
    // v5: a Make element carries its producing Pixel as `cell`
    // (a neutral look is omitted from the record, so this is independent of `look`). The
    // empty scene ADOPTS it, so the element lands 1:1 on the lattice it was made on.
    const cellRec = dropIds
      .map((id) => findRecord(id))
      .find((e) => e?.kind === 'composite' && e.cell !== undefined);
    if (cellRec?.kind === 'composite' && cellRec.cell !== undefined) {
      useSceneStore.getState().setScenePixel(cellRec.cell);
    }
  }
  const dims = currentSceneDims();

  const specs = [];
  let i = 0;
  for (const id of dropIds) {
    const a = cache.get(id);
    if (!a) continue;
    const rec = findRecord(id);
    const off = i * 4;
    // A video element's saved Burn reframe arrives as the node's initial crop
    // (element-local cells), so it drops in framed exactly as it was saved —
    // still a normal crop the user can adjust or double-click-reset.
    const crop =
      rec && rec.kind === 'video' && rec.reframe
        ? reframeCropCells(rec.w, rec.h, rec.aspect, rec.reframe, a.w, a.h)
        : null;
    // With a crop, place + scale so the CROPPED window is centred and fills the
    // scene — the element arrives looking exactly as it did on the Burn glass
    // (an uncropped video already fills: raster long edge == SCENE_LONG).
    // A v5 element keeps its real size: scale = its Pixel over the scene Pixel (1 on an
    // adopted scene → pixel-exact; an integer ratio is a clean pixel zoom). v4 = 1 as before.
    const cellScale =
      rec?.kind === 'composite' && rec.cell !== undefined
        ? rec.cell / useSceneStore.getState().pixel
        : 1;
    const s = crop ? Math.min(dims.w / crop.w, dims.h / crop.h) : cellScale;
    const cx = dims.w / 2 + off - (crop ? (crop.x + crop.w / 2 - a.w / 2) * s : 0);
    const cy = dims.h / 2 + off - (crop ? (crop.y + crop.h / 2 - a.h / 2) * s : 0);
    // Preserve the element's saved look so it drops in looking as it was made. The
    // PER-ELEMENT Halftone fields (dotSize/dotGrow) live in the node's Look, so a v4
    // element carries them onto the node ALWAYS (a v3 / neutral element omits `look`,
    // so the override stays exactly {palette,matrix} — byte-identical to before).
    // A non-default producing Pixel also rides the node's Look as a per-element coarsen
    // (US-R2/W5), so a coarse burn keeps its cell size in a finer scene; the resolver
    // clamps it to the scene when the scene is coarser (coarser-only). Composite AND
    // video records share the `look` blob now, so BOTH thread these per-element fields.
    // A PRESENT cellSize rides the node's Look as a per-element coarsen (the save site already
    // omitted its own default). The resolver clamps it to the scene when the scene is coarser
    // (coarser-only). Composite AND video records share the `look` blob, so BOTH thread it.
    const recLook = rec?.look;
    const look: LookOverride = rec
      ? {
          palette: rec.palette,
          matrix: rec.matrix,
          ...(recLook ? { dotSize: recLook.dotSize, dotGrow: recLook.dotGrow } : {}),
          ...(recLook?.cellSize !== undefined ? { pixel: recLook.cellSize } : {}),
          // Its own screen, so it drops in as the layer it was saved from.
          ...(recLook?.screen ?? {}),
        }
      : {};
    specs.push({
      assetId: id,
      w: a.w,
      h: a.h,
      cx,
      cy,
      scaleX: s,
      scaleY: s,
      look,
      crop,
    });
    i++;
  }
  if (specs.length === 0 && recordings.length === 0) {
    notifyBanner('Could not load elements');
    return;
  }
  if (specs.length) useSceneStore.getState().addNodes(specs);
  const count = specs.length + (await placeRecordings());
  useModeStore.getState().setMode('canvas');
  notifyBanner(count === 1 ? 'Added to canvas' : `Added ${count} to canvas`);
}

/** Render a resolved scene to a small PNG data URL for the backpack thumbnail. */
function sceneGridThumbnail(grid: SceneGrid, background?: SceneBackground): string {
  const cell = document.createElement('canvas');
  cell.width = grid.w;
  cell.height = grid.h;
  const ctx = cell.getContext('2d');
  if (!ctx) return '';
  const bg = background ? sceneBackgroundRgb(background) : null;
  const img = ctx.createImageData(grid.w, grid.h);
  const d = img.data;
  for (let i = 0; i < grid.covered.length; i++) {
    const o = i * 4;
    if (!grid.covered[i]) {
      if (bg) {
        d[o] = bg[0];
        d[o + 1] = bg[1];
        d[o + 2] = bg[2];
        d[o + 3] = 255;
      } else {
        d[o + 3] = 0;
      }
      continue;
    }
    const pal = PALETTES[PALETTE_IDS[grid.pal[i]]];
    const c = grid.idx[i] * 3;
    d[o] = pal[c];
    d[o + 1] = pal[c + 1];
    d[o + 2] = pal[c + 2];
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = grid.w * THUMB_SRC_SCALE;
  out.height = grid.h * THUMB_SRC_SCALE;
  const octx = out.getContext('2d');
  if (!octx) return cell.toDataURL('image/png');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cell, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Export the flattened scene as a transparent indexed PNG (multi-palette aware). */
export async function exportScene(baseName = 'dithtill-scene'): Promise<void> {
  const grid = await resolveCurrentScene();
  if (!grid) {
    notifyBanner('Scene is empty');
    return;
  }
  try {
    // The canvas as it rests, through the same print screens as the glass + the video.
    const s = useSceneStore.getState();
    const png = renderStillPng({
      nodes: s.nodes,
      scene: s.scene,
      dims: currentSceneDims(),
      assets: restingAssets(),
      background: currentSceneBackground(),
      dotInk: s.dotInk,
      canvasFx: s.canvasFx,
    });
    const saved = await savePngToDisk(new Uint8Array(png), `${baseName}.png`);
    if (saved) void notifyConfirm(`to ${folderName(saved)}`, 'Saved');
    else notifyBanner('Export cancelled');
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Export failed');
  }
}

/** Export the flattened scene as an SVG (G7) — the SAME resolveSceneGrid seam
 *  as the PNG, so the vector's rect coverage equals the raster cell-for-cell. */
export async function exportSceneSvg(baseName = 'dithtill-scene'): Promise<void> {
  const grid = await resolveCurrentScene();
  if (!grid) {
    notifyBanner('Scene is empty');
    return;
  }
  try {
    // The canvas as the glass shows it, as vectors: every layer's own dots + bits
    // (print screens), overprinting like the PNG.
    const st = useSceneStore.getState();
    const svg = renderStillSvg({
      nodes: st.nodes,
      scene: st.scene,
      dims: currentSceneDims(),
      assets: restingAssets(),
      background: currentSceneBackground() ?? null,
      dotInk: st.dotInk,
      canvasFx: st.canvasFx,
    });
    const saved = await saveSvgToDisk(svg, `${baseName}.svg`);
    if (saved) void notifyConfirm(`to ${folderName(saved)}`, 'Saved');
    else notifyBanner('Export cancelled');
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Export failed');
  }
}

/** A look's print-screen part, as an element carries it. */
function elementScreen(l: Look): ElementScreen {
  return {
    style: l.style,
    shape: l.shape,
    density: l.density,
    angle: l.angle,
    dotsTurn: l.dotsTurn,
    bitSize: l.bitSize,
    colourMode: l.colourMode,
  };
}

/** Flatten the scene and save it back to the Library as one new element. */
/** A Library element name: the project's, numbered when the Library already has it. */
function uniqueElementName(base: string): string {
  const taken = new Set(useLibraryStore.getState().elements.map((e) => e.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(base + ' ' + n)) return base + ' ' + n;
}

/** Save one recording to the Library: the layer itself, not a picture of it.
 *  Its tile is its finished picture. */
export async function saveRecordingToLibrary(nodeId: string, name: string): Promise<void> {
  const st = useSceneStore.getState();
  const lp = useLoopStore.getState();
  const n = st.nodes.find((x) => x.id === nodeId);
  const raster = n && getAssetCache().get(n.assetId);
  const loop = lp.layerLoops[nodeId];
  const picture = n && finishedPicture(n);
  if (!n || !raster || !loop || !picture) {
    notifyBanner('Nothing recorded to save yet');
    return;
  }
  try {
    const dims = currentSceneDims();
    const still = { ...n, clips: undefined, hidden: false };
    const assets = new Map(getAssetCache());
    assets.set(n.assetId, picture);
    const input = {
      nodes: [still],
      scene: st.scene,
      dims,
      assets,
      background: currentSceneBackground(),
      dotInk: st.dotInk,
    };
    const png = renderStillPng(input);
    const thumbnail = `data:image/png;base64,${bytesToBase64(renderStillPng(input, 2))}`;
    const clips = n.clips?.length
      ? n.clips
      : [{ id: 'bar', start: 0, duration: loop.frames, sourceIn: 0 }];
    const start = Math.min(...clips.map((c) => c.start));
    const own = lp.events.filter((e) => e.nodeId === nodeId);
    const muted = [...new Set(own.map((e) => e.layer))].filter((l) => lp.mutedLayers.includes(l));
    const built = await buildRecordingElement({
      data: {
        events: own,
        ...(muted.length ? { muted } : {}),
        loop,
        clips: clips.map((c) => ({ ...c, start: c.start - start })),
        layer: {
          look: n.look,
          opacity: n.opacity,
          placement: n.placement,
          crop: n.crop,
          motion: n.motion,
          ...(n.rec ? { rec: n.rec } : {}),
          ...(n.solid ? { solid: n.solid } : {}),
          ...(n.fx ? { fx: n.fx } : {}),
          ...(n.mods ? { mods: n.mods } : {}),
          ...(n.window ? { window: n.window } : {}),
        },
        canvas: dims,
      },
      png,
      thumbnail,
      w: raster.w,
      h: raster.h,
      ...(raster.per ? { per: raster.per } : {}),
      aspect: useBurnStore.getState().aspect,
      cell: st.pixel,
      palette: st.scene.palette,
      matrix: st.scene.matrix,
      fps: lp.meta.fps,
      createdAt: Date.now(),
      name: uniqueElementName(name),
    });
    await useLibraryStore.getState().addRecording(built);
    notifyBanner('Saved to Library');
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Could not save');
  }
}

export async function saveSceneAsElement(projectName?: string): Promise<void> {
  const grid = await resolveCurrentScene();
  if (!grid) {
    notifyBanner('Scene is empty');
    return;
  }
  try {
    const bg = currentSceneBackground();
    // Bake the stored element PNG in the active cell style so the saved
    // element — and its downloaded file — matches the dots on the glass, like the
    // direct/loop exports do. (The Library-grid thumbnail stays square; cosmetic.)
    const bsSave = useBurnStore.getState();
    // The element's picture is the canvas as the glass shows it (print screens).
    const st0 = useSceneStore.getState();
    const png = renderStillPng({
      nodes: st0.nodes,
      scene: st0.scene,
      dims: currentSceneDims(),
      assets: restingAssets(),
      background: bg,
      dotInk: st0.dotInk,
      canvasFx: st0.canvasFx,
    });
    const thumbnail = sceneGridThumbnail(grid, bg);
    // The background bakes into the saved element as content (its tone), so the
    // element carries its canvas everywhere.
    // HALFTONE keeps the background as a SETTING instead:
    // baked in as content, the background cells would grow dots of their own on reload, so
    // the canvas would not come back as saved. It re-applies when the element opens on an
    // empty canvas (the v4 look rule) — exactly as shown.
    const bakeBg = !!bg && !isHalftoneStyle(bsSave.cellStyle);
    const composite = sceneToneComposite(grid, bakeBg ? sceneBackgroundTone(bg!) : undefined);
    const sceneStore = useSceneStore.getState();
    const scene = sceneStore.scene;
    const topVisible = [...sceneStore.nodes].sort((x, y) => y.z - x.z).find((n) => !n.hidden);
    await useLibraryStore.getState().add({
      composite,
      png,
      thumbnail,
      source: 'record',
      aspect: useBurnStore.getState().aspect,
      palette: scene.palette,
      matrix: scene.matrix,
      // v4 (§8.B): persist the scene-wide look so a re-dropped scene keeps its render
      // style. cellStyle/dotDensity are the device globals; dotSize/dotGrow the scene
      // default; dotInk the scene Swatch. A dither canvas's flat background is baked into the
      // element's content (sceneToneComposite), so it's null here (not double-applied).
      look: {
        cellStyle: bsSave.cellStyle,
        dotDensity: bsSave.dotDensity,
        dotSize: scene.dotSize,
        dotGrow: scene.dotGrow,
        dotInk: sceneStore.dotInk,
        background: bakeBg ? null : sceneStore.background,
        // The top visible layer's screen (each layer keeps its own) — a layer made
        // from this element starts with it.
        screen: elementScreen({ ...scene, ...(topVisible?.look ?? {}) }),
      },
      // v5: the canvas Pixel travels as the record's producing `cell`,
      // so the saved canvas reopens / drops 1:1 on the grid it was made on.
      cell: sceneStore.pixel,
      // Named after its project — exports from the Library use it.
      ...(projectName ? { name: uniqueElementName(projectName) } : {}),
    });
    notifyBanner('Saved to Library');
  } catch (e) {
    void notifyConfirm(e instanceof Error ? e.message : String(e), 'Could not save');
  }
}
