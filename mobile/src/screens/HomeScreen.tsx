import { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Modal, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { getQueueCount, syncQueue } from "../utils/offlineQueue";
import { registerAnonymously } from "../services/auth";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_URL = "https://crisis-reporter-production.up.railway.app";

interface HomeScreenProps {
  navigation: any;
}

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { isVerified } = useAuthStore();
  const [queueCount, setQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [showLoginPopup, setShowLoginPopup] = useState(false);
  const [popupLoading, setPopupLoading] = useState(false);

  useEffect(() => {
    const checkPopup = async () => {
      const reporterId = await SecureStore.getItemAsync("cr_reporter_id");
      const popupShown = await AsyncStorage.getItem("cr_popup_shown");
      if (!reporterId && !popupShown) {
        setShowLoginPopup(true);
      }
    };
    checkPopup();
  }, []);

  const dismissPopup = async () => {
    await AsyncStorage.setItem("cr_popup_shown", "true");
    setShowLoginPopup(false);
  };

  const handleSkip = async () => {
    setPopupLoading(true);
    await dismissPopup();
    await registerAnonymously();
    setPopupLoading(false);
  };

  const handleLogIn = async () => {
    await dismissPopup();
    navigation.navigate("LoginScreen");
  };

  const handleCreateAccount = async () => {
    setPopupLoading(true);
    await dismissPopup();
    await registerAnonymously();
    setPopupLoading(false);
    navigation.navigate("ReporterProfileScreen");
  };

  useEffect(() => {
    getQueueCount().then(setQueueCount);

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? false;
      setIsOnline(online);
      if (online) {
        syncQueue(API_URL).then(() =>
          getQueueCount().then(setQueueCount)
        );
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.logo}>🆘</Text>
          <Text style={styles.appName}>{t("app.name")}</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate("Settings")}>
          <Text style={styles.settingsIcon}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* Offline banner */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>📵 {t("offline.banner")}</Text>
        </View>
      )}

      {/* Queue banner */}
      {queueCount > 0 && (
        <View style={styles.queueBanner}>
          <Text style={styles.queueBannerText}>
            🔄 {t("home.queuedReports", { count: queueCount })}
          </Text>
        </View>
      )}

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Powered by UNDP Crisis Response</Text>
          <View style={styles.statusRow}>
            <View style={[
              styles.statusDot,
              { backgroundColor: isOnline ? "#4caf50" : "#ff9800" }
            ]} />
            <Text style={styles.statusText}>
              {isOnline ? "Connected" : "Offline mode"}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.reportButton}
          onPress={() => navigation.navigate("Report")}
        >
          <Text style={styles.reportButtonIcon}>📋</Text>
          <Text style={styles.reportButtonText}>{t("home.reportButton")}</Text>
        </TouchableOpacity>

        <View style={styles.secondaryActions}>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate("Map")}
          >
            <Text style={styles.secondaryButtonText}>🗺️ View Map</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate("MyReports")}
          >
            <Text style={styles.secondaryButtonText}>
              📁 {t("home.myReports")}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Bottom nav */}
      <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.navItem}>
          <Text style={styles.navIcon}>🏠</Text>
          <Text style={styles.navLabel}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("Map")}
        >
          <Text style={styles.navIcon}>🗺️</Text>
          <Text style={styles.navLabel}>Map</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("MyReports")}
        >
          <Text style={styles.navIcon}>📁</Text>
          <Text style={styles.navLabel}>Reports</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showLoginPopup}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.popupOverlay}>
          <View style={styles.popupCard}>
            <Text style={styles.popupTitle}>{t("loginPopup.title")}</Text>
            <Text style={styles.popupBody}>{t("loginPopup.body")}</Text>

            {popupLoading ? (
              <ActivityIndicator color="#0468B1" style={{ marginTop: 24 }} />
            ) : (
              <View style={styles.popupButtons}>
                <TouchableOpacity style={styles.popupBtnPrimary} onPress={handleLogIn}>
                  <Text style={styles.popupBtnPrimaryText}>{t("loginPopup.loginButton")}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.popupBtnSecondary} onPress={handleCreateAccount}>
                  <Text style={styles.popupBtnSecondaryText}>{t("loginPopup.createButton")}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.popupBtnSkip} onPress={handleSkip}>
                  <Text style={styles.popupBtnSkipText}>{t("loginPopup.skipButton")}</Text>
                </TouchableOpacity>
              </View>
            )}
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
    justifyContent: "space-between",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { fontSize: 24 },
  appName: { color: "#fff", fontSize: 18, fontWeight: "700" },
  settingsIcon: { fontSize: 22 },
  offlineBanner: {
    backgroundColor: "#ff9800",
    padding: 10,
    alignItems: "center",
  },
  offlineBannerText: { color: "#fff", fontSize: 13 },
  queueBanner: {
    backgroundColor: "#0468B1",
    padding: 10,
    alignItems: "center",
  },
  queueBannerText: { color: "#fff", fontSize: 13 },
  content: { flex: 1 },
  contentContainer: { padding: 16, gap: 16 },
  statusCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  statusTitle: { fontSize: 14, color: "#666", fontWeight: "500" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 13, color: "#666" },
  reportButton: {
    backgroundColor: "#0468B1",
    borderRadius: 12,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    shadowColor: "#0468B1",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 4,
  },
  reportButtonIcon: { fontSize: 24 },
  reportButtonText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  secondaryActions: { flexDirection: "row", gap: 12 },
  secondaryButton: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e0e0e0",
  },
  secondaryButtonText: { fontSize: 14, fontWeight: "500", color: "#1A2B4A" },
  bottomNav: {
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 8,
  },
  navItem: { alignItems: "center", padding: 8 },
  navIcon: { fontSize: 20 },
  navLabel: { fontSize: 11, color: "#666", marginTop: 4 },

  popupOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  popupCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 24,
    marginHorizontal: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  popupTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#333333",
    textAlign: "center",
    marginBottom: 8,
  },
  popupBody: {
    fontSize: 14,
    color: "#666666",
    textAlign: "center",
    lineHeight: 20,
  },
  popupButtons: {
    marginTop: 20,
    gap: 12,
  },
  popupBtnPrimary: {
    backgroundColor: "#0468B1",
    borderRadius: 28,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
  },
  popupBtnPrimaryText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  popupBtnSecondary: {
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#0468B1",
  },
  popupBtnSecondaryText: {
    color: "#0468B1",
    fontSize: 16,
    fontWeight: "600",
  },
  popupBtnSkip: {
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  popupBtnSkipText: {
    color: "#888888",
    fontSize: 15,
  },
});