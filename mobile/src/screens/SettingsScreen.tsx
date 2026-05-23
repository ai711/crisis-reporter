import { useState, useEffect } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Modal, FlatList, TextInput, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useAuthStore } from "../stores/authStore";
import { logoutReporter } from "../services/auth";
import api from "../services/api";

type Country = { code: string; name: string };

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

const UN_LANG_CODES = ["ar", "zh", "en", "fr", "ru", "es"];

interface SettingsScreenProps {
  navigation: any;
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const { languageCode, isVerified, setLanguage, setCountry, reset } = useAuthStore();
  const insets = useSafeAreaInsets();

  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countrySearch, setCountrySearch] = useState("");
  const [currentCountry, setCurrentCountry] = useState("");
  const [availableLangs, setAvailableLangs] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    AsyncStorage.getItem("cr_country_name").then((v) => {
      if (v) setCurrentCountry(v);
    });
    AsyncStorage.getItem("cr_countries_cache").then((v) => {
      if (v) {
        setCountries(JSON.parse(v));
      } else {
        api
          .get("/api/countries")
          .then((r) => setCountries(r.data.filter((c: any) => c.is_active)))
          .catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    api.get('/api/language-packages/available')
      .then(r => setAvailableLangs(r.data))
      .catch(() => setAvailableLangs([
        { code: "en", name: "English" },
        { code: "fr", name: "Français" },
        { code: "ar", name: "العربية" },
        { code: "zh", name: "中文" },
        { code: "ru", name: "Русский" },
        { code: "es", name: "Español" },
      ]));
  }, []);

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  const handleCountryChange = async (country: Country) => {
    await AsyncStorage.setItem("cr_country_code", country.code);
    await AsyncStorage.setItem("cr_country_name", country.name);
    setCurrentCountry(country.name);
    setCountry(country.code);
    setShowCountryPicker(false);

    // Trigger question package version check for new country
    try {
      const langCode = (await AsyncStorage.getItem("cr_language")) ?? "en";
      const response = await api.get(
        `/api/question-packages/active?lang=${langCode}&country=${country.code}`
      );
      await AsyncStorage.setItem("cr_question_package", JSON.stringify(response.data));
    } catch {
      // Non-blocking
    }
  };

  const handleLanguageChange = async (langCode: string) => {
    if (!UN_LANG_CODES.includes(langCode)) {
      const netState = await NetInfo.fetch();
      if (!netState.isConnected) {
        Alert.alert(
          "No Internet",
          "This language requires a download to set up. Please connect to the internet to continue with this language, or choose from the available languages below."
        );
        return;
      }
      try {
        const pkgResponse = await api.get(`/api/language-packages/active/${langCode}`);
        const translationMap: Record<string, string> = pkgResponse.data;
        if (translationMap && Object.keys(translationMap).length > 0) {
          await AsyncStorage.setItem(
            `cr_lang_package_${langCode}`,
            JSON.stringify(translationMap)
          );
        }
      } catch {
        Alert.alert(
          "Download failed",
          "Could not download this language package. Please try again."
        );
        return;
      }
      const { loadDynamicLanguagePackage } = await import("../i18n");
      await loadDynamicLanguagePackage(langCode);
    }

    setLanguage(langCode);
    i18n.changeLanguage(langCode);
    await AsyncStorage.setItem("cr_language", langCode);
  };

  const handleLogout = async () => {
    await logoutReporter();
    reset();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("settings.title")}</Text>
      </View>

      <ScrollView style={styles.content}>
        {/* Account */}
        <Text style={styles.sectionTitle}>{t("settings.account")}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Status</Text>
            <View style={[
              styles.badge,
              { backgroundColor: isVerified ? "#d4edda" : "#E8F4FD" },
            ]}>
              <Text style={[
                styles.badgeText,
                { color: isVerified ? "#155724" : "#0468B1" },
              ]}>
                {isVerified ? "Verified" : "Anonymous"}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.row}
            onPress={() => setShowCountryPicker(true)}
          >
            <Text style={styles.label}>{t("settings.country")}</Text>
            <Text style={styles.settingValue}>{currentCountry || "Not set"} ›</Text>
          </TouchableOpacity>
        </View>

        {/* Language */}
        <Text style={styles.sectionTitle}>{t("settings.language")}</Text>
        <View style={styles.languageGrid}>
          {(() => {
            const currentLang = languageCode || i18n.language || "en";
            return availableLangs.map((lang) => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.langBtn,
                  currentLang === lang.code && styles.langBtnSelected,
                ]}
                onPress={() => handleLanguageChange(lang.code)}
              >
                <Text style={[
                  styles.langBtnText,
                  currentLang === lang.code && styles.langBtnTextSelected,
                ]}>
                  {lang.name}
                </Text>
              </TouchableOpacity>
            ));
          })()}
        </View>

        {/* Logout */}
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutBtnText}>
            {t("settings.logout")} / Reset App
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Country picker bottom sheet */}
      <Modal
        visible={showCountryPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCountryPicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select Country</Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(false)}>
                <Text style={styles.pickerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.pickerSearch}
              placeholder="Search countries..."
              value={countrySearch}
              onChangeText={setCountrySearch}
              autoCorrect={false}
            />
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => item.code}
              contentContainerStyle={styles.pickerList}
              renderItem={({ item }) => {
                const selected = item.name === currentCountry;
                return (
                  <TouchableOpacity
                    style={[styles.countryItem, selected && styles.countryItemSelected]}
                    onPress={() => handleCountryChange(item)}
                  >
                    <Text style={[styles.countryItemText, selected && styles.countryItemTextSelected]}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },
  header: {
    backgroundColor: "#1A2B4A",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  backBtn: { color: "#fff", fontSize: 22 },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  content: { flex: 1, padding: 16 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    minHeight: 52,
  },
  label: { fontSize: 15, color: "#1A2B4A" },
  settingValue: { fontSize: 15, color: "#666" },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 13, fontWeight: "500" },
  languageGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  langBtn: {
    width: "47%",
    padding: 14,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  langBtnSelected: { borderColor: "#0468B1", backgroundColor: "#0468B1" },
  langBtnText: { fontSize: 15, fontWeight: "500", color: "#1A2B4A" },
  langBtnTextSelected: { color: "#fff" },
  logoutBtn: {
    marginTop: 24,
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#d32f2f",
    alignItems: "center",
    marginBottom: 40,
  },
  logoutBtnText: { color: "#d32f2f", fontSize: 15, fontWeight: "600" },

  // Country picker bottom sheet
  pickerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  pickerSheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "75%",
    paddingTop: 16,
  },
  pickerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  pickerTitle: { fontSize: 18, fontWeight: "bold", color: "#333333" },
  pickerClose: { fontSize: 18, color: "#666666" },
  pickerSearch: {
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 20,
    marginBottom: 12,
    fontSize: 15,
  },
  pickerList: { paddingHorizontal: 20, paddingBottom: 8 },
  countryItem: {
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderColor: "#E0E0E0",
  },
  countryItemSelected: { backgroundColor: "#0468B1", borderColor: "#0468B1" },
  countryItemText: { fontSize: 15, fontWeight: "500", color: "#333" },
  countryItemTextSelected: { color: "#FFFFFF" },
});
