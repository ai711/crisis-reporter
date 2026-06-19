interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// ── Step 1: Web Session ID — must be the very first import. ──────────────────
// Importing this module runs initWebSessionId() synchronously before anything else.
import { WEB_SESSION_ID } from "./utils/sessionId";

// Ensure the ID is captured at module load time (the import side-effect is
// sufficient, but referencing it here keeps TypeScript from tree-shaking it).
void WEB_SESSION_ID;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadLanguagePackage, loadLanguagePackageFromCache } from "./i18n";
import App from "./App.tsx";
import "./index.css";
import { registerSyncTriggers, resetStuckItems, registerBackgroundSync } from "./utils/offlineQueue";
import { flushPendingAnonRegistration } from "./services/auth";
import { useAuthStore } from "./stores/authStore";
import { fetchAndCacheCountries } from "./utils/countryListCache";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// ── Startup sequence (async IIFE) ─────────────────────────────────────────────
(async () => {
  // ── D4: T&C declined flag — must clear state and restart from country step.
  try {
    if (sessionStorage.getItem("cr_tc_declined")) {
      sessionStorage.removeItem("cr_tc_declined");
      try {
        localStorage.removeItem("cr_country");
        localStorage.removeItem("cr_language");
      } catch { /* ignore */ }
      window.location.replace("/onboarding?step=country");
      return; // Do not mount React — redirect in progress.
    }
  } catch { /* sessionStorage unavailable — proceed normally */ }

  // ── B: Start country list fetch immediately (fire-and-forget).
  // The promise is memoised in countryListCache — OnboardingPage awaits it
  // without triggering a second network call.
  fetchAndCacheCountries();

  // ── C (startup): Restore returning user's language package.
  // Try cache first (instant); if empty fall back to a network fetch so the
  // language is always applied before React mounts.
  try {
    const savedLang = localStorage.getItem("cr_language");
    if (savedLang && savedLang !== "en") {
      const loaded = await loadLanguagePackageFromCache(savedLang);
      if (!loaded) {
        // No cache — fetch locale file + backend strings (locale file is static,
        // so this resolves in <100 ms in most cases).
        await loadLanguagePackage(savedLang);
      }
    }
  } catch { /* ignore */ }

  // ── Flush any pending anonymous registration queued while the reporter was
  // offline during onboarding. Must run before registerSyncTriggers so that
  // the reporter_id is stored before any queued reports attempt to sync.
  const _anonRegCallback = (reporterId: string) => {
    useAuthStore.getState().setReporter(reporterId, false);
  };
  await flushPendingAnonRegistration(_anonRegCallback).catch(() => { /* non-critical */ });

  // ── Reset any items stuck in "syncing" from a previous session that was killed
  // mid-flight. Must run before registerSyncTriggers so the sync pass picks them up.
  await resetStuckItems().catch(() => { /* non-critical */ });

  // ── Register offline sync triggers.
  registerSyncTriggers(API_URL);

  // ── Retry pending anonymous registration when connectivity is restored.
  // Registered after registerSyncTriggers so the reporter_id is set before
  // the report-sync pass that registerSyncTriggers schedules on the same event.
  window.addEventListener("online", () => {
    flushPendingAnonRegistration(_anonRegCallback).catch(() => { /* non-critical */ });
  });

  // ── Register the Web Background Sync tag (no-op on iOS Safari).
  // This allows the SW to trigger a sync pass while the tab is backgrounded.
  registerBackgroundSync().catch(() => { /* non-critical */ });

  // ── PWA install prompt — capture the browser's beforeinstallprompt event
  // so we can trigger it on demand from the side menu.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    (window as Window & { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt =
      e as BeforeInstallPromptEvent;
  });

  // ── Service worker update reload — when a new SW takes over, reload so
  // the page runs fresh JS (prevents stale-cache bugs like missing required
  // fields that cause 422 on report submission).
  if ("serviceWorker" in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloading) {
        reloading = true;
        window.location.reload();
      }
    });

    // ── Background sync message handler — the service worker posts TRIGGER_SYNC
    // when a background sync event fires while a window is open. We call the
    // full sync engine here (with access to localStorage tokens) rather than
    // trying to replicate it inside the SW context.
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "TRIGGER_SYNC") {
        import("./utils/offlineQueue").then(({ syncQueue }) => {
          syncQueue(API_URL);
        });
      }
    });
  }

  // ── Mount React.
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>
  );
})();

// Make WEB_SESSION_ID available on window for any non-module scripts (belt-and-suspenders).
(window as Window & { __crWebSessionId?: string }).__crWebSessionId =
  (window as Window & { __crWebSessionId?: string }).__crWebSessionId || WEB_SESSION_ID;

