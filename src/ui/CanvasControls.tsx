import { useEffect, useRef, useState } from 'react';
import {
  useSceneStore,
  hasDrawnRaster,
  type Detail,
  type LookOverride,
} from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { useLoopStore } from '../state/loop-store';
import { liveTakes } from '../core/loop-events';
import {
  ASPECT_IDS,
  DIFFUSION_IDS,
  MATRIX_IDS,
  PALETTE_IDS,
  PATTERN_IDS,
  orderedPattern,
  paletteLength,
  type AspectId,
} from '../core/dither-constants';
import { DRIFT_MAX } from '../core/modulators';
import {
  BIT_SIZE_MAX,
  BIT_SIZE_MIN,
  HALFTONE_SIZE_MIN,
  HALFTONE_SIZE_MAX,
  HALFTONE_DENSITY_MIN,
  HALFTONE_DENSITY_MAX,
} from '../core/cell-style';
import { Slider } from './Slider';
import { ModSlider } from './ModSlider';
import { Dropdown } from './Dropdown';
import { BgSwatches } from './BgSwatches';
import {
  matrixLabel,
  paletteLabel,
  cellModeLabel,
  shapeLabel,
  CELL_MODES,
  SHAPE_STYLES,
} from './deck-labels';
import { RecordExportMenu } from './RecordExportMenu';
import { DeckSlot } from './screen/DeckSlot';
import { regridPaintForDetail } from './paint-node';
import { initHistory, redo, undo, useHistory } from './history';
import { LayerPanel } from './LayerPanel';
import { liveAbsFrame } from './audio-engine';
import { layerNames } from './layer-names';

const ASPECT_LABEL: Record<AspectId, string> = {
  square: 'Square',
  landscape: 'Landscape',
  portrait: 'Portrait',
};
const ARM_MS = 2500;
type CanvasTool = 'draw' | 'erase' | 'move';

/**
 * The CANVAS deck (the minimal always-visible set). Left: the
 * tool (Draw · Erase · Move) with its options, the canvas-wide Look, and the Canvas
 * row (Pixel · Aspect · Background). Right rail: Undo/Redo · + Import, the SELECTED
 * LAYER's settings (LayerPanel), and File (Save · Export · Library).
 * Layers sit in the shell's right panel.
 */
export function CanvasControls() {
  const tool = useSceneStore((s) => s.tool);
  const brush = useSceneStore((s) => s.brush);
  const matteMode = useSceneStore((s) => s.matteMode);
  const scene = useSceneStore((s) => s.scene);
  const detail = useSceneStore((s) => s.detail);
  const background = useSceneStore((s) => s.background);
  const dotInk = useSceneStore((s) => s.dotInk);
  const nodes = useSceneStore((s) => s.nodes);
  const selected = useSceneStore((s) => s.selected);
  const events = useLoopStore((s) => s.events);
  const transport = useLoopStore((s) => s.transport);
  const withAudio = useLoopStore((s) => s.meta.withAudio);
  const animate = useLoopStore((s) => s.animate);
  const aspect = useBurnStore((s) => s.aspect);
  const st = useSceneStore.getState();
  // The Look is the PICKED layer's (each layer keeps its own); with Whole
  // canvas picked it is the look new layers start with.
  const picked = selected.length ? nodes.find((n) => n.id === selected[0]) : undefined;
  const look = picked ? { ...scene, ...picked.look } : scene;
  const lookNode = picked?.id ?? '';
  const setLookOf = (patch: LookOverride) => (picked ? st.setLook(patch) : st.setSceneLook(patch));
  const halftone = look.style === 'halftone';
  const canvasMods = useSceneStore((s) => s.canvasMods);
  const hasDriftMod = !!(picked ? picked.mods?.drift : canvasMods.drift);
  const [more, setMore] = useState(false);
  const [armApply, setArmApply] = useState(false);

  const current: CanvasTool =
    tool === 'arrange' ? 'move' : brush.tool === 'eraser' ? 'erase' : 'draw';
  const pickTool = (t: CanvasTool) => {
    if (t === 'move') return st.setTool('arrange');
    st.setTool('paint');
    st.setBrush({ tool: t === 'erase' ? 'eraser' : 'brush' });
  };

  // Undo/Redo: ONE history of every edit — strokes, layers, look, clips, Motion,
  // reactions, loop length — in the order they happened.
  useEffect(initHistory, []);
  const canUndo = useHistory((s) => s.canUndo);
  const canRedo = useHistory((s) => s.canRedo);

  // Pixel + Aspect: confirm-ARMED once there is a drawing (Pixel re-grids it; Aspect
  // clears the drawings). Takes freeze the resolution (Animate owns them).
  const hasDrawing = nodes.some(hasDrawnRaster);
  const hasTakes = liveTakes(events, new Set(nodes.map((n) => n.id))).length > 0;
  const [armDetail, setArmDetail] = useState(false);
  const [armAspect, setArmAspect] = useState<AspectId | null>(null);
  const timer = useRef(0);
  const arm = (fn: () => void) => {
    fn();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setArmDetail(false);
      setArmAspect(null);
      setArmApply(false);
    }, ARM_MS);
  };
  // Fine → Normal averages the drawings' fine edges away: confirm first (one Undo restores).
  const pickDetail = (d: Detail) => {
    if (d === detail || hasTakes) return;
    if (d === 'normal' && hasDrawing && !armDetail) return arm(() => setArmDetail(true));
    window.clearTimeout(timer.current);
    setArmDetail(false);
    st.setDetail(d, regridPaintForDetail(d));
  };
  const pickAspect = (a: AspectId) => {
    if (a === aspect) return;
    if (hasDrawing && armAspect !== a) return arm(() => setArmAspect(a));
    window.clearTimeout(timer.current);
    setArmAspect(null);
    if (hasDrawing) st.remove(nodes.filter(hasDrawnRaster).map((n) => n.id));
    useBurnStore.getState().setParam('aspect', a);
  };

  // Tonal (dots grow with brightness) only shows where there IS tone to follow — a flat
  // drawn stroke barely changes under it, so it hides on drawings alone.
  const hasTone = nodes.some((n) => !hasDrawnRaster(n));

  // Erase with ONE photo selected edits that photo's cutout.
  const erasePhotoNode =
    current === 'erase' && selected.length === 1
      ? nodes.find((n) => n.id === selected[0] && n.kind === 'image')
      : undefined;
  const erasePhoto = !!erasePhotoNode;
  const erasePhotoName = erasePhotoNode ? layerNames(nodes).get(erasePhotoNode.id) : '';

  // The Dot colour here is ALWAYS the canvas's; a layer's own colour is
  // "Own dot colour" in its panel (LayerPanel).
  const canvasDot = dotInk ?? paletteLength(scene.palette) - 1;

  return (
    <div className="deck-cols">
      <div className="deck-panel deck-panel-grow">
        <span className="deck-panel-label">Tool</span>
        <div className="deck-seg" role="radiogroup" aria-label="Tool">
          {(['draw', 'erase', 'move'] as const).map((t) => (
            <button
              type="button"
              key={t}
              role="radio"
              aria-checked={current === t}
              className={current === t ? 'is-on' : undefined}
              title={
                t === 'move'
                  ? 'Select and arrange layers · drag a photo to move it inside the frame · wheel zooms it'
                  : undefined
              }
              onClick={() => pickTool(t)}
            >
              {t === 'draw' ? 'Draw' : t === 'erase' ? 'Erase' : 'Move'}
            </button>
          ))}
        </div>
        {erasePhoto && (
          <div
            className="deck-seg"
            role="radiogroup"
            aria-label="Photo brush"
            title={`Brushing ${erasePhotoName}: Erase rubs it out, Restore paints it back`}
          >
            {(['erase', 'restore'] as const).map((m) => (
              <button
                type="button"
                key={m}
                role="radio"
                aria-checked={matteMode === m}
                className={matteMode === m ? 'is-on' : undefined}
                onClick={() => st.setMatteMode(m)}
              >
                {m === 'erase' ? `Erase ${erasePhotoName}` : 'Restore'}
              </button>
            ))}
          </div>
        )}
        {current !== 'move' && (
          <>
            <Slider
              label="Size"
              value={brush.size}
              min={1}
              max={24}
              step={1}
              onChange={(v) => st.setBrush({ size: v })}
              format={(v) => String(v)}
            />
            {!erasePhoto && (
              <Slider
                label="Shade"
                value={Math.round(brush.shade * 100)}
                min={0}
                max={100}
                step={5}
                onChange={(v) => st.setBrush({ shade: v / 100 })}
                format={(v) => `${v}%`}
              />
            )}
          </>
        )}
        <div className="deck-hsep" />

        <span className="deck-panel-label">
          Look · {picked ? (layerNames(nodes).get(picked.id) ?? 'layer') : 'new layers'}
        </span>
        <div className="deck-dd-row">
          <Dropdown
            label="Palette"
            options={PALETTE_IDS}
            value={look.palette}
            onChange={(v) => setLookOf({ palette: v })}
            format={paletteLabel}
          />
          <Dropdown
            label="Style"
            title="Dither = classic 1-bit pixels · Halftone = clean tonal dots"
            options={CELL_MODES}
            value={halftone ? 'halftone' : 'dither'}
            onChange={(m) => setLookOf({ style: m })}
            format={cellModeLabel}
          />
          {halftone ? (
            <Dropdown
              label="Shape"
              title="Halftone dot shape: round circles or square blocks"
              options={SHAPE_STYLES}
              value={look.shape === 'square' ? 'block' : 'round'}
              onChange={(v) => setLookOf({ shape: v === 'block' ? 'square' : 'circle' })}
              format={shapeLabel}
            />
          ) : (
            <Dropdown
              label="Pattern"
              title="Patterns repeat a fixed grid and stay calm when things move · Diffusion spreads each bit's error for a photo-like grain that shimmers when the picture moves"
              options={PATTERN_IDS}
              divider={{ before: DIFFUSION_IDS[0], label: 'diffusion' }}
              value={look.matrix}
              onChange={(v) => setLookOf({ matrix: v })}
              format={matrixLabel}
            />
          )}
        </div>
        {halftone ? (
          <>
            <ModSlider
              node={lookNode}
              param="dotSize"
              label="Dot size"
              value={look.dotSize}
              min={HALFTONE_SIZE_MIN}
              max={HALFTONE_SIZE_MAX}
              step={1}
              onChange={(v) => setLookOf({ dotSize: v })}
              format={(v) => (v <= HALFTONE_SIZE_MIN ? '1px' : `${v}px`)}
            />
            <ModSlider
              node={lookNode}
              param="density"
              label="Density"
              value={look.density}
              min={HALFTONE_DENSITY_MIN}
              max={HALFTONE_DENSITY_MAX}
              step={1}
              onChange={(v) => setLookOf({ density: v })}
              format={(v) =>
                v <= HALFTONE_DENSITY_MIN
                  ? 'sparse'
                  : v >= HALFTONE_DENSITY_MAX
                    ? 'cluster'
                    : String(v)
              }
            />
            {hasTone && (
              <div className="deck-switch" title="Tonal: dots grow in the brighter areas.">
                <span className="deck-switch-label">Tonal</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={look.dotGrow}
                  aria-label="Tonal dots — grow with brightness"
                  className={`rocker${look.dotGrow ? ' is-on' : ''}`}
                  onClick={() => setLookOf({ dotGrow: !look.dotGrow })}
                >
                  <span className="rocker-knob" />
                </button>
              </div>
            )}
            {/* Tonal off (J6): every dot the same size — the Pattern picks which
                show. Grids + Blue only: they never flicker when the picture moves. */}
            {!look.dotGrow && (
              <div className="deck-dd-row">
                <Dropdown
                  label="Pattern"
                  title="Which dots show when every dot is the same size: a grid's regular texture, or Blue's even scatter"
                  options={MATRIX_IDS}
                  value={orderedPattern(look.matrix)}
                  onChange={(v) => setLookOf({ matrix: v })}
                  format={matrixLabel}
                />
              </div>
            )}
          </>
        ) : (
          <ModSlider
            node={lookNode}
            param="bitSize"
            label="Bit size"
            title="How chunky the dither's pixels are"
            value={look.bitSize}
            min={BIT_SIZE_MIN}
            max={BIT_SIZE_MAX}
            step={1}
            onChange={(v) => setLookOf({ bitSize: v })}
            format={(v) => `${v}px`}
          />
        )}
        {/* Grain Drift (J6): the bits / dots slide over the still picture. */}
        <ModSlider
          node={lookNode}
          param="drift"
          label="Drift"
          title="Slide the dots over the still picture, in canvas squares per beat (0 = still)"
          value={look.drift ?? 0}
          min={0}
          max={DRIFT_MAX}
          step={0.25}
          onChange={(v) => setLookOf({ drift: v })}
          format={(v) => (v <= 0 ? 'still' : `${+v.toFixed(2)}/beat`)}
        />
        {(!!look.drift || hasDriftMod) && (
          <Slider
            label="Direction"
            title="Which way the dots drift: 0° right, 90° up, 180° left, 270° down"
            value={look.driftDir ?? 0}
            min={0}
            max={359}
            step={1}
            onChange={(v) => setLookOf({ driftDir: v })}
            format={(v) => `${Math.round(v)}°`}
          />
        )}
        {/* Colour: one ink, or dither between the palette's shades. */}
        <div className="deck-switch">
          <span className="deck-switch-label">Colour</span>
          <div className="deck-seg" role="radiogroup" aria-label="Colour">
            {(['ink', 'palette'] as const).map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={look.colourMode === c}
                className={look.colourMode === c ? 'is-on' : undefined}
                title={
                  c === 'ink'
                    ? 'One ink: the layer is one colour'
                    : "Palette: dither between the palette's shades"
                }
                onClick={() => setLookOf({ colourMode: c })}
              >
                {c === 'ink' ? 'One ink' : 'Palette'}
              </button>
            ))}
          </div>
        </div>
        {look.colourMode === 'ink' && (
          <BgSwatches
            label="Dot"
            name="Canvas dot colour"
            allowNone={false}
            palette={look.palette}
            value={canvasDot}
            onChange={(v) => st.setDotInk(v)}
          />
        )}
        <button
          type="button"
          className="deck-load viz-more"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? '▾' : '▸'} More
        </button>
        {more && (
          <>
            {halftone && (
              <Slider
                label="Angle"
                title="The dot screen's angle, like a print ink"
                value={look.angle}
                min={0}
                max={90}
                step={1}
                onChange={(v) => setLookOf({ angle: v })}
                format={(v) => `${v}°`}
              />
            )}
            <div
              className="deck-switch"
              title="On: the dots turn and grow with the layer when it spins or grows · Off: they stay upright at their size"
            >
              <span className="deck-switch-label">Dots turn + grow</span>
              <button
                type="button"
                role="switch"
                aria-checked={look.dotsTurn}
                aria-label="Dots turn and grow with the layer"
                className={`rocker${look.dotsTurn ? ' is-on' : ''}`}
                onClick={() => setLookOf({ dotsTurn: !look.dotsTurn })}
              >
                <span className="rocker-knob" />
              </button>
            </div>
          </>
        )}
        {/* Whole canvas only (never while one layer is picked): copy this look to every
            layer — two clicks, one Undo. */}
        {!picked && nodes.length > 0 && (
          <button
            type="button"
            className={`deck-load${armApply ? ' is-on' : ''}`}
            title="Give every layer this look (its own dot colour stays) — one Undo puts them back"
            onClick={() => {
              if (!armApply) return arm(() => setArmApply(true));
              window.clearTimeout(timer.current);
              setArmApply(false);
              st.applyLookToAll();
            }}
          >
            {armApply ? 'Sure?' : 'Apply to all layers'}
          </button>
        )}
        <div className="deck-hsep" />

        <span className="deck-panel-label">Canvas</span>
        {/* Detail: how finely every layer keeps its picture. */}
        <div className="deck-switch">
          <span className="deck-switch-label">{armDetail ? 'Sure?' : 'Detail'}</span>
          <div
            className="deck-seg"
            role="radiogroup"
            aria-label="Detail"
            title={
              hasTakes
                ? 'Detail is locked while the loop has takes'
                : armDetail
                  ? 'Normal loses your drawings’ fine edges (Undo brings them back) — click Normal again'
                  : 'Normal: one value per canvas square · Fine: 4× finer pictures, crisper edges'
            }
          >
            {(['normal', 'fine'] as const).map((d) => (
              <button
                type="button"
                key={d}
                role="radio"
                aria-checked={detail === d}
                className={detail === d ? 'is-on' : undefined}
                disabled={hasTakes || transport === 'recording'}
                onClick={() => pickDetail(d)}
              >
                {d === 'normal' ? 'Normal' : 'Fine'}
              </button>
            ))}
          </div>
        </div>
        <div className="deck-switch">
          <span className="deck-switch-label">{armAspect ? 'Clears drawings!' : 'Aspect'}</span>
          <div className="aspect-switch" role="radiogroup" aria-label="Aspect">
            {ASPECT_IDS.map((a) => (
              <button
                type="button"
                key={a}
                role="radio"
                aria-checked={aspect === a}
                aria-label={ASPECT_LABEL[a]}
                title={
                  armAspect === a
                    ? 'Clears your drawings — click again to confirm'
                    : ASPECT_LABEL[a]
                }
                className={`aspect-btn${aspect === a ? ' is-on' : ''}${armAspect === a ? ' is-arm' : ''}`}
                disabled={transport === 'recording'}
                onClick={() => pickAspect(a)}
              >
                <span className={`aspect-ico aspect-ico--${a}`} />
              </button>
            ))}
          </div>
        </div>
        <BgSwatches
          palette={scene.palette}
          value={background}
          onChange={st.setBackground}
          collapsed
        />
      </div>

      <div className="deck-vsep" />

      <DeckSlot>
        <div className="deck-panel deck-rail">
          <div className="deck-rail-pair">
            <button
              type="button"
              className="deck-load"
              disabled={!canUndo}
              onClick={undo}
              title="Undo"
              aria-label="Undo"
            >
              ↶
            </button>
            <button
              type="button"
              className="deck-load"
              disabled={!canRedo}
              onClick={redo}
              title="Redo"
              aria-label="Redo"
            >
              ↷
            </button>
          </div>
          {/* PLAY (video needs a play button to be judged) — the first
              piece of Animate, on the existing loop player. */}
          {/* With the timeline open its strip owns Play + Sound (and Rec). */}
          {!animate && (
            <div className="deck-rail-pair">
              <button
                type="button"
                className={`deck-load${transport === 'playing' ? ' is-on' : ''}`}
                aria-pressed={transport === 'playing'}
                disabled={nodes.length === 0 || transport === 'recording'}
                title={
                  transport === 'playing'
                    ? 'Pause — the canvas holds this moment'
                    : 'Play the canvas (videos play, loops repeat)'
                }
                onClick={() => {
                  const lp = useLoopStore.getState();
                  if (transport === 'playing') lp.pause(liveAbsFrame());
                  else lp.setTransport('playing');
                }}
              >
                {transport === 'playing' ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button
                type="button"
                className={`deck-load${withAudio ? ' is-on' : ''}`}
                aria-pressed={withAudio}
                title={
                  withAudio
                    ? 'Sound on — click to mute'
                    : 'Sound off — click to hear videos while playing'
                }
                onClick={() => useLoopStore.getState().setWithAudio(!withAudio)}
              >
                {withAudio ? 'Sound' : 'Muted'}
              </button>
            </div>
          )}
          <LayerPanel />

          <div className="deck-hsep" />
          {/* ONE Save / Export menu; the Library is the tab top-left. */}
          <RecordExportMenu />
        </div>
      </DeckSlot>
    </div>
  );
}
