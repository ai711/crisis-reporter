/**
 * Offline-safe progress sync queue for safety tips completion (mobile).
 *
 * When a reporter completes a module and is offline (or the POST fails),
 * the entry is written to AsyncStorage under `cr_progress_queue`. On the
 * next network-available attempt the queue is flushed automatically.
 *
 * Call flushProgressQueue() from the app's NetInfo handler or on startup.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import api from "../services/api";

const QUEUE_KEY = "cr_progress_queue";

interface QueueEntry {
  reporterId: string;
  partCompleted: string;
  completedAt: string;
}

async function readQueue(): Promise<QueueEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue(entries: QueueEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
  } catch { /* storage full — silently drop */ }
}

/**
 * Attempt to POST progress immediately. If the POST fails (offline or
 * server error), add the entry to the retry queue for later flushing.
 */
export async function enqueueProgress(
  reporterId: string,
  partCompleted: string
): Promise<void> {
  const completedAt = new Date().toISOString();
  try {
    await api.post(`/api/reporters/${reporterId}/safety-progress`, {
      part_completed: partCompleted,
      completed_at: completedAt,
    });
  } catch {
    // POST failed — queue for retry
    const queue = await readQueue();
    const duplicate = queue.some(
      (e) => e.reporterId === reporterId && e.partCompleted === partCompleted
    );
    if (!duplicate) {
      queue.push({ reporterId, partCompleted, completedAt });
      await writeQueue(queue);
    }
  }
}

/**
 * Flush all queued entries. Call on network reconnect or app startup.
 * Successfully sent entries are removed; failed ones remain for next flush.
 */
export async function flushProgressQueue(): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;

  const remaining: QueueEntry[] = [];
  for (const entry of queue) {
    try {
      await api.post(`/api/reporters/${entry.reporterId}/safety-progress`, {
        part_completed: entry.partCompleted,
        completed_at: entry.completedAt,
      });
    } catch {
      remaining.push(entry);
    }
  }
  await writeQueue(remaining);
}
