// =============================================================================
// A slider that can MOVE ON ITS OWN (J2 modulators — FL Studio's way, plain
// words). Its ∿ button (or a right-click) gives it a move and opens that move in the ONE
// Animate list (ui/MovesList), where every move of the layer lives —: one
// space, not a menu per slider. The ∿ glows while the slider moves; while the canvas plays
// a glowing marker runs along the groove (the handle stays where it was set, so it can
// still be dragged) and the readout shows the live value.
// =============================================================================
import { useSceneStore } from '../state/scene-store';
import { Slider, type SliderProps } from './Slider';
import { useModValue } from './mod-live';
import { moveSlider } from './moves';
import { modKey, type ModParam } from '../core/modulators';

export interface ModSliderProps extends SliderProps {
  /** The layer the slider belongs to ('' = the canvas). */
  node: string;
  param: ModParam;
  /** Slider units per stored unit (100 for a 0..1 dial shown as a percent). */
  scale?: number;
}

export function ModSlider({ node, param, scale = 1, ...slider }: ModSliderProps) {
  const mod = useSceneStore((s) =>
    node === '' ? s.canvasMods[param] : s.nodes.find((n) => n.id === node)?.mods?.[param],
  );
  const live = useModValue(mod ? modKey(node, param) : undefined);
  const step = slider.step || 1;
  const marker =
    live === undefined
      ? undefined
      : Math.round(Math.round((live * scale) / step) * step * 1e6) / 1e6;
  const go = () => moveSlider(node, param, slider.value / scale);
  return (
    <Slider
      {...slider}
      marker={marker}
      onContextMenu={(e) => {
        e.preventDefault();
        go();
      }}
      after={
        <button
          type="button"
          className={`deck-mod-btn${mod ? ' is-on' : ''}`}
          aria-pressed={!!mod}
          aria-label={`Move ${slider.label} on its own`}
          title={
            mod
              ? `${slider.label} moves on its own — open it in Animate`
              : `Make ${slider.label} move on its own (on the beat or with the sound)`
          }
          onClick={go}
        >
          ∿
        </button>
      }
    />
  );
}
