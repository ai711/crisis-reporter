import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerReporter } from "../services/auth";
import { useAuthStore } from "../stores/authStore";

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const setReporter = useAuthStore((s) => s.setReporter);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleRegister = async () => {
    if (!email.trim() || !password) {
      setError(t("login.validation") || "Please fill in all required fields");
      return;
    }
    if (password !== confirmPassword) {
      setError(t("register.password_mismatch") || "Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError(t("register.password_too_short") || "Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const countryCode = (await AsyncStorage.getItem("cr_country_code")) ?? "US";
      const languageCode = (await AsyncStorage.getItem("cr_language")) ?? "en";
      const tokens = await registerReporter(email.trim(), password, countryCode, languageCode);
      setReporter(String(tokens.reporter_id), tokens.is_verified);
      navigation.goBack();
      navigation.goBack();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400) {
        setError(err?.response?.data?.detail ?? (t("register.email_taken") || "Email already registered"));
      } else {
        setError(t("register.error") || "Registration failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>{t("common.back")}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("register.title") || "Create Account"}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>
          {t("register.hint") || "No email verification required. You can log in on any platform immediately after creating your account."}
        </Text>

        <TextInput
          style={styles.input}
          placeholder={t("login.emailPlaceholder") || "Email address"}
          placeholderTextColor="#999"
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
          autoComplete="email"
        />

        <View style={styles.passwordWrap}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder={t("login.passwordPlaceholder") || "Password (min 8 characters)"}
            placeholderTextColor="#999"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={setPassword}
            autoComplete="new-password"
          />
          <TouchableOpacity onPress={() => setShowPassword((v) => !v)} style={styles.eyeToggle}>
            <Text style={styles.eyeToggleText}>{showPassword ? t("common.hide") || "Hide" : t("common.show") || "Show"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.passwordWrap}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder={t("register.confirm_password") || "Confirm password"}
            placeholderTextColor="#999"
            secureTextEntry={!showConfirm}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            autoComplete="new-password"
          />
          <TouchableOpacity onPress={() => setShowConfirm((v) => !v)} style={styles.eyeToggle}>
            <Text style={styles.eyeToggleText}>{showConfirm ? t("common.hide") || "Hide" : t("common.show") || "Show"}</Text>
          </TouchableOpacity>
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[
            styles.registerBtn,
            (!email || !password || !confirmPassword || loading) && styles.registerBtnDisabled,
          ]}
          onPress={handleRegister}
          disabled={!email || !password || !confirmPassword || loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.registerBtnText}>{t("register.submit_btn") || "Create Account"}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.loginLink}>
          <Text style={styles.loginLinkText}>
            {t("register.already_have_account") || "Already have an account?"}{" "}
            <Text style={styles.loginLinkBold}>{t("login.title") || "Log In"}</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E0E0E0",
  },
  backBtn: { width: 60 },
  backText: { color: "#0468B1", fontSize: 15 },
  headerTitle: { fontSize: 18, fontWeight: "bold", color: "#333" },
  form: { padding: 24, gap: 14 },
  hint: {
    fontSize: 14,
    color: "#718096",
    lineHeight: 20,
    marginBottom: 6,
  },
  input: {
    height: 52,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    color: "#333",
    backgroundColor: "#fff",
  },
  passwordWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 8,
    overflow: "hidden",
  },
  eyeToggle: {
    paddingHorizontal: 14,
    height: 52,
    justifyContent: "center",
    backgroundColor: "#F7FAFC",
    borderLeftWidth: 1,
    borderLeftColor: "#E0E0E0",
  },
  eyeToggleText: { color: "#0468B1", fontSize: 13, fontWeight: "600" },
  errorText: { color: "#D32F2F", fontSize: 14 },
  registerBtn: {
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  registerBtnDisabled: { backgroundColor: "#B0C4D8" },
  registerBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  loginLink: { alignItems: "center", marginTop: 12 },
  loginLinkText: { fontSize: 14, color: "#718096", textAlign: "center" },
  loginLinkBold: { color: "#0468B1", fontWeight: "600" },
});
