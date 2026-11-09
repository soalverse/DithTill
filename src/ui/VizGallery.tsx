// The visualizer gallery ("the visualizers are important to me" — lil
// music videos). Live tiles: every style drawn by the SAME pure generator the canvas
// uses, moving to the song (its pre-analyzed features — the playhead while playing, a
// running preview while stopped). ONE gallery, two uses: + Visualizer
// opens it to ADD a layer; the selected visualizer's "Change style" opens the same gallery
// to swap that layer's style.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLoopStore } from '../state/loop-store';
import { useSceneStore } from '../state/scene-store';
import {
  renderVisualizerRaster,
  vizFeature,
  VISUALIZER_STYLES,
  type VisualizerConfig,
  type VisualizerStyle,
} from '../core/visualizer';
import { makeRng } from '../core/seeded-rng';
import { bayerThreshold, paletteLength, paletteRgbAt } from '../core/dither-constants';
import { liveAbsFrame } from './audio-engine';
import { VIZ_STYLE_LABEL } from './visualizer-node';
import { loadSong } from './load-image';

const TILE_RASTER = 64;
const TILE_FPS = 20;

/** Live, animated style tiles. `base` = the settings every tile previews with (the
 *  defaults in the gallery, the selected layer's own in its panel). */
export function VizTiles({
  base,
  size,
  selected,
  onPick,
  styles = VISUALIZER_STYLES,
  cols = 3,
}: {
  base: VisualizerConfig;
  size: number;
  selected?: VisualizerStyle;
  onPick: (style: VisualizerStyle) => void;
  styles?: readonly VisualizerStyle[];
  cols?: number;
}) {
  const refs = useRef<(HTMLCanvasElement | null)[]>([]);
  const baseRef = useRef(base);
  const stylesRef = useRef(styles);
  useEffect(() => {
    baseRef.current = base;
    stylesRef.current = styles;
  }, [base, styles]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / TILE_FPS) return;
      last = now;
      const loop = useLoopStore.getState();
      const palette = useSceneStore.getState().scene.palette;
      const F = Math.max(1, loop.meta.frames);
      const feats = loop.features;
      const total = Math.max(1, feats?.length ?? F);
      // Playing → the playhead; stopped → run through the song on our own clock.
      const abs =
        loop.transport !== 'stopped'
          ? liveAbsFrame()
          : Math.floor(((now - t0) / 1000) * Math.max(1, loop.meta.fps));
      const a = abs % total;
      const rng = makeRng(loop.meta.seed);
      const ink = paletteRgbAt(palette, paletteLength(palette) - 1);
      const bg = paletteRgbAt(palette, 0);
      stylesRef.current.forEach((style, k) => {
        const ctx = refs.current[k]?.getContext('2d');
        if (!ctx) return;
        const cfg = { ...baseRef.current, style, aspect: undefined }; // tiles stay square
        const r = renderVisualizerRaster(
          cfg,
          vizFeature(feats, a, cfg.smooth),
          a % F,
          F,
          rng,
          `tile:${style}`,
          TILE_RASTER,
          { features: feats, at: a },
        );
        // A quick 4×4 ordered screen in the canvas's own ink, so a tile reads like the
        // 1-bit result (the canvas itself dithers through the one resolver).
        const img = ctx.createImageData(r.w, r.h);
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++) {
            const i = y * r.w + x;
            const t = r.covered[i] ? r.tones[i] : 0;
            const on = t * 16 > (bayerThreshold(4, x, y) + 0.5) * 256;
            const c = on ? ink : bg;
            img.data[i * 4] = c[0];
            img.data[i * 4 + 1] = c[1];
            img.data[i * 4 + 2] = c[2];
            img.data[i * 4 + 3] = 255;
          }
        ctx.putImageData(img, 0, 0);
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`viz-tiles${styles.length === 1 ? ' viz-tiles--one' : ''}`}
      style={{ '--viz-tile': `${size}px`, '--viz-cols': cols } as CSSProperties}
    >
      {styles.map((s, k) => (
        <button
          key={s}
          type="button"
          className={`viz-tile${selected === s ? ' is-on' : ''}`}
          aria-pressed={selected === undefined ? undefined : selected === s}
          title={VIZ_STYLE_LABEL[s]}
          onClick={() => onPick(s)}
        >
          <canvas
            ref={(el) => {
              refs.current[k] = el;
            }}
            width={TILE_RASTER}
            height={TILE_RASTER}
          />
          <span>{VIZ_STYLE_LABEL[s]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * THE gallery: a popover beside `anchor` (portaled to <body> to escape the rail's fade —
 * carrying the mood colours along). Closes on a click elsewhere or Escape.
 */
export function VizGalleryPop({
  anchor,
  title,
  base,
  selected,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  base: VisualizerConfig;
  selected?: VisualizerStyle;
  onPick: (style: VisualizerStyle) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const moving = useLoopStore((s) => s.features !== null);
  const soundOff = useLoopStore((s) => !s.meta.withAudio && s.trackName !== null);
  const songRef = useRef<HTMLInputElement>(null);
  // Placed once, when it opens: beside the anchor, in the anchor's mood colours.
  const [place] = useState(() => {
    const r = anchor.getBoundingClientRect();
    const cs = getComputedStyle(anchor);
    const theme: Record<string, string> = {};
    for (const k of ['--accent', '--ink', '--sub', '--led-glow', '--phos', '--phos-dim'])
      theme[k] = cs.getPropertyValue(k);
    return {
      theme,
      right: window.innerWidth - r.left + 8,
      top: Math.max(8, Math.min(r.top, window.innerHeight - 400)),
    };
  });

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.contains(t) && !popRef.current?.contains(t)) onClose();
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
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={popRef}
      className="viz-pop"
      role="dialog"
      aria-label={title}
      style={{ ...place.theme, right: place.right, top: place.top } as CSSProperties}
    >
      <span className="viz-pop-title">{title}</span>
      <span className="viz-pop-hint">
        {moving
          ? 'Moving to your sound — click one to pick it.'
          : soundOff
            ? 'Sound is off — turn it on and these move to your track.'
            : 'Add a track and these move to it.'}
      </span>
      {!moving &&
        (soundOff ? (
          <button
            type="button"
            className="deck-load"
            onClick={() => useLoopStore.getState().setWithAudio(true)}
          >
            Turn Sound on
          </button>
        ) : (
          <>
            <button
              type="button"
              className="deck-load"
              title="Pick a music file (you can also use Load, or drop it on the canvas)"
              onClick={() => songRef.current?.click()}
            >
              ♪ Add a song
            </button>
            <input
              ref={songRef}
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void loadSong(file);
              }}
            />
          </>
        ))}
      <VizTiles
        base={base}
        size={84}
        cols={5}
        selected={selected}
        onPick={(style) => {
          onPick(style);
          onClose();
        }}
      />
    </div>,
    document.body,
  );
}

/** The selected visualizer's style: its ONE moving tile + "Change style ▸", which opens
 *  the same gallery to swap THIS layer's style (the rest of its settings stay). */
export function ChangeVizStyle({
  name,
  viz,
  onStyle,
}: {
  name: string;
  viz: VisualizerConfig;
  onStyle: (style: VisualizerStyle) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const toggle = () => setAnchor(anchor ? null : rowRef.current);
  return (
    <div className="viz-current" ref={rowRef}>
      <VizTiles base={viz} size={64} styles={[viz.style]} onPick={toggle} />
      <div className="viz-current-side">
        <span className="viz-current-name">{VIZ_STYLE_LABEL[viz.style]}</span>
        <button
          type="button"
          className={`deck-load${anchor ? ' is-on' : ''}`}
          aria-expanded={!!anchor}
          title={`Pick a different style for ${name}`}
          onClick={toggle}
        >
          Change style ▸
        </button>
      </div>
      {anchor && (
        <VizGalleryPop
          anchor={anchor}
          title={`Change ${name}`}
          base={viz}
          selected={viz.style}
          onPick={onStyle}
          onClose={close}
        />
      )}
    </div>
  );
}
