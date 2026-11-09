// =============================================================================
// The ONLY Tauri-coupled file in the export path. In the Tauri app it opens a
// native save dialog and writes to disk; in a plain browser (PWA / dev preview)
// it falls back to a download. Swap this module to re-target — core/ is untouched.
// =============================================================================
import { save } from '@tauri-apps/plugin-dialog';
import { exists, writeFile } from '@tauri-apps/plugin-fs';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The first of `name`, `name 2`, `name 3`… (before the extension) that `taken` says is
 *  free — the same numbering as Library elements and duplicate projects. */
export async function nextFreeName(
  name: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (!(await taken(name))) return name;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!(await taken(candidate))) return candidate;
  }
  return name;
}

// The folder of the last desktop save, so the next dialog opens there with a FREE name
// (a bare name let the dialog offer the same file twice). The app may
// only ask whether a file exists there (fs:allow-exists), never read it.
const LAST_DIR_KEY = 'dithtill:export-dir';

function lastExportDir(): string | null {
  try {
    return localStorage.getItem(LAST_DIR_KEY);
  } catch {
    return null;
  }
}

function rememberExportDir(path: string): void {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut <= 0) return;
  try {
    localStorage.setItem(LAST_DIR_KEY, path.slice(0, cut));
  } catch {
    // Storage blocked: the dialog just opens wherever the OS remembers.
  }
}

/** The dialog's default path: the last folder + the first free name in it. */
async function suggestedPath(name: string): Promise<string> {
  const dir = lastExportDir();
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  try {
    const free = await nextFreeName(name, (n) => exists(dir + sep + n));
    return dir + sep + free;
  } catch {
    return name; // the folder is gone or not checkable: fall back to the bare name
  }
}

/**
 * Save PNG bytes. In Tauri: prompt for a destination (the dialog auto-grants fs
 * scope to exactly the chosen path) and write it — returns the path, or null if
 * cancelled. In the browser: trigger a download — returns the file name.
 */
export async function savePngToDisk(
  bytes: Uint8Array,
  suggestedName = 'dithtill.png',
): Promise<string | null> {
  return saveBytesToDisk(bytes, suggestedName, 'image/png');
}

/** Save an SVG document (G7 vector export) — same dialog/download split. */
export async function saveSvgToDisk(
  svg: string,
  suggestedName = 'dithtill.svg',
): Promise<string | null> {
  return saveBytesToDisk(new TextEncoder().encode(svg), suggestedName, 'image/svg+xml');
}

/** Save arbitrary bytes (same Tauri-dialog / browser-download split as the PNG
 *  path). The save filter + browser blob type derive from `mime`/the name's
 *  extension, so video elements export under their real container. */
export async function saveBytesToDisk(
  bytes: Uint8Array,
  suggestedName: string,
  mime: string,
): Promise<string | null> {
  const ext = suggestedName.includes('.') ? suggestedName.split('.').pop()! : 'bin';
  if (isTauri()) {
    const path = await save({
      defaultPath: await suggestedPath(suggestedName),
      filters: [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }],
    });
    if (!path) return null; // cancelled
    await writeFile(path, bytes);
    rememberExportDir(path);
    return path;
  }

  // Browser fallback: download via an object URL.
  // Copy onto a plain ArrayBuffer so Blob's typing is satisfied (bytes may be
  // backed by ArrayBufferLike).
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}
