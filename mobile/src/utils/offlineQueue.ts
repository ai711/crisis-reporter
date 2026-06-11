import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueuedReport, QueuedPhoto, ReportSubmitRequest } from "../types";
import { tokenStorage } from "../services/api";

const QUEUE_KEY = "cr_report_queue";

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
  return data ? JSON.parse(data) : [];
}

async function saveQueue(queue: QueuedReport[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function addToQueue(
  report: ReportSubmitRequest,
  photos: QueuedPhoto[]
): Promise<string> {
  const local_id = `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const queue = await getQueue();

  const queuedReport: QueuedReport = {
    local_id,
    report: { ...report, local_id },
    photos,
    status: "pending",
    retry_count: 0,
    created_at: new Date().toISOString(),
    last_attempt_at: null,
  };

  queue.push(queuedReport);
  await saveQueue(queue);
  await notifyQueueChange();
  return local_id;
}

export async function getQueueCount(): Promise<number> {
  const queue = await getQueue();
  return queue.filter((item) => item.status === "pending").length;
}

export async function updateItemStatus(
  local_id: string,
  status: QueuedReport["status"],
  retry_count?: number
): Promise<void> {
  const queue = await getQueue();
  const index = queue.findIndex((item) => item.local_id === local_id);
  if (index === -1) return;

  queue[index].status = status;
  queue[index].last_attempt_at = new Date().toISOString();
  if (retry_count !== undefined) {
    queue[index].retry_count = retry_count;
  }

  await saveQueue(queue);
}

export async function removeFromQueue(local_id: string): Promise<void> {
  const queue = await getQueue();
  const filtered = queue.filter((item) => item.local_id !== local_id);
  await saveQueue(filtered);
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

// ── Sync engine ───────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

let isSyncing = false;

export async function resetItemForRetry(local_id: string): Promise<void> {
  return updateItemStatus(local_id, "pending", 0);
}

// Called once at startup — any item still in "syncing" state means the app was
// killed mid-flight; it will never be retried unless explicitly reset to "pending".
export async function resetStuckItems(): Promise<void> {
  const queue = await getQueue();
  const hasStuck = queue.some((i) => i.status === "syncing");
  if (!hasStuck) return;

  const reset = queue.map((i) =>
    i.status === "syncing" ? { ...i, status: "pending" as const } : i
  );
  await saveQueue(reset);
  await notifyQueueChange();
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
    const queue = await getQueue();
    const pending = queue.filter(
      (item) => item.status === "pending" && item.retry_count < MAX_RETRIES
    );

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

        // Submit report — use the pre-refreshed token
        const reportResponse = await fetch(`${apiBaseUrl}/api/reports`, {
          method: "POST",
          headers,
          body: JSON.stringify(item.report),
        });

        if (!reportResponse.ok) {
          if (reportResponse.status === 401) throw new Error("auth_expired");
          throw new Error(`Failed: ${reportResponse.status}`);
        }

        const reportData = await reportResponse.json();
        const reportId = reportData.report_id;

        // Upload photos
        for (const photo of item.photos) {
          const formData = new FormData();
          formData.append("report_id", reportId);
          formData.append("display_order", String(photo.display_order));
          formData.append("file", {
            uri: photo.uri,
            name: photo.filename,
            type: photo.content_type,
          } as any);

          const photoHeaders: Record<string, string> = {};
          if (accessToken) {
            photoHeaders["Authorization"] = `Bearer ${accessToken}`;
          }

          const photoResponse = await fetch(`${apiBaseUrl}/api/photos`, {
            method: "POST",
            headers: photoHeaders,
            body: formData,
          });

          if (!photoResponse.ok && photoResponse.status === 401) {
            throw new Error("auth_expired");
          }
        }

        // Persist a local record before removing so anonymous users can
        // still see the report in My Reports history.
        await saveLocalSubmittedRecord(item, reportId);
        await removeFromQueue(item.local_id);
        await notifyQueueChange();
      } catch (syncErr) {
        const isAuthExpired =
          syncErr instanceof Error && syncErr.message === "auth_expired";
        const nextRetry = isAuthExpired ? item.retry_count : item.retry_count + 1;
        const nextStatus = (!isAuthExpired && nextRetry >= MAX_RETRIES) ? "failed" : "pending";
        await updateItemStatus(item.local_id, nextStatus, nextRetry);
        await notifyQueueChange();
        // Auth expired — no point trying other items; let app refresh the token
        if (isAuthExpired) break;
      }
    }
  } finally {
    isSyncing = false;
  }
}