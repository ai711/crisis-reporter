// ── Step 1: Web Session ID — must be the very first import. ──────────────────
// Importing this module runs initWebSessionId() synchronously before anything else.
import { WEB_SESSION_ID } from "./utils/sessionId";

// Ensure the ID is captured at module load time (the import side-effect is
// sufficient, but referencing it here keeps TypeScript from tree-shaking it).
void WEB_SESSION_ID;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n, { loadLanguagePackageFromCache } from "./i18n";
import App from "./App.tsx";
import "./index.css";
import { registerSyncTriggers } from "./utils/offlineQueue";
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

  // ── C (startup): Restore returning user's language package from cache.
  // This is synchronous-equivalent (reads localStorage, no network).
  try {
    const savedLang = localStorage.getItem("cr_language");
    if (savedLang && savedLang !== "en") {
      await loadLanguagePackageFromCache(savedLang);
      // If no cache exists for this language the app stays on EN — acceptable.
    }
  } catch { /* ignore */ }

  // ── Register offline sync triggers.
  registerSyncTriggers(API_URL);

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

// Re-export so other modules can import directly from main if needed.
export { WEB_SESSION_ID };
export { i18n };
