// =============================================================================
// A compact deck dropdown (owner ask, 2026-07-04): a menu that shows ONE row when
// closed and pops the options on click — so many-option menus (Matrix, Palette,
// Cell style, …) stop eating deck rows and several can share a row, keeping the
// fixed deck reserve as controls grow.
//
// The popover is PORTALED to <body> so it escapes the CRT device's auto-fit
// `transform: scale()` (a transformed ancestor would otherwise become the
// containing block for position:fixed AND re-scale it, detaching the menu from its
// trigger on any window smaller than the device). Placed from the trigger's rect,
// re-placed on scroll/resize so it never drifts.
// =============================================================================
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';

interface DropdownProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly T[];
  format: (v: T) => string;
  onChange: (v: T) => void;
  title?: string;
  /** A labelled divider drawn above one option (e.g. "diffusion" in the Pattern menu). */
  divider?: { before: T; label: string };
}

export function Dropdown<T extends string | number>({
  label,
  value,
  options,
  format,
  onChange,
  title,
  divider,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  // The popover is portaled to <body>, escaping the device's theme vars — copy the
  // trigger's computed ink/accent onto it so the menu is readable AND mood-matched.
  const [theme, setTheme] = useState<Record<string, string>>({});

  // Place the fixed popover just under the trigger (flip above if it would clip).
  const place = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const estH = Math.min(options.length + (divider ? 1 : 0), 15) * 26 + 8;
    const below = r.bottom + 4;
    const flip = below + estH > window.innerHeight && r.top - estH > 0;
    setPos({ left: r.left, top: flip ? r.top - estH - 4 : below, width: Math.max(r.width, 96) });
  }, [options.length, divider]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const cs = getComputedStyle(btnRef.current);
    setTheme({
      '--ink': cs.getPropertyValue('--ink'),
      '--sub': cs.getPropertyValue('--sub'),
      '--accent': cs.getPropertyValue('--accent'),
      '--accent-ink': cs.getPropertyValue('--accent-ink'),
    });
    place();
  }, [open, place]);

  // While open: keep aligned on scroll/resize; close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <div className="deck-dd" title={title}>
      {label && <span className="deck-ctl-label">{label}</span>}
      <button
        type="button"
        ref={btnRef}
        className={`deck-dd-btn${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="deck-dd-val">{format(value)}</span>
        <span className="deck-dd-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="deck-dd-pop"
            role="listbox"
            aria-label={label}
            style={{ ...theme, left: pos.left, top: pos.top, minWidth: pos.width } as CSSProperties}
          >
            {options.map((o) => [
              divider && o === divider.before ? (
                <div key="divider" className="deck-dd-divider" role="separator">
                  {divider.label}
                </div>
              ) : null,
              <button
                type="button"
                key={String(o)}
                role="option"
                aria-selected={o === value}
                className={`deck-dd-opt${o === value ? ' is-on' : ''}`}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
              >
                {format(o)}
              </button>,
            ])}
          </div>,
          document.body,
        )}
    </div>
  );
}
