import React, { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Alert, Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import api from "../services/api";

export default function ReporterProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  const [reporterId, setReporterId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

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
          if (profile.name) setName(profile.name);
          if (profile.email) setEmail(profile.email);
          if (profile.phone) setPhone(profile.phone);
          if (profile.photo_url) setPhotoUrl(profile.photo_url);
        }
      } catch {
        // Cache read failed — fall through to API
      }

      // Fetch from backend (non-blocking update over cached values)
      try {
        const response = await api.get(`/api/reporters/${id}`);
        const data = response.data;
        if (data.name) setName(data.name);
        if (data.email) setEmail(data.email);
        if (data.phone) setPhone(data.phone);
        if (data.photo_url) setPhotoUrl(data.photo_url);

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

  const hasAtLeastOne = name.trim() || email.trim() || phone.trim();

  const handleSave = async () => {
    if (!hasAtLeastOne || !reporterId) return;
    setLoading(true);

    // Save locally first (offline-first)
    try {
      await AsyncStorage.setItem("cr_profile_cache", JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        photo_url: photoUrl ?? "",
      }));
    } catch {
      // Local save failed — continue to API attempt
    }

    // Attempt API save
    try {
      await api.patch(`/api/reporters/${reporterId}`, {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reporter Profile</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile photo circle */}
        <TouchableOpacity style={styles.avatarContainer} onPress={handlePickPhoto}>
          {photoUrl ? (
            <Image source={{ uri: photoUrl }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>
                {name ? name.charAt(0).toUpperCase() : "?"}
              </Text>
            </View>
          )}
          <View style={styles.avatarEditBadge}>
            <Text style={styles.avatarEditBadgeText}>📷</Text>
          </View>
        </TouchableOpacity>

        {/* Reporter ID display */}
        {reporterId && (
          <View style={styles.reporterIdBox}>
            <Text style={styles.reporterIdLabel}>Your Reporter ID</Text>
            <Text style={styles.reporterIdValue}>{reporterId}</Text>
          </View>
        )}

        {/* Text fields */}
        <TextInput
          style={styles.input}
          placeholder="Your name (optional)"
          placeholderTextColor="#999"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Email address (optional)"
          placeholderTextColor="#999"
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone number (optional)"
          placeholderTextColor="#999"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
        />

        {!hasAtLeastOne && (
          <Text style={styles.validationText}>
            Please fill in at least one field to continue.
          </Text>
        )}

        {/* Success banner — shown above Save button for 3 seconds */}
        {saveSuccess && (
          <View style={styles.successBanner}>
            <Text style={styles.successBannerText}>✓ Profile saved</Text>
          </View>
        )}

        {/* Save button */}
        <TouchableOpacity
          style={[
            styles.saveBtn,
            (!hasAtLeastOne || loading) && styles.saveBtnDisabled,
          ]}
          onPress={handleSave}
          disabled={!hasAtLeastOne || loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.saveBtnText}>Save Profile</Text>
          )}
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

  scroll: { flex: 1 },
  form: { padding: 24, gap: 12 },

  // Avatar
  avatarContainer: {
    alignSelf: "center",
    marginBottom: 20,
    marginTop: 8,
    position: "relative",
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#E0E0E0",
  },
  avatarPlaceholder: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarPlaceholderText: {
    color: "#FFFFFF",
    fontSize: 36,
    fontWeight: "bold",
  },
  avatarEditBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E0E0E0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  avatarEditBadgeText: { fontSize: 14 },

  // Reporter ID box
  reporterIdBox: {
    backgroundColor: "#F0F7FF",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    marginBottom: 8,
  },
  reporterIdLabel: { fontSize: 12, color: "#666", marginBottom: 4 },
  reporterIdValue: { fontSize: 18, fontWeight: "bold", color: "#0468B1" },

  // Inputs
  input: {
    height: 52,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    color: "#333",
  },
  validationText: { color: "#D32F2F", fontSize: 13 },

  // Success banner
  successBanner: {
    backgroundColor: "#E8F5E9",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 10,
    alignItems: "center",
    borderLeftWidth: 3,
    borderLeftColor: "#4CAF50",
  },
  successBannerText: {
    color: "#2E7D32",
    fontSize: 14,
    fontWeight: "600",
  },

  // Save button
  saveBtn: {
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  saveBtnDisabled: { backgroundColor: "#B0C4D8" },
  saveBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
