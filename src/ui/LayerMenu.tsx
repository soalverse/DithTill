import { useEffect, useRef } from 'react';
import { useSceneStore } from '../state/scene-store';
import { duplicateSelection } from './paint-node';
import { notifyBanner } from '../state/notify-store';
import { saveRecordingToLibrary } from './record-actions';

export interface LayerMenuAt {
  nodeId: string;
  name: string;
  x: number;
  y: number;
}

/**
 * The right-click menu on a layer — on the timeline rows and in the
 * Layers list: Hide / Show, Duplicate, Delete. Every action is one undo step. Closes on
 * any click elsewhere or Escape. Fixed to the pointer, kept on screen.
 */
export function LayerMenu({ at, onClose }: { at: LayerMenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const node = useSceneStore((s) => s.nodes.find((n) => n.id === at.nodeId));

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  if (!node) return null;
  const st = useSceneStore.getState();
  const left = Math.min(at.x, window.innerWidth - 180);
  const top = Math.min(at.y, window.innerHeight - 140);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="layer-menu"
      role="menu"
      aria-label={`${at.name} options`}
      style={{ left, top }}
    >
      <span className="layer-menu-title">{at.name}</span>
      <button
        type="button"
        role="menuitem"
        onClick={act(() => st.setHidden(node.id, !node.hidden))}
      >
        {node.hidden ? 'Show' : 'Hide'}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={act(() => {
          st.setSelection([node.id]);
          duplicateSelection();
        })}
      >
        Duplicate
      </button>
      {node.kind === 'recording' && (
        <button
          type="button"
          role="menuitem"
          onClick={act(() => void saveRecordingToLibrary(node.id, at.name))}
        >
          Save to Library
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="layer-menu-danger"
        onClick={act(() => {
          st.remove([node.id]);
          notifyBanner(`${at.name} deleted — Undo brings it back`);
        })}
      >
        Delete
      </button>
    </div>
  );
}
