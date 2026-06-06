import { useState, useEffect } from "react";
import { useRoute, useNavigation } from "@react-navigation/native";
import {
  View, Text, TouchableOpacity, TextInput,
  FlatList, ActivityIndicator, Alert, ScrollView,
  StyleSheet, Dimensions, Modal, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import api from "../services/api";
import { MaterialIcons } from "@expo/vector-icons";

type Country = {
  code: string;
  name: string;
  official_language: string | null;
  is_active: boolean;
};

const BUNDLED_COUNTRIES_FALLBACK: Country[] = [
  { code: "AF", name: "Afghanistan", official_language: null, is_active: true },
  { code: "BD", name: "Bangladesh", official_language: null, is_active: true },
  { code: "CM", name: "Cameroon", official_language: null, is_active: true },
  { code: "CD", name: "Congo (DRC)", official_language: null, is_active: true },
  { code: "ET", name: "Ethiopia", official_language: null, is_active: true },
  { code: "GT", name: "Guatemala", official_language: null, is_active: true },
  { code: "HT", name: "Haiti", official_language: null, is_active: true },
  { code: "IN", name: "India", official_language: null, is_active: true },
  { code: "IQ", name: "Iraq", official_language: null, is_active: true },
  { code: "KE", name: "Kenya", official_language: null, is_active: true },
  { code: "LB", name: "Lebanon", official_language: null, is_active: true },
  { code: "LY", name: "Libya", official_language: null, is_active: true },
  { code: "MM", name: "Myanmar", official_language: null, is_active: true },
  { code: "NP", name: "Nepal", official_language: null, is_active: true },
  { code: "NG", name: "Nigeria", official_language: null, is_active: true },
  { code: "PK", name: "Pakistan", official_language: null, is_active: true },
  { code: "PH", name: "Philippines", official_language: null, is_active: true },
  { code: "SO", name: "Somalia", official_language: null, is_active: true },
  { code: "SS", name: "South Sudan", official_language: null, is_active: true },
  { code: "SY", name: "Syria", official_language: null, is_active: true },
  { code: "TR", name: "Turkey", official_language: null, is_active: true },
  { code: "UA", name: "Ukraine", official_language: null, is_active: true },
  { code: "YE", name: "Yemen", official_language: null, is_active: true },
];

const UN_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
];

const UN_LANG_CODES = ["ar", "zh", "en", "fr", "ru", "es"];

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
const scale = (size: number) => Math.round((screenWidth / 375) * size);
const H_PAD = screenWidth * 0.06;

export default function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  // Allow deep-linking to a specific step (e.g. step=3 from Settings → T&C).
  const route = useRoute<any>();
  const initialStep: 1 | 2 | 3 = (route.params?.initialStep as 1 | 2 | 3) ?? 1;
  // True when opened from Settings to re-read T&C (user is already onboarded).
  const isTermsViewOnly = initialStep === 3;

  const [step, setStep] = useState<1 | 2 | 3>(initialStep);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<Country | null>(null);
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const [officialLangLoading, setOfficialLangLoading] = useState(false);
  const [countryDropdownOpen, setCountryDropdownOpen] = useState(false);
  const [availableLangs, setAvailableLangs] = useState<{code: string, name: string, is_un_language: boolean}[]>([]);
  const [showLangModal, setShowLangModal] = useState(false);

  useEffect(() => {
    const loadCountries = async () => {
      setCountriesLoading(true);
      try {
        const response = await api.get("/api/countries");
        const active = response.data.filter((c: Country) => c.is_active);
        setCountries(active);
        await AsyncStorage.setItem("cr_countries_cache", JSON.stringify(active));
      } catch {
        const cached = await AsyncStorage.getItem("cr_countries_cache");
        if (cached) {
          setCountries(JSON.parse(cached));
        } else {
          setCountries(BUNDLED_COUNTRIES_FALLBACK);
        }
      } finally {
        setCountriesLoading(false);
      }
    };
    loadCountries();
  }, []);

  useEffect(() => {
    api
      .get("/api/language-packages/available")
      .then((res) => setAvailableLangs(res.data))
      .catch(() => {
        setAvailableLangs(UN_LANGUAGES.map((l) => ({ code: l.code, name: l.label, is_un_language: true })));
      });
  }, []);

  async function checkIfSelectedLanguageDeactivated(storedLangCode: string) {
    try {
      const UN_CODES = ["en", "fr", "ar", "zh", "ru", "es"];
      if (UN_CODES.includes(storedLangCode)) return;

      const response = await api.get('/api/language-packages/available');
      const available: {code: string, name: string, is_un_language: boolean}[] = response.data;

      const isStillActive = available.some(l => l.code === storedLangCode);

      if (!isStillActive) {
        await AsyncStorage.setItem('cr_lang_deactivated', storedLangCode);
      } else {
        await AsyncStorage.removeItem('cr_lang_deactivated');
      }
    } catch (e) {
      console.warn('Language deactivation check failed', e);
    }
  }

  // Version + deactivation check on app open — fire and forget, non-blocking
  useEffect(() => {
    const startup = async () => {
      const storedLang = await AsyncStorage.getItem("cr_language");
      if (storedLang && storedLang !== "en") {
        checkIfSelectedLanguageDeactivated(storedLang); // fire-and-forget, no await
      }

      // Alert returning users if their previously-selected language was deactivated
      const deactivatedLang = await AsyncStorage.getItem('cr_lang_deactivated');
      const tandcAcceptedAt = await AsyncStorage.getItem('cr_tandc_accepted_at');
      if (deactivatedLang && tandcAcceptedAt) {
        Alert.alert(
          "Language No Longer Available",
          "The language you selected is no longer supported. Please select a new language to continue.",
          [{
            text: "Select Language",
            onPress: () => {
              AsyncStorage.removeItem('cr_lang_deactivated');
              setStep(2);
            },
          }]
        );
      }
    };
    startup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCountryNext = async () => {
    if (!selectedCountry || countriesLoading) return;
    await AsyncStorage.setItem("cr_country_code", selectedCountry.code);
    await AsyncStorage.setItem("cr_country_name", selectedCountry.name);
    setStep(2);
  };

  const handleLanguageNext = async () => {
    if (!selectedLang) return;

    // Only non-UN languages need a backend download — UN languages are bundled
    if (!UN_LANG_CODES.includes(selectedLang)) {
      try {
        const pkgResponse = await api.get(
          `/api/language-packages/active/${selectedLang}`
        );
        const data = pkgResponse.data;
        const translationMap: Record<string, string> = data?.strings ?? data;
        if (translationMap && Object.keys(translationMap).length > 0) {
          await AsyncStorage.setItem(
            `cr_lang_package_${selectedLang}`,
            JSON.stringify(translationMap)
          );
          // Use the per-language version key so HomeScreen's version check skips a redundant download
          if (data?.version) {
            await AsyncStorage.setItem(`cr_lang_version_${selectedLang}`, String(data.version));
          }
        }
      } catch (e) {
        console.warn("Language package fetch failed, using bundled fallback", e);
      }
      // Load the downloaded package into i18n immediately so T&C renders in the selected language
      const { loadDynamicLanguagePackage } = await import("../i18n");
      await loadDynamicLanguagePackage(selectedLang);
    }

    i18n.changeLanguage(selectedLang);
    useAuthStore.getState().setLanguage(selectedLang);
    await AsyncStorage.setItem("cr_language", selectedLang);
    setStep(3);
  };

  const handleAgree = async () => {
    const ts = new Date().toISOString();
    await AsyncStorage.setItem("cr_tandc_accepted_at", ts);
    useAuthStore.getState().setTAndCAcceptedAt(ts);
    useAuthStore.getState().setOnboarded();
    // If we arrived here from Settings (view-only), go back instead of
    // re-triggering the onboarding completion nav flow.
    if (isTermsViewOnly) navigation.goBack();
  };

  const handleDecline = () => {
    Alert.alert(
      t("tandc.declineAlertTitle"),
      t("tandc.declineAlertMessage"),
      [{ text: t("tandc.declineAlertButton"), style: "default" }]
    );
  };

  // Legacy internal components — kept, not rendered in active UI
  const ScreenHeader = ({
    showBack,
    onBack,
  }: {
    showBack?: boolean;
    onBack?: () => void;
  }) => (
    <>
      <View style={styles.header}>
        {showBack && (
          <TouchableOpacity onPress={onBack} style={styles.backArrow}>
            <Text style={styles.backArrowText}>{"←"}</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>Crisis Reporter</Text>
      </View>
      <View style={styles.divider} />
    </>
  );

  const NextButton = ({
    onPress,
    disabled,
  }: {
    onPress: () => void;
    disabled: boolean;
  }) => (
    <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
      <TouchableOpacity
        style={[styles.nextButton, disabled && styles.nextButtonDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        <Text style={styles.nextButtonText}>Next</Text>
      </TouchableOpacity>
    </View>
  );

  // Language grid — from backend availableLangs, official first if present
  type GridItem = { code: string; label: string; isSeeAll?: boolean };
  const officialCode = selectedCountry?.official_language ?? null;
  let orderedLangs = [...availableLangs];
  if (officialCode) {
    const officialIdx = orderedLangs.findIndex((l) => l.code === officialCode);
    if (officialIdx > 0) {
      const [officialEntry] = orderedLangs.splice(officialIdx, 1);
      orderedLangs.unshift(officialEntry);
    }
    // officialIdx === -1 means not in availableLangs — exclude silently
    // officialIdx === 0 means already first — no action needed
  }
  const GRID_LIMIT = 7;
  const gridItems: GridItem[] = orderedLangs.length >= GRID_LIMIT
    ? [
        ...orderedLangs.slice(0, 6).map((l) => ({ code: l.code, label: l.name })),
        { code: "__seeall__", label: `See all ${orderedLangs.length} languages`, isSeeAll: true },
      ]
    : orderedLangs.map((l) => ({ code: l.code, label: l.name }));
  const langRows: GridItem[][] = [];
  for (let i = 0; i < gridItems.length; i += 2) {
    langRows.push(gridItems.slice(i, i + 2));
  }
  const modalLangs = orderedLangs.length >= GRID_LIMIT ? orderedLangs : [];

  // ── Shared hero section ────────────────────────────────────────────────────
  const renderHero = (logoSize: number = 80) => (
    <View style={styles.heroSection}>
      <View
        style={[
          styles.logoBadge,
          { width: logoSize, height: logoSize, borderRadius: logoSize / 2 },
        ]}
      >
        <MaterialIcons
          name="shield"
          size={Math.round(logoSize * 0.45)}
          color="#FFFFFF"
        />
      </View>
      <Text style={styles.appTitle}>Crisis Reporter</Text>
      <Text style={styles.appSubtitle}>
        Report crisis damage from anywhere, even offline
      </Text>
    </View>
  );

  // ── Country picker modal ───────────────────────────────────────────────────
  const renderCountryModal = () => (
    <Modal
      visible={countryDropdownOpen}
      animationType="slide"
      onRequestClose={() => setCountryDropdownOpen(false)}
    >
      <SafeAreaView style={styles.modalSafeArea} edges={["top", "bottom"]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Select Country</Text>
          <TouchableOpacity
            onPress={() => setCountryDropdownOpen(false)}
            style={styles.modalCloseBtn}
          >
            <MaterialIcons name="close" size={24} color="#1B1C1C" />
          </TouchableOpacity>
        </View>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <TextInput
            style={styles.searchInput}
            placeholder="Search countries..."
            placeholderTextColor="#717782"
            value={search}
            onChangeText={setSearch}
          />
          {countriesLoading ? (
            <ActivityIndicator style={styles.centeredLoader} color="#0468B1" />
          ) : (
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => item.code}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const selected = selectedCountry?.code === item.code;
                return (
                  <TouchableOpacity
                    style={[
                      styles.countryItem,
                      selected && styles.countryItemSelected,
                    ]}
                    onPress={() => {
                      setSelectedCountry(item);
                      setSearch("");
                      setCountryDropdownOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.countryItemText,
                        selected && styles.countryItemTextSelected,
                      ]}
                    >
                      {item.name}
                    </Text>
                    {selected && (
                      <MaterialIcons name="check-circle" size={20} color="#FFFFFF" />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );

  // ── Step 1: Country selection ──────────────────────────────────────────────
  if (step === 1) {
    const canContinue = !!selectedCountry && !countriesLoading;
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        {renderCountryModal()}

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingHorizontal: H_PAD },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {renderHero(80)}
          <View style={{ height: 48 }} />

          <Text style={styles.sectionLabel}>SELECT YOUR COUNTRY</Text>
          <View style={{ height: 10 }} />

          <TouchableOpacity
            style={styles.dropdownPill}
            onPress={() => setCountryDropdownOpen(true)}
            activeOpacity={0.8}
          >
            <MaterialIcons name="location-on" size={20} color="#0468B1" />
            <Text
              style={[
                styles.dropdownPillText,
                !selectedCountry && styles.dropdownPillPlaceholder,
              ]}
              numberOfLines={1}
            >
              {selectedCountry ? selectedCountry.name : "Select your country"}
            </Text>
            <MaterialIcons name="expand-more" size={22} color="#717782" />
          </TouchableOpacity>

          <View style={{ height: 8 }} />
          <View style={styles.infoRow}>
            <MaterialIcons name="info-outline" size={14} color="#717782" />
            <Text style={styles.infoText}>
              Only countries with active UNDP operations are available
            </Text>
          </View>
          <View style={{ height: 32 }} />
        </ScrollView>

        <View
          style={[
            styles.bottomSection,
            { paddingBottom: Math.max(insets.bottom + 8, 16) },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.continueButton,
              !canContinue && styles.continueButtonDisabled,
            ]}
            onPress={handleCountryNext}
            disabled={!canContinue}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.continueButtonText,
                !canContinue && styles.continueButtonTextDisabled,
              ]}
            >
              Continue
            </Text>
          </TouchableOpacity>

          <Text style={styles.devicePrivacyText}>
            Your device ID is recorded anonymously for quality and security purposes
          </Text>

          <View style={styles.encryptedBadge}>
            <MaterialIcons name="lock" size={12} color="#717782" />
            <Text style={styles.encryptedBadgeText}>ENCRYPTED CONNECTION</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Step 2: Language selection ─────────────────────────────────────────────
  if (step === 2) {
    const canContinue = !!selectedLang;
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.navRow}>
          <TouchableOpacity
            onPress={() => setStep(1)}
            style={styles.navBackBtn}
            hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
          >
            <MaterialIcons name="arrow-back" size={24} color="#1B1C1C" />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[
            styles.scrollContent2,
            { paddingHorizontal: H_PAD },
          ]}
        >
          {renderHero(64)}
          <View style={{ height: 28 }} />

          {selectedCountry && (
            <View style={styles.selectedCountryRow}>
              <MaterialIcons name="location-on" size={16} color="#0468B1" />
              <Text style={styles.selectedCountryText}>{selectedCountry.name}</Text>
            </View>
          )}

          <View style={{ height: 28 }} />
          <Text style={styles.sectionLabel}>SELECT YOUR LANGUAGE</Text>
          <View style={{ height: 10 }} />

          {officialLangLoading && (
            <ActivityIndicator
              size="small"
              color="#0468B1"
              style={{ marginBottom: 8 }}
            />
          )}

          {langRows.map((row, rowIdx) => (
            <View key={rowIdx} style={styles.langRow}>
              {row.map((lang) => {
                if (lang.isSeeAll) {
                  return (
                    <TouchableOpacity
                      key="__seeall__"
                      style={[styles.langPill, styles.langPillMore]}
                      onPress={() => setShowLangModal(true)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.langPillMoreText}>{lang.label}</Text>
                    </TouchableOpacity>
                  );
                }
                const selected = selectedLang === lang.code;
                return (
                  <TouchableOpacity
                    key={lang.code}
                    style={[styles.langPill, selected && styles.langPillSelected]}
                    onPress={() => setSelectedLang(lang.code)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.langPillText,
                        selected && styles.langPillTextSelected,
                      ]}
                    >
                      {lang.label}
                    </Text>
                    {selected && (
                      <MaterialIcons
                        name="check-circle"
                        size={18}
                        color="#FFFFFF"
                        style={{ marginLeft: 6 }}
                      />
                    )}
                  </TouchableOpacity>
                );
              })}
              {row.length === 1 && <View style={styles.langPillFiller} />}
            </View>
          ))}

          <View style={{ height: 24 }} />
        </ScrollView>

        <View
          style={[
            styles.bottomSection,
            { paddingBottom: Math.max(insets.bottom + 8, 16) },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.continueButton,
              !canContinue && styles.continueButtonDisabled,
            ]}
            onPress={handleLanguageNext}
            disabled={!canContinue}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.continueButtonText,
                !canContinue && styles.continueButtonTextDisabled,
              ]}
            >
              Continue
            </Text>
          </TouchableOpacity>

          {canContinue ? (
            <Text style={styles.privacyPolicyText}>
              {"Your data is processed according to our "}
              <Text style={{ color: "#0468B1" }}>{"Privacy Policy"}</Text>
              {" and international humanitarian standards."}
            </Text>
          ) : (
            <View style={styles.lockRow}>
              <MaterialIcons name="lock" size={14} color="#717782" />
              <Text style={styles.lockRowText}>
                Your data is secured by UNDP Privacy Protocols
              </Text>
            </View>
          )}

          {canContinue && <View style={styles.homeIndicatorBar} />}
        </View>

        <Modal
          visible={showLangModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowLangModal(false)}
        >
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", paddingHorizontal: H_PAD }}>
            <View style={{ backgroundColor: "#FFFFFF", borderRadius: 16, padding: 20, maxHeight: screenHeight * 0.7, width: "100%" }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <Text style={{ fontSize: scale(17), fontWeight: "700", color: "#1B1C1C" }}>All Languages</Text>
                <TouchableOpacity onPress={() => setShowLangModal(false)} hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}>
                  <MaterialIcons name="close" size={24} color="#1B1C1C" />
                </TouchableOpacity>
              </View>
              <ScrollView>
                {modalLangs.map((lang) => {
                  const selected = selectedLang === lang.code;
                  return (
                    <TouchableOpacity
                      key={lang.code}
                      style={[styles.langPill, { marginBottom: 10 }, selected && styles.langPillSelected]}
                      onPress={() => { setSelectedLang(lang.code); setShowLangModal(false); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.langPillText, selected && styles.langPillTextSelected]}>{lang.name}</Text>
                      {selected && (
                        <MaterialIcons name="check-circle" size={18} color="#FFFFFF" style={{ marginLeft: 6 }} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // ── Step 3: Terms & Conditions ─────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.navRow}>
        <TouchableOpacity
          onPress={() => isTermsViewOnly ? navigation.goBack() : setStep(2)}
          style={styles.navBackBtn}
          hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
        >
          <MaterialIcons name="arrow-back" size={24} color="#1B1C1C" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scrollContent2,
          { paddingHorizontal: H_PAD },
        ]}
      >
        {renderHero(56)}
        <View style={{ height: 24 }} />

        <Text style={styles.tandcTitle}>{t("tandc.title")}</Text>
        <Text style={styles.tandcSubtitle}>{t("tandc.subtitle")}</Text>
        <View style={{ height: 16 }} />

        <View style={styles.tandcCard}>
          <ScrollView
            style={{ maxHeight: screenHeight * 0.4 }}
            nestedScrollEnabled
            contentContainerStyle={{ padding: 20 }}
          >
            <Text style={styles.tandcBody}>{t("tandc.body")}</Text>
          </ScrollView>
          <View style={styles.tandcCardDivider} />
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

      <View
        style={[
          styles.tandcButtons,
          { paddingBottom: Math.max(insets.bottom + 8, 16) },
        ]}
      >
        <TouchableOpacity
          style={styles.agreeButton}
          onPress={handleAgree}
          activeOpacity={0.85}
        >
          <Text style={styles.agreeButtonText}>{t("tandc.agreeButton")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.declineButton}
          onPress={handleDecline}
          activeOpacity={0.85}
        >
          <Text style={styles.declineButtonText}>{t("tandc.declineButton")}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // ── Base ────────────────────────────────────────────────────────────────────
  container: { flex: 1, backgroundColor: "#F6F3F2" },
  scrollContent: { flexGrow: 1, paddingTop: 32 },
  scrollContent2: { flexGrow: 1, paddingTop: 16 },

  // ── Hero ────────────────────────────────────────────────────────────────────
  heroSection: { alignItems: "center" },
  logoBadge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  appTitle: {
    fontSize: scale(28),
    fontWeight: "800",
    color: "#1B1C1C",
    marginTop: 20,
    textAlign: "center",
  },
  appSubtitle: {
    fontSize: scale(15),
    fontWeight: "400",
    color: "#414751",
    marginTop: 8,
    textAlign: "center",
    maxWidth: 260,
  },

  // ── Section label ──────────────────────────────────────────────────────────
  sectionLabel: {
    fontSize: scale(10),
    fontWeight: "700",
    letterSpacing: 1.5,
    color: "#717782",
    textTransform: "uppercase",
  },

  // ── Country dropdown pill ──────────────────────────────────────────────────
  dropdownPill: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    borderRadius: 28,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
    paddingHorizontal: 16,
    gap: 12,
  },
  dropdownPillText: {
    flex: 1,
    fontSize: scale(15),
    fontWeight: "600",
    color: "#1B1C1C",
  },
  dropdownPillPlaceholder: {
    color: "#717782",
    fontWeight: "400",
  },

  // ── Info row ───────────────────────────────────────────────────────────────
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  infoText: {
    flex: 1,
    fontSize: scale(12),
    color: "#717782",
    lineHeight: scale(12) * 1.5,
  },

  // ── Bottom section ─────────────────────────────────────────────────────────
  bottomSection: { paddingHorizontal: H_PAD, paddingTop: 16 },

  // ── Continue button ────────────────────────────────────────────────────────
  continueButton: {
    height: 56,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  continueButtonDisabled: {
    backgroundColor: "#E4E2E1",
    elevation: 0,
    shadowOpacity: 0,
  },
  continueButtonText: {
    fontSize: scale(16),
    fontWeight: "700",
    color: "#FFFFFF",
  },
  continueButtonTextDisabled: { color: "#717782" },

  // ── Step 1 footer ──────────────────────────────────────────────────────────
  devicePrivacyText: {
    fontSize: scale(11),
    fontWeight: "400",
    color: "#717782",
    textAlign: "center",
    marginTop: 12,
  },
  encryptedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F0EDED",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  encryptedBadgeText: {
    fontSize: scale(10),
    fontWeight: "700",
    color: "#717782",
    letterSpacing: 1,
  },

  // ── Country picker modal ───────────────────────────────────────────────────
  modalSafeArea: { flex: 1, backgroundColor: "#FFFFFF" },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: H_PAD,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(193,199,210,0.3)",
  },
  modalTitle: {
    fontSize: scale(18),
    fontWeight: "700",
    color: "#1B1C1C",
  },
  modalCloseBtn: {
    minWidth: 48,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  searchInput: {
    marginHorizontal: H_PAD,
    marginVertical: 12,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
    backgroundColor: "#F0EDED",
    paddingHorizontal: 16,
    fontSize: scale(15),
    color: "#1B1C1C",
  },
  centeredLoader: { flex: 1 },
  listContent: { paddingHorizontal: H_PAD, paddingBottom: 24 },
  countryItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 16,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
  },
  countryItemSelected: {
    backgroundColor: "#0468B1",
    borderColor: "#0468B1",
  },
  countryItemText: {
    fontSize: scale(15),
    fontWeight: "500",
    color: "#1B1C1C",
  },
  countryItemTextSelected: { color: "#FFFFFF", fontWeight: "700" },

  // ── Navigation row ─────────────────────────────────────────────────────────
  navRow: { paddingHorizontal: H_PAD, paddingVertical: 8 },
  navBackBtn: { minWidth: 48, minHeight: 48, justifyContent: "center" },

  // ── Selected country indicator (step 2) ────────────────────────────────────
  selectedCountryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
    alignSelf: "flex-start",
  },
  selectedCountryText: {
    fontSize: scale(14),
    fontWeight: "600",
    color: "#1B1C1C",
  },

  // ── Language grid ──────────────────────────────────────────────────────────
  langRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  langPill: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    minHeight: 48,
  },
  langPillSelected: {
    backgroundColor: "#0468B1",
    borderColor: "#0468B1",
  },
  langPillText: {
    fontSize: scale(15),
    fontWeight: "500",
    color: "#1B1C1C",
  },
  langPillTextSelected: { color: "#FFFFFF", fontWeight: "700" },
  langPillMore: {
    backgroundColor: "#F0EDED",
    borderColor: "transparent",
  },
  langPillMoreText: {
    fontSize: scale(15),
    fontWeight: "400",
    fontStyle: "italic",
    color: "#717782",
  },
  langPillFiller: { flex: 1 },

  // ── Step 2 footer ──────────────────────────────────────────────────────────
  lockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    justifyContent: "center",
    marginTop: 12,
  },
  lockRowText: { fontSize: scale(12), color: "#717782" },
  privacyPolicyText: {
    fontSize: scale(11),
    color: "#717782",
    textAlign: "center",
    marginTop: 12,
    maxWidth: 260,
    alignSelf: "center",
  },
  homeIndicatorBar: {
    width: 40,
    height: 4,
    backgroundColor: "#E4E2E1",
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 16,
    marginBottom: 8,
  },

  // ── T&C ───────────────────────────────────────────────────────────────────
  tandcTitle: {
    fontSize: scale(20),
    fontWeight: "700",
    color: "#1B1C1C",
  },
  tandcSubtitle: {
    fontSize: scale(14),
    color: "#414751",
    marginTop: 4,
  },
  tandcCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(193,199,210,0.3)",
  },
  tandcCardDivider: { height: 1, backgroundColor: "#E4E2E1" },
  tandcBody: {
    fontSize: scale(14),
    color: "#414751",
    lineHeight: scale(14) * 1.6,
  },
  tandcButtons: { paddingHorizontal: H_PAD, paddingTop: 12, gap: 12 },
  agreeButton: {
    height: 56,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  agreeButtonText: {
    color: "#FFFFFF",
    fontSize: scale(16),
    fontWeight: "700",
    textAlign: "center",
  },
  declineButton: {
    height: 56,
    borderRadius: 28,
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: "rgba(113,119,130,0.4)",
    justifyContent: "center",
    alignItems: "center",
  },
  declineButtonText: {
    color: "#717782",
    fontSize: scale(16),
    fontWeight: "500",
    textAlign: "center",
  },

  // ── Legacy styles (referenced by ScreenHeader / NextButton) ───────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: H_PAD,
    paddingTop: 16,
    paddingBottom: 16,
  },
  headerTitle: { fontWeight: "800", fontSize: scale(22), color: "#1B1C1C" },
  backArrow: {
    marginRight: 12,
    minWidth: 48,
    minHeight: 48,
    justifyContent: "center",
  },
  backArrowText: { fontSize: scale(20), color: "#1B1C1C" },
  divider: { height: 1, backgroundColor: "rgba(193,199,210,0.3)" },
  stepTitle: {
    fontSize: scale(18),
    fontWeight: "600",
    color: "#1B1C1C",
    marginHorizontal: H_PAD,
    marginTop: 20,
    marginBottom: 12,
  },
  bottomBar: { paddingHorizontal: H_PAD, paddingTop: 12 },
  nextButton: {
    width: "100%",
    height: 56,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  nextButtonDisabled: { backgroundColor: "#E4E2E1" },
  nextButtonText: { color: "#FFFFFF", fontSize: scale(16), fontWeight: "700" },

  // ── Other legacy lang styles (defined, not active in current render) ───────
  inlineLoader: { marginBottom: 8 },
  langContainer: { paddingHorizontal: H_PAD, paddingBottom: 8 },
  officialLangPill: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#0468B1",
    backgroundColor: "#E8F4FD",
    marginBottom: 12,
    justifyContent: "space-between",
  },
  officialLangPillSelected: { backgroundColor: "#0468B1" },
  officialLangText: { fontSize: scale(15), color: "#0468B1" },
  downloadIndicator: { fontSize: scale(14), color: "#0468B1" },
  langGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  langTextSelected: { color: "#FFFFFF" },
  moreLangsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingVertical: 12,
  },
  moreLangsIcon: { fontSize: scale(18), color: "#0468B1" },
  moreLangsText: { fontSize: scale(15), color: "#0468B1", marginLeft: 8 },
  tandcScroll: { flex: 1 },
  tandcScrollContent: { paddingHorizontal: H_PAD, paddingBottom: 16 },
});
