import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { loginReporter } from "../services/auth";
import { useAuthStore } from "../stores/authStore";

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setReporter = useAuthStore((s) => s.setReporter);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    try {
      // loginReporter calls the correct endpoint, stores access + refresh tokens
      // via tokenStorage.setTokens(), and returns the full AuthTokens payload.
      const tokens = await loginReporter(email, password);
      setReporter(tokens.reporter_id, tokens.is_verified);
      navigation.goBack();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 404) {
        setError(t("login.errorInvalid"));
      } else {
        setError(t("login.errorGeneric"));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = () => {
    Alert.alert(
      t("login.forgotPassword"),
      t("login.forgotPasswordMessage")
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>{t("common.back")}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("login.title")}</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder={t("login.emailPlaceholder")}
          placeholderTextColor="#999"
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder={t("login.passwordPlaceholder")}
          placeholderTextColor="#999"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[
            styles.loginBtn,
            (!email || !password || loading) && styles.loginBtnDisabled,
          ]}
          onPress={handleLogin}
          disabled={!email || !password || loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.loginBtnText}>{t("login.loginButton")}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={handleForgotPassword} style={styles.forgotBtn}>
          <Text style={styles.forgotText}>{t("login.forgotPassword")}</Text>
        </TouchableOpacity>

        <View style={styles.registerRow}>
          <Text style={styles.registerRowText}>
            {t("login.no_account") || "Don't have an account?"}
          </Text>
          <TouchableOpacity onPress={() => (navigation as any).navigate("RegisterScreen")}>
            <Text style={styles.registerLink}>{t("register.title") || "Create Account"}</Text>
          </TouchableOpacity>
        </View>
      </View>
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
  form: { padding: 24, gap: 12 },
  input: {
    height: 52,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    color: "#333",
  },
  errorText: { color: "#D32F2F", fontSize: 14, marginTop: 4 },
  loginBtn: {
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  loginBtnDisabled: { backgroundColor: "#B0C4D8" },
  loginBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  forgotBtn: { alignItems: "center", marginTop: 8 },
  forgotText: { color: "#0468B1", fontSize: 14 },
  registerRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 20, gap: 4, flexWrap: "wrap" },
  registerRowText: { fontSize: 14, color: "#718096" },
  registerLink: { fontSize: 14, color: "#0468B1", fontWeight: "600" },
});
