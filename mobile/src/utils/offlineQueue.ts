import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import { documentDirectory } from "expo-file-system/legacy";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import type { QueuedReport, QueuedPhoto, ReportSubmitRequest } from "../types";
import { tokenStorage } from "../services/api";
import { syncRegistrationQueue } from "../services/auth";

// Persistent photo storage — survives Android low-storage cache clears.
// documentDirectory must be imported from the legacy subpath because
// expo-file-system v19+ moved it out of the default namespace export.
const PHOTO_STORE_DIR: string | null = documentDirectory != null
  ? `${documentDirectory}cr_queued_photos/`
  : null;

async function ensurePhotoDir(): Promise<void> {
  if (PHOTO_STORE_DIR == null) throw new Error("documentDirectory unavailable");
  const info = await FileSystem.getInfoAsync(PHOTO_STORE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(PHOTO_STORE_DIR, { intermediates: true });
  }
}

const QUEUE_KEY = "cr_report_queue";

// ── Queue write mutex ─────────────────────────────────────────────────────────
// Serialises all queue reads+writes so concurrent callers (e.g. addToQueue
// called from the UI while syncQueue is mid-flight) never race on the
// AsyncStorage blob.

let _queueMutex: Promise<void> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _queueMutex.then(() => fn());
  // Absorb rejections on the chain so a failed op doesn't permanently poison
  // the mutex for future callers.
  _queueMutex = next.then(
    () => {},
    () => {}
  );
  return next;
}

// ── Queue change listeners ────────────────────────────────────────────────────

type QueueChangeListener = (count: number) => void;
const queueChangeListeners: QueueChangeListener[] = [];

export const onQueueChange = (listener: QueueChangeListener): (() => void) => {
  queueChangeListeners.push(listener);
  return () => {
    const index = queueChangeListeners.indexOf(listener);
    if (index > -1) queueChangeListeners.splice(index, 1);
  };
};

const notifyQueueChange = async () => {
  const count = await getQueueCount();
  queueChangeListeners.forEach((listener) => listener(count));
};

// ── Queue operations ──────────────────────────────────────────────────────────

export async function getQueue(): Promise<QueuedReport[]> {
  const data = await AsyncStorage.getItem(QUEUE_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveQueue(queue: QueuedReport[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function addToQueue(
  report: ReportSubmitRequest,
  photos: QueuedPhoto[]
): Promise<string> {
  const local_id = `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return withQueueLock(async () => {
    // Copy photos to documentDirectory before persisting the queue entry.
    // Android can clear the Expo cache directory under low-storage pressure;
    // documentDirectory is never cleared by the OS.
    let persistedPhotos = photos;
    try {
      await ensurePhotoDir();
      persistedPhotos = await Promise.all(
        photos.map(async (photo, i) => {
          const dest = `${PHOTO_STORE_DIR!}${local_id}_${i}.jpg`;
          try {
            await FileSystem.copyAsync({ from: photo.uri, to: dest });
            return { ...photo, persistent_uri: dest };
          } catch {
            return photo; // Fall back to original URI if copy fails
          }
        })
      );
    } catch {
      persistedPhotos = photos; // Fall back if directory creation fails
    }

    const queue = await getQueue();
    const queuedReport: QueuedReport = {
      local_id,
      report: { ...report, local_id },
      photos: persistedPhotos,
      status: "pending",
      retry_count: 0,
      created_at: new Date().toISOString(),
      last_attempt_at: null,
    };

    queue.push(queuedReport);
    await saveQueue(queue);
    await notifyQueueChange();
    return local_id;
  });
}

// Queues photo uploads only for a report that was already created on the server.
// Used when the report POST succeeded but photo uploads failed mid-submit —
// avoids re-submitting the report and creating a duplicate.
export async function queuePhotosForReport(reportId: string, photos: QueuedPhoto[]): Promise<void> {
  const local_id = `photo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await withQueueLock(async () => {
    let persistedPhotos = photos;
    try {
      await ensurePhotoDir();
      persistedPhotos = await Promise.all(
        photos.map(async (photo, i) => {
          const dest = `${PHOTO_STORE_DIR!}${local_id}_${i}.jpg`;
          try {
            await FileSystem.copyAsync({ from: photo.uri, to: dest });
            return { ...photo, persistent_uri: dest };
          } catch {
            return photo;
          }
        })
      );
    } catch {
      persistedPhotos = photos;
    }

    const queue = await getQueue();
    queue.push({
      local_id,
      report: {} as ReportSubmitRequest,
      photos: persistedPhotos,
      status: "pending",
      retry_count: 0,
      created_at: new Date().toISOString(),
      last_attempt_at: null,
      existing_report_id: reportId,
    });
    await saveQueue(queue);
    await notifyQueueChange();
  });
}

export async function getQueueCount(): Promise<number> {
  const queue = await getQueue();
  return queue.filter((item) => item.status === "pending").length;
}

export function updateItemStatus(
  local_id: string,
  status: QueuedReport["status"],
  retry_count?: number
): Promise<void> {
  return withQueueLock(async () => {
    const queue = await getQueue();
    const index = queue.findIndex((item) => item.local_id === local_id);
    if (index === -1) return;

    queue[index].status = status;
    queue[index].last_attempt_at = new Date().toISOString();
    if (retry_count !== undefined) {
      queue[index].retry_count = retry_count;
    }

    await saveQueue(queue);
  });
}

export function removeFromQueue(local_id: string): Promise<void> {
  return withQueueLock(async () => {
    const queue = await getQueue();
    const item = queue.find((i) => i.local_id === local_id);
    const filtered = queue.filter((i) => i.local_id !== local_id);
    await saveQueue(filtered);

    // Clean up persistent photo copies to free documentDirectory space
    if (item) {
      for (const photo of item.photos) {
        if (photo.persistent_uri) {
          try {
            await FileSystem.deleteAsync(photo.persistent_uri, { idempotent: true });
          } catch {
            // Non-critical — stale files are small and bounded
          }
        }
      }
    }
  });
}

// ── Local submitted-report history (anonymous fallback) ───────────────────────
// When a queued report is submitted successfully we save a lightweight record
// so anonymous users can still browse their report history in My Reports.

const ANON_SUBMITTED_KEY = "cr_anon_submitted_reports";

export interface LocalSubmittedRecord {
  id: string;
  damage_level: string | null;
  submitted_at: string;
  gps_latitude: number | null;
  gps_longitude: number | null;
  location_address: string | null;
  location_landmark: string | null;
  building_name: string | null;
  photo_count: number;
  first_photo_url: null;
  disaster_type: null;
  infrastructure_type: string | null;
  infrastructure_name: string | null;
}

export async function getLocalSubmittedReports(): Promise<LocalSubmittedRecord[]> {
  try {
    const data = await AsyncStorage.getItem(ANON_SUBMITTED_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

async function saveLocalSubmittedRecord(
  item: QueuedReport,
  reportId: string
): Promise<void> {
  try {
    const existing = await getLocalSubmittedReports();
    const record: LocalSubmittedRecord = {
      id: reportId,
      damage_level: item.report.damage_level,
      submitted_at: new Date().toISOString(),
      gps_latitude: item.report.location.gps_latitude,
      gps_longitude: item.report.location.gps_longitude,
      location_address: item.report.location.location_address,
      location_landmark: item.report.location.location_landmark,
      building_name: item.report.location.location_building_name,
      photo_count: item.photos.length,
      first_photo_url: null,
      disaster_type: null,
      infrastructure_type: item.report.infrastructure_types?.[0] ?? null,
      infrastructure_name: null,
    };
    // Prepend new record; keep max 50 to avoid storage bloat.
    const updated = [record, ...existing].slice(0, 50);
    await AsyncStorage.setItem(ANON_SUBMITTED_KEY, JSON.stringify(updated));
  } catch {
    // Non-critical — silent failure.
  }
}

export async function saveDirectSubmittedRecord(
  reportId: string,
  fields: {
    damage_level: string | null;
    gps_latitude: number | null;
    gps_longitude: number | null;
    location_address: string | null;
    location_landmark: string | null;
    building_name: string | null;
    photo_count: number;
    infrastructure_type: string | null;
  }
): Promise<void> {
  try {
    const existing = await getLocalSubmittedReports();
    const record: LocalSubmittedRecord = {
      id: reportId,
      damage_level: fields.damage_level,
      submitted_at: new Date().toISOString(),
      gps_latitude: fields.gps_latitude,
      gps_longitude: fields.gps_longitude,
      location_address: fields.location_address,
      location_landmark: fields.location_landmark,
      building_name: fields.building_name,
      photo_count: fields.photo_count,
      first_photo_url: null,
      disaster_type: null,
      infrastructure_type: fields.infrastructure_type,
      infrastructure_name: null,
    };
    const updated = [record, ...existing].slice(0, 50);
    await AsyncStorage.setItem(ANON_SUBMITTED_KEY, JSON.stringify(updated));
  } catch {
    // Non-critical — silent failure.
  }
}

// ── Notification helper ───────────────────────────────────────────────────────

async function showSyncNotification(title: string, body: string): Promise<void> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") return;
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: null,
    });
  } catch { /* non-critical */ }
}

// ── Sync engine ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

let isSyncing = false;

export async function resetItemForRetry(local_id: string): Promise<void> {
  return updateItemStatus(local_id, "pending", 0);
}

// Called once at startup — any item still in "syncing" state means the app was
// killed mid-flight; it will never be retried unless explicitly reset to "pending".
export function resetStuckItems(): Promise<void> {
  return withQueueLock(async () => {
    const queue = await getQueue();
    const hasStuck = queue.some((i) => i.status === "syncing");
    if (!hasStuck) return;

    const reset = queue.map((i) =>
      i.status === "syncing" ? { ...i, status: "pending" as const } : i
    );
    await saveQueue(reset);
    await notifyQueueChange();
  });
}

// Attempt a silent token refresh before the sync pass so that a 15-minute
// access-token expiry doesn't stall the entire queue with auth_expired failures.
async function refreshAccessTokenIfNeeded(apiBaseUrl: string): Promise<string | null> {
  const refreshToken = await tokenStorage.getRefreshToken();
  if (!refreshToken) return tokenStorage.getAccessToken(); // Anonymous — nothing to refresh

  try {
    const res = await fetch(`${apiBaseUrl}/api/reporter/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        const newRefresh = data.refresh_token ?? refreshToken;
        // setTokens requires reporterId — preserve the existing one
        const reporterId = (await tokenStorage.getReporterId()) ?? "";
        await tokenStorage.setTokens(data.access_token, newRefresh, reporterId);
        return data.access_token;
      }
    }
    // Non-200 (e.g. 401 = refresh token expired) — fall back to existing token
    return tokenStorage.getAccessToken();
  } catch {
    return tokenStorage.getAccessToken(); // Network error — carry on
  }
}

export async function syncQueue(apiBaseUrl: string): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    // Before syncing reports, resolve any pending anonymous registration.
    // CR-PENDING- IDs stored in queue items are not valid reporter identifiers —
    // the backend cannot resolve them and falls back to auto-creating a new
    // anonymous profile for each report, producing duplicate reporter IDs.
    const storedId = await SecureStore.getItemAsync("cr_reporter_id");
    if (storedId?.startsWith("CR-PENDING-")) {
      try { await syncRegistrationQueue(); } catch { /* still offline — carry on */ }
    }
    const resolvedReporterId = await SecureStore.getItemAsync("cr_reporter_id");
    const hasRealId = !!resolvedReporterId && !resolvedReporterId.startsWith("CR-PENDING-");

    // Read inside the lock so a concurrent addToQueue can't produce a torn snapshot.
    const pending = await withQueueLock(async () => {
      const queue = await getQueue();
      return queue.filter(
        (item) => item.status === "pending" && item.retry_count < MAX_RETRIES
      );
    });

    if (pending.length === 0) return;

    // Proactively refresh the access token once for the whole pass.
    const accessToken = await refreshAccessTokenIfNeeded(apiBaseUrl);

    for (const item of pending) {
      await updateItemStatus(item.local_id, "syncing");

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        // Submit report — skip if the report already exists on the server
        // (photo-only retry items carry existing_report_id to avoid duplicates).
        let reportId: string;
        if (item.existing_report_id) {
          reportId = item.existing_report_id;
        } else {
          // Inject the current real reporter_id, overriding any stale CR-PENDING-
          // value that was baked into the payload when the report was queued offline.
          const reportPayload = hasRealId
            ? { ...item.report, reporter_id: resolvedReporterId }
            : item.report;

          const reportResponse = await fetch(`${apiBaseUrl}/api/reports`, {
            method: "POST",
            headers,
            body: JSON.stringify(reportPayload),
          });

          if (!reportResponse.ok) {
            if (reportResponse.status === 401) throw new Error("auth_expired");
            throw new Error(`Failed: ${reportResponse.status}`);
          }

          const reportData = await reportResponse.json();
          reportId = reportData.report_id;

          // Report is now on the server. Save the local history record
          // immediately — even if photo uploads fail later, the reporter can
          // see their submitted report in My Reports.
          await saveLocalSubmittedRecord(item, reportId);

          // Convert this queue item to photo-only so future retries don't
          // re-POST the report and produce duplicates.
          await withQueueLock(async () => {
            const q = await getQueue();
            const idx = q.findIndex((i) => i.local_id === item.local_id);
            if (idx !== -1) q[idx].existing_report_id = reportId;
            await saveQueue(q);
          });
        }

        // Upload photos
        for (const photo of item.photos) {
          // Prefer persistent_uri (documentDirectory) over the original cache URI
          // which Android may have cleared under low-storage pressure.
          const uploadUri = photo.persistent_uri ?? photo.uri;

          // Pre-flight: skip if the file was lost.
          const fileInfo = await FileSystem.getInfoAsync(uploadUri);
          if (!fileInfo.exists) continue;

          const formData = new FormData();
          formData.append("report_id", reportId);
          formData.append("display_order", String(photo.display_order));
          formData.append("file", {
            uri: uploadUri,
            name: photo.filename,
            type: photo.content_type,
          } as any);

          const photoHeaders: Record<string, string> = {};
          if (accessToken) {
            photoHeaders["Authorization"] = `Bearer ${accessToken}`;
          }

          // 120 s per photo — generous for 2G/EDGE field networks
          const photoController = new AbortController();
          const photoTimeoutId = setTimeout(() => photoController.abort(), 120000);
          try {
            const photoResponse = await fetch(`${apiBaseUrl}/api/photos`, {
              method: "POST",
              headers: photoHeaders,
              body: formData,
              signal: photoController.signal,
            });
            clearTimeout(photoTimeoutId);
            if (!photoResponse.ok) {
              if (photoResponse.status === 401) throw new Error("auth_expired");
              // 5xx: transient server error — abort and retry the whole item.
              if (photoResponse.status >= 500) throw new Error(`photo_server_error:${photoResponse.status}`);
              // 4xx non-401: permanent client error (bad format, too large, etc.)
              // Log it and skip this photo — retrying won't help.
              console.warn(`[syncQueue] Photo upload skipped (HTTP ${photoResponse.status})`);
            }
          } catch (photoErr) {
            clearTimeout(photoTimeoutId);
            throw photoErr;
          }
        }

        await removeFromQueue(item.local_id);
        await notifyQueueChange();
        void showSyncNotification(
          "Report uploaded",
          "Your offline report has been successfully submitted."
        );
      } catch (syncErr) {
        const isAuthExpired =
          syncErr instanceof Error && syncErr.message === "auth_expired";
        const nextRetry = isAuthExpired ? item.retry_count : item.retry_count + 1;
        const nextStatus = (!isAuthExpired && nextRetry >= MAX_RETRIES) ? "failed" : "pending";
        await updateItemStatus(item.local_id, nextStatus, nextRetry);
        await notifyQueueChange();
        if (nextStatus === "failed") {
          void showSyncNotification(
            "Upload failed — tap to retry",
            "A report could not be uploaded after multiple attempts. Open the app to retry."
          );
        }
        // Auth expired — no point trying other items; let app refresh the token
        if (isAuthExpired) break;
      }
    }
  } finally {
    isSyncing = false;
  }
}