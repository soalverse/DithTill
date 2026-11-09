// =============================================================================
// The library INBOX sweep (AI-3) — the app half of the AI↔app Library
// bridge. DESKTOP ONLY. `<appData>/library-inbox/` is a drop folder: anything
// (the MCP `save_to_library` tool, a friend's shared element) can place
// element-file JSONs there; on Library init the app parses + HASH-VERIFIES each
// file (core/element-file — a file that parses is safe by construction), puts
// its blobs + record into the active LibraryBackend, and moves the file to
// `library-inbox/ingested/`. Content-addressing makes the sweep idempotent:
// re-ingesting a file the library already holds just rewrites the same record.
// Bad files are SKIPPED in place (never deleted) and reported via the return.
// =============================================================================
import { mkdir, readDir, readFile, rename } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { parseAnyElementFile } from '../core/element-file';
import type { LibraryBackend } from '../core/library';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const LIBRARY_INBOX_DIR = 'library-inbox';
const INGESTED_SUBDIR = 'ingested';

export interface InboxSweepResult {
  /** Records ingested (files moved to ingested/). */
  ingested: number;
  /** Files that failed parse/verify — left in place, reasons for the console. */
  skipped: { file: string; reason: string }[];
}

/** Parse + verify one element file's text and put it into the backend (blobs
 *  first, then the record). Pure of the filesystem — vitest covers it directly;
 *  the sweep below is only the Tauri fs glue around it. */
export async function ingestElementJson(
  text: string,
  backend: LibraryBackend,
): Promise<{ id: string }> {
  const { record, blobs } = await parseAnyElementFile(text);
  for (const b of blobs) {
    if (!(await backend.hasBlob(b.hash))) await backend.putBlob(b.hash, b.bytes);
  }
  await backend.putRecord(record);
  return { id: record.id };
}

/**
 * Sweep the inbox into the given backend. Never throws for a bad FILE (skips
 * it); only for an unavailable filesystem. A no-op (0/none) outside Tauri.
 */
export async function sweepLibraryInbox(backend: LibraryBackend): Promise<InboxSweepResult> {
  const result: InboxSweepResult = { ingested: 0, skipped: [] };
  if (!isTauri()) {
    // Diagnostic: a plain-browser tab at the dev URL looks
    // identical to the app window but the sweep intentionally no-ops there — say so,
    // so a "silent nothing" is distinguishable from an empty inbox.
    console.info('library-inbox: not a Tauri window — sweep skipped');
    return result;
  }

  const inbox = await join(await appDataDir(), LIBRARY_INBOX_DIR);
  // Ensure the folder exists so tools (and people) always have a target.
  await mkdir(inbox, { recursive: true });
  const entries = await readDir(inbox);
  const files = entries
    .filter((e) => e.isFile && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name)
    .sort();
  // Always log what the sweep actually saw (an un-ingested
  // inbox produced NO signal at all — success, failure, and found-nothing must be
  // distinguishable from the console alone).
  console.info(
    `library-inbox: ${inbox} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
      `${files.length} element file(s)`,
  );
  if (files.length === 0) return result;

  await mkdir(await join(inbox, INGESTED_SUBDIR), { recursive: true });
  const decoder = new TextDecoder();
  for (const name of files) {
    const path = await join(inbox, name);
    try {
      await ingestElementJson(decoder.decode(await readFile(path)), backend);
      await rename(path, await join(inbox, INGESTED_SUBDIR, name));
      result.ingested++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.skipped.push({ file: name, reason });
      console.error(`library-inbox: skipped ${name}: ${reason}`);
    }
  }
  return result;
}
