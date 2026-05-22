import { useState, useEffect } from "react";
import {
  View, Text, TouchableOpacity, TextInput,
  FlatList, ActivityIndicator, Alert, ScrollView,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import api from "../services/api";

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

export default function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<Country | null>(null);
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const [officialLang, setOfficialLang] = useState<{ code: string; label: string } | null>(null);
  const [officialLangLoading, setOfficialLangLoading] = useState(false);

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
    if (step !== 2 || !selectedCountry?.official_language) return;
    if (UN_LANG_CODES.includes(selectedCountry.official_language)) return;

    setOfficialLangLoading(true);
    api
      .get(`/api/language-packages/active/${selectedCountry.official_language}`)
      .then(() => {
        setOfficialLang({
          code: selectedCountry.official_language!,
          label: selectedCountry.official_language!.toUpperCase(),
        });
      })
      .catch(() => {
        setOfficialLang(null);
      })
      .finally(() => setOfficialLangLoading(false));
  }, [step, selectedCountry]);

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
    i18n.changeLanguage(selectedLang);
    await AsyncStorage.setItem("cr_language", selectedLang);
    setStep(3);
  };

  const handleAgree = async () => {
    const ts = new Date().toISOString();
    await AsyncStorage.setItem("cr_tandc_accepted_at", ts);
    useAuthStore.getState().setTAndCAcceptedAt(ts);
    useAuthStore.getState().setOnboarded();
  };

  const handleDecline = () => {
    Alert.alert(
      t("tandc.declineAlertTitle"),
      t("tandc.declineAlertMessage"),
      [{ text: t("tandc.declineAlertButton"), style: "default" }]
    );
  };

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

  if (step === 1) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader />
        <Text style={styles.stepTitle}>Select your country</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search countries..."
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
            renderItem={({ item }) => {
              const selected = selectedCountry?.code === item.code;
              return (
                <TouchableOpacity
                  style={[
                    styles.countryItem,
                    selected && styles.countryItemSelected,
                  ]}
                  onPress={() => setSelectedCountry(item)}
                >
                  <Text
                    style={[
                      styles.countryItemText,
                      selected && styles.countryItemTextSelected,
                    ]}
                  >
                    {item.name}
                  </Text>
                </TouchableOpacity>
              );
            }}
          />
        )}
        <NextButton
          onPress={handleCountryNext}
          disabled={!selectedCountry || countriesLoading}
        />
      </SafeAreaView>
    );
  }

  if (step === 2) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader showBack onBack={() => setStep(1)} />
        <Text style={styles.stepTitle}>Select your language</Text>
        {officialLangLoading && (
          <ActivityIndicator
            size="small"
            color="#0468B1"
            style={styles.inlineLoader}
          />
        )}
        <ScrollView contentContainerStyle={styles.langContainer}>
          {officialLang && (
            <TouchableOpacity
              style={[
                styles.officialLangPill,
                selectedLang === officialLang.code &&
                  styles.officialLangPillSelected,
              ]}
              onPress={() => setSelectedLang(officialLang.code)}
            >
              <Text
                style={[
                  styles.officialLangText,
                  selectedLang === officialLang.code && styles.langTextSelected,
                ]}
              >
                {officialLang.code.toUpperCase()} — {officialLang.label}
              </Text>
              {selectedLang !== officialLang.code && (
                <Text style={styles.downloadIndicator}>{"↓"}</Text>
              )}
            </TouchableOpacity>
          )}
          <View style={styles.langGrid}>
            {UN_LANGUAGES.map((lang) => {
              const selected = selectedLang === lang.code;
              return (
                <TouchableOpacity
                  key={lang.code}
                  style={[styles.langPill, selected && styles.langPillSelected]}
                  onPress={() => setSelectedLang(lang.code)}
                >
                  <Text
                    style={[
                      styles.langPillText,
                      selected && styles.langTextSelected,
                    ]}
                  >
                    {lang.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            style={styles.moreLangsRow}
            onPress={() =>
              Alert.alert(
                "Coming Soon",
                "Additional languages will be available in a future update."
              )
            }
          >
            <Text style={styles.moreLangsIcon}>+</Text>
            <Text style={styles.moreLangsText}>More languages</Text>
          </TouchableOpacity>
        </ScrollView>
        <NextButton onPress={handleLanguageNext} disabled={!selectedLang} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader showBack onBack={() => setStep(2)} />
      <Text style={styles.tandcTitle}>{t("tandc.title")}</Text>
      <Text style={styles.tandcSubtitle}>{t("tandc.subtitle")}</Text>
      <ScrollView
        style={styles.tandcScroll}
        contentContainerStyle={styles.tandcScrollContent}
      >
        <Text style={styles.tandcBody}>{t("tandc.body")}</Text>
      </ScrollView>
      <View style={[styles.tandcButtons, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={styles.agreeButton} onPress={handleAgree}>
          <Text style={styles.agreeButtonText}>{t("tandc.agreeButton")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.declineButton} onPress={handleDecline}>
          <Text style={styles.declineButtonText}>{t("tandc.declineButton")}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: "bold",
    fontSize: 22,
    color: "#0468B1",
  },
  backArrow: { marginRight: 12 },
  backArrowText: { fontSize: 20, color: "#0468B1" },
  divider: { height: 1, backgroundColor: "#E0E0E0" },

  stepTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
    marginHorizontal: 24,
    marginTop: 20,
    marginBottom: 12,
  },

  searchInput: {
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 24,
    marginBottom: 12,
    fontSize: 15,
  },

  centeredLoader: { flex: 1 },
  inlineLoader: { marginHorizontal: 24, marginBottom: 8 },

  listContent: { paddingHorizontal: 24, paddingBottom: 8 },
  countryItem: {
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    marginBottom: 8,
    backgroundColor: "#FFFFFF",
    borderColor: "#E0E0E0",
  },
  countryItemSelected: {
    backgroundColor: "#0468B1",
    borderColor: "#0468B1",
  },
  countryItemText: {
    fontSize: 15,
    fontWeight: "500",
    color: "#333",
  },
  countryItemTextSelected: { color: "#FFFFFF" },

  bottomBar: { paddingHorizontal: 24, paddingTop: 12 },
  nextButton: {
    width: "100%",
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  nextButtonDisabled: { backgroundColor: "#B0C4D8" },
  nextButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },

  langContainer: { paddingHorizontal: 24, paddingBottom: 8 },
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
  officialLangText: { fontSize: 15, color: "#0468B1" },
  downloadIndicator: { fontSize: 14, color: "#0468B1" },

  langGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  langPill: {
    width: "47%",
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#0468B1",
    backgroundColor: "#FFFFFF",
  },
  langPillSelected: { backgroundColor: "#0468B1" },
  langPillText: { color: "#0468B1", fontSize: 15, fontWeight: "500" },
  langTextSelected: { color: "#FFFFFF" },

  moreLangsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingVertical: 12,
  },
  moreLangsIcon: { fontSize: 18, color: "#0468B1" },
  moreLangsText: { fontSize: 15, color: "#0468B1", marginLeft: 8 },

  tandcTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#333",
    marginHorizontal: 24,
    marginTop: 20,
  },
  tandcSubtitle: {
    fontSize: 14,
    color: "#666",
    marginHorizontal: 24,
    marginTop: 4,
    marginBottom: 16,
  },
  tandcScroll: { flex: 1 },
  tandcScrollContent: { paddingHorizontal: 24, paddingBottom: 16 },
  tandcBody: { fontSize: 14, color: "#555", lineHeight: 22 },

  tandcButtons: { paddingHorizontal: 24, paddingTop: 12 },
  agreeButton: {
    width: "100%",
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  agreeButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  declineButton: {
    width: "100%",
    height: 52,
    borderRadius: 28,
    backgroundColor: "#FFFFFF",
    borderWidth: 1.5,
    borderColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  declineButtonText: {
    color: "#0468B1",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});
