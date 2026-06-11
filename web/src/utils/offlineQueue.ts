import type { QueuedReport, QueuedPhoto, ReportSubmitRequest } from "../types";
import { generateUUID } from "./uuid";

const DB_NAME = "crisis_reporter";
const DB_VERSION = 1;
const STORE_NAME = "report_queue";

// ── IndexedDB setup ───────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "local_id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("created_at", "created_at", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── Queue operations ──────────────────────────────────────────────────────────

export async function addToQueue(
  report: ReportSubmitRequest,
  photos: QueuedPhoto[]
): Promise<string> {
  const db = await openDB();
  const local_id = `local_${generateUUID()}`;

  const queuedReport: QueuedReport = {
    local_id,
    report: { ...report, local_id },
    photos,
    status: "pending",
    retry_count: 0,
    created_at: new Date().toISOString(),
    last_attempt_at: null,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(queuedReport);
    request.onsuccess = () => resolve(local_id);
    request.onerror = () => reject(request.error);
  });
}

export async function getPendingItems(): Promise<QueuedReport[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("status");
    const request = index.getAll("pending");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function updateItemStatus(
  local_id: string,
  status: QueuedReport["status"],
  retry_count?: number
): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getRequest = store.get(local_id);

    getRequest.onsuccess = () => {
      const item = getRequest.result as QueuedReport;
      if (!item) return resolve();

      item.status = status;
      item.last_attempt_at = new Date().toISOString();
      if (retry_count !== undefined) {
        item.retry_count = retry_count;
      }

      const putRequest = store.put(item);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

export async function removeFromQueue(local_id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(local_id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getQueueCount(): Promise<number> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllQueueItems(): Promise<QueuedReport[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function resetItemForRetry(local_id: string): Promise<void> {
  return updateItemStatus(local_id, "pending", 0);
}

// ── Sync engine ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

let isSyncing = false;

export async function syncQueue(apiBaseUrl: string): Promise<void> {
  // Sync lock — prevents concurrent sync passes
  if (isSyncing) return;
  if (!navigator.onLine) return;

  isSyncing = true;

  try {
    const pending = await getPendingItems();

    for (const item of pending) {
      // Promote exhausted items to "failed" so the UI can surface them
      if (item.retry_count >= MAX_RETRIES) {
        await updateItemStatus(item.local_id, "failed", item.retry_count);
        continue;
      }

      await updateItemStatus(item.local_id, "syncing");

      try {
        // Submit report
        const accessToken = localStorage.getItem("cr_access_token");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        const reportResponse = await fetch(`${apiBaseUrl}/api/reports`, {
          method: "POST",
          headers,
          body: JSON.stringify(item.report),
        });

        if (!reportResponse.ok) {
          if (reportResponse.status === 401) throw new Error("auth_expired");
          throw new Error(`Report submission failed: ${reportResponse.status}`);
        }

        const reportData = await reportResponse.json();
        const reportId = reportData.report_id;

        // Upload photos
        for (const photo of item.photos) {
          const formData = new FormData();
          formData.append("report_id", reportId);
          formData.append("display_order", String(photo.display_order));
          formData.append(
            "file",
            new File([photo.blob], photo.filename, { type: photo.content_type })
          );

          const photoHeaders: Record<string, string> = {};
          if (accessToken) {
            photoHeaders["Authorization"] = `Bearer ${accessToken}`;
          }

          const photoResponse = await fetch(`${apiBaseUrl}/api/photos`, {
            method: "POST",
            headers: photoHeaders,
            body: formData,
          });

          if (!photoResponse.ok) {
            // 401 means our token expired — stop retrying this session, let the
            // next online event try again once the app has refreshed the token
            if (photoResponse.status === 401) {
              throw new Error("auth_expired");
            }
            throw new Error(`Photo upload failed: ${photoResponse.status}`);
          }
        }

        // Remove from queue on success
        await removeFromQueue(item.local_id);
      } catch (syncErr) {
        const isAuthExpired =
          syncErr instanceof Error && syncErr.message === "auth_expired";
        const nextRetry = isAuthExpired ? item.retry_count : item.retry_count + 1;
        const nextStatus = (!isAuthExpired && nextRetry >= MAX_RETRIES) ? "failed" : "pending";
        await updateItemStatus(
          item.local_id,
          nextStatus,
          // Don't burn a retry on auth expiry — the token just needs refreshing
          nextRetry
        );
        // Auth expired — no point trying other items this pass
        if (isAuthExpired) break;
      }
    }
  } finally {
    isSyncing = false;
  }
}

// ── IndexedDB availability check (M4 — Safari private mode guard) ────────────
//
// Safari private mode enforces a 0-byte IndexedDB quota.  Any write attempt
// throws a QuotaExceededError / NS_ERROR_DOM_INDEXEDDB_UNKNOWN_ERR.  We probe
// availability once before entering the offline-queue path so the caller can
// show a clear message instead of a generic "server error".

export async function isIndexedDBAvailable(): Promise<boolean> {
  if (!window.indexedDB) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.open("__cr_idb_probe__", 1);
      req.onsuccess = () => {
        req.result.close();
        // Clean up the probe database asynchronously
        try { indexedDB.deleteDatabase("__cr_idb_probe__"); } catch { /* ignore */ }
        resolve(true);
      };
      req.onerror = () => resolve(false);
      // Some browsers fire onblocked instead of onerror in private mode
      req.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

// ── Auto-sync triggers ────────────────────────────────────────────────────────

export function registerSyncTriggers(apiBaseUrl: string): void {
  // Sync when internet connection is restored
  window.addEventListener("online", () => {
    syncQueue(apiBaseUrl);
  });

  // Sync when app becomes visible again (iOS PWA support)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      syncQueue(apiBaseUrl);
    }
  });
}