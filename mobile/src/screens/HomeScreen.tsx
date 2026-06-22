import { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Modal, ActivityIndicator, Dimensions, Animated,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { getQueueCount, syncQueue, onQueueChange, resetStuckItems } from "../utils/offlineQueue";
import { registerAnonymously } from "../services/auth";
import api, { API_BASE } from "../services/api";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import SideMenu from "../components/SideMenu";
import { fetchLanguagePackageFromBackend } from "../i18n";
const { width: _screenWidthRaw } = Dimensions.get("window");
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round((screenWidth / 375) * size);

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
  const [recentReports, setRecentReports] = useState<any[]>([]);
  const reportBtnScale = useRef(new Animated.Value(1)).current;

  // Login popup — show once until reporter_id exists; also fetch recent reports.
  useEffect(() => {
    const checkPopup = async () => {
      const reporterId = await SecureStore.getItemAsync("cr_reporter_id");
      const popupShown = await AsyncStorage.getItem("cr_popup_shown");
      if (!reporterId && !popupShown) {
        setShowLoginPopup(true);
      }
      // Fetch recent reports for logged-in (non-anonymous) reporters.
      const isAnon = !reporterId || reporterId.startsWith("CR-PENDING-");
      if (!isAnon) {
        try {
          const res = await api.get("/api/reports/my", { params: { limit: 3 } });
          const items = res.data?.items ?? res.data?.reports ?? res.data ?? [];
          setRecentReports(Array.isArray(items) ? items.slice(0, 3) : []);
        } catch {
          // Non-critical — silently ignore
        }
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

    // Reset any items stuck in "syncing" from a prior session that was killed
    // mid-flight — must run before the NetInfo listener fires so the sync pass
    // picks them up as "pending" rather than skipping them.
    resetStuckItems().catch(() => { /* non-critical */ });

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? false;
      setIsOnline(online);
      if (online) {
        syncQueue(API_BASE).then(() => getQueueCount().then(setQueueCount));
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

      // Question package: version-gate on content_version (language-aware cache keys)
      try {
        const pkgCacheKey = `cr_question_package_${langCode}`;
        const versionCacheKey = `cr_question_content_version_${langCode}`;
        const versionRes = await api.get("/api/question-packages/version");
        const latestContent = String(versionRes.data.content_version ?? versionRes.data.version ?? "");
        const cachedContent = await AsyncStorage.getItem(versionCacheKey);
        if (latestContent && latestContent !== cachedContent) {
          const pkgRes = await api.get(`/api/question-packages/active?lang=${langCode}`);
          await AsyncStorage.setItem(pkgCacheKey, JSON.stringify(pkgRes.data));
          await AsyncStorage.setItem(versionCacheKey, latestContent);
        }
      } catch {
        // Non-blocking — cached package will be used
      }

      // Language package: delegate to shared version-aware fetch (version-gated, non-blocking)
      if (langCode !== "en") {
        fetchLanguagePackageFromBackend(langCode).catch(() => {});
      }
    };

    checkVersionsAndSync();
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
          <MaterialIcons name="menu" size={scale(24)} color="#1B1C1C" />
        </TouchableOpacity>
        <Text style={styles.appName}>{t("app.name")}</Text>
        <TouchableOpacity
          onPress={() => navigation.navigate("SettingsScreen")}
          style={styles.iconBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="settings" size={scale(24)} color="#1B1C1C" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* Headline group */}
        <Text style={styles.headline}>{t("home.headline")}</Text>
        <Text style={styles.subtitle}>{t("home.subtitle")}</Text>

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
          <Text style={styles.statusTitle}>{t("home.status_title")}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: isOnline ? "#38A169" : "#F5A623" }]} />
            <Text style={styles.statusText}>{isOnline ? t("home.status_connected") : t("home.status_offline")}</Text>
          </View>
        </View>

        {/* Gap between headline group and button area */}
        <View style={{ height: 32 }} />

        {/* Offline sync amber banner — shown when queue > 0; tap navigates to My Reports */}
        {queueCount > 0 && (
          <TouchableOpacity
            style={styles.syncBanner}
            activeOpacity={0.8}
            onPress={() => navigation.navigate("MyReports")}
            accessibilityRole="button"
            accessibilityLabel={`${queueCount} pending reports. Tap to view.`}
          >
            <MaterialIcons name="warning-amber" size={scale(20)} color="#1B1C1C" />
            <Text style={styles.syncBannerText}>
              {t("home.sync_banner", { count: queueCount })}
            </Text>
          </TouchableOpacity>
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
            <MaterialIcons name="camera-alt" size={scale(22)} color="#FFFFFF" />
            <Text style={styles.reportButtonText}>{t("home.reportButton")}</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Sync status row — shown when queue is empty */}
        {queueCount === 0 && (
          <View style={styles.syncStatusRow}>
            <View style={styles.syncGreenDot} />
            <Text style={styles.syncStatusText}>{t("home.sync_none")}</Text>
          </View>
        )}

        {/* "What can I report?" info card */}
        <TouchableOpacity
          onPress={() => setShowCrisisModal(true)}
          style={styles.whatCard}
          activeOpacity={0.8}
        >
          <View style={styles.whatCardIconWrap}>
            <MaterialIcons name="info-outline" size={scale(20)} color="#0468B1" />
          </View>
          <View style={styles.whatCardText}>
            <Text style={styles.whatCardTitle}>{t("whatCanIReport.link")}</Text>
            <Text style={styles.whatCardSubtitle}>{t('home.what_card_subtitle')}</Text>
          </View>
          <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
        </TouchableOpacity>

        {/* Recent reports — shown for logged-in reporters with at least 1 report */}
        {recentReports.length > 0 && (
          <View style={styles.recentSection}>
            <View style={styles.recentHeader}>
              <Text style={styles.recentLabel}>{t("home.recent_reports")}</Text>
              <TouchableOpacity onPress={() => navigation.navigate("MyReports")}>
                <Text style={styles.recentSeeAll}>{t("home.see_all")}</Text>
              </TouchableOpacity>
            </View>
            {recentReports.map((report: any) => {
              const loc =
                report.building_name ||
                report.location_address ||
                report.location_landmark ||
                (report.gps_latitude != null
                  ? `${Number(report.gps_latitude).toFixed(4)}, ${Number(report.gps_longitude ?? 0).toFixed(4)}`
                  : "Unknown location");
              return (
                <TouchableOpacity
                  key={report.id}
                  style={styles.recentCard}
                  onPress={() => navigation.navigate("ReportDetailScreen", { reportId: report.id })}
                  activeOpacity={0.75}
                >
                  <Text style={styles.recentLocation} numberOfLines={1}>{loc}</Text>
                  <Text style={styles.recentMeta}>
                    {report.disaster_type
                      ? `${report.disaster_type}  ·  `
                      : ""}
                    {report.submitted_at
                      ? new Date(report.submitted_at).toLocaleDateString([], { month: "short", day: "numeric" })
                      : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

      </ScrollView>

      {/* Bottom navigation — Home tab is always active on this screen */}
      <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.navItem}>
          <View style={styles.activeNavPill}>
            <MaterialIcons name="home" size={scale(22)} color="#0468B1" />
            <Text style={styles.navLabelActive}>{t("home.nav_home")}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("Map")}
        >
          <MaterialIcons name="map" size={scale(22)} color="#717782" />
          <Text style={styles.navLabelInactive}>{t("home.nav_map")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate("MyReports")}
        >
          <MaterialIcons name="list-alt" size={scale(22)} color="#717782" />
          <Text style={styles.navLabelInactive}>{t("home.nav_reports")}</Text>
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
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("whatCanIReport.title")}</Text>
              <TouchableOpacity
                onPress={() => setShowCrisisModal(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              style={{ flex: 1 }}
              showsVerticalScrollIndicator={true}
              contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: insets.bottom + 20 }}
            >
              {Object.values(
                t("whatCanIReport.types", { returnObjects: true }) as Record<
                  string,
                  { name: string; description: string }
                >
              ).map((type, idx, arr) => (
                <View key={idx}>
                  <View style={styles.crisisTypeRow}>
                    <Text style={styles.crisisTypeName}>{type.name}</Text>
                    <Text style={styles.crisisTypeDesc}>{type.description}</Text>
                  </View>
                  {idx < arr.length - 1 && <View style={styles.crisisTypeDivider} />}
                </View>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({

  // ── Root ─────────────────────────────────────────────────────────────────────
  container: {
    flex: 1,
    backgroundColor: "#F6F3F2",
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
  appName: {
    flex: 1,
    fontSize: scale(17),
    fontWeight: "600",
    color: "#1B1C1C",
    textAlign: "center",
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
    backgroundColor: "rgba(4,104,177,0.06)",
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
  syncBannerText: {
    flex: 1,
    fontSize: scale(13),
    fontWeight: "700",
    color: "#1B1C1C",
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

  // ── Recent reports section ───────────────────────────────────────────────────
  recentSection: {
    width: "100%",
    marginTop: 16,
  },
  recentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  recentLabel: {
    fontSize: scale(10),
    fontWeight: "700",
    color: "#717782",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  recentSeeAll: {
    fontSize: scale(13),
    fontWeight: "600",
    color: "#0468B1",
  },
  recentCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: "#0468B1",
  },
  recentLocation: {
    fontSize: scale(14),
    fontWeight: "600",
    color: "#1B1C1C",
    marginBottom: 3,
  },
  recentMeta: {
    fontSize: scale(12),
    color: "#717782",
    textTransform: "capitalize",
  },

  // ── "What can I report?" info card ───────────────────────────────────────────
  whatCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 16,
    width: "100%",
    gap: 12,
    borderWidth: 1,
    borderColor: "rgba(4,104,177,0.15)",
  },
  whatCardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(4,104,177,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  whatCardText: { flex: 1 },
  whatCardTitle: {
    fontSize: scale(14),
    fontWeight: "600",
    color: "#0468B1",
  },
  whatCardSubtitle: {
    fontSize: scale(12),
    color: "#717782",
    marginTop: 2,
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
  navLabelActive: {
    fontSize: scale(10),
    fontWeight: "600",
    color: "#0468B1",
    letterSpacing: 1.2,
    marginTop: 2,
  },
  navLabelInactive: {
    fontSize: scale(10),
    fontWeight: "500",
    color: "#717782",
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
    minWidth: 44,
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
    maxHeight: "82%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F4F8",
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
  },
  crisisTypeName: {
    fontSize: scale(15),
    fontWeight: "600",
    color: "#1B1C1C",
    marginBottom: 3,
  },
  crisisTypeDesc: {
    fontSize: scale(13),
    color: "#717782",
    lineHeight: scale(13) * 1.5,
  },
  crisisTypeDivider: {
    height: 1,
    backgroundColor: "#F0F4F8",
  },
});
