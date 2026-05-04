import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuthStore } from "../stores/authStore";
import { logoutReporter } from "../services/auth";

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

interface SettingsScreenProps {
  navigation: any;
}

export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const { t, i18n } = useTranslation();
  const { languageCode, countryCode, isVerified, setLanguage, reset } = useAuthStore();

  const handleLanguageChange = async (code: string) => {
    setLanguage(code);
    i18n.changeLanguage(code);
    await AsyncStorage.setItem("cr_language", code);
  };

  const handleLogout = async () => {
    await logoutReporter();
    reset();
  };

  return (
    <View style={styles.container}>
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
              { backgroundColor: isVerified ? "#d4edda" : "#E8F4FD" }
            ]}>
              <Text style={[
                styles.badgeText,
                { color: isVerified ? "#155724" : "#0468B1" }
              ]}>
                {isVerified ? "Verified" : "Anonymous"}
              </Text>
            </View>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>{t("settings.country")}</Text>
            <Text style={styles.value}>{countryCode || "—"}</Text>
          </View>
        </View>

        {/* Language */}
        <Text style={styles.sectionTitle}>{t("settings.language")}</Text>
        <View style={styles.languageGrid}>
          {LANGUAGES.map((lang) => (
            <TouchableOpacity
              key={lang.code}
              style={[
                styles.langBtn,
                languageCode === lang.code && styles.langBtnSelected,
              ]}
              onPress={() => handleLanguageChange(lang.code)}
            >
              <Text style={[
                styles.langBtnText,
                languageCode === lang.code && styles.langBtnTextSelected,
              ]}>
                {lang.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Logout */}
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutBtnText}>
            {t("settings.logout")} / Reset App
          </Text>
        </TouchableOpacity>
      </ScrollView>
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
  },
  label: { fontSize: 15, color: "#1A2B4A" },
  value: { fontSize: 15, color: "#666" },
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
});