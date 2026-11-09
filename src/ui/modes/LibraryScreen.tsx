import { useEffect, useRef, useState } from 'react';
import { useLibraryStore } from '../../state/library-store';
import { useModeStore } from '../../state/mode-store';
import {
  deleteProject,
  duplicateProject,
  openProject,
  refreshList,
  renameProject,
  saveProjectFile,
  useProjects,
} from '../projects';
import type { ProjectMeta } from '../../platform/project-db';

const fmtDuration = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "just now" · "5 min ago" · "3 h ago" · "yesterday" · "4 days ago" · a date. */
function edited(at: number, now: number): string {
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString();
}

const fmtSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
      : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const IS_WEB = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

/** A project card's hover text: what clicking does + its size. */
function cardTitle(p: ProjectMeta, isOpen: boolean): string {
  const head = isOpen ? `${p.name} — open now` : `Open ${p.name}`;
  if (p.bytes === undefined) return head;
  return `${head}\nSize: ${fmtSize(p.bytes)} (deleting it frees only what no other project uses)`;
}

/** The ⓘ storage note on the Projects shelf. */
function StorageInfo() {
  const bytesUsed = useProjects((s) => s.bytesUsed);
  const [open, setOpen] = useState(false);
  return (
    <span className="lib-info">
      <button
        type="button"
        className="lib-info-btn"
        aria-label="Where projects are stored"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
      >
        ⓘ
      </button>
      <span className={`lib-info-pop${open ? ' is-open' : ''}`} role="tooltip">
        Projects and everything in them (photos, videos, songs) are stored inside DithTill on this
        device. Delete projects you no longer need to free up space, and use Save as file to keep a
        backup.
        {IS_WEB && <> Clearing your browser data deletes them.</>}
        <span className="lib-info-used">Using {fmtSize(bytesUsed)}.</span>
      </span>
    </span>
  );
}

interface CardMenuAt {
  p: ProjectMeta;
  x: number;
  y: number;
}

/** A project card's menu: Open · Rename · Duplicate · Save as file · Delete (two clicks). */
function CardMenu({
  at,
  onClose,
  onOpen,
  onRename,
}: {
  at: CardMenuAt;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [armDelete, setArmDelete] = useState(false);
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
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      ref={ref}
      className="layer-menu"
      role="menu"
      aria-label={`${at.p.name} options`}
      style={{
        left: Math.min(at.x, window.innerWidth - 180),
        top: Math.min(at.y, window.innerHeight - 200),
      }}
    >
      <span className="layer-menu-title">{at.p.name}</span>
      <button type="button" role="menuitem" onClick={act(() => onOpen(at.p.id))}>
        Open
      </button>
      <button type="button" role="menuitem" onClick={act(() => onRename(at.p.id))}>
        Rename
      </button>
      <button type="button" role="menuitem" onClick={act(() => void duplicateProject(at.p.id))}>
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={act(() => void saveProjectFile(at.p.id))}>
        Save as file…
      </button>
      <button
        type="button"
        role="menuitem"
        className="layer-menu-danger"
        onClick={() => {
          if (!armDelete) return setArmDelete(true);
          void deleteProject(at.p.id);
          onClose();
        }}
      >
        {armDelete ? 'Delete — sure?' : 'Delete'}
      </button>
    </div>
  );
}

/** The Projects shelf: every saved canvas, newest first. */
function ProjectsShelf() {
  const list = useProjects((s) => s.list);
  const currentId = useProjects((s) => s.currentId);
  const [menu, setMenu] = useState<CardMenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // "edited N min ago" ticks over once a minute.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void refreshList();
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const open = async (id: string) => {
    if (id !== currentId && !(await openProject(id))) return;
    useModeStore.getState().setMode('canvas');
  };
  const startRename = (id: string) => {
    setDraft(list.find((p) => p.id === id)?.name ?? '');
    setRenaming(id);
  };

  return (
    <section className="lib-section" aria-label="Projects">
      <div className="lib-heading">
        <span>Projects</span>
        <StorageInfo />
      </div>
      {list.length === 0 ? (
        <span className="lib-hint">Your canvas saves itself here as soon as you start.</span>
      ) : (
        <div className="lib-projects">
          {list.map((p) => (
            <div
              key={p.id}
              className={`lib-project${p.id === currentId ? ' is-open' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ p, x: e.clientX, y: e.clientY });
              }}
            >
              <button
                type="button"
                className="lib-project-open"
                title={cardTitle(p, p.id === currentId)}
                onClick={() => void open(p.id)}
              >
                {p.thumbnail ? (
                  <img src={p.thumbnail} alt="" className="lib-project-thumb" />
                ) : (
                  <span className="lib-project-thumb lib-project-blank">empty</span>
                )}
              </button>
              {renaming === p.id ? (
                <input
                  className="lib-project-input"
                  value={draft}
                  autoFocus
                  maxLength={80}
                  aria-label="Project name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    setRenaming(null);
                    void renameProject(p.id, draft);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="lib-project-name">{p.name}</span>
              )}
              <span className="lib-project-meta">
                {p.id === currentId ? 'open · ' : ''}
                {edited(p.updatedAt, now)}
              </span>
              <button
                type="button"
                className="lib-project-more"
                aria-label={`${p.name} options`}
                title="Open · Rename · Duplicate · Save as file · Delete"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ p, x: r.left, y: r.bottom + 4 });
                }}
              >
                ⋯
              </button>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <CardMenu
          at={menu}
          onClose={() => setMenu(null)}
          onOpen={(id) => void open(id)}
          onRename={startRename}
        />
      )}
    </section>
  );
}

/**
 * The Library "backpack" — the Projects shelf
 * above a thumbnail grid of saved elements on the CRT glass. A click on an
 * element toggles selection (multi-select); the Library deck acts on the selection.
 */
export function LibraryScreen() {
  const ready = useLibraryStore((s) => s.ready);
  const elements = useLibraryStore((s) => s.elements);
  const selected = useLibraryStore((s) => s.selected);
  const toggle = useLibraryStore((s) => s.toggle);

  useEffect(() => {
    void useLibraryStore.getState().init();
  }, []);

  return (
    <div className="lib-screen">
      <div className="lib-grid" role="listbox" aria-label="Library" aria-multiselectable="true">
        <ProjectsShelf />
        <div className="lib-heading lib-section">
          <span>Elements</span>
        </div>
        {ready && elements.length === 0 && (
          <span className="lib-hint lib-section">
            empty — Save to Library on the canvas to keep things here
          </span>
        )}
        {elements.map((el) => {
          const isSel = selected.includes(el.id);
          return (
            <button
              key={el.id}
              type="button"
              role="option"
              aria-selected={isSel}
              className={`lib-tile${isSel ? ' is-sel' : ''}`}
              title={el.name}
              onClick={() => toggle(el.id)}
            >
              <img src={el.thumbnail} alt="" className="lib-thumb" />
              {el.kind === 'video' && (
                <span className="lib-badge">▶ {fmtDuration(el.outSeconds - el.inSeconds)}</span>
              )}
              {el.kind === 'recording' && (
                <span className="lib-badge lib-badge--rec">
                  ● {fmtDuration(el.frames / el.fps)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
