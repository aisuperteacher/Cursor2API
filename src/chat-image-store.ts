/**
 * IndexedDB backing store for chat attachment images.
 *
 * localStorage holds only lightweight session/text state plus image metadata;
 * the bulky base64 payloads live here so a few attached images can no longer
 * blow the ~5MB localStorage quota and silently drop history. Every operation
 * degrades to a no-op when IndexedDB is unavailable (private mode, old
 * browsers) - the chat then behaves as before, images kept in memory only.
 */

const DB_NAME = "cursor-chat";
const DB_VERSION = 1;
const STORE = "images";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ||= new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Persist base64 payloads; resolves false when the store is unavailable. */
export async function storeChatImages(images: Array<{ id: string; dataUrl: string }>): Promise<boolean> {
  if (!images.length) return true;
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      for (const image of images) tx.objectStore(STORE).put({ id: image.id, dataUrl: image.dataUrl });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Fetch payloads by id; missing ids are simply absent from the result. */
export async function loadChatImages(ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!ids.length) return result;
  const db = await openDb();
  if (!db) return result;
  try {
    const records = await new Promise<Array<{ id: string; dataUrl: string }>>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const found: Array<{ id: string; dataUrl: string }> = [];
      let pending = ids.length;
      if (!pending) { resolve(found); return; }
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          const value = request.result as { id?: unknown; dataUrl?: unknown } | undefined;
          if (value && typeof value.id === "string" && typeof value.dataUrl === "string") {
            found.push({ id: value.id, dataUrl: value.dataUrl });
          }
          pending -= 1;
          if (!pending) resolve(found);
        };
        request.onerror = () => {
          pending -= 1;
          if (!pending) resolve(found);
        };
      }
    });
    for (const record of records) result.set(record.id, record.dataUrl);
  } catch {
    /* unreadable store: return whatever was found */
  }
  return result;
}

/** Best-effort cleanup when sessions are deleted. */
export async function deleteChatImages(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* cleanup is best-effort */
  }
}
