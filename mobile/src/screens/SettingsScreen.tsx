import { useState, useEffect } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Modal, FlatList, TextInput, Alert, Dimensions, I18nManager,
} from "react-native";
import * as Updates from "expo-updates";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { MaterialIcons } from "@expo/vector-icons";
import { useAuthStore } from "../stores/authStore";
import { logoutReporter } from "../services/auth";
import api from "../services/api";

const { width: _screenWidthRaw } = Dimensions.get("window");
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round((screenWidth / 375) * size);

type Country = { code: string; name: string };

const UN_LANG_CODES = ["ar", "zh", "en", "fr", "ru", "es"];

interface SettingsScreenProps {
  navigation: any;
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const { languageCode, isVerified, setLanguage, setCountry, logout } = useAuthStore();
  const insets = useSafeAreaInsets();

  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
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
    api.get("/api/language-packages/available")
      .then((r) => {
        setAvailableLangs(r.data);
        // Cache for offline use so previously-downloaded non-UN languages remain visible
        AsyncStorage.setItem("cr_available_languages", JSON.stringify(r.data)).catch(() => {});
      })
      .catch(async () => {
        // Offline: try the cached list before falling back to the 6 UN languages
        try {
          const cached = await AsyncStorage.getItem("cr_available_languages");
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setAvailableLangs(parsed);
              return;
            }
          }
        } catch { /* ignore */ }
        setAvailableLangs([
          { code: "en", name: "English" },
          { code: "fr", name: "Français" },
          { code: "ar", name: "العربية" },
          { code: "zh", name: "中文" },
          { code: "ru", name: "Русский" },
          { code: "es", name: "Español" },
        ]);
      });
  }, []);

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  const currentLang = languageCode || i18n.language || "en";
  const currentLangName =
    availableLangs.find((l) => l.code === currentLang)?.name ?? "English";

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
        // Before blocking with an alert, check if the package is already cached.
        // The user may have downloaded this language previously and just wants to switch back.
        const cached = await AsyncStorage.getItem(`cr_lang_package_${langCode}`);
        if (!cached) {
          Alert.alert(
            "No Internet",
            "This language requires a download to set up. Please connect to the internet to continue with this language, or choose from the available languages below."
          );
          return;
        }
        // Package is cached — load from cache and fall through to the language switch.
        const { loadDynamicLanguagePackage } = await import("../i18n");
        await loadDynamicLanguagePackage(langCode);
      } else {
        // Online — download fresh package from backend.
        try {
          const pkgResponse = await api.get(`/api/language-packages/active/${langCode}`);
          const translationMap: Record<string, string> = pkgResponse.data?.strings ?? pkgResponse.data;
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
    } else {
      // UN language: load cached backend package (full pipeline strings) before switching.
      // Fall back silently — bundled static file is used if no cache exists yet.
      const { loadDynamicLanguagePackage, fetchLanguagePackageFromBackend } = await import("../i18n");
      const loaded = await loadDynamicLanguagePackage(langCode);
      if (!loaded) {
        // No cache yet — fetch now so the user immediately gets full translations.
        await fetchLanguagePackageFromBackend(langCode);
      }
    }

    setLanguage(langCode);
    await i18n.changeLanguage(langCode);
    await AsyncStorage.setItem("cr_language", langCode);

    // RTL direction changes (switching to/from Arabic) require a full JS reload.
    const needsRTLChange = (langCode === "ar") !== I18nManager.isRTL;
    if (needsRTLChange) {
      I18nManager.forceRTL(langCode === "ar");
      Alert.alert(
        t("settings.rtl_restart_title"),
        t("settings.rtl_restart_body"),
        [{ text: t("settings.rtl_restart_btn"), onPress: () => Updates.reloadAsync() }]
      );
    }
  };

  const handleLogout = async () => {
    await logoutReporter();
    logout();
    navigation.navigate("Home");
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("settings.title")}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      >
        {/* APP PREFERENCES */}
        <Text style={styles.sectionHeader}>{t("settings.section_preferences")}</Text>
        <View style={styles.groupCard}>
          {/* Status row */}
          <View style={styles.settingRow}>
            <View style={styles.iconContainerBlue}>
              <MaterialIcons name="person" size={scale(20)} color="#0468B1" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.status_label")}</Text>
              <Text style={styles.rowSubtitle}>
                {isVerified ? t("settings.verified") : t("settings.anonymous")}
              </Text>
            </View>
            <View style={[
              styles.statusBadge,
              { backgroundColor: isVerified ? "rgba(56,161,105,0.12)" : "rgba(4,104,177,0.06)" },
            ]}>
              <Text style={[
                styles.statusBadgeText,
                { color: isVerified ? "#38A169" : "#0468B1" },
              ]}>
                {isVerified ? t("settings.verified") : t("settings.anonymous")}
              </Text>
            </View>
          </View>

          <View style={styles.separator} />

          {/* Country row */}
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setShowCountryPicker(true)}
          >
            <View style={styles.iconContainerBlue}>
              <MaterialIcons name="public" size={scale(20)} color="#0468B1" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.country")}</Text>
              <Text style={styles.rowSubtitle}>{currentCountry || t("settings.not_set")}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
          </TouchableOpacity>

          <View style={styles.separator} />

          {/* Language row */}
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setShowLanguagePicker(true)}
          >
            <View style={styles.iconContainerBlue}>
              <MaterialIcons name="language" size={scale(20)} color="#0468B1" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.language")}</Text>
              <Text style={styles.rowSubtitle}>{currentLangName}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
          </TouchableOpacity>
        </View>

        {/* ABOUT */}
        <Text style={styles.sectionHeader}>{t("settings.section_about")}</Text>
        <View style={styles.groupCard}>
          {/* App Version */}
          <View style={styles.settingRow}>
            <View style={styles.iconContainerGray}>
              <MaterialIcons name="info" size={scale(20)} color="#717782" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.app_version")}</Text>
            </View>
            <Text style={styles.staticValue}>{t("settings.version_value")}</Text>
          </View>

          <View style={styles.separator} />

          {/* Terms and Conditions */}
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => navigation.navigate('TermsScreen')}
          >
            <View style={styles.iconContainerGray}>
              <MaterialIcons name="description" size={scale(20)} color="#717782" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.terms_and_conditions")}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
          </TouchableOpacity>

          <View style={styles.separator} />

          {/* Privacy Policy */}
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setShowPrivacyModal(true)}
          >
            <View style={styles.iconContainerGray}>
              <MaterialIcons name="security" size={scale(20)} color="#717782" />
            </View>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t("settings.privacy_policy")}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
          </TouchableOpacity>
        </View>

        {/* Logout */}
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutBtnText}>
            {t("settings.logout")} {t("settings.reset_app")}
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
              <Text style={styles.pickerTitle}>{t("settings.select_country")}</Text>
              <TouchableOpacity
                onPress={() => setShowCountryPicker(false)}
                style={styles.pickerCloseBtn}
              >
                <Text style={styles.pickerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.pickerSearch}
              placeholder={t("settings.search_countries")}
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
                    style={[styles.pickerItem, selected && styles.pickerItemSelected]}
                    onPress={() => handleCountryChange(item)}
                  >
                    <Text style={[styles.pickerItemText, selected && styles.pickerItemTextSelected]}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      {/* Language picker bottom sheet */}
      <Modal
        visible={showLanguagePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLanguagePicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{t("settings.select_language")}</Text>
              <TouchableOpacity
                onPress={() => setShowLanguagePicker(false)}
                style={styles.pickerCloseBtn}
              >
                <Text style={styles.pickerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={availableLangs}
              keyExtractor={(item) => item.code}
              contentContainerStyle={styles.pickerList}
              renderItem={({ item }) => {
                const selected = item.code === currentLang;
                return (
                  <TouchableOpacity
                    style={[styles.pickerItem, selected && styles.pickerItemSelected]}
                    onPress={async () => {
                      setShowLanguagePicker(false);
                      await handleLanguageChange(item.code);
                    }}
                  >
                    <Text style={[styles.pickerItemText, selected && styles.pickerItemTextSelected]}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
      {/* Privacy Policy coming-soon modal */}
      <Modal
        visible={showPrivacyModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPrivacyModal(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={[styles.pickerSheet, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{t("settings.privacy_policy")}</Text>
              <TouchableOpacity
                onPress={() => setShowPrivacyModal(false)}
                style={styles.pickerCloseBtn}
              >
                <Text style={styles.pickerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.privacyBody}>
              <View style={styles.privacyIconCircle}>
                <MaterialIcons name="security" size={scale(28)} color="#0468B1" />
              </View>
              <Text style={styles.privacyHeading}>{t('about.privacy_coming_soon')}</Text>
              <Text style={styles.privacyText}>
                Our Privacy Policy is being finalized and will be available here shortly.
              </Text>
              <Text style={styles.privacySubText}>
                Crisis Reporter is operated by UNDP. Data collected is used solely for humanitarian response and is never shared with third parties without your consent.
              </Text>
              <TouchableOpacity
                style={styles.privacyCloseBtn}
                onPress={() => setShowPrivacyModal(false)}
                activeOpacity={0.85}
              >
                <Text style={styles.privacyCloseBtnText}>{t('about.privacy_got_it')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F3F2" },

  // Header
  header: {
    backgroundColor: "rgba(255,255,255,0.92)",
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E4E2E1",
  },
  headerBtn: { width: 44, minHeight: 44, justifyContent: "center" },
  headerTitle: { fontSize: scale(17), fontWeight: "600", color: "#1B1C1C" },

  content: { flex: 1 },

  // Section headers
  sectionHeader: {
    fontSize: scale(11),
    fontWeight: "700",
    color: "#717782",
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 10,
    marginTop: 24,
    paddingHorizontal: screenWidth * 0.05,
  },

  // Group card
  groupCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    overflow: "hidden",
  },

  // Settings row
  settingRow: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
  },
  iconContainerBlue: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(4,104,177,0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  iconContainerGray: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F0EDED",
    justifyContent: "center",
    alignItems: "center",
  },
  rowContent: { flex: 1 },
  rowLabel: { fontSize: scale(15), fontWeight: "600", color: "#1B1C1C" },
  rowSubtitle: { fontSize: scale(13), color: "#717782", marginTop: 2 },
  staticValue: { fontSize: scale(14), color: "#717782" },

  // Status badge
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  statusBadgeText: { fontSize: scale(13), fontWeight: "500" },

  // Separator
  separator: { height: 1, backgroundColor: "#F6F3F2", marginLeft: 64 },

  // Logout
  logoutBtn: {
    marginHorizontal: screenWidth * 0.05,
    marginTop: 24,
    padding: 16,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "#E53E3E",
    alignItems: "center",
  },
  logoutBtnText: { color: "#E53E3E", fontSize: scale(15), fontWeight: "600" },

  // Pickers (country + language)
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
  pickerTitle: { fontSize: scale(18), fontWeight: "bold", color: "#1B1C1C" },
  pickerCloseBtn: { minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" },
  pickerClose: { fontSize: scale(18), color: "#717782" },
  pickerSearch: {
    borderWidth: 1,
    borderColor: "#E4E2E1",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 20,
    marginBottom: 12,
    fontSize: scale(15),
    backgroundColor: "#F6F3F2",
  },
  pickerList: { paddingHorizontal: 20, paddingBottom: 8 },
  pickerItem: {
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderColor: "#E4E2E1",
    minHeight: 44,
    justifyContent: "center",
  },
  pickerItemSelected: { backgroundColor: "#0468B1", borderColor: "#0468B1" },
  pickerItemText: { fontSize: scale(15), fontWeight: "500", color: "#1B1C1C" },
  pickerItemTextSelected: { color: "#FFFFFF" },

  // Privacy Policy coming-soon modal
  privacyBody: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 8,
    gap: 12,
  },
  privacyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#EBF5FB",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  privacyHeading: {
    fontSize: scale(18),
    fontWeight: "700",
    color: "#1A2B4A",
    textAlign: "center",
  },
  privacyText: {
    fontSize: scale(14),
    color: "#718096",
    lineHeight: scale(14) * 1.65,
    textAlign: "center",
  },
  privacySubText: {
    fontSize: scale(13),
    color: "#A0AEC0",
    lineHeight: scale(13) * 1.6,
    textAlign: "center",
  },
  privacyCloseBtn: {
    marginTop: 8,
    width: "100%",
    height: 48,
    borderRadius: 24,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  privacyCloseBtnText: {
    color: "#FFFFFF",
    fontSize: scale(15),
    fontWeight: "600",
  },
});
