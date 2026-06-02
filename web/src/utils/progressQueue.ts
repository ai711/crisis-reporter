/**
 * Offline-safe progress sync queue for safety tips completion.
 *
 * When a reporter completes a module and is offline (or the POST fails),
 * the entry is written to localStorage under `cr_progress_queue`. On the
 * next `online` event the queue is flushed automatically.
 *
 * Anonymous reporters (no cr_reporter_id) are skipped — their progress is
 * session-only and there is no server record to update.
 */

import api from "../services/api";

const QUEUE_KEY = "cr_progress_queue";

interface QueueEntry {
  reporterId: string;
  partCompleted: string;
  completedAt: string;
}

function readQueue(): QueueEntry[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeQueue(entries: QueueEntry[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
  } catch { /* storage full — silently drop */ }
}

/**
 * Attempt to POST progress immediately. If the POST fails (offline or server
 * error), add the entry to the retry queue for later flushing.
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
    // POST failed — queue for retry when online
    const queue = readQueue();
    // Avoid duplicates: skip if an entry for the same reporter+part already exists
    const duplicate = queue.some(
      (e) => e.reporterId === reporterId && e.partCompleted === partCompleted
    );
    if (!duplicate) {
      queue.push({ reporterId, partCompleted, completedAt });
      writeQueue(queue);
    }
  }
}

/**
 * Flush all queued entries. Called on `window` `online` event.
 * Successfully sent entries are removed; failed ones remain for next flush.
 */
export async function flushProgressQueue(): Promise<void> {
  const queue = readQueue();
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
  writeQueue(remaining);
}
