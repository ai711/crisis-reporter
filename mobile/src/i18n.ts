import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";

import en from "./locales/en.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";
import fr from "./locales/fr.json";
import ru from "./locales/ru.json";
import es from "./locales/es.json";
import { API_BASE } from "./services/api";

const UN_CODES = ["en", "fr", "ar", "zh", "ru", "es"];
const FETCH_TIMEOUT_MS = 8_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Backend language-package fetch ────────────────────────────────────────────

/**
 * Fetches the published language package from the backend for `langCode`,
 * caches it to AsyncStorage, and merges the `strings` object into i18next.
 *
 * For the 6 UN languages: updates Q-key and UI-string translations that may
 * have been edited through the dashboard after the app was built.
 * For non-UN languages: provides whatever translations exist in the backend.
 *
 * Version-aware: downloads only when the backend reports a newer version than
 * what is cached, so this is cheap to call on every startup.
 *
 * Never throws — all errors are caught and logged as warnings.
 */
export async function fetchLanguagePackageFromBackend(langCode: string): Promise<void> {
  try {
    const cacheKey = `cr_lang_package_${langCode}`;
    const versionKey = `cr_lang_version_${langCode}`;

    // Step 1: Check the current published version
    let latestVersion: string | null = null;
    try {
      const versionRes = await safeFetch(
        `${API_BASE}/api/language-packages/${langCode}/version`
      );
      if (versionRes.ok) {
        const versionData = await versionRes.json();
        latestVersion = versionData.version ?? null;
      }
    } catch {
      // Version check failed — proceed to compare with cache anyway
    }

    const cachedVersion = await AsyncStorage.getItem(versionKey);

    // If versions match and we have a cache, use it without re-downloading
    if (latestVersion && latestVersion === cachedVersion) {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        const strings: Record<string, string> = JSON.parse(cached);
        if (Object.keys(strings).length > 0) {
          i18n.addResourceBundle(langCode, "translation", strings, true, true);
        }
        return;
      }
    }

    // Step 2: Download full package
    const res = await safeFetch(
      `${API_BASE}/api/language-packages/active/${langCode}`
    );
    if (!res.ok) return;

    const data = await res.json();
    const strings: Record<string, string> = data.strings ?? {};
    if (Object.keys(strings).length === 0) return;

    // Persist to AsyncStorage for offline use
    try {
      await AsyncStorage.setItem(cacheKey, JSON.stringify(strings));
      if (data.version) {
        await AsyncStorage.setItem(versionKey, data.version);
      }
    } catch { /* storage full — skip caching */ }

    // Merge into i18next (flat keys like TERMS_TITLE, Q1_LABEL, etc.)
    i18n.addResourceBundle(langCode, "translation", strings, true, true);
  } catch (e) {
    console.warn("[i18n] fetchLanguagePackageFromBackend failed for", langCode, e);
  }
}

// ── Load dynamic package from AsyncStorage cache ──────────────────────────────

/**
 * Loads a language package from AsyncStorage — no network call.
 * Returns true if a non-empty package was applied.
 */
export async function loadDynamicLanguagePackage(langCode: string): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(`cr_lang_package_${langCode}`);
    if (!stored) return false;

    const translationMap: Record<string, string> = JSON.parse(stored);
    if (!translationMap || Object.keys(translationMap).length === 0) return false;

    i18n.addResourceBundle(langCode, "translation", translationMap, true, true);
    return true;
  } catch (e) {
    console.warn("Failed to load dynamic language package:", e);
    return false;
  }
}

// ── Main init ─────────────────────────────────────────────────────────────────

export const initI18n = async () => {
  const savedLanguage = await AsyncStorage.getItem("cr_language");

  await i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
      zh: { translation: zh },
      fr: { translation: fr },
      ru: { translation: ru },
      es: { translation: es },
    },
    lng: savedLanguage || "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });

  const activeLang = savedLanguage || "en";

  if (!UN_CODES.includes(activeLang)) {
    // Non-UN language: load from cache first for instant display, then refresh
    await loadDynamicLanguagePackage(activeLang);
  }

  // Fire-and-forget background refresh for ALL languages (UN + non-UN).
  // Merges backend Q-key and UI-string translations on top of the bundled locale.
  // Does not block the UI — the app is already usable from the bundled locale.
  fetchLanguagePackageFromBackend(activeLang).catch(() => {});
};

initI18n();

export default i18n;
