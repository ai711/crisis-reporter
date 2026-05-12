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

  const cacheKey = `cr_language_package_${langCode}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${BASE_URL}/api/language-packages/active/${langCode}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: Record<string, unknown> = await res.json();

    i18n.addResourceBundle(langCode, "translation", data, true, true);
    await i18n.changeLanguage(langCode);

    try {
      localStorage.setItem(cacheKey, JSON.stringify(data));
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
      i18n.addResourceBundle(langCode, "translation", data, true, true);
      await i18n.changeLanguage(langCode);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export default i18n;
