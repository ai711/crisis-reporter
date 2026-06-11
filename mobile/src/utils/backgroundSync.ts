// ── Android Background Sync ───────────────────────────────────────────────────
//
// Uses expo-background-fetch + expo-task-manager to call syncQueue() on a
// periodic schedule (minimum 15 minutes — OS-enforced floor) so that offline
// reports upload even when the app is fully killed or backgrounded.
//
// IMPORTANT: TaskManager.defineTask() must be called in the module scope (not
// inside a React component or effect) so it is registered before the JS runtime
// tries to run the task. This file must be imported early in App.tsx.

import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import { syncQueue, resetStuckItems } from "./offlineQueue";
import { API_BASE } from "../services/api";

export const BACKGROUND_SYNC_TASK = "crisis-reporter-background-sync";

// Define the task — must run at module scope, before any `registerAsync` call.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // Reset any items stuck in "syncing" from a prior interrupted session.
    await resetStuckItems();
    await syncQueue(API_BASE);
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// Call once at app startup to register (or re-register) the background task.
// Safe to call multiple times — expo-background-fetch is idempotent.
export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      // Background fetch is disabled in device settings — nothing we can do.
      return;
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: 15 * 60, // 15 minutes (OS minimum)
        stopOnTerminate: false,   // Continue running after the app is killed
        startOnBoot: true,        // Resume after device reboot
      });
    }
  } catch {
    // Background fetch unavailable (e.g. Expo Go, certain emulators) — silent.
  }
}
