import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Image, Dimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { MaterialIcons } from "@expo/vector-icons";
import api from "../services/api";

const { width: _screenWidthRaw } = Dimensions.get("window");
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round((screenWidth / 375) * size);

const COUNTRY_CODES = [
  "+1", "+7", "+20", "+27", "+30", "+31", "+32", "+33", "+34", "+36",
  "+39", "+40", "+41", "+43", "+44", "+45", "+46", "+47", "+48", "+49",
  "+52", "+54", "+55", "+56", "+57", "+58", "+60", "+61", "+62", "+63",
  "+64", "+65", "+66", "+81", "+82", "+84", "+86", "+90", "+91", "+92",
  "+98", "+212", "+213", "+216", "+218", "+234", "+254", "+255", "+256",
  "+880", "+886", "+960", "+961", "+962", "+963", "+964", "+965", "+966",
  "+967", "+968", "+971", "+972", "+974", "+975", "+976", "+977", "+992",
  "+993", "+994", "+995", "+996", "+998",
];

function parsePhoneNumber(stored: string): { code: string; number: string } {
  if (!stored) return { code: "+1", number: "" };
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.length - a.length);
  const match = sorted.find((c) => stored.startsWith(c));
  if (match) return { code: match, number: stored.slice(match.length).trim() };
  return { code: "+1", number: stored };
}

export default function ReporterProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { t } = useTranslation();

  const [reporterId, setReporterId] = useState<string | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCountryCode, setPhoneCountryCode] = useState("+1");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const initialValues = useRef({
    firstName: "", lastName: "", email: "",
    phone: "", phoneCountryCode: "+1",
  });

  const completionCount = [firstName, lastName, email, phone, photoUrl].filter(Boolean).length;
  const completion = Math.round((completionCount / 5) * 100);

  // ── Load reporter ID + profile ───────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      const id = await SecureStore.getItemAsync("cr_reporter_id");
      setReporterId(id ?? null);
      const accessToken = await SecureStore.getItemAsync("cr_access_token");
      setIsVerified(!!accessToken && !!id && !id.startsWith("CR-PENDING-"));
      if (!id || id.startsWith("CR-PENDING-")) return;

      // Try local cache first (works offline)
      try {
        const cached = await AsyncStorage.getItem("cr_profile_cache");
        if (cached) {
          const profile = JSON.parse(cached);
          const parts = (profile.name ?? "").split(" ");
          const fn = parts[0] ?? "";
          const ln = parts.slice(1).join(" ");
          const parsed = parsePhoneNumber(profile.phone ?? "");
          setFirstName(fn);
          setLastName(ln);
          if (profile.email) setEmail(profile.email);
          setPhoneCountryCode(parsed.code);
          setPhone(parsed.number);
          if (profile.photo_url) setPhotoUrl(profile.photo_url);
          initialValues.current = {
            firstName: fn, lastName: ln,
            email: profile.email ?? "",
            phone: parsed.number,
            phoneCountryCode: parsed.code,
          };
        }
      } catch {
        // Cache read failed — fall through to API
      }

      // Fetch from backend (non-blocking update over cached values)
      try {
        const response = await api.get(`/api/reporters/${id}`);
        const data = response.data;
        const fn2 = data.first_name ?? (data.name ? (data.name.split(" ")[0] ?? "") : "");
        const ln2 = data.last_name ?? (data.name ? data.name.split(" ").slice(1).join(" ") : "");
        const parsed2 = parsePhoneNumber(data.phone_number ?? data.phone ?? "");
        setFirstName(fn2);
        setLastName(ln2);
        if (data.email) setEmail(data.email);
        setPhoneCountryCode(parsed2.code);
        setPhone(parsed2.number);
        if (data.profile_photo_url ?? data.photo_url) {
          setPhotoUrl(data.profile_photo_url ?? data.photo_url);
        }
        initialValues.current = {
          firstName: fn2, lastName: ln2,
          email: data.email ?? "",
          phone: parsed2.number,
          phoneCountryCode: parsed2.code,
        };
        await AsyncStorage.setItem("cr_profile_cache", JSON.stringify({
          name: [fn2, ln2].filter(Boolean).join(" "),
          email: data.email ?? "",
          phone: data.phone_number ?? data.phone ?? "",
          photo_url: data.profile_photo_url ?? data.photo_url ?? "",
        }));
      } catch {
        // API unavailable — cached values already applied
      }
    };
    init();
  }, []);

  // ── Photo picker ─────────────────────────────────────────────────────────────

  const uploadProfilePhoto = async (uri: string) => {
    if (!reporterId || reporterId.startsWith("CR-PENDING-")) return;
    try {
      const formData = new FormData();
      formData.append("photo", { uri, type: "image/jpeg", name: "profile_photo.jpg" } as any);
      await api.post(`/api/reporters/${reporterId}/photo`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    } catch {
      // Upload failed — photo shown locally only
    }
  };

  const handlePickPhoto = () => {
    Alert.alert(t('profile.pick_photo_title'), t('profile.pick_photo_take') + ' / ' + t('profile.pick_photo_upload'), [
      {
        text: t('profile.pick_photo_take'),
        onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== "granted") {
            Alert.alert(t('profile.camera_permission_title'), t('profile.camera_permission_body'));
            return;
          }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true, aspect: [1, 1], quality: 0.8,
          });
          if (!result.canceled && result.assets?.[0]) {
            const uri = result.assets[0].uri;
            setPhotoUrl(uri);
            setIsDirty(true);
            await uploadProfilePhoto(uri);
          }
        },
      },
      {
        text: t('profile.pick_photo_upload'),
        onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== "granted") {
            Alert.alert(t('profile.gallery_permission_title'), t('profile.gallery_permission_body'));
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true, aspect: [1, 1], quality: 0.8,
          });
          if (!result.canceled && result.assets?.[0]) {
            const uri = result.assets[0].uri;
            setPhotoUrl(uri);
            setIsDirty(true);
            await uploadProfilePhoto(uri);
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  // ── Save ─────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!isDirty || !reporterId || loading) return;
    setLoading(true);

    const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
    const fullPhone = phone.trim() ? `${phoneCountryCode}${phone.trim()}` : "";

    // Save locally first (offline-first)
    try {
      await AsyncStorage.setItem("cr_profile_cache", JSON.stringify({
        name: fullName,
        email: email.trim(),
        phone: fullPhone,
        photo_url: photoUrl ?? "",
      }));
    } catch { /* local save failed */ }

    try {
      await api.patch(`/api/reporters/${reporterId}`, {
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        email: email.trim() || undefined,
        phone_number: fullPhone || undefined,
      });
      initialValues.current = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        phoneCountryCode,
      };
      setIsDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      Alert.alert(
        "Error",
        "Could not save profile. Your changes are saved locally and will sync when you reconnect."
      );
    } finally {
      setLoading(false);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const mark = () => setIsDirty(true);

  const inputStyle = (field: string, hasValue: boolean) => [
    styles.input,
    focusedField === field && styles.inputFocused,
    hasValue && styles.inputFilled,
  ];

  const canSave = isDirty && !loading;

  // ── Render ───────────────────────────────────────────────────────────────────

  // Anonymous gate — show login/register prompt if not logged in
  if (!isVerified && !loading) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t("profile.title") || "Profile"}</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.anonGate}>
          <View style={styles.anonIcon}>
            <MaterialIcons name="person" size={scale(48)} color="#0468B1" />
          </View>
          <Text style={styles.anonHeading}>{t("profile.anon_gate_heading") || "Create a free account to save your profile and earn badges."}</Text>
          <Text style={styles.anonSubtext}>{t("profile.anon_gate_subtext") || "You can still submit reports anonymously without an account."}</Text>
          <TouchableOpacity style={styles.loginBtn} onPress={() => (navigation as any).navigate("LoginScreen")}>
            <Text style={styles.loginBtnText}>{t("login.loginButton") || "Log In"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.registerBtn} onPress={() => (navigation as any).navigate("RegisterScreen")}>
            <Text style={styles.registerBtnText}>{t("register.title") || "Create Account"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("profile.title") || "My Profile"}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Avatar section ── */}
        <View style={styles.avatarSection}>
          <TouchableOpacity onPress={handlePickPhoto} style={styles.avatarWrapper} activeOpacity={0.85}>
            {photoUrl ? (
              <Image source={{ uri: photoUrl }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarEmpty}>
                <MaterialIcons name="person" size={scale(56)} color="#9CA3AF" />
              </View>
            )}
            <View style={styles.cameraBadge}>
              <MaterialIcons name="photo-camera" size={scale(16)} color="#FFFFFF" />
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={handlePickPhoto} activeOpacity={0.7}>
            <Text style={styles.photoLabel}>{photoUrl ? "Change Photo" : "Add Profile Photo"}</Text>
          </TouchableOpacity>
          {reporterId && !reporterId.startsWith('CR-PENDING-') && (
            <Text style={styles.reporterIdText}>
              ID: {reporterId.replace(/-/g, '').slice(0, 3).toUpperCase()}-{reporterId.replace(/-/g, '').slice(3, 6).toUpperCase()}
            </Text>
          )}
        </View>

        {/* ── Completion bar ── */}
        <View style={styles.completionCard}>
          <View style={styles.completionRow}>
            <Text style={styles.completionLabel}>{t('profile.completion_heading')}</Text>
            <Text style={styles.completionPct}>{completion}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${completion}%` as any }]} />
          </View>
          <View style={styles.completionHintRow}>
            <MaterialIcons name="info-outline" size={scale(14)} color="#717782" />
            <Text style={styles.completionHint}>
              Adding your email or phone number links all your reports to your profile
            </Text>
          </View>
        </View>

        {/* ── Info notice ── */}
        <View style={styles.infoNotice}>
          <MaterialIcons name="info" size={scale(18)} color="#0468B1" />
          <Text style={styles.infoNoticeText}>
            Profile is optional. You can submit reports anonymously without filling in any details.
          </Text>
        </View>

        {/* ── Form fields ── */}
        <View style={styles.formSection}>

          {/* First Name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>FIRST NAME (OPTIONAL)</Text>
            <TextInput
              style={inputStyle("firstName", !!firstName)}
              placeholder={t('profile.first_name_placeholder')}
              placeholderTextColor="#9CA3AF"
              value={firstName}
              onChangeText={(v) => { setFirstName(v); mark(); }}
              onFocus={() => setFocusedField("firstName")}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {/* Last Name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>LAST NAME (OPTIONAL)</Text>
            <TextInput
              style={inputStyle("lastName", !!lastName)}
              placeholder={t('profile.last_name_placeholder')}
              placeholderTextColor="#9CA3AF"
              value={lastName}
              onChangeText={(v) => { setLastName(v); mark(); }}
              onFocus={() => setFocusedField("lastName")}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <View style={styles.fieldLabelRow}>
              <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>EMAIL ADDRESS (OPTIONAL)</Text>
              <Text style={styles.fieldHint}>{t('profile.email_hint')}</Text>
            </View>
            <View style={{ height: 6 }} />
            <TextInput
              style={inputStyle("email", !!email)}
              placeholder="name@example.com"
              placeholderTextColor="#9CA3AF"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={(v) => { setEmail(v); mark(); }}
              onFocus={() => setFocusedField("email")}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {/* Mobile Number */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>MOBILE NUMBER (OPTIONAL)</Text>
            <View style={styles.phoneRow}>
              <TextInput
                style={[inputStyle("phoneCode", true), styles.phoneCodeInput]}
                value={phoneCountryCode}
                onChangeText={(v) => { setPhoneCountryCode(v); mark(); }}
                keyboardType="phone-pad"
                onFocus={() => setFocusedField("phoneCode")}
                onBlur={() => setFocusedField(null)}
                maxLength={5}
              />
              <TextInput
                style={[inputStyle("phone", !!phone), styles.phoneNumberInput]}
                placeholder={t('profile.phone_placeholder')}
                placeholderTextColor="#9CA3AF"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={(v) => { setPhone(v); mark(); }}
                onFocus={() => setFocusedField("phone")}
                onBlur={() => setFocusedField(null)}
              />
            </View>
          </View>
        </View>

        {/* Success banner */}
        {saveSuccess && (
          <View style={styles.successBanner}>
            <MaterialIcons name="check-circle" size={scale(16)} color="#276749" />
            <Text style={styles.successBannerText}>{t('profile.save_success')}</Text>
          </View>
        )}
      </ScrollView>

      {/* ── Fixed footer ── */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={canSave ? 0.85 : 1}
        >
          <LinearGradient
            colors={canSave ? ["#0468B1", "#00508A"] : ["#E4E2E1", "#E4E2E1"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.saveBtn}
          >
            {loading ? (
              <ActivityIndicator color={canSave ? "#FFFFFF" : "#9CA3AF"} />
            ) : (
              <Text style={[styles.saveBtnText, !canSave && styles.saveBtnTextDisabled]}>
                {t('profile.save_btn')}
              </Text>
            )}
          </LinearGradient>
        </TouchableOpacity>
        <Text style={styles.footerHint}>{t('profile.footer_hint')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F3F2" },

  // Header
  header: {
    backgroundColor: "rgba(252,249,248,0.95)",
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E4E2E1",
  },
  headerBtn: { width: 44, minHeight: 44, justifyContent: "center" },
  headerTitle: { fontSize: scale(17), fontWeight: "600", color: "#1B1C1C" },

  scroll: { flex: 1 },
  scrollContent: { paddingTop: 0 },

  // ── Avatar section ──
  avatarSection: { alignItems: "center", paddingTop: 28, paddingBottom: 4 },
  avatarWrapper: { position: "relative" },
  avatar: {
    width: scale(128),
    height: scale(128),
    borderRadius: scale(64),
  },
  avatarEmpty: {
    width: scale(128),
    height: scale(128),
    borderRadius: scale(64),
    backgroundColor: "#E4E2E1",
    justifyContent: "center",
    alignItems: "center",
  },
  cameraBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: scale(36),
    height: scale(36),
    borderRadius: scale(18),
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#F6F3F2",
    shadowColor: "#0468B1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  photoLabel: {
    color: "#0468B1",
    fontSize: scale(14),
    fontWeight: "600",
    marginTop: 12,
  },
  reporterIdText: {
    fontSize: scale(11),
    color: "#9CA3AF",
    marginTop: 4,
    letterSpacing: 0.5,
  },

  // ── Completion card ──
  completionCard: {
    backgroundColor: "#F0EDED",
    borderRadius: 14,
    marginHorizontal: screenWidth * 0.05,
    padding: 16,
    marginTop: 24,
  },
  completionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  completionLabel: { fontSize: scale(14), fontWeight: "500", color: "#414751" },
  completionPct: { fontSize: scale(15), fontWeight: "700", color: "#0468B1" },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "#E4E2E1",
    marginTop: 10,
    overflow: "hidden",
  },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: "#0468B1" },
  completionHintRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 10,
  },
  completionHint: { fontSize: scale(12), color: "#717782", flex: 1, lineHeight: scale(17) },

  // ── Info notice ──
  infoNotice: {
    backgroundColor: "rgba(4,104,177,0.06)",
    borderRadius: 12,
    padding: 14,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(4,104,177,0.12)",
  },
  infoNoticeText: {
    fontSize: scale(13),
    color: "#00497F",
    flex: 1,
    lineHeight: scale(18),
    fontWeight: "500",
  },

  // ── Form section ──
  formSection: {
    marginHorizontal: screenWidth * 0.05,
    marginTop: 20,
    gap: 20,
  },
  fieldGroup: {},
  fieldLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  fieldLabel: {
    fontSize: scale(11),
    fontWeight: "700",
    color: "#717782",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: scale(10),
    color: "#0468B1",
    fontStyle: "italic",
    fontWeight: "500",
  },
  input: {
    backgroundColor: "#F0EDED",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: scale(13),
    fontSize: scale(15),
    color: "#1B1C1C",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  inputFocused: { borderBottomColor: "#0468B1" },
  inputFilled: { backgroundColor: "#E8E5E4", borderBottomColor: "#0468B1" },
  phoneRow: { flexDirection: "row", gap: 8 },
  phoneCodeInput: { width: scale(72), textAlign: "center" },
  phoneNumberInput: { flex: 1 },

  // ── Success banner ──
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(56,161,105,0.08)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 16,
    borderLeftWidth: 3,
    borderLeftColor: "#38A169",
  },
  successBannerText: {
    color: "#276749",
    fontSize: scale(14),
    fontWeight: "600",
  },

  // ── Footer ──
  footer: {
    backgroundColor: "#F6F3F2",
    paddingTop: 12,
    paddingHorizontal: screenWidth * 0.05,
  },
  saveBtn: {
    height: 52,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#0468B1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  saveBtnText: {
    color: "#FFFFFF",
    fontSize: scale(15),
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  saveBtnTextDisabled: { color: "#9CA3AF" },
  footerHint: {
    fontSize: scale(11),
    color: "#9CA3AF",
    textAlign: "center",
    marginTop: 8,
    fontWeight: "500",
    letterSpacing: 0.2,
  },

  // Anonymous gate
  anonGate: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  anonIcon: {
    width: scale(80),
    height: scale(80),
    borderRadius: scale(40),
    backgroundColor: "rgba(4,104,177,0.08)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  anonHeading: {
    fontSize: scale(20),
    fontWeight: "700",
    color: "#1B1C1C",
    marginBottom: 8,
    textAlign: "center",
  },
  anonSubtext: {
    fontSize: scale(14),
    color: "#717782",
    textAlign: "center",
    lineHeight: scale(20),
    marginBottom: 32,
    maxWidth: 280,
  },
  loginBtn: {
    width: "100%",
    height: 52,
    borderRadius: 14,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  loginBtnText: { color: "#fff", fontSize: scale(15), fontWeight: "700" },
  registerBtn: {
    width: "100%",
    height: 52,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  registerBtnText: { color: "#0468B1", fontSize: scale(15), fontWeight: "600" },
});
