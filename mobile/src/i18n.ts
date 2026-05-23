import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";

import en from "./locales/en.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";
import fr from "./locales/fr.json";
import ru from "./locales/ru.json";
import es from "./locales/es.json";

const UN_CODES = ["en", "fr", "ar", "zh", "ru", "es"];

export async function loadDynamicLanguagePackage(langCode: string): Promise<boolean> {
  try {
    if (UN_CODES.includes(langCode)) return false;

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

  if (savedLanguage && !UN_CODES.includes(savedLanguage)) {
    await loadDynamicLanguagePackage(savedLanguage);
  }
};

initI18n();

export default i18n;
