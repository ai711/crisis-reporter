import { useState } from "react";
import {
  View, Text, TouchableOpacity, TextInput,
  ScrollView, StyleSheet, ActivityIndicator, Alert
} from "react-native";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { createAnonymousSession } from "../services/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const COUNTRIES = [
  { code: "AF", name: "Afghanistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "CM", name: "Cameroon" },
  { code: "CD", name: "Congo (DRC)" },
  { code: "ET", name: "Ethiopia" },
  { code: "GT", name: "Guatemala" },
  { code: "HT", name: "Haiti" },
  { code: "IN", name: "India" },
  { code: "IQ", name: "Iraq" },
  { code: "KE", name: "Kenya" },
  { code: "LB", name: "Lebanon" },
  { code: "LY", name: "Libya" },
  { code: "MM", name: "Myanmar" },
  { code: "NP", name: "Nepal" },
  { code: "NG", name: "Nigeria" },
  { code: "PK", name: "Pakistan" },
  { code: "PH", name: "Philippines" },
  { code: "SO", name: "Somalia" },
  { code: "SS", name: "South Sudan" },
  { code: "SY", name: "Syria" },
  { code: "TR", name: "Turkey" },
  { code: "UA", name: "Ukraine" },
  { code: "YE", name: "Yemen" },
];

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

export default function OnboardingScreen() {
  const { t, i18n } = useTranslation();
  const { setCountry, setLanguage, setOnboarded, setReporter } = useAuthStore();

  const [step, setStep] = useState<"country" | "language">("country");
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const insets = useSafeAreaInsets();

  const filteredCountries = COUNTRIES.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

    const handleFinish = async () => {
    setLoading(true);
    try {
      console.log("Attempting to connect to:", process.env.EXPO_PUBLIC_API_URL);
      const session = await createAnonymousSession(
        selectedCountry,
        selectedLanguage
      );
      setReporter(session.reporter_id, session.is_verified);
      setCountry(selectedCountry);
      setLanguage(selectedLanguage);
      setOnboarded();
    } catch (error) {
      console.log("Connection error:", error);
      Alert.alert(
        "Connection Error",
        `Could not connect to: ${process.env.EXPO_PUBLIC_API_URL || "no URL set"}. Error: ${error}`
      );
    } finally {
      setLoading(false);
    }
    };

  const handleLanguageSelect = async (code: string) => {
    setSelectedLanguage(code);
    i18n.changeLanguage(code);
    await AsyncStorage.setItem("cr_language", code);
  };

  if (step === "country") {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.logo}>🆘</Text>
          <Text style={styles.appName}>Crisis Reporter</Text>
          <Text style={styles.subtitle}>UNDP Crisis Damage Reporting</Text>
        </View>

        <View style={styles.content}>
          <Text style={styles.stepTitle}>{t("onboarding.selectCountry")}</Text>

          <TextInput
            style={styles.searchInput}
            placeholder={t("onboarding.countryPlaceholder")}
            value={search}
            onChangeText={setSearch}
          />

          <ScrollView style={styles.listContainer}>
            {filteredCountries.map((country) => (
              <TouchableOpacity
                key={country.code}
                style={[
                  styles.listItem,
                  selectedCountry === country.code && styles.listItemSelected,
                ]}
                onPress={() => setSelectedCountry(country.code)}
              >
                <Text style={styles.listItemText}>{country.name}</Text>
                {selectedCountry === country.code && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>

          <TouchableOpacity
            style={[
              styles.primaryButton,
              !selectedCountry && styles.buttonDisabled,
            ]}
            onPress={() => selectedCountry && setStep("language")}
            disabled={!selectedCountry}
          >
            <Text style={styles.primaryButtonText}>
              {t("onboarding.continue")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.logo}>🆘</Text>
        <Text style={styles.appName}>Crisis Reporter</Text>
        <Text style={styles.subtitle}>UNDP Crisis Damage Reporting</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.stepTitle}>{t("onboarding.selectLanguage")}</Text>

        <View style={styles.languageGrid}>
          {LANGUAGES.map((lang) => (
            <TouchableOpacity
              key={lang.code}
              style={[
                styles.languageItem,
                selectedLanguage === lang.code && styles.languageItemSelected,
              ]}
              onPress={() => handleLanguageSelect(lang.code)}
            >
              <Text style={[
                styles.languageText,
                selectedLanguage === lang.code && styles.languageTextSelected,
              ]}>
                {lang.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.buttonDisabled]}
          onPress={handleFinish}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {t("onboarding.continue")}
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.backButton}
          onPress={() => setStep("country")}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },
  header: {
    backgroundColor: "#1A2B4A",
    padding: 40,
    alignItems: "center",
  },
  logo: { fontSize: 48, marginBottom: 12 },
  appName: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: { color: "#A0B4CC", fontSize: 14 },
  content: { flex: 1, padding: 16, gap: 16 },
  stepTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: "#1A2B4A",
    marginBottom: 8,
  },
  searchInput: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    padding: 12,
    fontSize: 16,
  },
  listContainer: { flex: 1, maxHeight: 300 },
  listItem: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    padding: 14,
    marginBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  listItemSelected: {
    borderColor: "#0468B1",
    backgroundColor: "#E8F4FD",
  },
  listItemText: { fontSize: 16, color: "#1A2B4A" },
  checkmark: { color: "#0468B1", fontWeight: "700", fontSize: 18 },
  languageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  languageItem: {
    width: "47%",
    padding: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  languageItemSelected: {
    borderColor: "#0468B1",
    backgroundColor: "#0468B1",
  },
  languageText: { fontSize: 15, fontWeight: "500", color: "#1A2B4A" },
  languageTextSelected: { color: "#fff" },
  primaryButton: {
    backgroundColor: "#0468B1",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  backButton: { alignItems: "center", padding: 12 },
  backButtonText: { color: "#666", fontSize: 15 },
});