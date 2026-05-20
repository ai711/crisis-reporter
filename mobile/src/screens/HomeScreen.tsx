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
import api from "../services/api";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import SideMenu from "../components/SideMenu";

const API_URL = "https://crisis-reporter-production.up.railway.app";

// Module-level flag — survives navigation, ensures one check per app session
const packageSyncDone = { current: false };

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCrisisModal, setShowCrisisModal] = useState(false);
  const [showWelcomeCard, setShowWelcomeCard] = useState(false);
  const [activeCrisis, setActiveCrisis] = useState<{ name: string; crisis_type: string } | null>(null);

  // Login popup — show once until reporter_id exists
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

  // Welcome card — show on first visit only
  useEffect(() => {
    AsyncStorage.getItem("cr_welcome_dismissed").then((val) => {
      if (!val) setShowWelcomeCard(true);
    });
  }, []);

  // Queue count + NetInfo sync listener
  useEffect(() => {
    getQueueCount().then(setQueueCount);

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? false;
      setIsOnline(online);
      if (online) {
        syncQueue(API_URL).then(() => getQueueCount().then(setQueueCount));
      }
    });

    return () => unsubscribe();
  }, []);

  // Background question package version check — once per app session
  useEffect(() => {
    const syncQuestionPackage = async () => {
      if (packageSyncDone.current) return;
      packageSyncDone.current = true;

      const netState = await NetInfo.fetch();
      if (!netState.isConnected) return;

      try {
        const langCode = (await AsyncStorage.getItem("cr_language")) ?? "en";
        const response = await api.get(`/api/question-packages/active?lang=${langCode}`);
        const newPackage = response.data;

        const cached = await AsyncStorage.getItem("cr_question_package");
        const cachedParsed = cached ? JSON.parse(cached) : null;

        if (!cachedParsed || cachedParsed.version !== newPackage.version) {
          await AsyncStorage.setItem("cr_question_package", JSON.stringify(newPackage));
        }
      } catch {
        // Non-blocking — cached package will be used
      }
    };

    syncQuestionPackage();
  }, []);

  // Active crisis banner — best-effort, no loading state
  useEffect(() => {
    api
      .get("/api/crises/active")
      .then((res) => {
        if (Array.isArray(res.data) && res.data.length > 0) {
          setActiveCrisis(res.data[0]);
        }
      })
      .catch(() => {
        // Offline or no active crisis — no banner shown
      });
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const dismissWelcomeCard = async () => {
    await AsyncStorage.setItem("cr_welcome_dismissed", "true");
    setShowWelcomeCard(false);
  };

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

  const handleReportPress = () => {
    if (showWelcomeCard) dismissWelcomeCard();
    navigation.navigate("Report");
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* Header — white background, UNDP blue text */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setMenuOpen(true)}
          style={styles.menuBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.menuIcon}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.appName}>{t("app.name")}</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate("SettingsScreen")}
          style={styles.menuBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.settingsIcon}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* Active crisis banner */}
      {activeCrisis && (
        <View style={styles.crisisBanner}>
          <Text style={styles.crisisBannerText}>
            🚨 Active crisis: {activeCrisis.name} ({activeCrisis.crisis_type})
          </Text>
        </View>
      )}

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>

        {/* Welcome card — first visit only */}
        {showWelcomeCard && (
          <View style={styles.welcomeCard}>
            <Text style={styles.welcomeText}>{t("welcomeCard.body")}</Text>
            <TouchableOpacity style={styles.welcomeBtn} onPress={dismissWelcomeCard}>
              <Text style={styles.welcomeBtnText}>{t("welcomeCard.dismiss")}</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Powered by UNDP Crisis Response</Text>
          <View style={styles.statusRow}>
            <View style={[
              styles.statusDot,
              { backgroundColor: isOnline ? "#4caf50" : "#ff9800" },
            ]} />
            <Text style={styles.statusText}>
              {isOnline ? "Connected" : "Offline mode"}
            </Text>
          </View>
        </View>

        {/* Primary action */}
        <TouchableOpacity style={styles.reportButton} onPress={handleReportPress}>
          <Text style={styles.reportButtonIcon}>📋</Text>
          <Text style={styles.reportButtonText}>{t("home.reportButton")}</Text>
        </TouchableOpacity>

        {/* "What can I report?" link */}
        <TouchableOpacity
          onPress={() => setShowCrisisModal(true)}
          style={styles.whatLink}
        >
          <Text style={styles.whatLinkText}>{t("whatCanIReport.link")}</Text>
        </TouchableOpacity>

        {/* Pending sync counter — inline, below report button */}
        {queueCount > 0 && (
          <Text style={styles.pendingNote}>
            {queueCount === 1
              ? "1 report pending — waiting for internet connection."
              : `${queueCount} reports pending — waiting for internet connection.`}
          </Text>
        )}

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

      {/* Footer navigation — Home tab is always active on this screen */}
      <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.navItem}>
          <Text style={[styles.navIcon, styles.activeTabIcon]}>🏠</Text>
          <Text style={[styles.navLabel, styles.activeTabLabel]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("Map")}
        >
          <Text style={[styles.navIcon, styles.inactiveTabIcon]}>🗺️</Text>
          <Text style={[styles.navLabel, styles.inactiveTabLabel]}>Map</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("MyReports")}
        >
          <Text style={[styles.navIcon, styles.inactiveTabIcon]}>📁</Text>
          <Text style={[styles.navLabel, styles.inactiveTabLabel]}>My Reports</Text>
        </TouchableOpacity>
      </View>

      {/* Login popup modal */}
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

      {/* Side menu drawer */}
      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* "What can I report?" bottom sheet modal */}
      <Modal
        visible={showCrisisModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCrisisModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowCrisisModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("whatCanIReport.title")}</Text>
              <TouchableOpacity onPress={() => setShowCrisisModal(false)}>
                <Text style={styles.modalClose}>{t("whatCanIReport.close")} ✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {Object.values(
                t("whatCanIReport.types", { returnObjects: true }) as Record<
                  string,
                  { name: string; description: string }
                >
              ).map((type) => (
                <View key={type.name} style={styles.crisisTypeRow}>
                  <Text style={styles.crisisTypeName}>{type.name}</Text>
                  <Text style={styles.crisisTypeDesc}>{type.description}</Text>
                </View>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },

  // Header — white background, UNDP blue text
  header: {
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 8,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#E8EDF2",
  },
  menuBtn: { padding: 8, width: 44, justifyContent: "center" },
  menuIcon: { fontSize: 20, color: "#0468B1" },
  appName: { fontSize: 18, fontWeight: "700", color: "#0468B1" },
  settingsIcon: { fontSize: 22 },

  // Active crisis banner
  crisisBanner: {
    backgroundColor: "#FFF3E0",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#FFB74D",
  },
  crisisBannerText: {
    fontSize: 13,
    color: "#E65100",
    fontWeight: "500",
  },

  // Welcome card
  welcomeCard: {
    backgroundColor: "#E8F4FD",
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 0,
    marginBottom: 0,
    borderLeftWidth: 4,
    borderLeftColor: "#0468B1",
  },
  welcomeText: {
    fontSize: 14,
    color: "#333333",
    lineHeight: 20,
    marginBottom: 12,
  },
  welcomeBtn: {
    alignSelf: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#0468B1",
    borderRadius: 20,
  },
  welcomeBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },

  // Status card
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
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 13, color: "#666" },

  // Report button
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

  // "What can I report?" link
  whatLink: { alignItems: "center", marginTop: -8 },
  whatLinkText: { fontSize: 14, color: "#0468B1", textDecorationLine: "underline" },

  // Pending sync counter
  pendingNote: {
    fontSize: 13,
    color: "#E65100",
    textAlign: "center",
    marginTop: -4,
    marginHorizontal: 24,
  },

  // Secondary action buttons
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

  // Footer navigation
  bottomNav: {
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 8,
  },
  navItem: { alignItems: "center", padding: 8, minWidth: 64 },
  navIcon: { fontSize: 20 },
  navLabel: { fontSize: 11, marginTop: 4 },
  activeTabLabel: { color: "#0468B1", fontWeight: "600" },
  activeTabIcon: { color: "#0468B1" },
  inactiveTabLabel: { color: "#999" },
  inactiveTabIcon: { color: "#999" },

  // Login popup
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
  popupButtons: { marginTop: 20, gap: 12 },
  popupBtnPrimary: {
    backgroundColor: "#0468B1",
    borderRadius: 28,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
  },
  popupBtnPrimaryText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  popupBtnSecondary: {
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    height: 52,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#0468B1",
  },
  popupBtnSecondaryText: { color: "#0468B1", fontSize: 16, fontWeight: "600" },
  popupBtnSkip: { height: 44, justifyContent: "center", alignItems: "center" },
  popupBtnSkipText: { color: "#888888", fontSize: 15 },

  // "What can I report?" bottom sheet
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: "bold", color: "#333333" },
  modalClose: { fontSize: 14, color: "#0468B1" },
  crisisTypeRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  crisisTypeName: {
    fontSize: 15,
    fontWeight: "600",
    color: "#333333",
    marginBottom: 2,
  },
  crisisTypeDesc: { fontSize: 13, color: "#666666", lineHeight: 18 },
});
