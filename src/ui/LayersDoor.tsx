import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useSceneStore } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import { clearTrack } from './audio-engine';
import { layerKind, layerNames } from './layer-names';
import { notifyBanner } from '../state/notify-store';
import { LayerMenu, type LayerMenuAt } from './LayerMenu';
import { MoveMark } from './MovesList';
import { createPaintLayer, createRecordingLayer } from './paint-node';
import { importToCanvas } from './image-layers';
import { loadMedia, loadSong } from './load-image';
import { VizGalleryPop } from './VizGallery';
import { addVisualizer } from './visualizer-node';
import { addTextLayer } from './text-node';
import { VISUALIZER_DEFAULT } from '../core/visualizer';
import type { ModParam } from '../core/modulators';
import type { FxKind } from '../core/layer-fx';
import { asOneStep } from './history';

/**
 * The Layers "+": every way to add something to the canvas in one
 * short menu — a blank drawing, a photo or video, a visualizer (the gallery), a song.
 */
function AddLayerMenu() {
  // The open menu's anchor (the + button) and position — captured on click, never read
  // from a ref during render.
  const [at, setAt] = useState<{ el: HTMLElement; left: number; top: number } | null>(null);
  const [gallery, setGallery] = useState<HTMLElement | null>(null);
  const recording = useLoopStore((s) => s.transport === 'recording');
  const menuRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const songRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !at.el.contains(t)) setAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAt(null);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [at]);

  return (
    <>
      <button
        type="button"
        className={`crt-layers-add${at || gallery ? ' is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label="Add a layer"
        title="Add a layer: drawing, photo or video, visualizer, text, track"
        disabled={recording}
        onClick={(e) => {
          setGallery(null);
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ el: e.currentTarget, left: Math.max(8, r.right - 180), top: r.bottom + 4 });
        }}
      >
        +
      </button>
      {at && (
        <div
          ref={menuRef}
          className="layer-menu"
          role="menu"
          aria-label="Add a layer"
          style={{ left: at.left, top: at.top }}
        >
          <span className="layer-menu-title">Add</span>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              createPaintLayer();
              useSceneStore.getState().setTool('paint');
              notifyBanner('New layer — draw on the canvas');
            }}
          >
            New layer
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              createRecordingLayer();
              useSceneStore.getState().setTool('paint');
              notifyBanner('New recording — set its Look, then press Rec on the timeline');
            }}
          >
            New recording
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              mediaRef.current?.click();
            }}
          >
            Photo or video…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              setGallery(at.el);
            }}
          >
            Visualizer…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              addTextLayer();
            }}
          >
            Text…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              songRef.current?.click();
            }}
          >
            Track…
          </button>
        </div>
      )}
      {gallery && (
        <VizGalleryPop
          anchor={gallery}
          title="Add a visualizer"
          base={VISUALIZER_DEFAULT}
          onPick={addVisualizer}
          onClose={() => setGallery(null)}
        />
      )}
      <input
        ref={mediaRef}
        type="file"
        accept="image/*,video/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) loadMedia(file, importToCanvas);
        }}
      />
      <input
        ref={songRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void loadSong(file);
        }}
      />
    </>
  );
}

/** Clear all ("clears the whole canvas, every single thing"): every
 *  layer, take, reaction and canvas move, and the track. ONE Undo brings everything back
 *  except the track (session audio — add it again). */
function clearEverything(): void {
  asOneStep(() => {
    const st = useSceneStore.getState();
    st.clear();
    for (const p of Object.keys(st.canvasMods) as ModParam[]) st.setMod('', p, null);
    st.setMotion('', null);
    for (const k of Object.keys(st.canvasFx ?? {}) as FxKind[]) st.setFx('', k, null);
    useLoopStore.getState().clearAllAuthored();
  });
  clearTrack();
  notifyBanner('Everything cleared — Undo brings it back (add the track again)');
}

/**
 * The LAYERS door (owner ask, 2026-07-02) — Record's scene stack inside the left
 * grille compartment. One row per scene element, TOP layer first (a simple
 * Procreate-style stack): tap = select (synced with the on-glass selection —
 * also the only way to reach something buried under a full-frame video). One canvas:
 * rows read as names (Photo 1, Drawing 2…), DRAG a row up/down to
 * reorder (one undo step), and the selected layer's settings — Delete included — open
 * in the panel below. Arrangement is an EDIT, so the stack rests while the loop runs.
 */
export function LayersDoor({ onClose }: { onClose: () => void }) {
  const nodes = useSceneStore((s) => s.nodes);
  const selected = useSceneStore((s) => s.selected);
  const transport = useLoopStore((s) => s.transport);
  const withAudio = useLoopStore((s) => s.meta.withAudio);
  const audioSources = useLoopStore((s) => s.audioSources);
  const audioMuted = useLoopStore((s) => s.audioMuted);
  const trackName = useLoopStore((s) => s.trackName);
  const toggleAudioMute = useLoopStore((s) => s.toggleAudioMute);
  const [armDelete, setArmDelete] = useState(false);
  // The imported track is a pseudo-layer (not a scene node) — track its selection
  // locally so its own ✕ can remove it.
  const [trackSelected, setTrackSelected] = useState(false);
  const deleteTimer = useRef(0);

  const stack = [...nodes].sort((a, b) => b.z - a.z); // top layer first
  const locked = transport !== 'stopped';
  // Audio-bearing sources (P6): a speaker toggle per source — a MIX filter, live
  // OK (muting mid-play is a performance move; the engine rebuilds the mix).
  const audioIds = withAudio ? new Set(audioSources.map((a) => a.id)) : new Set<string>();
  // The imported track ROW shows whenever a track EXISTS (removable regardless of
  // Loop-Sound state — a track persists when audio is toggled off, so gating the
  // ✕ on "in the mix" would strand it). The mute speaker only shows when it's
  // actually mixed (muting an inactive track is meaningless).
  const trackInMix = withAudio && audioSources.some((a) => a.kind === 'track');
  const trackSel = trackSelected && trackName != null; // self-invalidates when the track is gone

  const speaker = (id: string, label: string) => {
    const muted = audioMuted.includes(id);
    return (
      <span
        role="button"
        tabIndex={0}
        className={`crt-layer-spk${muted ? ' is-muted' : ''}`}
        aria-pressed={muted}
        title={muted ? `Unmute ${label}` : `Mute ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleAudioMute(id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            toggleAudioMute(id);
          }
        }}
      >
        {muted ? '🔇' : '🔊'}
      </span>
    );
  };

  const names = layerNames(nodes);

  // DRAG to reorder: press a row and move past a few px → it follows the
  // pointer; release over another row's slot to move it there (ONE undo step). A press
  // without movement is a plain select. Pointer events (not HTML5 drag) so it works the
  // same in the desktop webview, where file-drop handling can swallow native drags.
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const [menu, setMenu] = useState<LayerMenuAt | null>(null);
  const press = useRef<{ id: string; y: number; moved: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** The stack slot (0 = top) under a client Y — the row whose midpoint is below it. */
  const slotAt = (clientY: number): number => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-slot]') ?? [];
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (clientY < b.top + b.height / 2) return Number(r.dataset.slot);
    }
    return stack.length - 1;
  };
  const onRowDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (locked || e.button !== 0) return;
    press.current = { id, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onRowMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.abs(e.clientY - p.y) < 5) return;
    p.moved = true;
    setDrag({ id: p.id, over: slotAt(e.clientY) });
  };
  const onRowUp = (id: string) => {
    const p = press.current;
    press.current = null;
    if (p?.moved && drag) {
      // Stack slot (top-first) → bottom-up z index.
      useSceneStore.getState().moveLayer(drag.id, stack.length - 1 - drag.over);
      setDrag(null);
      return;
    }
    setDrag(null);
    setTrackSelected(false);
    useSceneStore.getState().setSelection([id]);
  };

  const canvasMods = useSceneStore((s) => s.canvasMods);
  const canvasReacts = useLoopStore((s) => s.reactions.some((r) => r.nodeId === ''));
  const canvasMotion = useSceneStore((s) => !!s.canvasMotion);
  const canvasFx = useSceneStore((s) => !!s.canvasFx);
  const hasCanvasMoves =
    Object.values(canvasMods).some(Boolean) || canvasReacts || canvasMotion || canvasFx;
  const wholeSel = selected.length === 0 && !trackSel;
  const [armClearAll, setArmClearAll] = useState(false);
  const clearAllTimer = useRef(0);
  const onClearAll = () => {
    if (locked) return;
    if (!armClearAll) {
      setArmClearAll(true);
      clearAllTimer.current = window.setTimeout(() => setArmClearAll(false), 2500);
      return;
    }
    window.clearTimeout(clearAllTimer.current);
    setArmClearAll(false);
    clearEverything();
  };

  const onDeleteTrack = () => {
    if (locked || !trackName) return;
    if (!armDelete) {
      setArmDelete(true);
      deleteTimer.current = window.setTimeout(() => setArmDelete(false), 2500);
      return;
    }
    window.clearTimeout(deleteTimer.current);
    setArmDelete(false);
    clearTrack();
    setTrackSelected(false);
    notifyBanner('Track removed');
  };

  return (
    <div className="crt-layers" role="group" aria-label="Layers">
      {menu && <LayerMenu at={menu} onClose={() => setMenu(null)} />}
      <button
        type="button"
        className="crt-layers-close"
        onClick={onClose}
        aria-label="Close layers"
        title="Close"
      >
        ‹
      </button>
      <span className="crt-layers-title">Layers</span>
      <AddLayerMenu />
      <div className="crt-layers-list" role="listbox" aria-label="Layers, top first" ref={listRef}>
        {/* Whole canvas: always the top row. Picking it = no layer picked,
            so the panel shows the canvas's own moves; its Clear all wipes everything. */}
        <div className="crt-layer-wrap">
          <button
            type="button"
            role="option"
            aria-selected={wholeSel}
            className={`crt-layer-row crt-layer-row--canvas${wholeSel ? ' is-sel' : ''}`}
            disabled={locked}
            title="The whole canvas: its Look and its own moves (no layer picked)"
            onClick={() => {
              setTrackSelected(false);
              useSceneStore.getState().clearSelection();
            }}
          >
            <span className="crt-layer-name">◇ Whole canvas</span>
          </button>
          {wholeSel && (stack.length > 0 || trackName != null || hasCanvasMoves) && (
            <button
              type="button"
              className={`crt-layer-btn crt-layer-clear${armClearAll ? ' is-arm' : ''}`}
              disabled={locked}
              title="Clear all: wipe every layer, take, move and the track (click twice). Undo brings it back, except the track."
              aria-label="Clear all"
              onClick={onClearAll}
            >
              {armClearAll ? 'Sure?' : 'Clear all'}
            </button>
          )}
        </div>
        {trackName != null && (
          <div className="crt-layer-wrap">
            <button
              type="button"
              role="option"
              aria-selected={trackSel}
              className={`crt-layer-row crt-layer-row--audio${trackInMix ? '' : ' is-off'}${trackSel ? ' is-sel' : ''}`}
              disabled={locked}
              title={`Imported track: ${trackName}${trackInMix ? '' : ' — Loop Sound is off'}`}
              onClick={() => {
                setTrackSelected(true);
                useSceneStore.getState().setSelection([]);
              }}
            >
              <span className="crt-layer-name">♪ Track</span>
            </button>
            {trackInMix && speaker('track', 'the imported track')}
            {trackSel && (
              <button
                type="button"
                className={`crt-layer-btn crt-layer-x${armDelete ? ' is-arm' : ''}`}
                disabled={locked}
                title="Remove the imported track (click twice)"
                aria-label="Remove the imported track"
                onClick={onDeleteTrack}
              >
                {armDelete ? '?' : '✕'}
              </button>
            )}
          </div>
        )}
        {stack.map((n, i) => {
          const isSel = selected.includes(n.id);
          const dragging = drag?.id === n.id;
          const dropHere = drag && !dragging && drag.over === i;
          return (
            <div className="crt-layer-wrap" key={n.id}>
              <button
                type="button"
                role="option"
                data-slot={i}
                aria-selected={isSel}
                className={`crt-layer-row${n.kind === 'recording' ? ' is-rec' : ''}${isSel ? ' is-sel' : ''}${dragging ? ' is-drag' : ''}${dropHere ? ' is-drop' : ''}${n.hidden ? ' is-hidden' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!locked)
                    setMenu({
                      nodeId: n.id,
                      name: names.get(n.id) ?? 'Layer',
                      x: e.clientX,
                      y: e.clientY,
                    });
                }}
                disabled={locked}
                title={
                  locked
                    ? 'Stop the loop to arrange layers'
                    : 'Select · drag up or down to reorder · right-click for Hide / Duplicate / Delete'
                }
                onPointerDown={(e) => onRowDown(e, n.id)}
                onPointerMove={onRowMove}
                onPointerUp={() => onRowUp(n.id)}
                onPointerCancel={() => {
                  press.current = null;
                  setDrag(null);
                }}
              >
                <span className="crt-layer-name">
                  {n.kind === 'recording' && '● '}
                  {names.get(n.id)}
                  <MoveMark node={n} />
                  {n.window && (
                    <span className="move-mark" title="Seen through its window">
                      {' '}
                      ▭
                    </span>
                  )}
                </span>
                <span className={`crt-layer-tag crt-layer-tag--${layerKind(n)}`}>
                  {stack.length - i}
                </span>
              </button>
              {audioIds.has(n.assetId) && speaker(n.assetId, 'this layer’s audio')}
            </div>
          );
        })}
      </div>
    </div>
  );
}
