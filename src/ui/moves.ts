// =============================================================================
// MOVES (J2: "one space for everything that moves"). The
// Animate panel lists every move a layer (or the whole canvas) has, whatever drives it:
// its looping Motion, its reactions to the sound, and its sliders that move (from → to on
// the beat, with the sound, or along a line drawn on the timeline). This module holds what
// the list needs about each movable slider (its label, how it reads, its current value),
// which row is open, which drawn lanes are folded, and whether a layer moves at all (the ∿
// mark in the Layers list and on its timeline row).
// =============================================================================
import { create } from 'zustand';
import { useSceneStore, type SceneNode } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import type { AudioReactEvent } from '../core/loop-events';
import { hasMods, modKey, newWave, type ModParam } from '../core/modulators';
import { liveTotalFrames } from './audio-engine';
import { HALFTONE_SIZE_MIN } from '../core/cell-style';
import { STYLE_EXTRAS } from '../core/visualizer';
import { NOISE_TYPES } from './motion-presets';
import { FX_DEFAULT, FX_ORDER, type FxKind, type LayerFx } from '../core/layer-fx';

export interface ParamInfo {
  label: string;
  /** Slider units per stored unit (100 for a 0..1 dial shown as a percent). */
  scale: number;
  /** The slider's step, in slider units. */
  step: number;
  /** How the slider reads a value (slider units). */
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v)}%`;
const dec = (v: number) => v.toFixed(2);
const int = (v: number) => String(Math.round(v));

export function paramInfo(param: ModParam, node?: SceneNode): ParamInfo {
  switch (param) {
    case 'opacity':
      return { label: 'Opacity', scale: 1, step: 1, format: pct };
    case 'dotSize':
      return {
        label: 'Dot size',
        scale: 1,
        step: 1,
        format: (v) => (v <= HALFTONE_SIZE_MIN ? '1px' : `${Math.round(v)}px`),
      };
    case 'density':
      return { label: 'Density', scale: 1, step: 1, format: int };
    case 'bitSize':
      return { label: 'Bit size', scale: 1, step: 1, format: (v) => `${Math.round(v)}px` };
    case 'drift':
      return {
        label: 'Drift',
        scale: 1,
        step: 0.25,
        format: (v) => (v <= 0 ? 'still' : `${+v.toFixed(2)}/beat`),
      };
    case 'photo.brightness':
      return {
        label: 'Brightness',
        scale: 1,
        step: 1,
        format: (v) => (v > 0 ? `+${Math.round(v)}` : int(v)),
      };
    case 'photo.contrast':
      return { label: 'Contrast', scale: 1, step: 0.05, format: dec };
    case 'photo.gamma':
      return { label: 'Mid-tones', scale: 1, step: 0.05, format: dec };
    case 'photo.black':
      return { label: 'Shadows', scale: 1, step: 1, format: int };
    case 'photo.white':
      return { label: 'Highlights', scale: 1, step: 1, format: int };
    case 'text.size':
      return { label: 'Text size', scale: 1, step: 1, format: int };
    case 'text.spacing':
      return { label: 'Spacing', scale: 1, step: 1, format: int };
    case 'viz.gain':
      return { label: 'Strength', scale: 100, step: 1, format: pct };
    case 'viz.smooth':
      return { label: 'Smoothness', scale: 100, step: 1, format: pct };
    case 'viz.amount':
      return {
        label: (node?.viz && STYLE_EXTRAS[node.viz.style].amount) || 'Amount',
        scale: 100,
        step: 1,
        format: pct,
      };
    case 'motion.amp':
      return { label: 'Intensity', scale: 1, step: 1, format: int };
    // Effects (J5): sizes in canvas squares.
    case 'fx.blur':
      return {
        label: 'Blur',
        scale: 1,
        step: 0.5,
        format: (v) => (v <= 0 ? 'off' : `${+v.toFixed(1)}`),
      };
    case 'fx.posterize':
      return { label: 'Steps', scale: 1, step: 1, format: int };
    case 'fx.outline':
      return { label: 'Outline', scale: 1, step: 1, format: pct };
    case 'fx.kaleido.wedges':
      return { label: 'Wedges', scale: 1, step: 1, format: int };
    case 'fx.kaleido.turn':
      return { label: 'Turn', scale: 1, step: 1, format: (v) => `${Math.round(v)}°` };
    case 'fx.wave.amount':
      return { label: 'Amount', scale: 1, step: 0.5, format: (v) => `${+v.toFixed(1)}` };
    case 'fx.wave.size':
      return { label: 'Size', scale: 1, step: 1, format: int };
    case 'fx.wave.flow':
      return { label: 'Flow', scale: 1, step: 1, format: pct };
    case 'fx.trail.length':
      return { label: 'Length', scale: 1, step: 0.25, format: beatsLabel };
    case 'fx.trail.fade':
      return { label: 'Fade', scale: 1, step: 1, format: pct };
  }
}

/** A layer's effects, or with no layer the Whole canvas's (J5). */
const fxOf = (node: SceneNode | undefined): LayerFx | undefined =>
  node ? node.fx : (useSceneStore.getState().canvasFx ?? undefined);

/** A slider's own value (stored units): the layer's, or the canvas look's Dot size /
 *  Density / Bit size (a layer keeps its own look). */
export function paramValue(
  param: ModParam,
  node: SceneNode | undefined,
  canvas: { dotSize: number; density: number; bitSize: number },
): number {
  switch (param) {
    case 'opacity':
      return node?.opacity ?? 100;
    case 'dotSize':
      return node?.look.dotSize ?? canvas.dotSize;
    case 'density':
      return node?.look.density ?? canvas.density;
    case 'bitSize':
      return node?.look.bitSize ?? canvas.bitSize;
    case 'drift':
      return (node ? node.look.drift : useSceneStore.getState().scene.drift) ?? 0;
    case 'photo.brightness':
      return node?.image?.brightness ?? 0;
    case 'photo.contrast':
      return node?.image?.contrast ?? 1;
    case 'photo.gamma':
      return node?.image?.gamma ?? 1;
    case 'photo.black':
      return node?.image?.black ?? 0;
    case 'photo.white':
      return node?.image?.white ?? 255;
    case 'text.size':
      return node?.text?.size ?? 1;
    case 'text.spacing':
      return node?.text?.spacing ?? 0;
    case 'viz.gain':
      return node?.viz?.gain ?? 0.6;
    case 'viz.smooth':
      return node?.viz?.smooth ?? 0;
    case 'viz.amount':
      return node?.viz?.amount ?? 0.5;
    case 'motion.amp': // a layer's jitter, or the Whole canvas's
      return (node ? node.motion : useSceneStore.getState().canvasMotion)?.amp ?? 1;
    case 'fx.blur':
      return fxOf(node)?.blur?.radius ?? FX_DEFAULT.blur.radius;
    case 'fx.posterize':
      return fxOf(node)?.posterize?.steps ?? FX_DEFAULT.posterize.steps;
    case 'fx.outline':
      return fxOf(node)?.outline?.strength ?? FX_DEFAULT.outline.strength;
    case 'fx.kaleido.wedges':
      return fxOf(node)?.kaleido?.wedges ?? FX_DEFAULT.kaleido.wedges;
    case 'fx.kaleido.turn':
      return fxOf(node)?.kaleido?.turn ?? FX_DEFAULT.kaleido.turn;
    case 'fx.wave.amount':
      return fxOf(node)?.wave?.amount ?? FX_DEFAULT.wave.amount;
    case 'fx.wave.size':
      return fxOf(node)?.wave?.size ?? FX_DEFAULT.wave.size;
    case 'fx.wave.flow':
      return fxOf(node)?.wave?.flow ?? FX_DEFAULT.wave.flow;
    case 'fx.trail.length':
      return fxOf(node)?.trail?.length ?? FX_DEFAULT.trail.length;
    case 'fx.trail.fade':
      return fxOf(node)?.trail?.fade ?? FX_DEFAULT.trail.fade;
  }
}

/** Each effect's movable amounts (J5), in its row's order. */
export const FX_PARAMS: Record<FxKind, ModParam[]> = {
  mirror: [],
  kaleido: ['fx.kaleido.wedges', 'fx.kaleido.turn'],
  wave: ['fx.wave.amount', 'fx.wave.size', 'fx.wave.flow'],
  blur: ['fx.blur'],
  posterize: ['fx.posterize'],
  outline: ['fx.outline'],
  trail: ['fx.trail.length', 'fx.trail.fade'],
};

/** A trail Length: "¼ beat", "1.5 beats", "1 bar". */
export function beatsLabel(v: number): string {
  if (v === 4) return '1 bar';
  const frac: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  return `${frac[v] ?? +v.toFixed(2)} beat${v > 1 ? 's' : ''}`;
}

/** Write one effect amount (stored units) into the layer's (no layer: the canvas's) effect. */
export function setFxParam(node: SceneNode | undefined, param: ModParam, v: number): void {
  const fx = fxOf(node);
  const id = node?.id ?? '';
  const st = useSceneStore.getState();
  if (param === 'fx.blur' && fx?.blur) st.setFx(id, 'blur', { radius: v });
  else if (param === 'fx.posterize' && fx?.posterize) st.setFx(id, 'posterize', { steps: v });
  else if (param === 'fx.outline' && fx?.outline) st.setFx(id, 'outline', { strength: v });
  else if (param === 'fx.kaleido.wedges' && fx?.kaleido)
    st.setFx(id, 'kaleido', { ...fx.kaleido, wedges: v });
  else if (param === 'fx.kaleido.turn' && fx?.kaleido)
    st.setFx(id, 'kaleido', { ...fx.kaleido, turn: v });
  else if (param === 'fx.wave.amount' && fx?.wave) st.setFx(id, 'wave', { ...fx.wave, amount: v });
  else if (param === 'fx.wave.size' && fx?.wave) st.setFx(id, 'wave', { ...fx.wave, size: v });
  else if (param === 'fx.wave.flow' && fx?.wave) st.setFx(id, 'wave', { ...fx.wave, flow: v });
  else if (param === 'fx.trail.length' && fx?.trail)
    st.setFx(id, 'trail', { ...fx.trail, length: v });
  else if (param === 'fx.trail.fade' && fx?.trail) st.setFx(id, 'trail', { ...fx.trail, fade: v });
}

/** The sliders a layer (or, with no layer, the canvas) can move, in panel order: its Look's
 *  (Halftone: Dot size + Density · Dither: Bit size), then its own. */
export function movableParams(node: SceneNode | undefined, halftone: boolean): ModParam[] {
  const look: ModParam[] = halftone ? ['dotSize', 'density', 'drift'] : ['bitSize', 'drift'];
  if (!node) {
    const { canvasMotion: cm, canvasFx } = useSceneStore.getState();
    const out: ModParam[] = cm && NOISE_TYPES.has(cm.type) ? [...look, 'motion.amp'] : look;
    // The Whole canvas effects' amounts (J5).
    for (const k of FX_ORDER) if (canvasFx?.[k]) out.push(...FX_PARAMS[k]);
    return out;
  }
  const out: ModParam[] = [...look];
  if (node.kind === 'image')
    out.push('photo.brightness', 'photo.contrast', 'photo.gamma', 'photo.black', 'photo.white');
  if (node.kind === 'text') out.push('text.size', 'text.spacing');
  if (node.kind === 'visualizer' && node.viz) {
    out.push('viz.gain', 'viz.smooth');
    if (STYLE_EXTRAS[node.viz.style].amount) out.push('viz.amount');
  }
  if (node.motion && NOISE_TYPES.has(node.motion.type)) out.push('motion.amp');
  out.push('opacity');
  // Its effects' amounts (J5), in the effects' fixed order.
  for (const k of FX_ORDER) if (node.fx?.[k]) out.push(...FX_PARAMS[k]);
  return out;
}

/** Does this layer move at all (a Motion, a reaction or a moving slider)? */
export const layerMoves = (node: SceneNode, reactions: readonly AudioReactEvent[]): boolean =>
  !!node.motion || hasMods(node.mods) || reactions.some((r) => r.nodeId === node.id);

/** The open row in the Animate list: `motion`, `react:<id>` or `mod:<param>` (one at a time,
 *  so the panel stays short). A slider's ∿ button opens its row here. */
export const useOpenMove = create<{ key: string | null; scroll: number }>(() => ({
  key: null,
  scroll: 0,
}));
export function openMove(key: string | null, scrollTo = false): void {
  useOpenMove.setState((s) => ({ key, scroll: scrollTo ? s.scroll + 1 : s.scroll }));
}

/** Give a slider a move (a one-bar Smooth beat move, from where it sits) if it has none,
 *  then open the Animate list at that move. */
export function moveSlider(node: string, param: ModParam, value: number): void {
  const st = useSceneStore.getState();
  const has =
    node === '' ? st.canvasMods[param] : st.nodes.find((n) => n.id === node)?.mods?.[param];
  if (!has) st.setMod(node, param, newWave(param, value));
  if (node === '') st.clearSelection(); // the canvas's moves are the Whole canvas list
  openMove(`mod:${param}`, true);
}

/** How long the video is — the song, else the end of the last layer bar (the
 *  loop at least) — and so how long a drawn lane is (J2b). */
export function timelineSpan(): number {
  return Math.max(1, useLoopStore.getState().meta.frames, liveTotalFrames());
}

/** Timeline rows whose drawn lanes are folded away (layer ids; '' = the canvas row). A view
 *  choice: never saved, never an edit. */
export const useLaneFold = create<{ folded: readonly string[] }>(() => ({ folded: [] }));
export function toggleLaneFold(node: string): void {
  useLaneFold.setState((s) => ({
    folded: s.folded.includes(node) ? s.folded.filter((x) => x !== node) : [...s.folded, node],
  }));
}

/** Unfold a drawn lane and bring it into view (a switch to Timeline, or "Show its lane"). */
export function showLane(node: string, param: ModParam): void {
  useLoopStore.getState().setAnimate(true); // the lanes live on the timeline strip
  useLaneFold.setState((s) => ({ folded: s.folded.filter((x) => x !== node) }));
  requestAnimationFrame(() =>
    document
      .querySelector(`[data-lane="${CSS.escape(modKey(node, param))}"]`)
      ?.scrollIntoView({ block: 'nearest' }),
  );
}
