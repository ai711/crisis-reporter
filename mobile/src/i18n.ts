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

const FETCH_TIMEOUT_MS = 8_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a flat key→value dict from the backend into the nested object
 * structure that i18next expects when keys are dot-separated paths.
 *
 * Two key formats coexist in the backend pipeline:
 *   - dotted  e.g. "common.back"   → nested into { common: { back: … } }
 *   - UPPERCASE e.g. "SAFETY_DO"  → kept as top-level (no dot, pass through)
 *
 * Without this, i18next resolves t("common.back") by traversing the nested
 * path on the bundle object — but a flat literal key "common.back" sits at
 * the top level and is never found, so the lookup falls back to English.
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
 * caches it in AsyncStorage, merges the strings into i18next, and calls
 * changeLanguage so react-i18next re-renders all mounted components.
 *
 * Mirrors the web's loadLanguagePackage:
 *   • Version-aware — skips download when cached version matches server.
 *   • Cache-first fallback — if the version endpoint fails (offline/timeout),
 *     applies the cached bundle rather than attempting a failing download.
 *   • Always calls changeLanguage after applying a bundle so every mounted
 *     screen re-renders with the updated translations.
 *   • English is excluded — served entirely from the bundled en.json.
 *
 * Never throws — all errors are caught and logged as warnings.
 */
export async function fetchLanguagePackageFromBackend(langCode: string): Promise<void> {
  // English is fully served by the bundled en.json — no pipeline fetch needed.
  if (langCode === "en") return;

  try {
    const cacheKey = `cr_lang_package_${langCode}`;
    const versionKey = `cr_lang_version_${langCode}`;

    // Read both version and content from cache upfront — one AsyncStorage batch.
    const [cachedVersion, cached] = await Promise.all([
      AsyncStorage.getItem(versionKey),
      AsyncStorage.getItem(cacheKey),
    ]);

    // Step 1: Check the published version on the server.
    let latestVersion: string | null = null;
    try {
      const versionRes = await safeFetch(
        `${API_BASE}/api/language-packages/${langCode}/version`
      );
      if (versionRes.ok) {
        const versionData = await versionRes.json();
        // Normalise to string — backend may return a number or string.
        latestVersion = versionData.version != null ? String(versionData.version) : null;
      }
    } catch {
      // Version endpoint unreachable (offline or timeout).
    }

    // Cache-hit path: server version matches what we have → no download needed.
    if (latestVersion && latestVersion === cachedVersion && cached) {
      const strings: Record<string, string> = JSON.parse(cached);
      if (Object.keys(strings).length > 0) {
        i18n.addResourceBundle(langCode, "translation", unflattenStrings(strings), true, true);
        await i18n.changeLanguage(langCode);
      }
      return;
    }

    // Offline/version-check-failed path: server unreachable but cache exists.
    // Apply the cache immediately and skip the download attempt — a failing
    // network call would just time out and waste 8 seconds.
    if (!latestVersion && cached) {
      const strings: Record<string, string> = JSON.parse(cached);
      if (Object.keys(strings).length > 0) {
        i18n.addResourceBundle(langCode, "translation", unflattenStrings(strings), true, true);
        await i18n.changeLanguage(langCode);
      }
      return;
    }

    // Step 2: Download full package (new version available or no cache yet).
    const res = await safeFetch(
      `${API_BASE}/api/language-packages/active/${langCode}`
    );
    if (!res.ok) return;

    const data = await res.json();
    // Backend wraps the flat strings dict in { version, language_code, strings }.
    const strings: Record<string, string> = data.strings ?? data;
    if (Object.keys(strings).length === 0) return;

    // Persist to AsyncStorage for offline use.
    try {
      await AsyncStorage.setItem(cacheKey, JSON.stringify(strings));
      if (data.version != null) {
        await AsyncStorage.setItem(versionKey, String(data.version));
      }
    } catch { /* storage full — skip caching */ }

    // Apply bundle and commit the language switch. changeLanguage triggers
    // react-i18next to re-render all mounted screens with the updated strings.
    i18n.addResourceBundle(langCode, "translation", unflattenStrings(strings), true, true);
    await i18n.changeLanguage(langCode);
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

    i18n.addResourceBundle(langCode, "translation", unflattenStrings(translationMap), true, true);
    return true;
  } catch (e) {
    console.warn("Failed to load dynamic language package:", e);
    return false;
  }
}

// ── Synchronous init — all resources are bundled, so this completes instantly ─

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ar: { translation: ar },
    zh: { translation: zh },
    fr: { translation: fr },
    ru: { translation: ru },
    es: { translation: es },
  },
  lng: "en",            // Safe default — overwritten below after AsyncStorage read
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// ── Async language restore — runs immediately after module loads ───────────────
// Phase 1 (synchronous path): loads the cached bundle and calls changeLanguage
// so the first render of every screen uses full pipeline translations, not the
// sparse bundled fallback file.
//
// Phase 2 (background): fetchLanguagePackageFromBackend checks the server for a
// newer version. If one is found it downloads, caches, and calls changeLanguage
// again — re-rendering all mounted screens with the updated strings.
// English is skipped in both phases — the bundled en.json is the source of truth.
(async () => {
  try {
    const savedLanguage = await AsyncStorage.getItem("cr_language");
    const activeLang = savedLanguage || "en";

    if (savedLanguage && savedLanguage !== "en") {
      // Apply cached backend package before changeLanguage so the full pipeline
      // strings are in the bundle when react-i18next first renders components.
      await loadDynamicLanguagePackage(savedLanguage);
      await i18n.changeLanguage(savedLanguage);
    }

    // Background version check + refresh. fetchLanguagePackageFromBackend now
    // calls changeLanguage internally after applying any bundle update, so all
    // mounted screens re-render automatically when the fetch completes.
    // No manual i18n.emit needed — and English is excluded (no pipeline needed).
    if (activeLang !== "en") {
      fetchLanguagePackageFromBackend(activeLang).catch(() => {});
    }
  } catch (e) {
    console.warn("[i18n] Async language restore failed:", e);
  }
})();

export default i18n;
