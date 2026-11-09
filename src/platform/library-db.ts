// =============================================================================
// IndexedDB backend for the Library. The durable, on-device store:
// the library lives in the app's local database (browser OR Tauri webview),
// survives reloads, and is only ever cleared when the user deletes an element.
// Two object stores: `records` (small JSON, keyed by id) + `blobs` (the big
// pixel bytes, keyed by SHA-256 hash → automatic dedupe). The swappable
// LibraryBackend seam means a Tauri filesystem backend can replace this later
// (D11) with no caller change — same pattern as save-png.ts.
// =============================================================================
import { type AssetRecord, type LibraryBackend, MemoryBackend } from '../core/library';

const DB_NAME = 'dithtill-library';
const DB_VERSION = 1;
const BLOBS = 'blobs';
const RECORDS = 'records';

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

class IdbBackend implements LibraryBackend {
  private dbp: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(RECORDS))
          db.createObjectStore(RECORDS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  private async run<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  async loadAll(): Promise<AssetRecord[]> {
    return (await this.run<AssetRecord[]>(RECORDS, 'readonly', (s) => s.getAll())) ?? [];
  }
  async putRecord(rec: AssetRecord): Promise<void> {
    await this.run(RECORDS, 'readwrite', (s) => s.put(rec));
  }
  async deleteRecord(id: string): Promise<void> {
    await this.run(RECORDS, 'readwrite', (s) => s.delete(id));
  }
  async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    // Store a standalone copy so we never persist a view onto a larger buffer.
    await this.run(BLOBS, 'readwrite', (s) => s.put(bytes.slice(), hash));
  }
  async getBlob(hash: string): Promise<Uint8Array | undefined> {
    return this.run<Uint8Array | undefined>(BLOBS, 'readonly', (s) => s.get(hash));
  }
  async hasBlob(hash: string): Promise<boolean> {
    const key = await this.run<IDBValidKey | undefined>(BLOBS, 'readonly', (s) => s.getKey(hash));
    return key !== undefined;
  }
  async deleteBlob(hash: string): Promise<void> {
    await this.run(BLOBS, 'readwrite', (s) => s.delete(hash));
  }
}

/** The live backend: IndexedDB when available (the durable on-device store), else
 *  an in-memory fallback (e.g. a stripped runtime) so the app never crashes. */
export function createLibraryBackend(): LibraryBackend {
  if (hasIndexedDB()) {
    try {
      return new IdbBackend();
    } catch {
      /* fall through to memory */
    }
  }
  return new MemoryBackend();
}

/** Ask the browser to mark storage persistent so the library is never evicted
 *  under storage pressure ("nothing erased unless the user erases it"). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore — best effort */
  }
  return false;
}
