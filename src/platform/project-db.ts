// =============================================================================
// Project storage. Projects live INSIDE the app on this device — the
// browser's / webview's IndexedDB, the same on desktop and web, no server. One
// database, three stores:
//   projects  — { id, name, createdAt, updatedAt, thumbnail, doc } (the latest save)
//   versions  — earlier saves per project, newest RECOVERY_VERSIONS kept (recovery
//               only: if a project won't open, the newest good version is offered)
//   blobs     — media by SHA-256 hash (+ blobSizes: hash → bytes, for "Using N MB")
// Every save is ONE readwrite transaction (record + version + missing blobs + prune),
// so a crash or a closed tab leaves the previous save or the new one — never a mix
// (IndexedDB's atomic transactions play FilmCraft's temp-file-and-rename role).
// A MemoryProjectStore mirrors the contract for tests.
// =============================================================================
import { projectBlobHashes, type ProjectDoc } from '../core/project-format';

/** Earlier saves kept per project, for recovery. */
export const RECOVERY_VERSIONS = 10;

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** A small PNG data URL of the canvas. */
  thumbnail: string;
  /** Bytes of media this project uses (media shared with other projects counts in each). */
  bytes?: number;
}

export interface ProjectRecord extends ProjectMeta {
  doc: ProjectDoc;
}

export interface ProjectVersion {
  projectId: string;
  savedAt: number;
  doc: ProjectDoc;
}

export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectRecord | undefined>;
  /** Newest first. */
  versions(id: string): Promise<ProjectVersion[]>;
  /** Save the latest state atomically (blobs: every hash the doc names that may be new). */
  save(rec: ProjectRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Delete a project, its versions, and any media no project references any more. */
  delete(id: string): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | undefined>;
  /** Total bytes of stored project media. */
  bytesUsed(): Promise<number>;
}

const metaOf = (r: ProjectRecord): ProjectMeta => ({
  id: r.id,
  name: r.name,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  thumbnail: r.thumbnail,
  ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
});

/** The hashes every remaining project (latest + versions) still uses. */
function referenced(recs: ProjectRecord[], vers: ProjectVersion[]): Set<string> {
  const keep = new Set<string>();
  for (const r of recs) for (const h of projectBlobHashes(r.doc.project)) keep.add(h);
  for (const v of vers) for (const h of projectBlobHashes(v.doc.project)) keep.add(h);
  return keep;
}

export class MemoryProjectStore implements ProjectStore {
  private recs = new Map<string, ProjectRecord>();
  private vers: ProjectVersion[] = [];
  private blobs = new Map<string, Uint8Array>();

  async list(): Promise<ProjectMeta[]> {
    return [...this.recs.values()].map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<ProjectRecord | undefined> {
    return this.recs.get(id);
  }
  async versions(id: string): Promise<ProjectVersion[]> {
    return this.vers.filter((v) => v.projectId === id).sort((a, b) => b.savedAt - a.savedAt);
  }
  async save(rec: ProjectRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const h of projectBlobHashes(rec.doc.project)) {
      if (this.blobs.has(h)) continue;
      const b = blobs.get(h);
      if (!b) throw new Error(`missing media ${h.slice(0, 12)}`);
      this.blobs.set(h, b.slice());
    }
    const prev = this.recs.get(rec.id);
    if (prev) this.vers.push({ projectId: rec.id, savedAt: prev.updatedAt, doc: prev.doc });
    this.recs.set(rec.id, rec);
    const mine = await this.versions(rec.id);
    const drop = new Set(mine.slice(RECOVERY_VERSIONS));
    this.vers = this.vers.filter((v) => !drop.has(v));
    if (drop.size > 0) {
      // A pruned version may have been the last user of some media.
      const keep = referenced([...this.recs.values()], this.vers);
      for (const h of [...this.blobs.keys()]) if (!keep.has(h)) this.blobs.delete(h);
    }
  }
  async rename(id: string, name: string): Promise<void> {
    const r = this.recs.get(id);
    if (r) this.recs.set(id, { ...r, name });
  }
  async delete(id: string): Promise<void> {
    this.recs.delete(id);
    this.vers = this.vers.filter((v) => v.projectId !== id);
    const keep = referenced([...this.recs.values()], this.vers);
    for (const h of [...this.blobs.keys()]) if (!keep.has(h)) this.blobs.delete(h);
  }
  async getBlob(hash: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(hash);
  }
  async bytesUsed(): Promise<number> {
    let n = 0;
    for (const b of this.blobs.values()) n += b.byteLength;
    return n;
  }
}

const DB_NAME = 'dithtill-projects';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const VERSIONS = 'versions';
const BLOBS = 'blobs';
const SIZES = 'blobSizes';

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('save aborted'));
  });

/** Version keys sort by project then time: `${id}|${zero-padded savedAt}`. */
const versionKey = (id: string, at: number): string => `${id}|${String(at).padStart(16, '0')}`;

class IdbProjectStore implements ProjectStore {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(PROJECTS))
          db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(VERSIONS)) db.createObjectStore(VERSIONS);
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(SIZES)) db.createObjectStore(SIZES);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbp;
  }

  async list(): Promise<ProjectMeta[]> {
    const db = await this.db();
    const all = await req(
      db.transaction(PROJECTS).objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>,
    );
    return all.map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    const db = await this.db();
    return req(
      db.transaction(PROJECTS).objectStore(PROJECTS).get(id) as IDBRequest<
        ProjectRecord | undefined
      >,
    );
  }

  async versions(id: string): Promise<ProjectVersion[]> {
    const db = await this.db();
    const range = IDBKeyRange.bound(`${id}|`, `${id}|\uffff`);
    const all = await req(
      db.transaction(VERSIONS).objectStore(VERSIONS).getAll(range) as IDBRequest<ProjectVersion[]>,
    );
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  async save(rec: ProjectRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([PROJECTS, VERSIONS, BLOBS, SIZES], 'readwrite');
    const finished = done(tx);
    const projects = tx.objectStore(PROJECTS);
    const versions = tx.objectStore(VERSIONS);
    const blobStore = tx.objectStore(BLOBS);
    const sizes = tx.objectStore(SIZES);
    try {
      for (const h of projectBlobHashes(rec.doc.project)) {
        const has = await req(sizes.getKey(h));
        if (has !== undefined) continue;
        const b = blobs.get(h);
        if (!b) throw new Error(`missing media ${h.slice(0, 12)}`);
        blobStore.put(b.slice(), h);
        sizes.put(b.byteLength, h);
      }
      const prev = (await req(projects.get(rec.id))) as ProjectRecord | undefined;
      if (prev)
        versions.put(
          { projectId: rec.id, savedAt: prev.updatedAt, doc: prev.doc } satisfies ProjectVersion,
          versionKey(rec.id, prev.updatedAt),
        );
      projects.put(rec);
      const range = IDBKeyRange.bound(`${rec.id}|`, `${rec.id}|\uffff`);
      const keys = (await req(versions.getAllKeys(range))) as string[];
      // Keys sort oldest → newest; drop all but the newest RECOVERY_VERSIONS.
      const pruned = keys.slice(0, Math.max(0, keys.length - RECOVERY_VERSIONS));
      for (const k of pruned) versions.delete(k);
      if (pruned.length > 0) {
        // A pruned version may have been the last user of some media — sweep it in the
        // SAME transaction (reads here already see this save's writes and deletes).
        const recs = (await req(projects.getAll())) as ProjectRecord[];
        const vers = (await req(versions.getAll())) as ProjectVersion[];
        const keep = referenced(recs, vers);
        for (const h of (await req(sizes.getAllKeys())) as string[]) {
          if (keep.has(h)) continue;
          sizes.delete(h);
          blobStore.delete(h);
        }
      }
    } catch (e) {
      tx.abort();
      await finished.catch(() => {});
      throw e;
    }
    await finished;
  }

  async rename(id: string, name: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(PROJECTS, 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore(PROJECTS);
    const r = (await req(store.get(id))) as ProjectRecord | undefined;
    if (r) store.put({ ...r, name });
    await finished;
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([PROJECTS, VERSIONS, BLOBS, SIZES], 'readwrite');
    const finished = done(tx);
    const projects = tx.objectStore(PROJECTS);
    const versions = tx.objectStore(VERSIONS);
    projects.delete(id);
    versions.delete(IDBKeyRange.bound(`${id}|`, `${id}|\uffff`));
    const recs = ((await req(projects.getAll())) as ProjectRecord[]).filter((r) => r.id !== id);
    const vers = ((await req(versions.getAll())) as ProjectVersion[]).filter(
      (v) => v.projectId !== id,
    );
    const keep = referenced(recs, vers);
    const sizes = tx.objectStore(SIZES);
    const blobStore = tx.objectStore(BLOBS);
    for (const h of (await req(sizes.getAllKeys())) as string[]) {
      if (keep.has(h)) continue;
      sizes.delete(h);
      blobStore.delete(h);
    }
    await finished;
  }

  async getBlob(hash: string): Promise<Uint8Array | undefined> {
    const db = await this.db();
    return req(
      db.transaction(BLOBS).objectStore(BLOBS).get(hash) as IDBRequest<Uint8Array | undefined>,
    );
  }

  async bytesUsed(): Promise<number> {
    const db = await this.db();
    const all = (await req(db.transaction(SIZES).objectStore(SIZES).getAll())) as number[];
    return all.reduce((a, b) => a + b, 0);
  }
}

let store: ProjectStore | null = null;

/** The live store: IndexedDB when available, else in memory (projects then last
 *  only for the session — a stripped runtime never crashes). */
export function projectStore(): ProjectStore {
  if (store) return store;
  try {
    store = typeof indexedDB !== 'undefined' ? new IdbProjectStore() : new MemoryProjectStore();
  } catch {
    store = new MemoryProjectStore();
  }
  return store;
}

/** Tests: swap the live store. */
export function _setProjectStoreForTest(s: ProjectStore | null): void {
  store = s;
}
