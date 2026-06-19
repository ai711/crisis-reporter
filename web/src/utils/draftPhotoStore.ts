const DB_NAME = "crisis_reporter_draft";
const DB_VERSION = 1;
const STORE_NAME = "draft_photos";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "index" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface DraftPhotoEntry {
  index: number;
  blob: Blob;
  filename: string;
  type: string;
}

export async function saveDraftPhotos(photos: File[]): Promise<void> {
  if (!window.indexedDB) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (let i = 0; i < photos.length; i++) {
      const entry: DraftPhotoEntry = {
        index: i,
        blob: photos[i],
        filename: photos[i].name,
        type: photos[i].type,
      };
      store.put(entry);
    }
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* non-critical — draft photos simply won't restore */ }
}

export async function loadDraftPhotos(): Promise<File[]> {
  if (!window.indexedDB) return [];
  try {
    const db = await openDB();
    const entries = await new Promise<DraftPhotoEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as DraftPhotoEntry[]);
      req.onerror = () => reject(req.error);
    });
    return entries
      .sort((a, b) => a.index - b.index)
      .map((e) => new File([e.blob], e.filename, { type: e.type }));
  } catch {
    return [];
  }
}

export async function clearDraftPhotos(): Promise<void> {
  if (!window.indexedDB) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* non-critical */ }
}
