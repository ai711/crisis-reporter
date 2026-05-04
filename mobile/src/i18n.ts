import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";

import en from "./locales/en.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";
import fr from "./locales/fr.json";
import ru from "./locales/ru.json";
import es from "./locales/es.json";

const initI18n = async () => {
  const savedLanguage = await AsyncStorage.getItem("cr_language");

  i18n.use(initReactI18next).init({
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
};

initI18n();

export default i18n;