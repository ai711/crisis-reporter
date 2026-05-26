import { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Modal, ActivityIndicator, Dimensions, Animated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { getQueueCount, syncQueue, onQueueChange } from "../utils/offlineQueue";
import { registerAnonymously } from "../services/auth";
import api from "../services/api";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import SideMenu from "../components/SideMenu";
import { loadDynamicLanguagePackage } from "../i18n";

const { width: screenWidth } = Dimensions.get("window");
const scale = (size: number) => Math.round((screenWidth / 375) * size);

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

  const reportBtnScale = useRef(new Animated.Value(1)).current;

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

  // Queue count + NetInfo sync listener + reactive queue change subscription
  useEffect(() => {
    getQueueCount().then(setQueueCount);

    const unsubscribeQueue = onQueueChange((count) => {
      setQueueCount(count);
    });

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? false;
      setIsOnline(online);
      if (online) {
        syncQueue(API_URL).then(() => getQueueCount().then(setQueueCount));
      }
    });

    return () => {
      unsubscribeQueue();
      unsubscribeNet();
    };
  }, []);

  // Background version check — questions + language package, once per app session
  useEffect(() => {
    const checkVersionsAndSync = async () => {
      if (packageSyncDone.current) return;
      packageSyncDone.current = true;

      const netState = await NetInfo.fetch();
      if (!netState.isConnected) return;

      const langCode = (await AsyncStorage.getItem("cr_language")) ?? "en";

      // Question package: version-gate on content_version
      try {
        const versionRes = await api.get("/api/question-packages/version");
        const latestContent = String(versionRes.data.content_version ?? versionRes.data.version ?? "");
        const cachedContent = await AsyncStorage.getItem("cr_question_content_version");
        if (latestContent && latestContent !== cachedContent) {
          const pkgRes = await api.get(`/api/question-packages/active?lang=${langCode}`);
          await AsyncStorage.setItem("cr_question_package", JSON.stringify(pkgRes.data));
          await AsyncStorage.setItem("cr_question_content_version", latestContent);
        }
      } catch {
        // Non-blocking — cached package will be used
      }

      // Language package: version-gate on lang version
      if (langCode !== "en") {
        try {
          const langVerRes = await api.get(`/api/language-packages/${langCode}/version`);
          const latestLangVer = String(langVerRes.data.version ?? "");
          const cachedLangVer = await AsyncStorage.getItem(`cr_lang_version_${langCode}`);
          if (latestLangVer && latestLangVer !== cachedLangVer) {
            const langPkgRes = await api.get(`/api/language-packages/active/${langCode}`);
            await AsyncStorage.setItem(`cr_lang_package_${langCode}`, JSON.stringify(langPkgRes.data));
            await AsyncStorage.setItem(`cr_lang_version_${langCode}`, latestLangVer);
            await loadDynamicLanguagePackage(langCode);
          }
        } catch {
          // Non-blocking — cached language package will be used
        }
      }
    };

    checkVersionsAndSync();
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

  const handleReportPressIn = () => {
    Animated.spring(reportBtnScale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 50,
      bounciness: 0,
    }).start();
  };

  const handleReportPressOut = () => {
    Animated.spring(reportBtnScale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => setMenuOpen(true)}
          style={styles.iconBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.menuIcon}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.appName}>{t("app.name")}</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate("SettingsScreen")}
          style={styles.iconBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.settingsIcon}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Active crisis banner */}
      {activeCrisis && (
        <View style={styles.crisisBanner}>
          <Text style={styles.crisisBannerEmoji}>🚨</Text>
          <Text style={styles.crisisBannerText}>
            Active crisis: {activeCrisis.name} ({activeCrisis.crisis_type})
          </Text>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* Headline group */}
        <Text style={styles.headline}>Ready to report?</Text>
        <Text style={styles.subtitle}>Help UNDP map damage in your area</Text>

        {/* Existing functional: welcome card */}
        {showWelcomeCard && (
          <View style={styles.welcomeCard}>
            <Text style={styles.welcomeText}>{t("welcomeCard.body")}</Text>
            <TouchableOpacity style={styles.welcomeBtn} onPress={dismissWelcomeCard}>
              <Text style={styles.welcomeBtnText}>{t("welcomeCard.dismiss")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Existing functional: connectivity status card */}
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Powered by UNDP Crisis Response</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: isOnline ? "#38A169" : "#F5A623" }]} />
            <Text style={styles.statusText}>{isOnline ? "Connected" : "Offline mode"}</Text>
          </View>
        </View>

        {/* Gap between headline group and button area */}
        <View style={{ height: 32 }} />

        {/* Offline sync amber banner — shown when queue > 0 */}
        {queueCount > 0 && (
          <View style={styles.syncBanner}>
            <Text style={styles.syncBannerIcon}>⚠</Text>
            <Text style={styles.syncBannerText}>
              {queueCount} {queueCount === 1 ? "report" : "reports"} waiting to sync — connect to internet to upload
            </Text>
          </View>
        )}

        {/* Primary report button */}
        <Animated.View style={[styles.reportBtnWrapper, { transform: [{ scale: reportBtnScale }] }]}>
          <TouchableOpacity
            style={styles.reportButton}
            onPress={handleReportPress}
            onPressIn={handleReportPressIn}
            onPressOut={handleReportPressOut}
            activeOpacity={1}
          >
            <Text style={styles.reportButtonIcon}>📷</Text>
            <Text style={styles.reportButtonText}>{t("home.reportButton")}</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Sync status row — shown when queue is empty */}
        {queueCount === 0 && (
          <View style={styles.syncStatusRow}>
            <View style={styles.syncGreenDot} />
            <Text style={styles.syncStatusText}>NO REPORTS PENDING SYNC</Text>
          </View>
        )}

        {/* Existing functional: "What can I report?" link */}
        <TouchableOpacity
          onPress={() => setShowCrisisModal(true)}
          style={styles.whatLink}
        >
          <Text style={styles.whatLinkText}>{t("whatCanIReport.link")}</Text>
        </TouchableOpacity>

        {/* Existing functional: secondary navigation buttons */}
        <View style={styles.secondaryActions}>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate("Map")}
          >
            <Text style={styles.secondaryButtonText}>🗺️  View Map</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate("MyReports")}
          >
            <Text style={styles.secondaryButtonText}>
              📁  {t("home.myReports")}
            </Text>
          </TouchableOpacity>
        </View>

      </ScrollView>

      {/* Bottom navigation — Home tab is always active on this screen */}
      <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.navItem}>
          <View style={styles.activeNavPill}>
            <Text style={styles.navIconActive}>🏠</Text>
            <Text style={styles.navLabelActive}>HOME</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("Map")}
        >
          <Text style={styles.navIconInactive}>🗺</Text>
          <Text style={styles.navLabelInactive}>MAP</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("MyReports")}
        >
          <Text style={styles.navIconInactive}>📋</Text>
          <Text style={styles.navLabelInactive}>REPORTS</Text>
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

  // ── Root ─────────────────────────────────────────────────────────────────────
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  // ── Header ───────────────────────────────────────────────────────────────────
  header: {
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingHorizontal: screenWidth * 0.06,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  menuIcon: {
    fontSize: scale(22),
    color: "#49454F",
  },
  settingsIcon: {
    fontSize: scale(22),
    color: "#49454F",
  },
  appName: {
    flex: 1,
    fontSize: scale(18),
    fontWeight: "700",
    color: "#0468B1",
    textAlign: "center",
  },

  // ── Active crisis banner ──────────────────────────────────────────────────────
  crisisBanner: {
    backgroundColor: "#FFF3E0",
    paddingHorizontal: screenWidth * 0.06,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#FFB74D",
  },
  crisisBannerEmoji: {
    fontSize: scale(14),
  },
  crisisBannerText: {
    flex: 1,
    fontSize: scale(13),
    color: "#E65100",
    fontWeight: "500",
    lineHeight: scale(13) * 1.5,
  },

  // ── Scroll area ───────────────────────────────────────────────────────────────
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: screenWidth * 0.06,
    paddingVertical: 24,
  },

  // ── Headline group ────────────────────────────────────────────────────────────
  headline: {
    fontSize: scale(32),
    fontWeight: "900",
    color: "#1B1C1C",
    textAlign: "center",
    letterSpacing: -0.5,
    alignSelf: "center",
  },
  subtitle: {
    fontSize: scale(16),
    fontWeight: "400",
    color: "#414751",
    textAlign: "center",
    marginTop: 8,
    maxWidth: screenWidth * 0.7,
    lineHeight: scale(16) * 1.5,
    alignSelf: "center",
  },

  // ── Welcome card (existing functional) ───────────────────────────────────────
  welcomeCard: {
    backgroundColor: "#E8F4FD",
    borderRadius: 16,
    padding: 16,
    marginTop: 20,
    borderLeftWidth: 4,
    borderLeftColor: "#0468B1",
    width: "100%",
  },
  welcomeText: {
    fontSize: scale(14),
    color: "#414751",
    lineHeight: scale(14) * 1.5,
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
    fontSize: scale(13),
    fontWeight: "600",
  },

  // ── Status card (existing functional) ────────────────────────────────────────
  statusCard: {
    backgroundColor: "#F6F3F2",
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
    width: "100%",
  },
  statusTitle: {
    fontSize: scale(12),
    color: "#717782",
    fontWeight: "500",
    letterSpacing: 0.3,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: scale(13),
    color: "#414751",
    fontWeight: "500",
  },

  // ── Amber sync banner (queue > 0) ─────────────────────────────────────────────
  syncBanner: {
    backgroundColor: "#F5A623",
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
    width: screenWidth * 0.88,
  },
  syncBannerIcon: {
    fontSize: scale(20),
    color: "#291800",
  },
  syncBannerText: {
    flex: 1,
    fontSize: scale(13),
    fontWeight: "700",
    color: "#291800",
    lineHeight: scale(13) * 1.5,
  },

  // ── Report button ─────────────────────────────────────────────────────────────
  reportBtnWrapper: {
    width: screenWidth * 0.88,
    alignSelf: "center",
  },
  reportButton: {
    backgroundColor: "#0468B1",
    height: 56,
    borderRadius: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#0468B1",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 4,
  },
  reportButtonIcon: {
    fontSize: scale(20),
  },
  reportButtonText: {
    color: "#FFFFFF",
    fontSize: scale(16),
    fontWeight: "700",
  },

  // ── Sync status row (queue === 0) ─────────────────────────────────────────────
  syncStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 12,
  },
  syncGreenDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#38A169",
  },
  syncStatusText: {
    fontSize: scale(10),
    fontWeight: "600",
    color: "#717782",
    letterSpacing: 1.5,
  },

  // ── "What can I report?" link ─────────────────────────────────────────────────
  whatLink: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    marginTop: 16,
  },
  whatLinkText: {
    fontSize: scale(14),
    color: "#0468B1",
    textDecorationLine: "underline",
  },

  // ── Secondary action buttons (existing functional) ────────────────────────────
  secondaryActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
    width: "100%",
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: "#F6F3F2",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  secondaryButtonText: {
    fontSize: scale(14),
    fontWeight: "500",
    color: "#414751",
  },

  // ── Bottom navigation ─────────────────────────────────────────────────────────
  bottomNav: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    paddingTop: 12,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 8,
  },
  navItem: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
    minHeight: 44,
  },
  activeNavPill: {
    backgroundColor: "rgba(4,104,177,0.1)",
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 6,
    alignItems: "center",
    gap: 2,
  },
  navIconActive: {
    fontSize: scale(24),
    color: "#0468B1",
  },
  navLabelActive: {
    fontSize: scale(10),
    fontWeight: "600",
    color: "#0468B1",
    letterSpacing: 1.2,
  },
  navIconInactive: {
    fontSize: scale(24),
    color: "#6B7280",
  },
  navLabelInactive: {
    fontSize: scale(10),
    fontWeight: "500",
    color: "#6B7280",
    letterSpacing: 1.2,
    marginTop: 2,
  },

  // ── Login popup ───────────────────────────────────────────────────────────────
  popupOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  popupCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    padding: 24,
    width: screenWidth - 48,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  popupTitle: {
    fontSize: scale(18),
    fontWeight: "700",
    color: "#1B1C1C",
    textAlign: "center",
    marginBottom: 8,
  },
  popupBody: {
    fontSize: scale(14),
    color: "#717782",
    textAlign: "center",
    lineHeight: scale(14) * 1.5,
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
    fontSize: scale(16),
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
    fontSize: scale(16),
    fontWeight: "600",
  },
  popupBtnSkip: {
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  popupBtnSkipText: {
    color: "#717782",
    fontSize: scale(14),
  },

  // ── "What can I report?" bottom sheet ────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: "80%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: scale(18),
    fontWeight: "700",
    color: "#1B1C1C",
  },
  modalClose: {
    fontSize: scale(14),
    color: "#0468B1",
  },
  crisisTypeRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#F6F3F2",
  },
  crisisTypeName: {
    fontSize: scale(15),
    fontWeight: "600",
    color: "#1B1C1C",
    marginBottom: 2,
  },
  crisisTypeDesc: {
    fontSize: scale(13),
    color: "#717782",
    lineHeight: scale(13) * 1.5,
  },
});
