// =============================================================================
// The ANIMATE list (J2: "combine/simplify all these controls
// into one space"). Everything that moves on a layer — or on the whole canvas when nothing
// is selected — is one row here: WHAT moves, then WHEN (audit Q6: two
// kinds of move + one When switch).
//   - MOVE IT: where it is, how it turns or grows (Spin, Bounce, Shake…) — on the Beat (its
//     looping Motion), or with the Sound for the ones that hit (Pulse, Bounce, Shake);
//   - CHANGE IT: how it looks — a slider that moves FROM → TO (Opacity, Dot size…) on the
//     Beat, with the Sound or along Frame dots, or a hit on the Sound (Flash, Invert…).
// One row open at a time keeps the panel short; "+ Add move" adds any of them, and a
// slider's ∿ button lands here too. Under the hood each kind keeps its own (saved, undoable)
// home — node.motion, the loop's reactions, node.mods / canvasMods — so old projects open
// exactly as before.
// =============================================================================
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSceneStore, type MotionDescriptor, type SceneNode } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import { Slider } from './Slider';
import { ModSlider } from './ModSlider';
import { Dropdown } from './Dropdown';
import { asOneStep } from './history';
import { beatClock } from './audio-engine';
import { useLiveFrame } from './mod-live';
import {
  layerMoves,
  movableParams,
  openMove,
  paramInfo,
  paramValue,
  showLane,
  timelineSpan,
  useOpenMove,
} from './moves';
import {
  BEAT_STEPS,
  MOTION_LABELS,
  MOTION_TYPES,
  NOISE_TYPES,
  beatStep,
  newMotion,
  speedLabel,
  type MotionType,
} from './motion-presets';
import {
  BANDS,
  DEFAULT_REACTION,
  EFFECTS,
  bandLabel,
  effectKeyOf,
  type EffectKey,
} from './react-presets';
import { VIZ_BANDS } from './visualizer-node';
import { EffectsList } from './EffectsList';
import { beatLengthLabel, framesPerBeat } from '../core/tempo';
import { vizFeature } from '../core/visualizer';
import {
  MOD_RANGE,
  MOD_SHAPES,
  MOD_SHAPE_LABEL,
  clampMod,
  modEnds,
  newDrawn,
  newWave,
  type ModBand,
  type ModParam,
  type Modulator,
  type ModShape,
} from '../core/modulators';
import type { AudioReactEvent } from '../core/loop-events';

const MOTIONS = MOTION_TYPES.filter((t): t is MotionType => t !== 'none');
/** The sound hits that are a Move it (Pulse / Bounce / Shake with When = Sound). */
const SOUND_HIT_MOVES: ReadonlySet<EffectKey> = new Set(['pulse', 'bounce', 'shake']);
const NO_REACTIONS: AudioReactEvent[] = [];

/** Every move of one layer (`nodeId`), or of the whole canvas (`nodeId` = ''). */
export function MovesList({ nodeId, locked }: { nodeId: string; locked: boolean }) {
  const node = useSceneStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const canvasMods = useSceneStore((s) => s.canvasMods);
  const canvasMotion = useSceneStore((s) => s.canvasMotion);
  const dotSize = useSceneStore((s) => s.scene.dotSize);
  const density = useSceneStore((s) => s.scene.density);
  const bitSize = useSceneStore((s) => s.scene.bitSize);
  // The layer's own style (each layer keeps its own look), else the canvas's.
  const halftone = useSceneStore((s) => (node?.look.style ?? s.scene.style) === 'halftone');
  const all = useLoopStore((s) => s.reactions);
  const recording = useLoopStore((s) => s.transport === 'recording');
  const reactions = all.length ? all.filter((r) => r.nodeId === nodeId) : NO_REACTIONS;
  const { key: openKey, scroll } = useOpenMove();
  const box = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);

  // A slider's ∿ asks for its row: bring it into view.
  useEffect(() => {
    if (!openKey) return;
    const row = box.current?.querySelector(`[data-move="${CSS.escape(openKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [openKey, scroll]);

  if (nodeId && !node) return null;
  const mods = (node ? node.mods : canvasMods) ?? {};
  const modParams = (Object.keys(mods) as ModParam[]).filter((p) => mods[p]);
  const canvas = { dotSize, density, bitSize };
  const toggle = (k: string) => openMove(openKey === k ? null : k);
  const sliders = movableParams(node, halftone);
  // A layer's own Motion, or the Whole canvas Motion (the whole picture moving as one).
  const motion = node ? node.motion : canvasMotion;
  const amp = mods['motion.amp'];
  const empty = !motion && reactions.length === 0 && modParams.length === 0;

  return (
    <div className="moves" ref={box}>
      {empty && (
        <span className="deck-ctl-label layer-hint">
          Nothing moves yet — + Add move, or press ∿ on a slider.
        </span>
      )}
      {motion && (
        <MoveRow
          moveKey="motion"
          open={openKey === 'motion'}
          onToggle={() => toggle('motion')}
          name={MOTION_LABELS[motion.type]}
          drive="Beat"
          summary={motionSummary(motion)}
          onRemove={() => removeMotion(nodeId, !!amp)}
        >
          <MotionBody nodeId={nodeId} m={motion} locked={locked} />
        </MoveRow>
      )}
      {reactions.map((r) => {
        const k = `react:${r.id}`;
        const effect = EFFECTS.find((e) => e.key === effectKeyOf(r.target));
        return (
          <MoveRow
            key={k}
            moveKey={k}
            open={openKey === k}
            onToggle={() => toggle(k)}
            name={effect?.label ?? 'React'}
            drive="Sound"
            summary={`${bandLabel(r.band)} · ${Math.round(r.depth * 100)}%`}
            onRemove={() => useLoopStore.getState().removeReaction(r.id)}
          >
            <ReactBody
              r={r}
              nodeId={nodeId}
              slider={sliderOfHit(r, node, sliders, modParams)}
              asSlider={(p) => paramValue(p, node, canvas)}
            />
          </MoveRow>
        );
      })}
      {modParams.map((p) => {
        const k = `mod:${p}`;
        const raw = mods[p] as Modulator;
        const mod: Modulator =
          raw.kind === 'drawn' ? raw : { ...raw, ...modEnds(p, raw, paramValue(p, node, canvas)) };
        const info = paramInfo(p, node);
        const f = (v: number) => info.format(v * info.scale);
        return (
          <MoveRow
            key={k}
            moveKey={k}
            open={openKey === k}
            onToggle={() => toggle(k)}
            name={`${info.label} ∿`}
            drive={mod.kind === 'wave' ? 'Beat' : mod.kind === 'sound' ? 'Sound' : 'Frame dots'}
            summary={
              mod.kind === 'drawn'
                ? drawnSummary(
                    mod.points.map((pt) => pt.v),
                    f,
                  )
                : `${
                    mod.kind === 'wave' ? beatLengthLabel(mod.beats) : bandName(mod.band)
                  } · ${f(mod.from)} → ${f(mod.to)}`
            }
            onRemove={() => useSceneStore.getState().setMod(nodeId, p, null)}
          >
            <ModBody nodeId={nodeId} node={node} param={p} mod={mod} />
          </MoveRow>
        );
      })}
      <button
        type="button"
        className="deck-load"
        title={
          node
            ? 'Make this layer move: a looping motion, a hit on the sound, or a slider that moves'
            : 'Make everything move together: a looping motion, a hit on the sound, or a canvas slider that moves'
        }
        disabled={recording}
        onClick={(e) => setAdding({ x: e.clientX, y: e.clientY })}
      >
        + Add move
      </button>
      {adding && (
        <AddMoveMenu
          at={adding}
          nodeId={nodeId}
          node={node}
          motion={motion}
          canvas={canvas}
          halftone={halftone}
          taken={modParams}
          onClose={() => setAdding(null)}
        />
      )}
      {/* The layer's (or the Whole canvas's) effects (J5), under their own sub-heading. */}
      <EffectsList node={node} />
    </div>
  );
}

/** One move: its header (name · what drives it · a short summary · ✕) and, when open, its
 *  settings. */
function MoveRow({
  moveKey,
  open,
  onToggle,
  name,
  drive,
  summary,
  onRemove,
  children,
}: {
  moveKey: string;
  open: boolean;
  onToggle: () => void;
  name: string;
  drive: 'Beat' | 'Sound' | 'Frame dots';
  summary: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <div data-move={moveKey} className={`move${open ? ' is-open' : ''}`}>
      <div className="move-head">
        <button
          type="button"
          className="move-title"
          aria-expanded={open}
          title={open ? 'Close its settings' : 'Open its settings'}
          onClick={onToggle}
        >
          <span className="move-name">{name}</span>
          <span className={`move-drive move-drive--${drive.split(' ')[0].toLowerCase()}`}>
            {drive}
          </span>
          <span className="move-sum">{summary}</span>
        </button>
        <button
          type="button"
          className="move-x"
          aria-label={`Stop ${name}`}
          title="Stop this move"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      {open && <div className="move-body">{children}</div>}
    </div>
  );
}

// ---- Motion (on the beat) ---------------------------------------------------------------

const legacySpeed = (m: MotionDescriptor) => !NOISE_TYPES.has(m.type) && m.beats === undefined;
function motionBeats(m: MotionDescriptor): number {
  const clock = beatClock();
  const loopBeats = clock.frames / framesPerBeat(clock.bpm, clock.fps);
  return m.beats ?? loopBeats / Math.max(1e-6, m.cycles);
}
function motionSummary(m: MotionDescriptor): string {
  if (NOISE_TYPES.has(m.type)) return `intensity ${m.amp}`;
  return legacySpeed(m) ? `${speedLabel(m.cycles)} / loop` : beatLengthLabel(motionBeats(m));
}
/** The moving Intensity of a layer's (or the canvas's, `nodeId` '') jitter. */
const ampMod = (nodeId: string) => {
  const st = useSceneStore.getState();
  return (nodeId === '' ? st.canvasMods : st.nodes.find((n) => n.id === nodeId)?.mods)?.[
    'motion.amp'
  ];
};
function removeMotion(nodeId: string, amp: boolean): void {
  asOneStep(() => {
    const st = useSceneStore.getState();
    st.setMotion(nodeId, null);
    if (amp) st.setMod(nodeId, 'motion.amp', null);
  });
  openMove(null);
}
/** Swap a layer's (or the Whole canvas's, `nodeId` '') Motion — one each; a jitter's
 *  moving Intensity goes with it. */
function setMotionType(nodeId: string, t: MotionType): void {
  asOneStep(() => {
    const st = useSceneStore.getState();
    st.setMotion(nodeId, newMotion(t));
    if (ampMod(nodeId) && !NOISE_TYPES.has(t)) st.setMod(nodeId, 'motion.amp', null);
  });
}

function MotionBody({
  nodeId,
  m,
  locked,
}: {
  nodeId: string;
  m: MotionDescriptor;
  locked: boolean;
}) {
  const st = useSceneStore.getState();
  const noise = NOISE_TYPES.has(m.type);
  const hit = SOUND_MOVES[m.type];
  return (
    <>
      <WhenSwitch
        value="Beat"
        can={(w) => w === 'Sound' && !!hit}
        why={`${MOTION_LABELS[m.type]} only loops on the beat`}
        onPick={() => {
          if (!hit) return;
          let id = '';
          asOneStep(() => {
            removeMotion(nodeId, !!ampMod(nodeId));
            id = useLoopStore
              .getState()
              .addReaction({ ...DEFAULT_REACTION, target: { kind: hit }, nodeId });
          });
          openMove(`react:${id}`, true);
        }}
      />
      <Dropdown<MotionType>
        label="Motion"
        title="The looping move — one per layer"
        options={MOTIONS}
        value={m.type}
        onChange={(t) => setMotionType(nodeId, t)}
        format={(t) => MOTION_LABELS[t]}
      />
      {noise ? (
        <ModSlider
          node={nodeId}
          param="motion.amp"
          label="Intensity"
          title="How strong the jitter is"
          value={m.amp}
          min={1}
          max={30}
          step={1}
          disabled={locked}
          onChange={(v) => st.setMotion(nodeId, { ...m, amp: v })}
          format={(v) => String(v)}
        />
      ) : (
        <Slider
          label="One cycle"
          title="How long one cycle takes, in beats — it follows the tempo. Longer than the loop is fine: the export covers whole cycles"
          value={beatStep(motionBeats(m))}
          min={0}
          max={BEAT_STEPS.length - 1}
          step={1}
          disabled={locked}
          onChange={(v) => st.setMotion(nodeId, { ...m, cycles: 1, beats: BEAT_STEPS[v] })}
          format={(v) =>
            legacySpeed(m) ? `${speedLabel(m.cycles)} / loop` : beatLengthLabel(BEAT_STEPS[v])
          }
        />
      )}
    </>
  );
}

// ---- A reaction (with the sound) ---------------------------------------------------------

/** A sound hit that is also a slider (Dot size; a photo's Contrast / Brightness): the
 *  slider it becomes on the Beat or along Frame dots, if the layer has it free. */
function sliderOfHit(
  r: AudioReactEvent,
  node: SceneNode | undefined,
  sliders: ModParam[],
  taken: ModParam[],
): ModParam | null {
  const k = effectKeyOf(r.target);
  const p: ModParam | null =
    k === 'dotSize'
      ? 'dotSize'
      : node?.kind === 'image' && k === 'contrast'
        ? 'photo.contrast'
        : node?.kind === 'image' && k === 'brightness'
          ? 'photo.brightness'
          : null;
  return p && sliders.includes(p) && !taken.includes(p) ? p : null;
}

function ReactBody({
  r,
  nodeId,
  slider,
  asSlider,
}: {
  r: AudioReactEvent;
  nodeId: string;
  slider: ModParam | null;
  asSlider: (p: ModParam) => number;
}) {
  const lp = useLoopStore.getState();
  const k = r.target.kind;
  const move = k === 'pulse' || k === 'bounce' || k === 'shake' ? k : null;
  const label = EFFECTS.find((e) => e.key === effectKeyOf(r.target))?.label ?? 'It';
  return (
    <>
      <WhenSwitch
        value="Sound"
        can={(w) => (w === 'Beat' && !!move) || !!slider}
        why={`${label} only goes with the sound`}
        onPick={(w) => {
          asOneStep(() => {
            lp.removeReaction(r.id);
            if (move) setMotionType(nodeId, move);
            else if (slider) {
              const wave = newWave(slider, asSlider(slider));
              const drawn = () =>
                newDrawn(clampMod(slider, wave.from), clampMod(slider, wave.to), timelineSpan());
              useSceneStore.getState().setMod(nodeId, slider, w === 'Beat' ? wave : drawn());
            }
          });
          if (move) openMove('motion', true);
          else if (slider) {
            openMove(`mod:${slider}`, true);
            if (w === 'Frame dots') showLane(nodeId, slider);
          }
        }}
      />
      <Dropdown<AudioReactEvent['band']>
        label="Listens to"
        title="Which part of the sound sets it off"
        options={BANDS.map((b) => b.value)}
        value={r.band}
        onChange={(band) => lp.updateReaction(r.id, { band })}
        format={bandLabel}
      />
      <Dropdown<EffectKey>
        label="Does"
        title="What a hit does"
        options={EFFECTS.map((e) => e.key)}
        value={effectKeyOf(r.target)}
        onChange={(k) =>
          lp.updateReaction(r.id, { target: EFFECTS.find((e) => e.key === k)?.target ?? r.target })
        }
        format={(k) => EFFECTS.find((e) => e.key === k)?.label ?? k}
      />
      <Slider
        label="How much"
        title="How big each hit is (for Invert / Palette / Coarser: how easily it fires)"
        value={Math.round(r.depth * 100)}
        min={0}
        max={100}
        step={5}
        onChange={(v) => lp.updateReaction(r.id, { depth: v / 100 })}
        format={(v) => `${v}%`}
      />
      <SoundLevel band={r.band} smooth={0} />
    </>
  );
}

// ---- A slider that moves (from → to) -------------------------------------------------------

const bandName = (b: ModBand) => VIZ_BANDS.find((x) => x.value === b)?.label ?? b;

type When = 'Beat' | 'Sound' | 'Frame dots';
/** When a move happens — the same switch on every move. */
const WHENS: { when: When; title: string }[] = [
  { when: 'Beat', title: 'On the beat: it loops in time with the tempo' },
  { when: 'Sound', title: 'With the sound: the track sets it off' },
  { when: 'Frame dots', title: 'Along dots you place on the timeline, across the whole video' },
];

/** A Move it that also comes as a hit on the sound: its Motion type ↔ the hit. */
const SOUND_MOVES: Partial<Record<MotionType, 'pulse' | 'bounce' | 'shake'>> = {
  pulse: 'pulse',
  bounce: 'bounce',
  shake: 'shake',
};

/** The When switch: the move's own When lit, the ones it can't do greyed out (`why`). */
function WhenSwitch({
  value,
  can,
  why,
  onPick,
}: {
  value: When;
  can: (w: When) => boolean;
  why: string;
  onPick: (w: When) => void;
}) {
  return (
    <div className="move-when">
      <span className="deck-ctl-label">When</span>
      <div className="deck-seg move-drive-seg" role="radiogroup" aria-label="When">
        {WHENS.map(({ when, title }) => {
          const on = value === when;
          const ok = on || can(when);
          return (
            <button
              type="button"
              key={when}
              role="radio"
              aria-checked={on}
              className={on ? 'is-on' : undefined}
              disabled={!ok}
              title={ok ? title : why}
              onClick={() => {
                if (!on) onPick(when);
              }}
            >
              {when}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A drawn line in a few words: "3 dots · 20% – 80%". */
function drawnSummary(values: number[], f: (v: number) => string): string {
  const n = values.length;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `${n} dot${n === 1 ? '' : 's'} · ${lo === hi ? f(lo) : `${f(lo)} – ${f(hi)}`}`;
}

function ModBody({
  nodeId,
  node,
  param,
  mod,
}: {
  nodeId: string;
  node: SceneNode | undefined;
  param: ModParam;
  mod: Modulator;
}) {
  const set = (m: Modulator) => useSceneStore.getState().setMod(nodeId, param, m);
  const info = paramInfo(param, node);
  const r = MOD_RANGE[param];
  const end = (label: string, title: string, v: number, on: (x: number) => void) => (
    <Slider
      label={label}
      title={title}
      value={Math.round((v * info.scale) / info.step) * info.step}
      min={r.min * info.scale}
      max={r.max * info.scale}
      step={info.step}
      onChange={(x) => on(x / info.scale)}
      format={info.format}
    />
  );
  return (
    <>
      <WhenSwitch
        value={mod.kind === 'wave' ? 'Beat' : mod.kind === 'sound' ? 'Sound' : 'Frame dots'}
        can={() => true}
        why=""
        onPick={(w) => {
          // A switch keeps the move's two values (a drawn line's: its first dot and the dot
          // farthest from it).
          const ends = modEnds(param, mod, r.min);
          if (w === 'Beat') set({ ...newWave(param, ends.from), ...ends });
          else if (w === 'Sound') set({ kind: 'sound', band: 'low', smooth: 0.3, ...ends });
          else {
            set(newDrawn(clampMod(param, ends.from), clampMod(param, ends.to), timelineSpan()));
            showLane(nodeId, param);
          }
        }}
      />
      {mod.kind === 'drawn' ? (
        <>
          <span className="deck-ctl-label layer-hint">
            Follows the dots you place in its lane on the timeline, under{' '}
            {node ? 'this layer' : 'Whole canvas'}. Double-click the lane to add a dot; hover it for
            more.
          </span>
          <button
            type="button"
            className="deck-load"
            title="Unfold its lane on the timeline and scroll to it"
            onClick={() => showLane(nodeId, param)}
          >
            Show its lane
          </button>
        </>
      ) : mod.kind === 'wave' ? (
        <>
          <Dropdown<ModShape>
            label="Shape"
            title="How it travels between the two values"
            options={MOD_SHAPES}
            value={mod.shape}
            onChange={(shape) => set({ ...mod, shape })}
            format={(s) => MOD_SHAPE_LABEL[s]}
          />
          <Slider
            label="One cycle"
            title="How long one trip there and back takes, in beats — it follows the tempo"
            value={beatStep(mod.beats)}
            min={0}
            max={BEAT_STEPS.length - 1}
            step={1}
            onChange={(v) => set({ ...mod, beats: BEAT_STEPS[v] })}
            format={(v) => beatLengthLabel(BEAT_STEPS[v])}
          />
          {end('From', 'Where it starts', mod.from, (from) => set({ ...mod, from }))}
          {end('To', 'Where it swings to', mod.to, (to) => set({ ...mod, to }))}
        </>
      ) : (
        <>
          <Dropdown<ModBand>
            label="Listens to"
            title="Which part of the sound it follows"
            options={VIZ_BANDS.map((b) => b.value)}
            value={mod.band}
            onChange={(band) => set({ ...mod, band })}
            format={bandName}
          />
          {end('Quiet', 'Its value when the sound is quiet', mod.from, (from) =>
            set({ ...mod, from }),
          )}
          {end('Loud', 'Its value on the loudest parts', mod.to, (to) => set({ ...mod, to }))}
          <Slider
            label="Smoothness"
            title="How slowly it falls back after a hit"
            value={Math.round(mod.smooth * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(v) => set({ ...mod, smooth: v / 100 })}
            format={(v) => `${v}%`}
          />
          <SoundLevel band={mod.band} smooth={mod.smooth} />
        </>
      )}
    </>
  );
}

/** What a Sound move hears, live: the last ~half second of its band while playing — or why
 *  it's silent. */
function SoundLevel({ band, smooth }: { band: ModBand; smooth: number }) {
  const frame = useLiveFrame();
  const features = useLoopStore((s) => s.features);
  const withAudio = useLoopStore((s) => s.meta.withAudio);
  const hint = (text: string) => <span className="deck-ctl-label layer-hint">{text}</span>;
  if (!withAudio) return hint('Sound is off — turn Sound on to hear it and drive this.');
  if (!features?.length) return hint('No track yet — add one on the timeline (♪).');
  if (frame === undefined) return hint('Press Play to see what it hears.');
  const n = features.length;
  const bars: number[] = [];
  for (let k = 15; k >= 0; k--) {
    const f = vizFeature(features, (((frame - k) % n) + n) % n, smooth);
    bars.push(f ? Math.max(0, Math.min(1, f[band])) : 0);
  }
  return (
    <div className="move-level" title={`What it hears (${bandName(band)})`} aria-hidden="true">
      <span className="deck-ctl-label">Hears</span>
      <span className="move-level-bars">
        {bars.map((v, i) => (
          <i key={i} style={{ height: `${Math.max(6, v * 100)}%` }} />
        ))}
      </span>
    </div>
  );
}

// ---- + Add move ---------------------------------------------------------------------------

function AddMoveMenu({
  at,
  nodeId,
  node,
  motion,
  canvas,
  halftone,
  taken,
  onClose,
}: {
  at: { x: number; y: number };
  nodeId: string;
  node: SceneNode | undefined;
  motion: MotionDescriptor | null | undefined;
  canvas: { dotSize: number; density: number; bitSize: number };
  halftone: boolean;
  taken: ModParam[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Portaled out of the screen's theme — copy its colours on (read once, as it opens).
  const [theme] = useState<Record<string, string>>(() => {
    const cs = getComputedStyle(document.querySelector('.scr') ?? document.body);
    const vars = ['--accent', '--accent-rgb', '--phos', '--phos-dim', '--phos-faint', '--led-glow'];
    return Object.fromEntries(vars.map((v) => [v, cs.getPropertyValue(v)]));
  });
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
  const pick = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const sliders = movableParams(node, halftone).filter((p) => !taken.includes(p));
  // The Change it's that only go with the sound (Flash, Invert, Palette, Coarser), plus the
  // look hits this layer has no slider for (a drawing's Contrast / Brightness). Dot size is
  // always a slider (Halftone; a dither layer has none to change).
  const hits = EFFECTS.filter(
    (e) =>
      !SOUND_HIT_MOVES.has(e.key) &&
      e.key !== 'dotSize' &&
      !(node?.kind === 'image' && (e.key === 'contrast' || e.key === 'brightness')),
  );
  const width = 250;
  return createPortal(
    <div
      ref={ref}
      className="layer-menu add-move"
      role="menu"
      aria-label="Add a move"
      style={
        {
          ...theme,
          width,
          left: Math.max(8, Math.min(at.x - width, window.innerWidth - width - 8)),
          top: Math.max(8, Math.min(at.y - 40, window.innerHeight - 420)),
        } as CSSProperties
      }
    >
      <span className="layer-menu-title">Move it{motion ? ' (swaps)' : ''}</span>
      <span className="layer-menu-hint">where it is, how it turns or grows</span>
      <div className="add-move-chips">
        {MOTIONS.map((t) => (
          <button
            type="button"
            role="menuitem"
            key={t}
            className={motion?.type === t ? 'is-on' : undefined}
            onClick={pick(() => {
              setMotionType(nodeId, t);
              openMove('motion', true);
            })}
          >
            {MOTION_LABELS[t]}
          </button>
        ))}
      </div>
      <span className="layer-menu-title">Change it</span>
      <span className="layer-menu-hint">how it looks</span>
      <div className="add-move-chips">
        {sliders.map((p) => (
          <button
            type="button"
            role="menuitem"
            key={p}
            onClick={pick(() => {
              useSceneStore.getState().setMod(nodeId, p, newWave(p, paramValue(p, node, canvas)));
              openMove(`mod:${p}`, true);
            })}
          >
            {paramInfo(p, node).label}
          </button>
        ))}
        {hits.map((e) => (
          <button
            type="button"
            role="menuitem"
            key={e.key}
            onClick={pick(() => {
              const id = useLoopStore
                .getState()
                .addReaction({ ...DEFAULT_REACTION, target: e.target, nodeId });
              openMove(`react:${id}`, true);
            })}
          >
            {e.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** The ∿ after a layer's name (Layers list, timeline row) when anything on it moves. */
export function MoveMark({ node }: { node: SceneNode }) {
  const reactions = useLoopStore((s) => s.reactions);
  return layerMoves(node, reactions) ? (
    <span className="move-mark" title="This layer moves — see Animate">
      {' '}
      ∿
    </span>
  ) : null;
}
