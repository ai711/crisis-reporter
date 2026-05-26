import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Image, Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { MaterialIcons } from "@expo/vector-icons";
import api from "../services/api";

const { width: screenWidth } = Dimensions.get("window");
const scale = (size: number) => Math.round((screenWidth / 375) * size);

export default function ReporterProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  const [reporterId, setReporterId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCountryCode, setPhoneCountryCode] = useState("+1");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const initialValues = useRef({ firstName: "", lastName: "", email: "", phone: "" });

  const hasChanges =
    firstName !== initialValues.current.firstName ||
    lastName !== initialValues.current.lastName ||
    email !== initialValues.current.email ||
    phone !== initialValues.current.phone;

  const completionCount = [firstName, lastName, email, phone].filter(Boolean).length;
  const completion = Math.round((completionCount / 4) * 100);

  // ── Load reporter ID + pre-populate fields ──────────────────────────────

  useEffect(() => {
    const init = async () => {
      const id = await SecureStore.getItemAsync("cr_reporter_id");
      setReporterId(id ?? null);

      if (!id || id.startsWith("CR-PENDING-")) return;

      // Try local cache first (works offline)
      try {
        const cached = await AsyncStorage.getItem("cr_profile_cache");
        if (cached) {
          const profile = JSON.parse(cached);
          const parts = (profile.name ?? "").split(" ");
          const fn = parts[0] ?? "";
          const ln = parts.slice(1).join(" ");
          setFirstName(fn);
          setLastName(ln);
          if (profile.email) setEmail(profile.email);
          if (profile.phone) setPhone(profile.phone);
          if (profile.photo_url) setPhotoUrl(profile.photo_url);
          initialValues.current = {
            firstName: fn,
            lastName: ln,
            email: profile.email ?? "",
            phone: profile.phone ?? "",
          };
        }
      } catch {
        // Cache read failed — fall through to API
      }

      // Fetch from backend (non-blocking update over cached values)
      try {
        const response = await api.get(`/api/reporters/${id}`);
        const data = response.data;
        if (data.name) {
          const parts = (data.name ?? "").split(" ");
          const fn = parts[0] ?? "";
          const ln = parts.slice(1).join(" ");
          setFirstName(fn);
          setLastName(ln);
        }
        if (data.email) setEmail(data.email);
        if (data.phone) setPhone(data.phone);
        if (data.photo_url) setPhotoUrl(data.photo_url);

        const fn2 = data.name ? data.name.split(" ")[0] ?? "" : "";
        const ln2 = data.name ? data.name.split(" ").slice(1).join(" ") : "";
        initialValues.current = {
          firstName: fn2,
          lastName: ln2,
          email: data.email ?? "",
          phone: data.phone ?? "",
        };

        await AsyncStorage.setItem("cr_profile_cache", JSON.stringify({
          name: data.name ?? "",
          email: data.email ?? "",
          phone: data.phone ?? "",
          photo_url: data.photo_url ?? "",
        }));
      } catch {
        // API unavailable — cached values already applied
      }
    };

    init();
  }, []);

  // ── Photo picker ──────────────────────────────────────────────────────────

  const uploadProfilePhoto = async (uri: string) => {
    if (!reporterId || reporterId.startsWith("CR-PENDING-")) return;
    try {
      const formData = new FormData();
      formData.append("photo", {
        uri,
        type: "image/jpeg",
        name: "profile_photo.jpg",
      } as any);
      await api.post(`/api/reporters/${reporterId}/photo`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    } catch {
      // Upload failed — photo shown locally only
    }
  };

  const handlePickPhoto = () => {
    Alert.alert(
      "Profile Photo",
      "Choose a source",
      [
        {
          text: "Take a Photo",
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Camera needed", "Please allow camera access in settings.");
              return;
            }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              allowsEditing: true,
              aspect: [1, 1],
              quality: 0.8,
            });
            if (!result.canceled && result.assets?.[0]) {
              const uri = result.assets[0].uri;
              setPhotoUrl(uri);
              await uploadProfilePhoto(uri);
            }
          },
        },
        {
          text: "Upload from Gallery",
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== "granted") {
              Alert.alert("Gallery needed", "Please allow gallery access in settings.");
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              allowsEditing: true,
              aspect: [1, 1],
              quality: 0.8,
            });
            if (!result.canceled && result.assets?.[0]) {
              const uri = result.assets[0].uri;
              setPhotoUrl(uri);
              await uploadProfilePhoto(uri);
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!hasChanges || !reporterId || loading) return;
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
    } catch {
      // Local save failed — continue to API attempt
    }

    // Attempt API save
    try {
      await api.patch(`/api/reporters/${reporterId}`, {
        name: fullName || undefined,
        email: email.trim() || undefined,
        phone: fullPhone || undefined,
      });
      initialValues.current = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      };
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

  // ── Render ────────────────────────────────────────────────────────────────

  const inputStyle = (field: string, hasValue: boolean) => [
    styles.input,
    focusedField === field && styles.inputFocused,
    hasValue && !focusedField && styles.inputFilled,
    hasValue && focusedField === field && styles.inputFocused,
  ];

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
        <Text style={styles.headerTitle}>Reporter Profile</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile photo section */}
        <View style={styles.photoSection}>
          <TouchableOpacity onPress={handlePickPhoto} style={styles.avatarWrapper}>
            {photoUrl ? (
              <Image source={{ uri: photoUrl }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarEmpty}>
                <MaterialIcons name="person" size={scale(48)} color="#9CA3AF" />
              </View>
            )}
            <View style={styles.cameraBadge}>
              <MaterialIcons name="photo-camera" size={scale(16)} color="#FFFFFF" />
            </View>
          </TouchableOpacity>
          <Text style={styles.photoLabel}>{photoUrl ? "Change Photo" : "Add Profile Photo"}</Text>
          {reporterId && (
            <Text style={styles.reporterIdText}>{reporterId}</Text>
          )}
        </View>

        {/* Profile completion */}
        <View style={styles.completionCard}>
          <View style={styles.completionRow}>
            <Text style={styles.completionLabel}>Profile Completion</Text>
            <Text style={styles.completionPct}>{completion}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${completion}%` as any }]} />
          </View>
          <View style={styles.completionHintRow}>
            <MaterialIcons name="info-outline" size={scale(14)} color="#717782" />
            <Text style={styles.completionHint}>
              Add your email or phone number to unlock badges
            </Text>
          </View>
        </View>

        {/* Optional info notice */}
        <View style={styles.infoNotice}>
          <MaterialIcons name="info" size={scale(18)} color="#0468B1" />
          <Text style={styles.infoNoticeText}>
            Profile is optional. You can submit reports anonymously without filling in any details.
          </Text>
        </View>

        {/* Form fields */}
        <View style={styles.formCard}>
          {/* First Name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>FIRST NAME (OPTIONAL)</Text>
            <TextInput
              style={inputStyle("firstName", !!firstName)}
              placeholder="First name"
              placeholderTextColor="#9CA3AF"
              value={firstName}
              onChangeText={setFirstName}
              onFocus={() => setFocusedField("firstName")}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {/* Last Name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>LAST NAME (OPTIONAL)</Text>
            <TextInput
              style={inputStyle("lastName", !!lastName)}
              placeholder="Last name"
              placeholderTextColor="#9CA3AF"
              value={lastName}
              onChangeText={setLastName}
              onFocus={() => setFocusedField("lastName")}
              onBlur={() => setFocusedField(null)}
            />
          </View>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <View style={styles.fieldLabelRow}>
              <Text style={[styles.fieldLabel, { marginBottom: 0 }]}>EMAIL ADDRESS (OPTIONAL)</Text>
              <Text style={styles.fieldHint}>Links all your reports to this email</Text>
            </View>
            <View style={{ height: 6 }} />
            <TextInput
              style={inputStyle("email", !!email)}
              placeholder="email@example.com"
              placeholderTextColor="#9CA3AF"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
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
                onChangeText={setPhoneCountryCode}
                keyboardType="phone-pad"
                onFocus={() => setFocusedField("phoneCode")}
                onBlur={() => setFocusedField(null)}
              />
              <TextInput
                style={[inputStyle("phone", !!phone), styles.phoneNumberInput]}
                placeholder="Phone number"
                placeholderTextColor="#9CA3AF"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
                onFocus={() => setFocusedField("phone")}
                onBlur={() => setFocusedField(null)}
              />
            </View>
          </View>
        </View>

        {/* Success banner */}
        {saveSuccess && (
          <View style={styles.successBanner}>
            <MaterialIcons name="check-circle" size={scale(16)} color="#38A169" />
            <Text style={styles.successBannerText}>Profile saved</Text>
          </View>
        )}
      </ScrollView>

      {/* Fixed footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={[styles.saveBtn, (!hasChanges || loading) && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!hasChanges || loading}
        >
          {loading ? (
            <ActivityIndicator color={hasChanges ? "#FFF" : "#9CA3AF"} />
          ) : (
            <Text style={[styles.saveBtnText, (!hasChanges || loading) && styles.saveBtnTextDisabled]}>
              Save Profile
            </Text>
          )}
        </TouchableOpacity>
        <Text style={styles.footerHint}>
          Your profile is saved locally and synced when online
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F3F2" },

  // Header
  header: {
    backgroundColor: "rgba(255,255,255,0.92)",
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

  // Photo section
  photoSection: { alignItems: "center", marginTop: 24 },
  avatarWrapper: { position: "relative" },
  avatar: { width: scale(96), height: scale(96), borderRadius: scale(48) },
  avatarEmpty: {
    width: scale(96),
    height: scale(96),
    borderRadius: scale(48),
    backgroundColor: "#E4E2E1",
    justifyContent: "center",
    alignItems: "center",
  },
  cameraBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: scale(32),
    height: scale(32),
    borderRadius: scale(16),
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  photoLabel: {
    color: "#0468B1",
    fontSize: scale(14),
    fontWeight: "600",
    marginTop: 10,
  },
  reporterIdText: {
    fontSize: scale(12),
    color: "#9CA3AF",
    marginTop: 4,
    letterSpacing: 0.5,
  },

  // Profile completion
  completionCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    padding: 16,
    marginTop: 20,
  },
  completionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  completionLabel: { fontSize: scale(14), fontWeight: "500", color: "#1B1C1C" },
  completionPct: { fontSize: scale(16), fontWeight: "700", color: "#0468B1" },
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
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  completionHint: { fontSize: scale(13), color: "#717782", flex: 1 },

  // Info notice
  infoNotice: {
    backgroundColor: "rgba(4,104,177,0.06)",
    borderRadius: 12,
    padding: 14,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  infoNoticeText: { fontSize: scale(13), color: "#0468B1", flex: 1 },

  // Form card
  formCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    padding: 20,
    marginTop: 16,
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
  },
  input: {
    backgroundColor: "#E4E2E1",
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: scale(14),
    color: "#1B1C1C",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  inputFocused: { borderBottomColor: "#0468B1" },
  inputFilled: { borderBottomColor: "#0468B1" },
  phoneRow: { flexDirection: "row", gap: 8 },
  phoneCodeInput: { width: 72 },
  phoneNumberInput: { flex: 1 },

  // Success banner
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(56,161,105,0.1)",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 12,
    borderLeftWidth: 3,
    borderLeftColor: "#38A169",
  },
  successBannerText: {
    color: "#38A169",
    fontSize: scale(14),
    fontWeight: "600",
  },

  // Footer
  footer: {
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingTop: 12,
    paddingHorizontal: screenWidth * 0.05,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E4E2E1",
  },
  saveBtn: {
    height: 52,
    borderRadius: 26,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#0468B1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  saveBtnDisabled: {
    backgroundColor: "#E4E2E1",
    elevation: 0,
    shadowOpacity: 0,
  },
  saveBtnText: {
    color: "#FFFFFF",
    fontSize: scale(16),
    fontWeight: "600",
  },
  saveBtnTextDisabled: { color: "#9CA3AF" },
  footerHint: {
    fontSize: scale(12),
    color: "#9CA3AF",
    textAlign: "center",
    marginTop: 8,
  },
});
