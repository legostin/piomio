// This device's copy of what the hub showed last (IndexedDB, per hub origin): the dialogs' latest messages, the team,
// the group chats and the pictures' previews. The page draws from it at once and the hub's answer replaces it, so a
// chat opens instantly and still shows something offline. Nothing here is the truth: any of it may go at any time
// (clearCache, the browser freeing space, a private window without IndexedDB), and every call works without it.

const DB = "piomio-cache";
const VERSION = 1;
/** JSON values by key ("team", "messages:<conversation id>"). */
const DATA = "data";
/** Pictures by the address the page loads them from. */
const MEDIA = "media";

export interface CachedMedia {
  url: string;
  blob: Blob;
  etag?: string;
  size: number;
  /** When it was last shown (ms): the oldest go first when the store grows too big. */
  at: number;
}

// A scripted demo owns a fresh world on each load, even on the same origin.
let persistent = true;
export function disablePersistentCache(): void {
  persistent = false;
}

let opening: Promise<IDBDatabase | undefined> | undefined;

function open(): Promise<IDBDatabase | undefined> {
  if (!persistent) return Promise.resolve(undefined);
  opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") return resolve(undefined);
      req = indexedDB.open(DB, VERSION);
    } catch {
      return resolve(undefined);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA, { keyPath: "url" }).createIndex("at", "at");
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another page deletes the database (clearCache there): this one lets go and opens it again next time.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
    req.onerror = () => resolve(undefined);
    req.onblocked = () => resolve(undefined);
  });
  return opening;
}

/** One request in its own transaction; undefined when there is no database or the request fails. */
async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await run<T>(DATA, "readonly", (s) => s.get(key))) ?? undefined;
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  await run(DATA, "readwrite", (s) => s.put(value, key));
}

export async function cacheDelete(key: string): Promise<void> {
  await run(DATA, "readwrite", (s) => s.delete(key));
}

export async function mediaGet(url: string): Promise<CachedMedia | undefined> {
  return (await run<CachedMedia>(MEDIA, "readonly", (s) => s.get(url))) ?? undefined;
}

/** Pictures kept at most (bytes); past it the least recently shown go. */
export const MEDIA_LIMIT = 200 * 1024 * 1024;
let putsSincePrune = 0;

export async function mediaPut(entry: CachedMedia): Promise<void> {
  await run(MEDIA, "readwrite", (s) => s.put(entry));
  if (++putsSincePrune >= 40) {
    putsSincePrune = 0;
    void pruneMedia();
  }
}

/** The picture was shown again: it moves to the back of the line to go. */
export async function mediaTouch(entry: CachedMedia): Promise<void> {
  if (Date.now() - entry.at < 3600_000) return;
  await run(MEDIA, "readwrite", (s) => s.put({ ...entry, at: Date.now() }));
}

/** Newest first, keep pictures up to `limit` bytes, delete the rest. */
export async function pruneMedia(limit = MEDIA_LIMIT): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(MEDIA, "readwrite");
      let total = 0;
      const req = tx.objectStore(MEDIA).index("at").openCursor(null, "prev");
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        total += (c.value as CachedMedia).size;
        if (total > limit) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

const cleared = new Set<() => void>();

/** Called after clearCache, here and in the page's own copies (lib/media-cache.ts drops its picture URLs). */
export function onCacheCleared(cb: () => void): () => void {
  cleared.add(cb);
  return () => cleared.delete(cb);
}

/** Everything this device kept: the next page load fetches it all from the hub again. */
export async function clearCache(): Promise<void> {
  const db = await open();
  if (db) {
    await Promise.all(
      [DATA, MEDIA].map(
        (store) =>
          new Promise<void>((resolve) => {
            try {
              const tx = db.transaction(store, "readwrite");
              tx.objectStore(store).clear();
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
              tx.onabort = () => resolve();
            } catch {
              resolve();
            }
          }),
      ),
    );
  }
  for (const cb of [...cleared]) cb();
}
