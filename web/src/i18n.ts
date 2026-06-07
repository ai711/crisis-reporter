import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";

// English is the only build-time bundle.
// All other languages are fetched exclusively from the backend string translation pipeline.
// Hardcoded locale files are NOT used — the pipeline is the single source of truth for all
// non-English text. Missing keys fall back to English via fallbackLng.
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

/**
 * Converts a flat key→value dict from the backend into the nested object
 * structure that i18next expects when keys are dot-separated paths.
 *
 * Two key formats coexist in the backend pipeline:
 *   - dotted  e.g. "home.reportButton"  → nested into { home: { reportButton: … } }
 *   - UPPERCASE e.g. "SAFETY_DO"        → kept as top-level (SafetyTipsPage uses these)
 *
 * Without this step, i18next resolves t("home.reportButton") by traversing
 * the nested path — but the bundle only has a literal "home.reportButton" key,
 * so lookup fails and falls back to English.
 */
function unflattenStrings(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (!k.includes(".")) {
      // No dot → UPPERCASE_SNAKE key (SAFETY_DO, COMMON_NEXT…) — keep top-level
      out[k] = v;
    } else {
      const parts = k.split(".");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cur = out as Record<string, any>;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) {
          cur[parts[i]] = {};
        }
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = v;
    }
  }
  return out;
}
const FETCH_TIMEOUT_MS = 10_000;

export interface LangPackageResult {
  success: boolean;
  fromCache: boolean;
}

/**
 * Loads a language package from the backend string translation pipeline.
 * Falls back to the localStorage-cached copy if the fetch fails.
 * On success, caches the raw JSON in localStorage and notifies the service worker.
 *
 * Non-English translations come exclusively from the backend pipeline — there are no
 * bundled locale files for non-English languages. Translators publish strings through
 * the backend dashboard and reporters receive them here.
 */
export async function loadLanguagePackage(langCode: string): Promise<LangPackageResult> {
  if (langCode === "en") {
    await i18n.changeLanguage("en");
    return { success: true, fromCache: false };
  }

  const cacheKey = `cr_language_package_${langCode}`;
  const versionKey = `cr_lang_version_${langCode}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // Check cached version first — skip full download if already up to date
  try {
    const versionRes = await fetch(
      `${BASE_URL}/api/language-packages/${langCode}/version`,
      { signal: controller.signal }
    );
    if (versionRes.ok) {
      const versionData = await versionRes.json();
      const latestVersion = versionData.version;
      const cachedVersion = localStorage.getItem(versionKey);

      if (latestVersion && latestVersion === cachedVersion) {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          clearTimeout(timer);
          const cachedData = JSON.parse(cached);
          i18n.addResourceBundle(langCode, "translation", unflattenStrings(cachedData), true, true);
          await i18n.changeLanguage(langCode);
          return { success: true, fromCache: true };
        }
      }
    }
  } catch {
    // Version check failed — proceed with full download
  }

  try {
    const res = await fetch(
      `${BASE_URL}/api/language-packages/active/${langCode}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: Record<string, unknown> = await res.json();

    // Extract the flat strings dict (backend wraps it in { version, language_code, strings })
    const strings = (data.strings as Record<string, unknown>) ?? data;
    // Unflatten dotted keys (home.reportButton → nested) before registering so
    // i18next path-based lookups resolve correctly. UPPERCASE keys pass through.
    i18n.addResourceBundle(langCode, "translation", unflattenStrings(strings), true, true);
    await i18n.changeLanguage(langCode);

    try {
      localStorage.setItem(cacheKey, JSON.stringify(strings));
      localStorage.setItem(versionKey, (data.version as string) || "");
    } catch { /* ignore */ }

    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "CACHE_LANGUAGE_PACKAGE",
          langCode,
        });
      }
    } catch { /* ignore */ }

    return { success: true, fromCache: false };
  } catch {
    clearTimeout(timer);
    const loaded = await loadLanguagePackageFromCache(langCode);
    if (loaded) return { success: true, fromCache: true };
    return { success: false, fromCache: false };
  }
}

/**
 * Loads a language package from localStorage only — no network call.
 * Used at startup to restore a returning user's language instantly.
 * Restores only the backend pipeline cache (`cr_language_package_*`).
 */
export async function loadLanguagePackageFromCache(langCode: string): Promise<boolean> {
  if (langCode === "en") {
    await i18n.changeLanguage("en");
    return true;
  }
  try {
    const cached = localStorage.getItem(`cr_language_package_${langCode}`);
    if (cached) {
      const data: Record<string, unknown> = JSON.parse(cached);
      i18n.addResourceBundle(langCode, "translation", unflattenStrings(data), true, true);
      await i18n.changeLanguage(langCode);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export default i18n;
