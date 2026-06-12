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

export async function getQueueItem(local_id: string): Promise<QueuedReport | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(local_id);
    request.onsuccess = () => resolve((request.result as QueuedReport) ?? null);
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

// Called once at startup — any item still in "syncing" state means the app was
// killed mid-flight; it will never be retried unless explicitly reset to "pending".
export async function resetStuckItems(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = request.result as QueuedReport[];
      const stuck = items.filter((i) => i.status === "syncing");
      let remaining = stuck.length;

      if (remaining === 0) return resolve();

      for (const item of stuck) {
        item.status = "pending";
        const put = store.put(item);
        put.onsuccess = () => { if (--remaining === 0) resolve(); };
        put.onerror = () => reject(put.error);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

// ── Sync engine ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

let isSyncing = false;

// Attempt a silent token refresh before the sync pass so that a 15-minute
// access-token expiry doesn't stall the entire queue.  Returns the fresh
// access token (or the existing one if still valid, or null for anonymous users).
async function refreshAccessTokenIfNeeded(apiBaseUrl: string): Promise<string | null> {
  const currentToken = localStorage.getItem("cr_access_token");
  const refreshToken  = localStorage.getItem("cr_refresh_token");

  if (!refreshToken) return currentToken; // Anonymous user — no token to refresh

  try {
    const refreshController = new AbortController();
    const refreshTimeoutId = setTimeout(() => refreshController.abort(), 20000);
    const res = await fetch(`${apiBaseUrl}/api/reporter/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: refreshController.signal,
    });
    clearTimeout(refreshTimeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        localStorage.setItem("cr_access_token", data.access_token);
        if (data.refresh_token) {
          localStorage.setItem("cr_refresh_token", data.refresh_token);
        }
        return data.access_token;
      }
    }
    // Refresh endpoint returned a non-200 (e.g. 401 = refresh token expired).
    // Fall back to the current access token — the per-item auth_expired handler
    // will surface the issue on first use.
    return currentToken;
  } catch {
    return currentToken; // Network error — carry on with existing token
  }
}

export async function syncQueue(apiBaseUrl: string): Promise<void> {
  // Sync lock — prevents concurrent sync passes
  if (isSyncing) return;
  if (!navigator.onLine) return;

  isSyncing = true;

  try {
    const pending = await getPendingItems();
    if (pending.length === 0) return;

    // Proactively refresh the access token once for the whole pass rather than
    // letting each item hit a 401 and burning time on per-item retries.
    const accessToken = await refreshAccessTokenIfNeeded(apiBaseUrl);

    for (const item of pending) {
      // Promote exhausted items to "failed" so the UI can surface them
      if (item.retry_count >= MAX_RETRIES) {
        await updateItemStatus(item.local_id, "failed", item.retry_count);
        continue;
      }

      await updateItemStatus(item.local_id, "syncing");

      try {
        // Submit report — use the pre-refreshed token for all items in this pass
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        const reportController = new AbortController();
        const reportTimeoutId = setTimeout(() => reportController.abort(), 20000);
        const reportResponse = await fetch(`${apiBaseUrl}/api/reports`, {
          method: "POST",
          headers,
          body: JSON.stringify(item.report),
          signal: reportController.signal,
        });
        clearTimeout(reportTimeoutId);

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

          const photoController = new AbortController();
          const photoTimeoutId = setTimeout(() => photoController.abort(), 120000);
          const photoResponse = await fetch(`${apiBaseUrl}/api/photos`, {
            method: "POST",
            headers: photoHeaders,
            body: formData,
            signal: photoController.signal,
          });
          clearTimeout(photoTimeoutId);

          if (!photoResponse.ok) {
            // 401 means our token expired — stop retrying this session, let the
            // next online event try again once the app has refreshed the token
            if (photoResponse.status === 401) {
              throw new Error("auth_expired");
            }
            throw new Error(`Photo upload failed: ${photoResponse.status}`);
          }
        }

        // Persist a local record so My Reports shows this report even when
        // the reporter is anonymous or the JWT has since expired.
        // Schema matches the shape written by the online ReportPage.tsx submit path.
        try {
          const stored: Array<Record<string, unknown>> = JSON.parse(
            localStorage.getItem("cr_local_reports") || "[]"
          );
          stored.push({
            id: reportId,
            damage_level: item.report.damage_level,
            gps_latitude: item.report.location?.gps_latitude ?? null,
            gps_longitude: item.report.location?.gps_longitude ?? null,
            location_address: item.report.location?.location_address ?? null,
            submitted_at: item.created_at,
            created_at: new Date().toISOString(),
          });
          if (stored.length > 100) stored.splice(0, stored.length - 100);
          localStorage.setItem("cr_local_reports", JSON.stringify(stored));
        } catch { /* non-critical */ }

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

let _syncTriggersRegistered = false;

export function registerSyncTriggers(apiBaseUrl: string): void {
  if (_syncTriggersRegistered) return;
  _syncTriggersRegistered = true;
  // Sync when internet connection is restored
  window.addEventListener("online", () => {
    syncQueue(apiBaseUrl);
    // Re-register the background sync tag so the SW picks it up too
    registerBackgroundSync();
  });

  // Sync when app becomes visible again (iOS PWA support)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      syncQueue(apiBaseUrl);
    }
  });

  // Proactive cold-start sync — if the browser is already online when this
  // function runs (page load / refresh), neither event above will fire because
  // there is no transition from an offline or hidden state. Trigger one pass now.
  if (navigator.onLine) {
    syncQueue(apiBaseUrl);
  }
}

// Register (or re-register) a Web Background Sync tag so the SW can trigger
// syncQueue even when the tab is backgrounded (but not fully closed).
// Browsers that don't support SyncManager (iOS Safari) silently skip this.
export async function registerBackgroundSync(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await (registration as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register("sync-reports");
  } catch {
    // Background sync not available or permission denied — the foreground
    // online/visibilitychange triggers still provide coverage.
  }
}