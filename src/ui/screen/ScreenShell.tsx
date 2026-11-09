import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useBurnStore } from '../../state/burn-store';
import { ASPECT_RATIO } from '../../core/dither-constants';
import { useModeStore, MODES } from '../../state/mode-store';
import { Notifications } from '../Notifications';
import { ExportLengthPanel } from '../ExportLengthPanel';
import { LayersDoor } from '../LayersDoor';
import {
  CREDITS,
  HELP_TOPICS,
  MATCH_CANVAS,
  THEMES,
  THEME_KEY,
  loadTheme,
  paletteStrip,
  resolveTheme,
  themeSwatch,
  themeVars,
  type CSSVars,
} from '../shell-theme';
import { useSceneStore } from '../../state/scene-store';
import { DeckSlotTarget } from './deck-slot-context';
import { Timeline } from '../Timeline';
import { useLoopStore } from '../../state/loop-store';
import { renameProject, useProjects } from '../projects';
import '../../styles/crt.css';
import '../../styles/screen.css';

/**
 * SCREEN shell — PROTOTYPE. The window IS the
 * CRT: nothing but a black screen. The artwork is letterboxed at its aspect in the
 * full window, and the controls are ON-GLASS panels at the left (modes + params) and
 * right (actions + system) edges in the ? help aesthetic — phosphor type that glows.
 * Hide UI (button or H) clears the glass; the panels auto-fade while you drag on it.
 * Power stays — an on-screen glowing button with the CRT on/off flash.
 *
 * No AUTO-FIT scale: laid out at 1:1, so type stays crisp. The render is
 * CSS-size-independent, so nothing in core/ or the export path moves.
 */
/** The open project's (silly) name beside the wordmark — click to rename. */
function ProjectName() {
  const name = useProjects((s) => s.name);
  const currentId = useProjects((s) => s.currentId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!name) return null;
  if (editing)
    return (
      <input
        className="scr-project-input"
        value={draft}
        autoFocus
        maxLength={80}
        aria-label="Project name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          void renameProject(currentId, draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <button
      type="button"
      className="scr-project"
      title="This project — click to rename. It saves itself; find all your projects in the Library."
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
    >
      <span className="scr-project-dot">·</span> {name} <span aria-hidden>✎</span>
    </button>
  );
}

export function ScreenShell({ screen, deck }: { screen: ReactNode; deck: ReactNode }) {
  const crtEffects = useBurnStore((s) => s.crtEffects);
  const setCrtEffects = useBurnStore((s) => s.setCrtEffects);
  const aspect = useBurnStore((s) => s.aspect);
  const mode = useModeStore((s) => s.mode);
  // The Animate timeline strip along the bottom.
  const animate = useLoopStore((s) => s.animate);
  // While recording (0.1.0: grey out what can't be used mid-take) the canvas can't be left.
  const recording = useLoopStore((s) => s.transport === 'recording');
  const strip = mode === 'canvas' && animate;
  const setMode = useModeStore((s) => s.setMode);
  const ar = ASPECT_RATIO[aspect].w / ASPECT_RATIO[aspect].h;

  const [themeId, setThemeIdState] = useState(loadTheme);
  const setTheme = (id: string) => {
    setThemeIdState(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch {
      /* storage denied — the theme just won't persist */
    }
  };
  const palette = useSceneStore((s) => s.scene.palette);
  // The theme tints the whole page (<html>), so pop-ups portaled to <body> follow it.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(themeVars(resolveTheme(themeId, palette))))
      root.setProperty(k, v);
  }, [themeId, palette]);
  const [power, setPower] = useState(true);
  const powerRef = useRef<HTMLButtonElement>(null);
  const [offAt, setOffAt] = useState<{ left: number; top: number } | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [layersOpen, setLayersOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [sysOpen, setSysOpen] = useState(false);
  const sysRef = useRef<HTMLDivElement>(null);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const staticRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);

  // H toggles the UI (ignored while typing in a field or with a modifier held).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'h') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      setUiHidden((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Esc opens / closes Help. An open menu, list or dialog takes the
  // Esc first (it closes itself); typing in a field never opens Help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (creditsOpen) {
        setCreditsOpen(false);
        return;
      }
      if (document.querySelector('[role="menu"], [role="dialog"]:not(.crt-help), .deck-dd-pop'))
        return;
      setHelpOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creditsOpen]);

  // The ⚙ menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!sysOpen) return;
    const down = (e: PointerEvent) => {
      if (!sysRef.current?.contains(e.target as Node)) setSysOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSysOpen(false);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [sysOpen]);

  // Auto-fade: any drag that starts on the glass dims the rails until release.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging]);

  // Power on/off flash over the whole tube (the radio's playStatic, full-window).
  function playStatic(on: boolean) {
    const el = staticRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = 'scaleY(1)';
    el.style.opacity = '1';
    void el.offsetWidth;
    requestAnimationFrame(() => {
      if (on) {
        el.style.transition = 'opacity .45s ease';
        el.style.opacity = '0';
      } else {
        el.style.transition = 'transform .4s ease-in, opacity .4s ease-in';
        el.style.transform = 'scaleY(.02)';
        el.style.opacity = '0';
      }
    });
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      el.style.transition = 'none';
      el.style.opacity = '0';
    }, 560);
  }
  function togglePower() {
    const r = powerRef.current?.getBoundingClientRect();
    if (power && r) setOffAt({ left: r.left, top: r.top });
    setPower((p) => {
      playStatic(!p);
      return !p;
    });
  }
  function toggleHelp() {
    setHelpOpen((v) => !v);
  }

  const activeHelp = HELP_TOPICS.find((t) => t.id === helpTopic) ?? HELP_TOPICS[0];
  const vars: CSSVars = { '--ar': String(ar) };
  const cls = `scr${power ? ' is-on' : ''}${crtEffects ? ' is-fx' : ''}${
    uiHidden ? ' is-ui-hidden' : ''
  }${dragging ? ' is-dragging' : ''}${strip ? ' has-strip' : ''}`;

  return (
    <div className={cls} style={vars}>
      <aside className="scr-rail scr-rail--l" aria-label="Modes and controls">
        <div className="scr-brand">
          <span className="scr-wordmark">
            Dith<b>till</b>
          </span>
          <ProjectName />
        </div>
        <nav className="scr-modes" aria-label="Mode">
          {MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              className={`scr-mode${mode === m.id ? ' is-on' : ''}`}
              disabled={recording && mode !== m.id}
              title={recording && mode !== m.id ? 'Finish the take first' : undefined}
              onClick={() => setMode(m.id)}
              aria-pressed={mode === m.id}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <div className="scr-deck">
          <DeckSlotTarget.Provider value={slotEl}>{deck}</DeckSlotTarget.Provider>
        </div>
      </aside>

      <main
        className="scr-stage"
        onPointerDown={(e) => {
          setDragging(true);
          // A press on the black around the picture = Whole canvas.
          if (e.target === e.currentTarget && mode === 'canvas')
            useSceneStore.getState().clearSelection();
        }}
      >
        <div className="crt-glass scr-glass">
          <div className="crt-screen-slot" key={mode}>
            {screen}
          </div>
          <Notifications />
          <ExportLengthPanel />
        </div>
      </main>

      {strip && (
        <footer className="scr-strip" aria-label="Timeline">
          <Timeline />
        </footer>
      )}

      <aside className="scr-rail scr-rail--r" aria-label="Actions">
        {mode === 'canvas' &&
          (layersOpen ? (
            <section className="scr-layers">
              <LayersDoor onClose={() => setLayersOpen(false)} />
            </section>
          ) : (
            <button
              type="button"
              className="deck-load scr-layers-open"
              onClick={() => setLayersOpen(true)}
            >
              Layers ▸
            </button>
          ))}
        <div className="scr-slot" ref={setSlotEl} />
        <div className="scr-sys" ref={sysRef}>
          {sysOpen && (
            <div className="scr-sys-pop" role="menu" aria-label="Settings">
              <button
                type="button"
                className="scr-chip"
                role="menuitem"
                onClick={() => {
                  setSysOpen(false);
                  setUiHidden(true);
                }}
                title="Hide the UI (H)"
              >
                Hide UI
              </button>
              <button
                type="button"
                className={`scr-chip${helpOpen ? ' is-on' : ''}`}
                role="menuitem"
                onClick={() => {
                  setSysOpen(false);
                  toggleHelp();
                }}
                aria-pressed={helpOpen}
              >
                Help
              </button>
              <button
                type="button"
                className={`scr-chip${crtEffects ? ' is-on' : ''}`}
                onClick={() => setCrtEffects(!crtEffects)}
                role="switch"
                aria-checked={crtEffects}
                title="CRT effects (scanlines + glow)"
              >
                FX
              </button>
              <button
                type="button"
                className={`scr-chip${creditsOpen ? ' is-on' : ''}`}
                role="menuitem"
                onClick={() => {
                  setSysOpen(false);
                  setCreditsOpen(true);
                }}
              >
                Credits &amp; licences
              </button>
              <span className="scr-sys-label">Theme</span>
              <div className="scr-moods" role="radiogroup" aria-label="Theme">
                {THEMES.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className={`scr-mood${t.id === themeId ? ' is-on' : ''}`}
                    onClick={() => setTheme(t.id)}
                    title={t.name}
                    aria-label={t.name}
                    aria-pressed={t.id === themeId}
                    style={{ color: themeSwatch(t) }}
                  />
                ))}
                <button
                  type="button"
                  className={`scr-mood scr-mood--canvas${themeId === MATCH_CANVAS ? ' is-on' : ''}`}
                  onClick={() => setTheme(MATCH_CANVAS)}
                  title="Match my canvas: the UI takes its colour from the canvas palette"
                  aria-label="Match my canvas"
                  aria-pressed={themeId === MATCH_CANVAS}
                  style={{
                    color: themeSwatch(resolveTheme(MATCH_CANVAS, palette)),
                    background: `conic-gradient(${paletteStrip(palette).join(', ')})`,
                  }}
                />
              </div>
            </div>
          )}
          <div className="scr-sys-row">
            <button
              type="button"
              className={`scr-chip scr-gear${sysOpen ? ' is-on' : ''}`}
              aria-expanded={sysOpen}
              aria-label="Settings"
              title="Settings: hide UI, help, credits, CRT effects, theme"
              onClick={() => setSysOpen((o) => !o)}
            >
              ⚙
            </button>
            <button
              type="button"
              className={`scr-chip scr-gear${helpOpen ? ' is-on' : ''}`}
              aria-pressed={helpOpen}
              aria-label="Help"
              title="Help (Esc)"
              onClick={toggleHelp}
            >
              ?
            </button>
            {/* Power sits beside ⚙ (it covered the Project menu). */}
            <button
              type="button"
              ref={powerRef}
              className="scr-power scr-power--rail"
              onClick={togglePower}
              aria-pressed={power}
              aria-label="Power"
              title="Power"
              tabIndex={power ? 0 : -1}
            >
              <span className="scr-power-glyph" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      {/* Help: a card over everything, the canvas dimmed behind; a click outside closes it. */}
      {helpOpen && (
        <div
          className="crt-help"
          role="dialog"
          aria-label="Help"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHelpOpen(false);
          }}
        >
          <div className="crt-help-card">
            <div className="crt-help-head">
              <span className="crt-help-title">Help</span>
              <span className="crt-help-close">Esc or click outside to close</span>
            </div>
            <div className="crt-help-cols">
              <div className="crt-help-list" role="tablist" aria-label="Help topics">
                {HELP_TOPICS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    role="tab"
                    aria-selected={t.id === activeHelp.id}
                    className={`crt-help-item${t.id === activeHelp.id ? ' is-on' : ''}`}
                    onClick={() => setHelpTopic(t.id)}
                  >
                    <span className="crt-help-mark">{t.id === activeHelp.id ? '▸' : ''}</span>
                    {t.label}
                  </button>
                ))}
              </div>
              {/* Every topic sits in the same spot (only the picked one shows), so the card is
                  always the size of the longest and never jumps between topics. */}
              <div className="crt-help-stack">
                {HELP_TOPICS.map((t) => (
                  <div
                    key={t.id}
                    className={`crt-help-body${t.id === activeHelp.id ? '' : ' is-off'}`}
                    role="tabpanel"
                    aria-hidden={t.id !== activeHelp.id}
                  >
                    <span className="crt-help-topic">{t.label}</span>
                    {t.lines.map((l, i) => (
                      <span key={i} className="crt-help-line">
                        {l}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Credits & licences: the Help card's look, opened from ⚙. */}
      {creditsOpen && (
        <div
          className="crt-help crt-credits"
          role="dialog"
          aria-label="Credits and licences"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCreditsOpen(false);
          }}
        >
          <div className="crt-help-card">
            <div className="crt-help-head">
              <span className="crt-help-title">Credits &amp; licences</span>
              <span className="crt-help-close">Esc or click outside to close</span>
            </div>
            <span className="crt-help-topic">{CREDITS.byline}</span>
            <span className="crt-help-close">{CREDITS.eyebrow}</span>
            <span className="crt-help-line">{CREDITS.intro}</span>
            <dl className="crt-credits-list">
              {CREDITS.entries.map((c) => (
                <div key={c.name} className="crt-credits-row">
                  <dt className="crt-credits-name">{c.name}</dt>
                  <dd className="crt-help-line">{c.does}</dd>
                </div>
              ))}
            </dl>
            <span className="crt-help-line">{CREDITS.rest}</span>
          </div>
        </div>
      )}

      {/* The whole window is the tube: scanlines + vignette over everything. */}
      <div className="scr-fx" aria-hidden="true">
        <div className="scr-scan" />
        <div className="scr-vig" />
      </div>
      <div className="scr-off" aria-hidden="true" />
      <div className="scr-staticline" ref={staticRef} aria-hidden="true" />

      {/* Switched off, the dark tube covers the rails: the power button floats over the
          cover in the very spot it sits beside ⚙. */}
      {!power && offAt && (
        <button
          type="button"
          className="scr-power scr-power--off"
          style={{ left: offAt.left, top: offAt.top }}
          onClick={togglePower}
          aria-pressed={false}
          aria-label="Power"
          title="Power"
        >
          <span className="scr-power-glyph" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="scr-ghost"
        onClick={() => setUiHidden(false)}
        tabIndex={uiHidden ? 0 : -1}
        aria-hidden={!uiHidden}
        title="Show the UI (H)"
      >
        Show UI
      </button>
    </div>
  );
}
