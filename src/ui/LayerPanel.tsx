import { useEffect, useRef, useState } from 'react';
import { useSceneStore, IMAGE_PARAMS_DEFAULT, type ImageLayerParams } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import { Slider } from './Slider';
import { ModSlider } from './ModSlider';
import { MovesList } from './MovesList';
import { duplicateSelection } from './paint-node';
import { hasCutout, removePhotoBackground } from './image-layers';
import { layerKind, layerNames } from './layer-names';
import { notifyBanner } from '../state/notify-store';
import { Dropdown } from './Dropdown';
import { BgSwatches } from './BgSwatches';
import type { Swatch } from '../core/color';
import { paletteLength, type PaletteId } from '../core/dither-constants';
import {
  cyclesOf,
  STYLE_EXTRAS,
  STYLE_SELF_DRIVEN,
  type VisualizerBand,
  type VisualizerConfig,
  type VisualizerMirror,
} from '../core/visualizer';
import { ChangeVizStyle } from './VizGallery';
import { VIZ_BANDS, VIZ_STYLE_LABEL } from './visualizer-node';
import { textFocus } from './text-node';
import { toggleWindowEdit } from './layer-window';
import {
  TEXT_MAX_CHARS,
  TEXT_SIZE_MAX,
  TEXT_SPACING_MAX,
  type TextAlign,
  type TextLayerConfig,
} from '../core/dot-font';
import { beginGesture, endGesture } from '../state/gesture';

const ARM_MS = 2500;

/** A layer's OWN halftone dot colour: off = it uses the canvas dot colour
 *  (set in the left rail's Look); on = its own swatch row. */
function OwnDotColour({
  nodeId,
  own,
  canvasDot,
  palette,
}: {
  nodeId: string;
  own: Swatch | undefined;
  canvasDot: Swatch;
  palette: PaletteId;
}) {
  const st = useSceneStore.getState();
  const on = own !== undefined;
  return (
    <>
      <div className="deck-switch" title="Off: this layer uses the canvas dot colour (Look, left)">
        <span className="deck-switch-label">Own dot colour</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Own dot colour"
          className={`rocker${on ? ' is-on' : ''}`}
          onClick={() => st.setLayerInk(nodeId, on ? undefined : canvasDot)}
        >
          <span className="rocker-knob" />
        </button>
      </div>
      {on && (
        <BgSwatches
          label="Dot"
          name="This layer's dot colour"
          allowNone={false}
          palette={palette}
          value={own}
          onChange={(v) => st.setLayerInk(nodeId, v)}
        />
      )}
    </>
  );
}

/**
 * The SELECTED LAYER's settings — shown in the right panel only while one
 * layer is selected. A photo's own tone dials; any layer's Opacity · Flip · Crop ·
 * Duplicate · Delete. (A layer's own halftone dot colour is set from the ONE Dot row in
 * the Look, which follows the selection —.) Rests while the loop runs.
 */
export function LayerPanel() {
  const nodes = useSceneStore((s) => s.nodes);
  const selected = useSceneStore((s) => s.selected);
  const cropId = useSceneStore((s) => s.cropId);
  const windowId = useSceneStore((s) => s.windowId);
  const transport = useLoopStore((s) => s.transport);
  const layerLoops = useLoopStore((s) => s.layerLoops);
  const fps = useLoopStore((s) => s.meta.fps);
  const [armDelete, setArmDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [photoMore, setPhotoMore] = useState(false);
  const scenePalette = useSceneStore((s) => s.scene.palette);
  const canvasDot = useSceneStore((s) => s.dotInk);
  const timer = useRef(0);

  const node = selected.length === 1 ? nodes.find((n) => n.id === selected[0]) : undefined;
  // The layer's own look: its palette, and whether it prints in one ink.
  const palette = node?.look.palette ?? scenePalette;
  const oneInk = (node?.look.colourMode ?? 'ink') === 'ink';
  if (!node)
    // Whole canvas: its moves move everything together. Shown even with
    // no layers — the canvas's own moves outlive them.
    return selected.length === 0 ? (
      <>
        <div className="deck-hsep" />
        <AnimateHead />
        <span className="deck-ctl-label layer-hint">Whole canvas: moves everything together.</span>
        <MovesList nodeId="" locked={transport !== 'stopped'} />
      </>
    ) : null;
  const st = useSceneStore.getState();
  const kind = layerKind(node);
  const name = layerNames(nodes).get(node.id) ?? 'Layer';
  // The layer's own loop — set by its first recorded take.
  const ownLoop = layerLoops[node.id];
  const loopSecs = ownLoop ? +(ownLoop.frames / Math.max(1, fps)).toFixed(1) : 0;
  const loopLabel = !ownLoop
    ? null
    : ownLoop.free
      ? `Free · ${loopSecs}s`
      : ownLoop.bars
        ? `${ownLoop.bars} bar${ownLoop.bars === 1 ? '' : 's'} · ${loopSecs}s`
        : `${loopSecs}s`;
  const locked = transport !== 'stopped';
  const ip = node.image;
  const setIp = (patch: Partial<ImageLayerParams>) => st.setImageParams(node.id, patch);

  const onDelete = () => {
    if (!armDelete) {
      setArmDelete(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmDelete(false), ARM_MS);
      return;
    }
    window.clearTimeout(timer.current);
    setArmDelete(false);
    st.remove([node.id]);
    notifyBanner(`${name} deleted`);
  };

  return (
    <>
      <div className="deck-hsep" />
      <span className="deck-panel-label">{name}</span>
      {loopLabel && (
        <span
          className="deck-ctl-label layer-hint"
          title="What you recorded into this layer repeats this often, for as long as its bar on the timeline lasts"
        >
          Loop: {loopLabel}
        </span>
      )}
      {kind === 'photo' && ip && (
        <>
          <ModSlider
            node={node.id}
            param="photo.brightness"
            label="Brightness"
            value={ip.brightness ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => setIp({ brightness: v })}
            format={(v) => (v > 0 ? `+${v}` : String(v))}
          />
          <ModSlider
            node={node.id}
            param="photo.contrast"
            label="Contrast"
            value={ip.contrast}
            min={0.5}
            max={2.5}
            step={0.05}
            onChange={(v) => setIp({ contrast: v })}
            format={(v) => v.toFixed(2)}
          />
          <div className="deck-switch">
            <span className="deck-switch-label">Invert</span>
            <button
              type="button"
              role="switch"
              aria-checked={ip.invert}
              aria-label="Invert"
              className={`rocker${ip.invert ? ' is-on' : ''}`}
              onClick={() => setIp({ invert: !ip.invert })}
            >
              <span className="rocker-knob" />
            </button>
          </div>
          <div
            className="deck-switch"
            title="Cut out: remove the background offline and keep the subject (then Erase / Restore to tidy it). Off brings the whole photo back."
          >
            <span className="deck-switch-label">{removing ? 'Cutting…' : 'Cut out'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={hasCutout(node)}
              aria-label="Cut out the background"
              disabled={locked || removing}
              className={`rocker${hasCutout(node) ? ' is-on' : ''}`}
              onClick={() => {
                if (hasCutout(node)) return setIp({ matte: null });
                setRemoving(true);
                void removePhotoBackground(node.id).finally(() => setRemoving(false));
              }}
            >
              <span className="rocker-knob" />
            </button>
          </div>
          <button
            type="button"
            className="deck-load viz-more"
            aria-expanded={photoMore}
            onClick={() => setPhotoMore((m) => !m)}
          >
            {photoMore ? '▾ More' : '▸ More'}
          </button>
          {photoMore && (
            <>
              <ModSlider
                node={node.id}
                param="photo.black"
                label="Shadows"
                title="Darker parts at or below this go fully dark"
                value={ip.black}
                min={0}
                max={120}
                step={1}
                onChange={(v) => setIp({ black: v })}
                format={(v) => String(v)}
              />
              <ModSlider
                node={node.id}
                param="photo.gamma"
                label="Mid-tones"
                title="Brighten or darken the middle greys"
                value={ip.gamma}
                min={0.4}
                max={2.5}
                step={0.05}
                onChange={(v) => setIp({ gamma: v })}
                format={(v) => v.toFixed(2)}
              />
              <ModSlider
                node={node.id}
                param="photo.white"
                label="Highlights"
                title="Brighter parts at or above this go fully bright"
                value={ip.white}
                min={135}
                max={255}
                step={1}
                onChange={(v) => setIp({ white: v })}
                format={(v) => String(v)}
              />
              <button
                type="button"
                className="deck-load"
                title="Reset this photo's dials and framing (keeps its cutout)"
                onClick={() => setIp({ ...IMAGE_PARAMS_DEFAULT, matte: ip.matte })}
              >
                Reset photo
              </button>
            </>
          )}
        </>
      )}
      {kind === 'visualizer' && node.viz && (
        <VizSettings nodeId={node.id} name={name} viz={node.viz} />
      )}
      {kind === 'text' && node.text && (
        <TextSettings nodeId={node.id} text={node.text} locked={locked} />
      )}
      {kind === 'video' && (
        <span className="deck-ctl-label layer-hint">
          Trim + sound: on the timeline (Animate's Timeline ▴)
        </span>
      )}
      {oneInk && (
        <OwnDotColour
          nodeId={node.id}
          own={node.look.dotInk}
          canvasDot={canvasDot ?? paletteLength(palette) - 1}
          palette={palette}
        />
      )}
      <ModSlider
        node={node.id}
        param="opacity"
        label="Opacity"
        value={node.opacity ?? 100}
        min={0}
        max={100}
        step={1}
        disabled={locked}
        onChange={(v) => st.setOpacity([node.id], v)}
        format={(v) => `${v}%`}
      />
      {/* Solid: off = its inks mix with what's under it; on = blocks it. */}
      <div
        className="deck-switch"
        title="Solid: blocks what's under it inside its shape · off: its dots mix with the layers below"
      >
        <span className="deck-switch-label">Solid</span>
        <button
          type="button"
          role="switch"
          aria-checked={!!node.solid}
          aria-label="Solid — block what's under it"
          className={`rocker${node.solid ? ' is-on' : ''}`}
          disabled={locked}
          onClick={() => st.setSolid([node.id], !node.solid)}
        >
          <span className="rocker-knob" />
        </button>
      </div>
      <div className="layer-acts">
        <button
          type="button"
          className="deck-load"
          disabled={locked}
          title="Flip left–right"
          aria-label="Flip horizontal"
          onClick={() => st.flip('h')}
        >
          ⇋
        </button>
        <button
          type="button"
          className="deck-load"
          disabled={locked}
          title="Flip upside down"
          aria-label="Flip vertical"
          onClick={() => st.flip('v')}
        >
          ⇵
        </button>
        <button
          type="button"
          className={`deck-load${cropId === node.id ? ' is-on' : ''}`}
          disabled={locked}
          aria-pressed={cropId === node.id}
          title="Crop: drag the box's edges on the canvas · double-click it to clear · click Crop again when done"
          onClick={() => {
            if (cropId === node.id) return st.setCropId(null);
            st.setTool('arrange'); // the crop box needs the pointer, not the brush
            st.setCropId(node.id);
          }}
        >
          Crop
        </button>
        <button
          type="button"
          className={`deck-load${windowId === node.id ? ' is-on' : ''}`}
          disabled={locked}
          aria-pressed={windowId === node.id}
          title="Window: a box fixed on the canvas this layer is seen through as it moves (a sign for a marquee) · drag it or its edges on the canvas · click Window again when done"
          onClick={() => toggleWindowEdit(node)}
        >
          Window
        </button>
        <button
          type="button"
          className="deck-load"
          disabled={locked}
          title="Duplicate this layer"
          onClick={duplicateSelection}
        >
          Copy
        </button>
        <button
          type="button"
          className={`deck-load layer-del${armDelete ? ' is-arm' : ''}`}
          disabled={locked}
          title={armDelete ? 'Click again to delete' : 'Delete this layer (click twice)'}
          onClick={onDelete}
        >
          {armDelete ? 'Sure?' : 'Delete'}
        </button>
      </div>
      {node.window && (
        <div className="layer-window-row">
          <span className="deck-ctl-label layer-hint">
            {windowId === node.id
              ? 'Drag the box or its edges on the canvas.'
              : 'Seen through its window ▭'}
          </span>
          <button
            type="button"
            className="deck-load"
            disabled={locked}
            title="Remove the window: the whole layer shows again"
            onClick={() => {
              st.setWindow(node.id, null);
              if (windowId === node.id) st.setWindowId(null);
            }}
          >
            Remove
          </button>
        </div>
      )}
      <div className="deck-hsep" />
      <AnimateHead />
      <MovesList nodeId={node.id} locked={locked} />
    </>
  );
}

/** The Animate list's title, with the button that opens / closes the timeline strip along
 *  the bottom (it replaced the Animate ▸ button under Layers). */
function AnimateHead() {
  const open = useLoopStore((s) => s.animate);
  return (
    <div className="anim-head">
      <span className="deck-panel-label">Animate</span>
      <button
        type="button"
        className={`deck-load anim-tl${open ? ' is-on' : ''}`}
        aria-pressed={open}
        title={
          open
            ? 'Close the timeline'
            : 'Open the timeline: record takes, trim clips, time the loop and draw Frame dots'
        }
        onClick={() => {
          const lp = useLoopStore.getState();
          if (open) lp.setScrub(null);
          lp.setAnimate(!open);
        }}
      >
        {open ? 'Timeline ▾' : 'Timeline ▴'}
      </button>
    </div>
  );
}

const ALIGNS: { value: TextAlign; label: string; title: string }[] = [
  { value: 'left', label: 'L', title: 'Line up the lines on the left' },
  { value: 'center', label: 'C', title: 'Centre the lines' },
  { value: 'right', label: 'R', title: 'Line up the lines on the right' },
];

/**
 * A selected TEXT layer's settings: a box to type into (Enter
 * starts a new line), Size (the same dots, spread further apart), Spacing (gaps between
 * letters) and Align. A typing session is ONE undo step (a gesture from the first key to
 * leaving the box); each slider drag is one step too.
 */
function TextSettings({
  nodeId,
  text,
  locked,
}: {
  nodeId: string;
  text: TextLayerConfig;
  locked: boolean;
}) {
  const set = (patch: Partial<TextLayerConfig>) => useSceneStore.getState().setText(nodeId, patch);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // A just-added layer takes the cursor with its words selected, so typing replaces them.
  useEffect(() => {
    if (textFocus.id !== nodeId) return;
    textFocus.id = null;
    boxRef.current?.focus();
    boxRef.current?.select();
  }, [nodeId]);
  return (
    <>
      <textarea
        ref={boxRef}
        className="text-layer-input"
        aria-label="Text"
        value={text.text}
        rows={Math.min(4, Math.max(1, text.text.split('\n').length))}
        maxLength={TEXT_MAX_CHARS}
        spellCheck={false}
        disabled={locked}
        placeholder="Type here"
        onKeyDown={(e) => {
          e.stopPropagation(); // typing must never trigger canvas shortcuts (Delete, Ctrl+Z…)
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        onBeforeInput={() => {
          if (!gestureOpen.current) {
            gestureOpen.current = true;
            beginGesture();
          }
        }}
        onChange={(e) => set({ text: e.target.value })}
        onBlur={() => {
          if (gestureOpen.current) endGesture();
          gestureOpen.current = false;
        }}
      />
      <ModSlider
        node={nodeId}
        param="text.size"
        label="Size"
        title="Bigger text keeps the same dots and spreads them further apart"
        value={text.size}
        min={1}
        max={TEXT_SIZE_MAX}
        step={1}
        disabled={locked}
        onChange={(v) => set({ size: v })}
        format={(v) => String(v)}
      />
      <ModSlider
        node={nodeId}
        param="text.spacing"
        label="Spacing"
        title="Empty dot columns between letters"
        value={text.spacing}
        min={0}
        max={TEXT_SPACING_MAX}
        step={1}
        disabled={locked}
        onChange={(v) => set({ spacing: v })}
        format={(v) => String(v)}
      />
      <span className="deck-ctl-label">Align</span>
      <div className="layer-acts">
        {ALIGNS.map((a) => (
          <button
            key={a.value}
            type="button"
            className={`deck-load${text.align === a.value ? ' is-on' : ''}`}
            aria-pressed={text.align === a.value}
            disabled={locked}
            title={a.title}
            onClick={() => set({ align: a.value })}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** The open typing session (module-level: one text box is focused at a time). */
const gestureOpen = { current: false };

const MIRRORS: { value: VisualizerMirror; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'No mirror' },
  { value: 'lr', label: '⇋', title: 'Mirror left onto right' },
  { value: 'quad', label: '✣', title: 'Mirror into all four corners' },
];

/**
 * A selected VISUALIZER's settings: its moving style tile + Change
 * style (the ONE gallery), then three plain
 * sliders — what it listens to, how strongly, how smoothly — and the style's extras +
 * Mirror tucked under "More". Every change is one undo step on the layer.
 */
function VizSettings({
  nodeId,
  name,
  viz,
}: {
  nodeId: string;
  name: string;
  viz: VisualizerConfig;
}) {
  const [more, setMore] = useState(false);
  const set = (patch: Partial<VisualizerConfig>) => useSceneStore.getState().setViz(nodeId, patch);
  const ex = STYLE_EXTRAS[viz.style];
  const paceMax = ex.paceMax ?? 1;
  return (
    <>
      <ChangeVizStyle name={name} viz={viz} onStyle={(style) => set({ style })} />
      {STYLE_SELF_DRIVEN.has(viz.style) ? (
        <span
          className="deck-ctl-label layer-hint viz-why"
          title={`${VIZ_STYLE_LABEL[viz.style]} always moves to every part of the sound at once, so it has no Listens to. Rings, Tunnel, Stars, Bubbles, Dust and Vinyl let you pick Bass, Mid, Treble, Beat or Everything.`}
        >
          Moves to every frequency at once ⓘ
        </span>
      ) : (
        <Dropdown<VisualizerBand>
          label="Listens to"
          title="Which part of the sound it moves to"
          options={VIZ_BANDS.map((b) => b.value)}
          value={viz.band}
          onChange={(band) => set({ band })}
          format={(b) => VIZ_BANDS.find((x) => x.value === b)?.label ?? b}
        />
      )}
      <ModSlider
        node={nodeId}
        param="viz.gain"
        scale={100}
        label="Strength"
        title="How big it reacts"
        value={Math.round(viz.gain * 100)}
        min={0}
        max={100}
        step={1}
        onChange={(v) => set({ gain: v / 100 })}
        format={(v) => `${v}%`}
      />
      <ModSlider
        node={nodeId}
        param="viz.smooth"
        scale={100}
        label="Smoothness"
        title="How slowly it falls back after a hit"
        value={Math.round((viz.smooth ?? 0) * 100)}
        min={0}
        max={100}
        step={1}
        onChange={(v) => set({ smooth: v / 100 })}
        format={(v) => `${v}%`}
      />
      <button
        type="button"
        className="deck-load viz-more"
        aria-expanded={more}
        onClick={() => setMore((m) => !m)}
      >
        {more ? '▾ More' : '▸ More'}
      </button>
      {more && (
        <>
          {ex.amount && (
            <ModSlider
              node={nodeId}
              param="viz.amount"
              scale={100}
              label={ex.amount}
              value={Math.round((viz.amount ?? 0.5) * 100)}
              min={0}
              max={100}
              step={1}
              onChange={(v) => set({ amount: v / 100 })}
              format={(v) => `${v}%`}
            />
          )}
          {ex.pace && paceMax > 1 && (
            <Slider
              label={ex.pace}
              title="Whole cycles per loop — whole numbers keep the loop seamless"
              value={cyclesOf(viz.pace, paceMax, viz.style === 'vinyl' ? 2 : 1)}
              min={1}
              max={paceMax}
              step={1}
              onChange={(v) => set({ pace: (v - 1) / (paceMax - 1) })}
              format={(v) => `${v}×`}
            />
          )}
          <span className="deck-ctl-label">Mirror</span>
          <div className="layer-acts">
            {MIRRORS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`deck-load${(viz.mirror ?? 'off') === m.value ? ' is-on' : ''}`}
                aria-pressed={(viz.mirror ?? 'off') === m.value}
                title={m.title}
                onClick={() => set({ mirror: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
