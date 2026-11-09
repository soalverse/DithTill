// =============================================================================
// A TIMELINE LANE (J2b: FL Studio's automation clip, in
// plain words). A slider whose move is "Timeline" gets a thin lane under its layer's timeline
// row, over the whole video; the setting follows the line through its dots.
//   - double-click the lane = add a dot; drag a dot = move it (a click elsewhere scrubs);
//   - dots snap to beats (hold Shift to place freely); values never snap;
//   - right-click a dot = delete it; right-click a line = Smooth / Straight / Jump.
// Each add / drag / delete is ONE undo step (state/gesture). The line drawn here uses the same
// formulas the canvas follows (core/modulators drawnAt), so what you see is what plays.
// =============================================================================
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as RMouseEvent,
  type PointerEvent as RPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useSceneStore, type SceneNode } from '../state/scene-store';
import { beginGesture, endGesture } from '../state/gesture';
import { notifyBanner } from '../state/notify-store';
import { snapFrame } from '../core/timeline-edit';
import {
  DRAWN_CURVES,
  DRAWN_CURVE_LABEL,
  MOD_RANGE,
  addDot,
  clampMod,
  moveDot,
  removeDot,
  setDotCurve,
  type DrawnCurve,
  type DrawnPoint,
  type ModParam,
} from '../core/modulators';
import { paramInfo } from './moves';

/** The line's drawing box width (stretched to the lane; the height is 0..100). */
const VB_W = 1000;
/** Dots stay this far (a share of the lane's height) inside its top and bottom edges. */
const PAD = 0.12;
/** Smooth lines are drawn from this many straight pieces per pair of dots. */
const SMOOTH_STEPS = 16;

export const LANE_TITLE =
  'Double-click to add a dot · drag a dot to move it (it snaps to beats — hold Shift to place it freely) · right-click a dot to delete it · right-click a line for Smooth, Straight or Jump';

export function DrawnLane({
  nodeId,
  node,
  param,
  points,
  span,
  beats,
  fps,
}: {
  /** The layer ('' = the canvas). */
  nodeId: string;
  node: SceneNode | undefined;
  param: ModParam;
  points: readonly DrawnPoint[];
  /** The frames the timeline spans (the whole video). */
  span: number;
  /** Every beat's frame in the span (the snap targets). */
  beats: readonly number[];
  fps: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const r = MOD_RANGE[param];
  const info = paramInfo(param, node);
  const fmt = (v: number) => info.format(v * info.scale);
  const at = (f: number) => `${(f / fps).toFixed(1)}s`;
  /** A value's height in the lane, 0 (top) … 1 (bottom). */
  const yOf = (v: number) => PAD + (1 - (v - r.min) / (r.max - r.min)) * (1 - 2 * PAD);

  // The store's dots right now (a drag writes several times between renders).
  const current = (): readonly DrawnPoint[] => {
    const s = useSceneStore.getState();
    const m =
      nodeId === '' ? s.canvasMods[param] : s.nodes.find((n) => n.id === nodeId)?.mods?.[param];
    return m?.kind === 'drawn' ? m.points : points;
  };
  const save = (next: DrawnPoint[]) =>
    useSceneStore.getState().setMod(nodeId, param, { kind: 'drawn', points: next });

  /** Where the pointer is: its frame (snapped to the nearest beat unless Shift) + value. */
  const pointAt = (e: { clientX: number; clientY: number; shiftKey: boolean }) => {
    const b = ref.current!.getBoundingClientRect();
    const raw = Math.round(((e.clientX - b.left) / Math.max(1, b.width)) * span);
    const free = Math.min(span - 1, Math.max(0, raw));
    const f = e.shiftKey ? free : snapFrame(free, beats, Infinity);
    const t = ((e.clientY - b.top) / Math.max(1, b.height) - PAD) / (1 - 2 * PAD);
    const v = clampMod(param, r.max - Math.min(1, Math.max(0, t)) * (r.max - r.min));
    return { f, v, free };
  };
  const dotOf = (e: { target: EventTarget }): number | null => {
    const d = (e.target as HTMLElement).dataset?.dot;
    return d === undefined ? null : Number(d);
  };

  // Press a dot = drag it. A press on the empty lane is left to the strip (it moves the
  // playhead, like the other rows) so a stray click never adds a dot.
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const i = dotOf(e);
    if (e.button !== 0 || i === null) return;
    e.stopPropagation(); // not a scrub
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the drag still works while the pointer stays over the lane */
    }
    beginGesture(); // the whole drag = one undo step
    drag.current = i;
    setActive(i);
  };
  // Double-click the empty lane = add a dot there.
  const onDouble = (e: RMouseEvent<HTMLDivElement>) => {
    if (dotOf(e) !== null) return;
    const { f, v } = pointAt(e);
    save(addDot(current(), f, v).points);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const i = drag.current;
    if (i === null) return;
    const { f, v } = pointAt(e);
    const cur = current();
    if (cur[i] && (cur[i].f !== f || cur[i].v !== v)) save(moveDot(cur, i, f, v));
  };
  const onUp = () => {
    if (drag.current === null) return;
    drag.current = null;
    setActive(null);
    endGesture();
  };
  const onContext = (e: RMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const cur = current();
    const d = dotOf(e);
    if (d !== null) {
      if (cur.length <= 1)
        return notifyBanner('A lane keeps one dot — press ✕ on its row in Animate to stop it');
      return save(removeDot(cur, d));
    }
    const { free } = pointAt({ ...e, shiftKey: true });
    let i = -1;
    for (let k = 0; k < cur.length; k++) if (cur[k].f <= free) i = k;
    if (i < 0 || i >= cur.length - 1)
      return notifyBanner('Right-click between two dots to change that line');
    setMenu({ i, x: e.clientX, y: e.clientY });
  };

  const X = (f: number) => (f / span) * VB_W;
  const Y = (v: number) => yOf(v) * 100;
  let line = '';
  if (points.length) {
    const p0 = points[0];
    line = `M0 ${Y(p0.v)} L${X(p0.f)} ${Y(p0.v)}`;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.curve === 'jump') line += ` L${X(b.f)} ${Y(a.v)} L${X(b.f)} ${Y(b.v)}`;
      else if (a.curve === 'straight') line += ` L${X(b.f)} ${Y(b.v)}`;
      else
        for (let k = 1; k <= SMOOTH_STEPS; k++) {
          const u = k / SMOOTH_STEPS;
          const v = a.v + ((b.v - a.v) * (1 - Math.cos(Math.PI * u))) / 2;
          line += ` L${X(a.f + (b.f - a.f) * u)} ${Y(v)}`;
        }
    }
    line += ` L${VB_W} ${Y(points[points.length - 1].v)}`;
  }

  return (
    <div
      ref={ref}
      className="tl-lane tl-lane--auto"
      title={LANE_TITLE}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onDouble}
      onContextMenu={onContext}
    >
      <svg className="tl-auto-line" viewBox={`0 0 ${VB_W} 100`} preserveAspectRatio="none">
        <path className="tl-auto-fill" d={`${line} L${VB_W} 100 L0 100 Z`} />
        <path className="tl-auto-stroke" d={line} />
      </svg>
      {points.map((p, i) => (
        <span
          key={i}
          data-dot={i}
          className={`tl-dot${active === i ? ' is-on' : ''}`}
          style={{ left: `${(p.f / span) * 100}%`, top: `${yOf(p.v) * 100}%` }}
          title={`${info.label} ${fmt(p.v)} at ${at(p.f)} — drag to move · right-click to delete`}
        />
      ))}
      {/* Every dot's value, written beside it (read the lane without Play). */}
      {points.map((p, i) =>
        active === i ? null : (
          <span
            key={`v${i}`}
            className="tl-dot-val"
            aria-hidden="true"
            style={{ left: `${(p.f / span) * 100}%`, top: `${yOf(p.v) * 100}%` }}
          >
            {fmt(p.v)}
          </span>
        ),
      )}
      {active !== null && points[active] && (
        <span
          className="tl-dot-tip"
          style={{
            left: `${(points[active].f / span) * 100}%`,
            top: `${yOf(points[active].v) * 100}%`,
          }}
        >
          {fmt(points[active].v)} · {at(points[active].f)}
        </span>
      )}
      {menu && (
        <CurveMenu
          at={menu}
          value={points[menu.i]?.curve ?? 'smooth'}
          onPick={(curve) => save(setDotCurve(current(), menu.i, curve))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Right-click on a line: how it runs to the next dot. Closes on any click elsewhere or
 *  Escape. */
function CurveMenu({
  at,
  value,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  value: DrawnCurve;
  onPick: (curve: DrawnCurve) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
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
  const hint: Record<DrawnCurve, string> = {
    smooth: 'Curves gently from one dot to the next',
    straight: 'A straight line to the next dot',
    jump: 'Stays put, then jumps at the next dot',
  };
  // Portalled out of the scrolling strip; React still bubbles its events to the lane.
  return createPortal(
    <div
      ref={box}
      className="layer-menu"
      role="menu"
      aria-label="Line options"
      // Keep its clicks from reaching the lane (adding dots) or the strip (scrubbing).
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        left: Math.min(at.x, window.innerWidth - 180),
        top: Math.min(at.y, window.innerHeight - 130),
      }}
    >
      <span className="layer-menu-title">Line</span>
      {DRAWN_CURVES.map((c) => (
        <button
          key={c}
          type="button"
          role="menuitemradio"
          aria-checked={c === value}
          title={hint[c]}
          onClick={() => {
            onPick(c);
            onClose();
          }}
        >
          {c === value ? '• ' : '  '}
          {DRAWN_CURVE_LABEL[c]}
        </button>
      ))}
    </div>,
    document.body,
  );
}
