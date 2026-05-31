import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";

// English is the only build-time bundle. All other languages are fetched on-demand.
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const FETCH_TIMEOUT_MS = 10_000;

export interface LangPackageResult {
  success: boolean;
  fromCache: boolean;
}

/**
 * Loads a language package by fetching from the backend.
 * Falls back to the localStorage-cached copy if the fetch fails.
 * On success, caches the raw JSON in localStorage and notifies the service worker.
 */
export async function loadLanguagePackage(langCode: string): Promise<LangPackageResult> {
  if (langCode === "en") {
    await i18n.changeLanguage("en");
    return { success: true, fromCache: false };
  }

  // Step 1: Load UI translations from bundled locale file
  try {
    const localeRes = await fetch(`/locales/${langCode}.json`);
    if (localeRes.ok) {
      const localeData = await localeRes.json();
      i18n.addResourceBundle(langCode, "translation", localeData, true, true);
      try { localStorage.setItem(`cr_locale_${langCode}`, JSON.stringify(localeData)); } catch { /* ignore */ }
    }
  } catch {
    console.warn("[i18n] Could not load locale file for", langCode);
  }

  // Step 2: Load question/content strings from backend and merge
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
          i18n.addResourceBundle(langCode, "translation", cachedData, true, true);
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

    i18n.addResourceBundle(langCode, "translation", data, true, true);
    // Step 3: Apply the language
    await i18n.changeLanguage(langCode);

    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
      localStorage.setItem(versionKey, (data.version as string) || '');
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
    // Locale file loaded successfully even though backend failed
    if (i18n.hasResourceBundle(langCode, "translation")) {
      await i18n.changeLanguage(langCode);
      return { success: true, fromCache: false };
    }
    return { success: false, fromCache: false };
  }
}

/**
 * Loads a language package from localStorage only — no network call.
 * Used at startup to restore a returning user's language instantly.
 */
export async function loadLanguagePackageFromCache(langCode: string): Promise<boolean> {
  if (langCode === "en") {
    await i18n.changeLanguage("en");
    return true;
  }
  try {
    let hasData = false;

    // Restore locale UI strings first (cached by loadLanguagePackage)
    const cachedLocale = localStorage.getItem(`cr_locale_${langCode}`);
    if (cachedLocale) {
      const localeData: Record<string, unknown> = JSON.parse(cachedLocale);
      i18n.addResourceBundle(langCode, "translation", localeData, true, false);
      hasData = true;
    }

    // Restore backend question strings on top
    const cached = localStorage.getItem(`cr_language_package_${langCode}`);
    if (cached) {
      const data: Record<string, unknown> = JSON.parse(cached);
      i18n.addResourceBundle(langCode, "translation", data, true, true);
      hasData = true;
    }

    if (hasData) {
      await i18n.changeLanguage(langCode);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export default i18n;
