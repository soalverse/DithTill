import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** One entry in a mode's Export… menu. `run` owns the full export flow
 *  (including its own notify/progress messages); the menu only manages the
 *  open/busy/cancel chrome around it. */
export interface ExportMenuItem {
  key: string;
  label: string;
  title?: string;
  disabled?: boolean;
  /** Draw a divider above this entry. */
  divider?: boolean;
  /** A group heading drawn above this entry (with a divider unless it's the first). */
  heading?: string;
  /** A short line under the label saying what the item makes. */
  hint?: string;
  /** Long-running + abortable (video/loop): while it runs the trigger becomes
   *  Cancel and clicking aborts via the signal passed to `run`. */
  cancellable?: boolean;
  run: (ctx: { signal: AbortSignal }) => Promise<void>;
}

/**
 * The ONE deck export control (G7, owner-locked): a single "Export…" button per
 * mode whose popover lists that mode's formats (Burn: PNG/SVG/Video · Draw:
 * PNG/SVG · Record: PNG/SVG/Loop). The popover is FIXED-positioned under the trigger, so it
 * never adds to the rail's scrollHeight and the scrolling rail can't clip it
 * (the grouped menu with hints is taller than the rail).
 */
export function ExportMenu({
  items,
  label = 'Export…',
  title = 'Export the current work',
  disabled = false,
}: {
  items: ExportMenuItem[];
  label?: string;
  /** The trigger's tooltip. */
  title?: string;
  /** Grey the whole menu out (e.g. while recording). */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; bottom: number; right: number; up: boolean }>({
    top: 0,
    bottom: 0,
    right: 0,
    up: false,
  });
  const popRef = useRef<HTMLDivElement>(null);
  // Too tall for the room below the button (Export slid under the timeline)
  // and more room above? Open UPWARD instead.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!open || !pop || at.up) return;
    // The timeline strip (when open) is the floor: the menu can't sit over it.
    const floor = document.querySelector('.scr-strip')?.getBoundingClientRect().top;
    const below = (floor ?? window.innerHeight) - at.top - 12;
    const above = at.bottom - 12;
    if (pop.scrollHeight > below && above > below) setAt((a) => ({ ...a, up: true }));
  }, [open, at]);

  // Click-away closes the popover (capture phase so deck buttons still work).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const busyItem = busyKey ? items.find((i) => i.key === busyKey) : undefined;
  const allDisabled = items.every((i) => i.disabled);

  async function runItem(item: ExportMenuItem) {
    setOpen(false);
    setBusyKey(item.key);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await item.run({ signal: ctrl.signal });
    } finally {
      setBusyKey(null);
      abortRef.current = null;
    }
  }

  function onTrigger() {
    if (busyItem?.cancellable) {
      abortRef.current?.abort();
      return;
    }
    if (!open) {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r)
        setAt({
          top: r.bottom + 6,
          bottom: r.top - 6,
          right: window.innerWidth - r.right,
          up: false,
        });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="export-menu" ref={wrapRef}>
      <button
        type="button"
        className={`deck-load deck-export${busyKey ? ' is-busy' : ''}`}
        disabled={!busyKey && (allDisabled || disabled)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={busyItem?.cancellable ? 'Cancel the running export' : title}
        onClick={onTrigger}
      >
        {busyKey ? (busyItem?.cancellable ? 'Cancel' : 'Exporting…') : label}
      </button>
      {open && (
        <div
          className="export-menu-pop"
          role="menu"
          ref={popRef}
          style={
            at.up
              ? {
                  top: 'auto',
                  bottom: window.innerHeight - at.bottom,
                  right: at.right,
                  maxHeight: at.bottom - 12,
                }
              : { top: at.top, right: at.right, maxHeight: `calc(100vh - ${at.top + 12}px)` }
          }
        >
          {items.map((item, i) => [
            item.divider || (item.heading && i > 0) ? (
              <hr key={`${item.key}-sep`} className="export-menu-sep" />
            ) : null,
            item.heading ? (
              <span key={`${item.key}-head`} className="export-menu-head" role="presentation">
                {item.heading}
              </span>
            ) : null,
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`deck-load${item.hint ? ' has-hint' : ''}`}
              disabled={item.disabled || busyKey !== null}
              title={item.title}
              onClick={() => void runItem(item)}
            >
              {item.label}
              {item.hint && <span className="export-menu-hint">{item.hint}</span>}
            </button>,
          ])}
        </div>
      )}
    </div>
  );
}
