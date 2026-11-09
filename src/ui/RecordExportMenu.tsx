import { useRef } from 'react';
import { useSceneStore, sceneDimsAt, detailFactor } from '../state/scene-store';
import { findRecord, getAssetBytes } from './session-assets';
import { useBurnStore } from '../state/burn-store';
import { useLoopStore } from '../state/loop-store';
import { exportLoop } from '../platform/loop-export';
import { motionPeriodFrames } from '../core/loop-events';
import { beatClock, exportAudioInputs } from './audio-engine';
import { timelineSpan } from './moves';
import { BEATS_PER_BAR, BPM_DEFAULT } from '../core/tempo';
import { pickExportLength } from '../state/export-length-store';
import { videoRasterLongForCoverage } from './image-to-grid';
import { modulatedPhotoRaster } from './image-layers';
import { ensureAssets, getAssetCache } from './scene-assets';
import {
  currentSceneBackground,
  exportScene,
  exportSceneSvg,
  saveSceneAsElement,
} from './record-actions';
import { notifyConfirm, notifyBanner, folderName, useNotifyStore } from '../state/notify-store';
import { ExportMenu, type ExportMenuItem } from './ExportMenu';
import { exportBaseName, newProject, openProjectFile, saveProjectFile } from './projects';

/**
 * The canvas's Project ▾ menu, in three labelled groups with a hint under the items that make
 * something: PROJECT (New project · Back up as file · Open file) ·
 * KEEP (Save to Library) · SHARE (the
 * Export items (G7): the still scene as PNG or SVG (both through the
 * ONE resolveSceneGrid seam) and the deterministic loop export (P8 —
 * MP4/GIF via the codec; cancellable, runs from a
 * STOPPED transport). Replaces the PNG|Loop rail pair with a single button, so
 * the rail got SHORTER — the shared deck reserve is untouched.
 */
export function RecordExportMenu() {
  const nodes = useSceneStore((s) => s.nodes);
  const transport = useLoopStore((s) => s.transport);
  const empty = nodes.length === 0;
  const fileRef = useRef<HTMLInputElement>(null);

  // Projects: the canvas auto-saves; these start, move and reopen projects.
  const projectItems: ExportMenuItem[] = [
    {
      key: 'new',
      heading: 'Project',
      label: 'New project',
      title: 'Start a fresh canvas (this one is saved in Projects, in the Library)',
      disabled: transport !== 'stopped',
      run: () => newProject(),
    },
    {
      key: 'save-file',
      label: 'Back up as file…',
      hint: 'the whole project, editable (.dithtill)',
      title:
        'Save this project as one .dithtill file — to back it up or move it to another computer',
      run: () => saveProjectFile(),
    },
    {
      key: 'open-file',
      label: 'Open file…',
      title: 'Open a .dithtill project file',
      disabled: transport !== 'stopped',
      run: async () => fileRef.current?.click(),
    },
  ];

  const items: ExportMenuItem[] = [
    {
      key: 'save',
      heading: 'Keep',
      label: 'Save to Library',
      hint: 'this picture, to reuse in other projects',
      title: 'Save the whole canvas to your Library, exactly as shown',
      disabled: empty,
      run: async () => {
        await saveSceneAsElement(exportBaseName());
      },
    },
    {
      key: 'png',
      heading: 'Share',
      label: 'Export PNG',
      hint: 'a picture to post',
      title: 'Export the scene as a PNG',
      disabled: empty,
      run: () => exportScene(exportBaseName()),
    },
    {
      key: 'svg',
      label: 'Export SVG',
      hint: 'a scalable picture for print or design',
      title: 'Export the scene as a scalable vector',
      disabled: empty,
      run: () => exportSceneSvg(exportBaseName()),
    },
    {
      key: 'video',
      label: 'Export video…',
      hint: 'the loop as MP4 or GIF',
      title: 'Export the loop as video — pick the format (MP4 / GIF) + length on the glass',
      disabled: empty || transport !== 'stopped',
      cancellable: true,
      run: async ({ signal }) => {
        const setProgress = useNotifyStore.getState().setProgress;
        const scene = useSceneStore.getState();
        if (scene.nodes.length === 0) {
          notifyBanner('Scene is empty');
          return;
        }
        // the on-glass panel picks the whole video or the marked part (and the
        // container). It checks a GIF against the loops that move in it.
        const lp0 = useLoopStore.getState();
        const loopMeta = lp0.meta;
        const F = Math.max(1, loopMeta.frames);
        const loops = new Set<number>();
        const recorded = new Set(lp0.events.map((e) => e.nodeId));
        for (const n of scene.nodes) {
          const own = lp0.layerLoops[n.id];
          if (own) loops.add(own.frames);
          else if (recorded.has(n.id)) loops.add(F);
          if (n.motion) loops.add(motionPeriodFrames(F, [n], [], beatClock()));
        }
        if (scene.canvasMotion)
          loops.add(motionPeriodFrames(F, [], [], beatClock(), undefined, scene.canvasMotion));
        const chosen = await pickExportLength(
          {
            fps: loopMeta.fps,
            videoFrames: timelineSpan(),
            loops: [...loops],
            bpm: loopMeta.bpm ?? BPM_DEFAULT,
            beatsPerBar: loopMeta.beatsPerBar ?? BEATS_PER_BAR,
          },
          signal,
        );
        if (chosen == null) {
          notifyBanner('Export cancelled');
          return;
        }
        // The panel resolves the length, the start (a marked part) and the container.
        const totalFrames = chosen.frames !== F ? chosen.frames : undefined; // omit when T == F
        setProgress('Preparing…');
        try {
          await ensureAssets(scene.nodes.map((n) => n.assetId));
          // The scene lattice dims (== the live previewer's) size the crop-aware video rasters.
          // At the project's Detail (Fine keeps 4× the picture per square).
          const per = detailFactor();
          const lattice = sceneDimsAt(
            useBurnStore.getState().aspect,
            useSceneStore.getState().pixel,
          );
          const sceneLatticeDims = { w: lattice.w * per, h: lattice.h * per };
          const sceneLatticeLong = Math.max(sceneLatticeDims.w, sceneLatticeDims.h);
          // Placed video elements: the Library record + the full source bytes (the exporter
          // decodes exact frames in bounded segments) + the CROP-AWARE tone-raster long (S2),
          // computed HERE via the SAME formula the live previewer uses so live == export and
          // the deterministic export module stays ui-free (the determinism lint).
          const videos: Parameters<typeof exportLoop>[0]['videos'] = [];
          for (const n of scene.nodes) {
            const rec = findRecord(n.assetId);
            if (!rec || rec.kind !== 'video') continue;
            if (videos.some((v) => v.assetId === n.assetId)) continue;
            const bytes = await getAssetBytes(rec.videoHash);
            if (!bytes) throw new Error('A video layer’s source bytes are missing');
            const rasterLong = videoRasterLongForCoverage(
              rec.w,
              rec.h,
              rec.aspect,
              rec.reframe,
              sceneLatticeDims.w,
              sceneLatticeDims.h,
              sceneLatticeLong,
            );
            videos.push({ assetId: n.assetId, rec, bytes, rasterLong, per, clips: n.clips });
          }
          const loop = useLoopStore.getState();
          // v15: the Loop-Sound inputs as plain data (null = silent MP4). Gathered
          // HERE (the live layer) so the deterministic exporter stays engine-free.
          const audio = await exportAudioInputs();
          const saved = await exportLoop(
            {
              render: {
                nodes: scene.nodes,
                scene: scene.scene,
                // Authored reactions fold in beside the overdub log (same as live).
                events: [...loop.events, ...loop.reactions],
                frames: loop.meta.frames,
                // the picker's absolute frame count T (beyond the loop).
                // Omitted when T == F → today's single-pass, byte-identical path.
                ...(totalFrames != null ? { totalFrames } : {}),
                seed: loop.meta.seed,
                dims: sceneDimsAt(useBurnStore.getState().aspect, useSceneStore.getState().pixel),
                assets: new Map(getAssetCache()),
                mutedLayers: new Set(loop.mutedLayers),
                // The pre-analyzed FeatureArray — the SAME array the live preview
                // reads, so the exported reactions match the glass frame-for-frame.
                features: loop.features,
                background: currentSceneBackground() ?? null,
                // Scene-wide Halftone dot ink (custom-colour Phase 1) — live == export.
                dotInk: scene.dotInk,
                // Object-path loop-close blend (H-A0) — the SAME toggle the live glass
                // reads, so exported paths wrap exactly as previewed.
                pathClose: loop.meta.pathClose,
                // The beat clock (J1) — the SAME one the live canvas reads.
                beat: beatClock(),
                // Modulators (J2): the canvas's own, and the SAME photo re-treatment the
                // live canvas uses for a moving tone dial.
                canvasMods: scene.canvasMods,
                canvasMotion: scene.canvasMotion,
                canvasFx: scene.canvasFx,
                // Each recorded layer's own loop — the SAME the live canvas reads.
                layerLoops: loop.layerLoops,
                photoRasterAt: modulatedPhotoRaster,
              },
              fps: loop.meta.fps,
              videos, // each carries its crop-aware rasterLong (== the live previewer)
              audio, // v15: the canonical Loop-Sound inputs (MP4 carries them; GIF is silent)
              // F5: the on-glass panel chose the container; the save dialog now shows
              // ONLY this format's filter (a beyond-loop length forced MP4 already).
              format: chosen.format,
              startFrame: chosen.start, // the marked part's start, else 0
              fileName: exportBaseName(), // named after the project
            },
            {
              onStatus: setProgress,
              onProgress: (done, total) => setProgress(`Rendering ${done}/${total}`),
              signal,
            },
          );
          setProgress(null);
          if (saved) void notifyConfirm(`to ${folderName(saved)}`, 'Saved');
          else notifyBanner('Export cancelled');
          // v1 policy (mirrors the Burn suite): only MP4 carries the Loop Sound.
          if (saved && audio && !saved.toLowerCase().endsWith('.mp4')) {
            notifyBanner('GIF exports are silent — use MP4 to keep the sound.');
          }
        } catch (e) {
          setProgress(null);
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === 'cancelled') notifyBanner('Export cancelled');
          else void notifyConfirm(msg, 'Export failed');
        }
      },
    },
  ];

  return (
    <>
      <ExportMenu
        items={[...projectItems, ...items]}
        label="Project ▾"
        title={
          transport === 'recording'
            ? 'Finish the take first'
            : 'New project, back up or open a project file, Save to Library, and exports'
        }
        disabled={transport === 'recording'}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".dithtill"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openProjectFile(file);
        }}
      />
    </>
  );
}
