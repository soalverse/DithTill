// =============================================================================
// The EFFECTS part of the Animate list (J5: "inside the animate
// list, but under a sub-heading called effects"). A layer's effects, one row each in their
// fixed order (Mirror → Kaleidoscope → Wave → Blur → Posterize → Outline), every amount a ∿
// slider like any other; "+ Add effect" offers the ones it doesn't have yet. Rows share the
// Animate list's one-open-row rule.
// =============================================================================
import { useState } from 'react';
import { useSceneStore, type SceneNode } from '../state/scene-store';
import { useLoopStore } from '../state/loop-store';
import { ModSlider } from './ModSlider';
import { CANVAS_FX_KINDS } from '../core/canvas-fx';
import { isVideoAsset } from './video-assets';
import {
  beatsLabel,
  openMove,
  paramInfo,
  paramValue,
  setFxParam,
  useOpenMove,
  FX_PARAMS,
} from './moves';
import { MOD_RANGE } from '../core/modulators';
import {
  FX_DEFAULT,
  FX_LABEL,
  FX_ORDER,
  MIRROR_LABEL,
  MIRROR_MODES,
  TRAIL_KINDS,
  TRAIL_LABEL,
  type FxKind,
  type LayerFx,
} from '../core/layer-fx';

const NO_CANVAS = { dotSize: 0, density: 0, bitSize: 0 };

/** A short summary of an effect's settings for its row. */
function fxSummary(kind: FxKind, fx: LayerFx): string {
  switch (kind) {
    case 'mirror':
      return MIRROR_LABEL[fx.mirror!.mode];
    case 'kaleido':
      return `${Math.round(fx.kaleido!.wedges)} wedges · ${Math.round(fx.kaleido!.turn)}°`;
    case 'wave':
      return `amount ${+fx.wave!.amount.toFixed(1)} · size ${Math.round(fx.wave!.size)}`;
    case 'blur':
      return `${+fx.blur!.radius.toFixed(1)}`;
    case 'posterize':
      return `${Math.round(fx.posterize!.steps)} steps`;
    case 'outline':
      return `${Math.round(fx.outline!.strength)}%`;
    case 'trail':
      return `${TRAIL_LABEL[fx.trail!.kind]} · ${beatsLabel(fx.trail!.length)}`;
  }
}

/** What an effect starts at on this layer: a Trail starts as Smear on a video or visualizer
 *  (its picture moves), Echo otherwise (the layer moves). */
function fxStart(kind: FxKind, node: SceneNode | undefined): LayerFx[FxKind] {
  if (kind === 'trail' && node)
    return {
      ...FX_DEFAULT.trail,
      kind: isVideoAsset(node.assetId) || node.kind === 'visualizer' ? 'smear' : 'echo',
    };
  return { ...FX_DEFAULT[kind] };
}

/** A layer's effects, or with no layer the Whole canvas's (about the canvas middle, on the
 *  whole picture — no Trail: that is a layer's own). */
export function EffectsList({ node }: { node: SceneNode | undefined }) {
  const { key: openKey } = useOpenMove();
  const [adding, setAdding] = useState(false);
  const canvasFx = useSceneStore((s) => s.canvasFx);
  const fx = (node ? node.fx : canvasFx) ?? {};
  const offered = node ? FX_ORDER : CANVAS_FX_KINDS;
  const kinds = offered.filter((k) => fx[k] !== undefined);
  const free = offered.filter((k) => fx[k] === undefined);
  const id = node?.id ?? '';
  const setFx = useSceneStore.getState().setFx;
  const recording = useLoopStore((s) => s.transport === 'recording');
  return (
    <div className="moves fx-list">
      <span className="deck-panel-label moves-sub">Effects</span>
      {kinds.map((k) => {
        const key = `fx:${k}`;
        const open = openKey === key;
        return (
          <div key={k} data-move={key} className={`move${open ? ' is-open' : ''}`}>
            <div className="move-head">
              <button
                type="button"
                className="move-title"
                aria-expanded={open}
                title={open ? 'Close its settings' : 'Open its settings'}
                onClick={() => openMove(open ? null : key)}
              >
                <span className="move-name">{FX_LABEL[k]}</span>
                <span className="move-sum">{fxSummary(k, fx)}</span>
              </button>
              <button
                type="button"
                className="move-x"
                aria-label={`Remove ${FX_LABEL[k]}`}
                title="Remove this effect"
                onClick={() => {
                  setFx(id, k, null);
                  if (open) openMove(null);
                }}
              >
                ✕
              </button>
            </div>
            {open && (
              <div className="move-body">
                {k === 'mirror' && (
                  <div className="deck-seg" role="radiogroup" aria-label="Mirror">
                    {MIRROR_MODES.map((m) => (
                      <button
                        type="button"
                        key={m}
                        role="radio"
                        aria-checked={fx.mirror!.mode === m}
                        className={fx.mirror!.mode === m ? 'is-on' : undefined}
                        onClick={() => setFx(id, 'mirror', { mode: m })}
                      >
                        {MIRROR_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
                {k === 'trail' && (
                  <div className="deck-seg" role="radiogroup" aria-label="Trail">
                    {TRAIL_KINDS.map((m) => (
                      <button
                        type="button"
                        key={m}
                        role="radio"
                        aria-checked={fx.trail!.kind === m}
                        className={fx.trail!.kind === m ? 'is-on' : undefined}
                        title={
                          m === 'echo'
                            ? 'Fading copies of the layer where it was a moment ago'
                            : 'The picture keeps the brightest of its recent past'
                        }
                        onClick={() => setFx(id, 'trail', { ...fx.trail!, kind: m })}
                      >
                        {TRAIL_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
                {FX_PARAMS[k].map((p) => {
                  const info = paramInfo(p, node);
                  const r = MOD_RANGE[p];
                  return (
                    <ModSlider
                      key={p}
                      node={id}
                      param={p}
                      label={info.label}
                      value={paramValue(p, node, NO_CANVAS)}
                      min={r.min}
                      max={r.max}
                      step={info.step}
                      onChange={(v) => setFxParam(node, p, v)}
                      format={info.format}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {free.length > 0 && (
        <button
          type="button"
          className={`deck-load${adding ? ' is-on' : ''}`}
          disabled={recording}
          title={
            node
              ? 'Change the picture before its dots: mirror it, blur it, outline it, trail it…'
              : 'Change the whole picture before its dots: mirror it about the middle, fold it into a kaleidoscope…'
          }
          onClick={() => setAdding(!adding)}
        >
          + Add effect
        </button>
      )}
      {adding && (
        <div className="add-move-chips fx-add" role="menu" aria-label="Add an effect">
          {free.map((k) => (
            <button
              type="button"
              role="menuitem"
              key={k}
              onClick={() => {
                setFx(id, k, fxStart(k, node) as never);
                setAdding(false);
                openMove(`fx:${k}`, true);
              }}
            >
              {FX_LABEL[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
