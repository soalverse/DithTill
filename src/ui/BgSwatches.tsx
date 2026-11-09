import { useEffect, useRef, useState } from 'react';
import { paletteHex } from '../core/color';
import { hexToRgb, isCustomSwatch, rgbToHex, type Rgb, type Swatch } from '../core/color';
import type { PaletteId } from '../core/dither-constants';

/**
 * Flat-colour swatch picker. The row: optionally
 * a transparent chip, the shades of the CURRENT palette, then ONE custom "+" chip.
 *
 * The value is a `Swatch`: a palette shade INDEX (tracks the palette on a switch —
 * the behaviour), a CUSTOM `[r,g,b]` (pinned across switches), or null
 * (transparent / none). Flat CHROME, never dithered. Used for the canvas BACKGROUND
 * (Draw doc / Record scene / Burn — `allowNone`, null = transparent) AND the Halftone
 * DOT colour (`allowNone={false}`; null = the palette's brightest shade).
 *
 * The custom "+" chip opens a FLOATING RGB popover (a native <input type="color">)
 * positioned over the glass with `position: fixed` from the chip's rect, so it adds
 * ZERO deck height (the 378px reserve, is untouched — like the ExportMenu
 * popover). When a custom value is active the chip renders as a selected swatch in
 * that colour.
 */
export function BgSwatches({
  palette,
  value,
  onChange,
  label = 'BG',
  allowNone = true,
  name = 'Canvas background',
  collapsed = false,
}: {
  palette: PaletteId;
  value: Swatch;
  onChange: (v: Swatch) => void;
  /** Compact visible row label (default 'BG'; 'Dot' for the Halftone ink picker). */
  label?: string;
  /** Show the transparent chip (default true). false = a shade is always selected. */
  allowNone?: boolean;
  /** Descriptive ACCESSIBLE name for the group + swatches (default 'Canvas background';
   *  'Halftone dot colour' for the Dot picker) — the short `label` reads poorly to a
   *  screen reader, so name it in full. */
  name?: string;
  /** ONE swatch showing the current colour; click it for the choices (the canvas Background). */
  collapsed?: boolean;
}) {
  const hexes = paletteHex(palette);
  const isCustom = isCustomSwatch(value);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickPos, setPickPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const pickBtnRef = useRef<HTMLButtonElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);

  // Seed the picker at the CURRENT colour: the custom value, else the resolved preset
  // shade, else mid-grey (transparent / brightest-default has no colour of its own).
  const clampIdx = (i: number): number => Math.max(0, Math.min(hexes.length - 1, i | 0));
  const currentHex = isCustom
    ? rgbToHex(value as Rgb)
    : typeof value === 'number'
      ? (hexes[clampIdx(value)] ?? '#808080')
      : '#808080';

  // Click-away closes the popover (capture phase so other deck controls still work).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || chipRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // The collapsed picker closes on a click elsewhere (the custom colour popover counts
  // as inside, so picking a custom shade doesn't close it).
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        pickRef.current?.contains(t) ||
        pickBtnRef.current?.contains(t) ||
        popRef.current?.contains(t)
      )
        return;
      setPickOpen(false);
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pickOpen]);

  const openPopover = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.top - 6 }); // CSS lifts it up by its own height
    setOpen((o) => !o);
  };

  const lower = name.toLowerCase();

  const swatches = (
    <div className="bg-swatches" role="radiogroup" aria-label={name}>
      {allowNone && (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label={`Transparent ${lower}`}
          title="Transparent"
          className={`bg-swatch bg-swatch-none${value === null ? ' is-on' : ''}`}
          onClick={() => onChange(null)}
        />
      )}
      {hexes.map((hx, i) => (
        <button
          key={hx}
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={`${name} ${hx}`}
          title={hx}
          className={`bg-swatch${value === i ? ' is-on' : ''}`}
          style={{ background: hx }}
          onClick={() => onChange(i)}
        />
      ))}
      {/* Custom RGB chip: shows the chosen colour when active, a "+" otherwise. */}
      <button
        ref={chipRef}
        type="button"
        role="radio"
        aria-checked={isCustom}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Custom ${lower}`}
        title={isCustom ? currentHex : 'Custom colour…'}
        className={`bg-swatch bg-swatch-custom${isCustom ? ' is-on' : ''}`}
        style={isCustom ? { background: currentHex } : undefined}
        onClick={openPopover}
      >
        {isCustom ? '' : '+'}
      </button>
    </div>
  );
  const currentSwatch = value === null ? 'bg-swatch bg-swatch-none' : 'bg-swatch';

  return (
    // Compact INLINE row (label beside the swatches): the deck reserve is a hard
    // ceiling and a stacked switch row pushed Record past it.
    <div className="deck-toolrow bg-row">
      <span className="deck-ctl-label">{label}</span>
      {collapsed ? (
        <button
          ref={pickBtnRef}
          type="button"
          className={`${currentSwatch} bg-swatch-current${pickOpen ? ' is-on' : ''}`}
          style={value === null ? undefined : { background: currentHex }}
          aria-haspopup="dialog"
          aria-expanded={pickOpen}
          aria-label={`${name}: change`}
          title={`${name} — click to change`}
          onClick={() => {
            const r = pickBtnRef.current?.getBoundingClientRect();
            if (r) setPickPos({ left: r.left, top: r.top - 6 });
            setPickOpen((o) => !o);
          }}
        />
      ) : (
        swatches
      )}
      {collapsed && pickOpen && (
        <div
          ref={pickRef}
          className="bg-pick-pop"
          role="dialog"
          aria-label={name}
          style={{ left: `${pickPos.left}px`, top: `${pickPos.top}px` }}
        >
          {swatches}
        </div>
      )}
      {open && (
        <div
          ref={popRef}
          className="bg-custom-pop"
          role="dialog"
          aria-label={`Custom ${lower}`}
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        >
          <input
            type="color"
            className="bg-custom-input"
            aria-label={`${name} colour`}
            value={currentHex}
            onChange={(e) => onChange(hexToRgb(e.target.value))}
          />
          <span className="bg-custom-hex">{currentHex}</span>
          <button type="button" className="deck-load bg-custom-done" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
