import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import type { QueuedReport, QueuedPhoto, ReportSubmitRequest } from "../types";

const QUEUE_KEY = "cr_report_queue";

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

// ── Sync engine ───────────────────────────────────────────────────────────────

let isSyncing = false;

export async function syncQueue(apiBaseUrl: string): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const queue = await getQueue();
    const pending = queue.filter(
      (item) => item.status === "pending" && item.retry_count < 5
    );

    for (const item of pending) {
      await updateItemStatus(item.local_id, "syncing");

      try {
        const accessToken = await AsyncStorage.getItem("cr_access_token");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (accessToken) {
          headers["Authorization"] = `Bearer ${accessToken}`;
        }

        // Submit report
        const reportResponse = await fetch(`${apiBaseUrl}/api/reports`, {
          method: "POST",
          headers,
          body: JSON.stringify(item.report),
        });

        if (!reportResponse.ok) {
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

          await fetch(`${apiBaseUrl}/api/photos`, {
            method: "POST",
            headers: photoHeaders,
            body: formData,
          });
        }

        await removeFromQueue(item.local_id);
      } catch {
        await updateItemStatus(
          item.local_id,
          "pending",
          item.retry_count + 1
        );
      }
    }
  } finally {
    isSyncing = false;
  }
}