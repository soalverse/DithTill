import type { ChangeEvent, MouseEvent, ReactNode } from 'react';
import { beginGesture, endGesture } from '../state/gesture';

/**
 * Deck fader (the fader-board design pass) — replaces the Knob for continuous
 * params. A native range input (drag sweeps the range; arrow/Page/Home/End keys
 * step it for precision) skinned as a recessed groove with an LED-notched cap.
 * Same value/onChange store wiring the Knob used.
 */
export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** Readout + aria-valuetext for the current value. */
  format: (v: number) => string;
  /** Greys the fader out (e.g. a per-selection param with nothing selected). */
  disabled?: boolean;
  /** Hover tooltip on the whole control (e.g. explaining why it is locked). */
  title?: string;
  /** A moving slider's LIVE value while playing (J2): a glowing marker runs along the
   *  groove and the readout shows it; the handle stays where it was set. */
  marker?: number;
  /** A control after the readout (a movable slider's ∿ button). */
  after?: ReactNode;
  onContextMenu?: (e: MouseEvent) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
  title,
  marker,
  after,
  onContextMenu,
}: SliderProps) {
  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    onChange(Math.round(v * 1e6) / 1e6); // kill FP drift on fractional steps (0.05)
  };
  const at =
    marker === undefined ? null : Math.max(0, Math.min(1, (marker - min) / (max - min || 1)));
  return (
    <div
      className={after ? 'deck-slider deck-slider--after' : 'deck-slider'}
      title={title}
      onContextMenu={onContextMenu}
    >
      <span className="deck-ctl-label">{label}</span>
      <span className="deck-range-wrap">
        <input
          type="range"
          className="deck-range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          aria-valuetext={format(value)}
          onChange={handle}
          // A drag is ONE undo step: mark its start and end.
          onPointerDown={beginGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onBlur={endGesture}
          disabled={disabled}
        />
        {at !== null && (
          <span
            className="deck-mod-marker"
            aria-hidden="true"
            style={{ left: `calc(4px + (100% - 8px) * ${at})` }}
          />
        )}
      </span>
      <span className="deck-slider-readout">{format(marker ?? value)}</span>
      {after}
    </div>
  );
}
