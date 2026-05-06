import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Alert, ActivityIndicator, Image
} from "react-native";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { addToQueue } from "../utils/offlineQueue";
import type { DamageLevel, QueuedPhoto } from "../types";


interface ReportScreenProps {
  navigation: any;
}

export default function ReportScreen({ navigation }: ReportScreenProps) {
  const { t } = useTranslation();
  const { reporterId, languageCode, activeCrisisId } = useAuthStore();

  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [damageLevel, setDamageLevel] = useState<DamageLevel | "">("");
  const [infrastructureType, setInfrastructureType] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<{ uri: string; filename: string; type: string }[]>([]);
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [wasQueued, setWasQueued] = useState(false);
  const insets = useSafeAreaInsets();

const handleTakePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert("Permission needed", "Please allow camera access in settings.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setPhotos((prev) => [
          ...prev,
          { uri: asset.uri, filename: `photo_${Date.now()}.jpg`, type: "image/jpeg" },
        ]);
      }
    } catch (e) {
      Alert.alert("Camera Error", String(e));
    }
  };

  const handlePickPhoto = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert("Permission needed", "Please allow photo library access in settings.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setPhotos((prev) => [
          ...prev,
          { uri: asset.uri, filename: `photo_${Date.now()}.jpg`, type: "image/jpeg" },
        ]);
      }
    } catch (e) {
      Alert.alert("Gallery Error", String(e));
    }
  };

  const handleGetGPS = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    setGpsCoords({
      lat: location.coords.latitude,
      lng: location.coords.longitude,
    });
    Alert.alert("GPS Captured", `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`);
  };

  const handleSubmit = async () => {
    if (!damageLevel || !infrastructureType || photos.length === 0) {
      Alert.alert("Required Fields", "Please complete all required fields.");
      return;
    }

    setSubmitting(true);

    const crisisId = activeCrisisId || "62304240-9cba-474d-9997-790dbb6e6e9a";

    const reportPayload = {
      crisis_id: crisisId,
      damage_level: damageLevel as DamageLevel,
      infrastructure_type: infrastructureType,
      platform: "android" as const,
      submitted_at: new Date().toISOString(),
      location: {
        gps_latitude: gpsCoords?.lat || null,
        gps_longitude: gpsCoords?.lng || null,
        gps_accuracy_meters: null,
        gps_available: !!gpsCoords,
        location_address: locationAddress || null,
        location_landmark: locationLandmark || null,
        location_building_name: null,
      },
      reporter_id: reporterId || undefined,
      description: description || undefined,
      language_code: languageCode,
      was_queued: false,
    };

    try {
      // Try online submission first
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      // Upload photos
      for (let i = 0; i < photos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", {
          uri: photos[i].uri,
          name: photos[i].filename,
          type: photos[i].type,
        } as any);

        await api.post("/api/photos", formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }

      setSubmitted(true);
      setWasQueued(false);
    } catch (error: any) {
      console.log("Submit error:", error?.message, error?.response?.status, error?.response?.data);
      // Save to offline queue
      const queuedPhotos: QueuedPhoto[] = photos.map((p, i) => ({
        uri: p.uri,
        filename: p.filename,
        content_type: p.type,
        display_order: i,
      }));

      await addToQueue(
        { ...reportPayload, was_queued: true },
        queuedPhotos
      );

      setSubmitted(true);
      setWasQueued(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <View style={styles.successContainer}>
        <Text style={styles.successIcon}>✅</Text>
        <Text style={styles.successTitle}>
          {wasQueued ? t("report.queued") : t("report.success")}
        </Text>
        <Text style={styles.successText}>
          {wasQueued
            ? "Your report is saved and will sync when you reconnect."
            : "Your damage report has been submitted to UNDP."}
        </Text>
        <TouchableOpacity
          style={styles.homeButton}
          onPress={() => navigation.navigate("Home")}
        >
          <Text style={styles.primaryButtonText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const stepNumber = step === "photos" ? 1 : step === "location" ? 2 : step === "damage" ? 3 : 4;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("report.title")}</Text>
        <Text style={styles.stepIndicator}>{stepNumber}/4</Text>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${stepNumber * 25}%` as any }]} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentPadding}>

        {/* Step 3 — Damage Assessment */}
        {step === "damage" && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}>{t("report.damageLevel")} *</Text>

            {(["minimal", "partial", "complete"] as DamageLevel[]).map((level) => (
              <TouchableOpacity
                key={level}
                style={[
                  styles.optionBtn,
                  damageLevel === level && styles.optionBtnSelected,
                ]}
                onPress={() => setDamageLevel(level)}
              >
                <Text style={styles.optionIcon}>
                  {level === "minimal" ? "🟢" : level === "partial" ? "🟠" : "🔴"}
                </Text>
                <Text style={styles.optionText}>{t(`report.${level}`)}</Text>
              </TouchableOpacity>
            ))}

            <Text style={[styles.stepTitle, { marginTop: 24 }]}>
              {t("report.infrastructureType")} *
            </Text>

            <View style={styles.typeGrid}>
              {["residential", "commercial", "school", "hospital", "road", "other"].map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[
                    styles.typeBtn,
                    infrastructureType === type && styles.typeBtnSelected,
                  ]}
                  onPress={() => setInfrastructureType(type)}
                >
                  <Text style={[
                    styles.typeBtnText,
                    infrastructureType === type && styles.typeBtnTextSelected,
                  ]}>
                    {t(`report.${type}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.stepTitle, { marginTop: 24 }]}>
              {t("report.description")}
            </Text>
            <TextInput
              style={styles.textarea}
              placeholder={t("report.descriptionPlaceholder")}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
            />

            <View style={styles.navButtons}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setStep("location")}
              >
                <Text style={styles.secondaryButtonText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (!damageLevel || !infrastructureType) && styles.buttonDisabled,
                ]}
                onPress={() => damageLevel && infrastructureType && setStep("review")}
                disabled={!damageLevel || !infrastructureType}
              >
                <Text style={styles.primaryButtonText}>Next →</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Step 2 — Location */}
        {step === "location" && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}>{t("report.location")}</Text>

            <TouchableOpacity style={styles.gpsButton} onPress={handleGetGPS}>
              <Text style={styles.gpsButtonText}>
                {gpsCoords ? "✅ GPS Captured" : "📍 Capture GPS Location"}
              </Text>
            </TouchableOpacity>

            <Text style={styles.fieldLabel}>{t("report.address")}</Text>
            <TextInput
              style={styles.input}
              placeholder="Street address or area name"
              value={locationAddress}
              onChangeText={setLocationAddress}
            />

            <Text style={styles.fieldLabel}>{t("report.landmark")}</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Near the central market"
              value={locationLandmark}
              onChangeText={setLocationLandmark}
            />

            <View style={styles.navButtons}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setStep("photos")}
              >
                <Text style={styles.secondaryButtonText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => setStep("damage")}
              >
                <Text style={styles.primaryButtonText}>Next →</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Step 1 — Photos */}
        {step === "photos" && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}>{t("report.photos")} *</Text>
            <Text style={styles.hintText}>
              Add up to 3 photos. At least 1 required.
            </Text>

            <View style={styles.photoGrid}>
              {photos.map((photo, index) => (
                <View key={index} style={styles.photoThumb}>
                  <Image source={{ uri: photo.uri }} style={styles.thumbImage} />
                  <TouchableOpacity
                    style={styles.removePhotoBtn}
                    onPress={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Text style={styles.removePhotoBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>

            {photos.length < 3 && (
              <View style={styles.photoButtons}>
                <TouchableOpacity
                  style={styles.photoOptionBtn}
                  onPress={handleTakePhoto}
                >
                  <Text style={styles.photoOptionIcon}>📷</Text>
                  <Text style={styles.photoOptionText}>{t("report.takePhoto")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.photoOptionBtn}
                  onPress={handlePickPhoto}
                >
                  <Text style={styles.photoOptionIcon}>🖼️</Text>
                  <Text style={styles.photoOptionText}>{t("report.uploadPhoto")}</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.primaryButton,
                photos.length === 0 && styles.buttonDisabled,
              ]}
              onPress={() => photos.length > 0 && setStep("location")}
              disabled={photos.length === 0}
            >
              <Text style={styles.primaryButtonText}>Next →</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Step 4 — Review and Submit */}
        {step === "review" && (
          <View style={styles.step}>
            <Text style={styles.stepTitle}>Review Your Report</Text>

            <View style={styles.reviewCard}>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Damage Level</Text>
                <Text style={styles.reviewValue}>
                  {damageLevel === "minimal" ? "🟢 " : damageLevel === "partial" ? "🟠 " : "🔴 "}
                  {t(`report.${damageLevel}`)}
                </Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Infrastructure</Text>
                <Text style={styles.reviewValue}>
                  {t(`report.${infrastructureType}`)}
                </Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Photos</Text>
                <Text style={styles.reviewValue}>{photos.length} photo(s)</Text>
              </View>
              {gpsCoords && (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>GPS</Text>
                  <Text style={styles.reviewValue}>
                    {gpsCoords.lat.toFixed(4)}, {gpsCoords.lng.toFixed(4)}
                  </Text>
                </View>
              )}
              {locationAddress ? (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Address</Text>
                  <Text style={styles.reviewValue}>{locationAddress}</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.navButtons}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setStep("damage")}
              >
                <Text style={styles.secondaryButtonText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>{t("report.submit")}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
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
    justifyContent: "space-between",
  },
  backBtn: { color: "#fff", fontSize: 22 },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700", flex: 1, textAlign: "center" },
  stepIndicator: { color: "#A0B4CC", fontSize: 14 },
  progressBar: { height: 4, backgroundColor: "#e0e0e0" },
  progressFill: { height: 4, backgroundColor: "#0468B1" },
  content: { flex: 1 },
  contentPadding: { padding: 16 },
  step: { gap: 12 },
  stepTitle: { fontSize: 17, fontWeight: "600", color: "#1A2B4A" },
  optionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    backgroundColor: "#fff",
  },
  optionBtnSelected: { borderColor: "#0468B1", backgroundColor: "#E8F4FD" },
  optionIcon: { fontSize: 28 },
  optionText: { fontSize: 16, fontWeight: "600", color: "#1A2B4A" },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  typeBtn: {
    width: "47%",
    padding: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#e0e0e0",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  typeBtnSelected: { borderColor: "#0468B1", backgroundColor: "#E8F4FD" },
  typeBtnText: { fontSize: 13, fontWeight: "500", color: "#1A2B4A" },
  typeBtnTextSelected: { color: "#0468B1" },
  textarea: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    padding: 12,
    fontSize: 15,
    minHeight: 100,
    textAlignVertical: "top",
  },
  gpsButton: {
    backgroundColor: "#E8F4FD",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#0468B1",
  },
  gpsButtonText: { color: "#0468B1", fontWeight: "600", fontSize: 15 },
  fieldLabel: { fontSize: 14, fontWeight: "500", color: "#666" },
  input: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    padding: 12,
    fontSize: 15,
  },
  hintText: { fontSize: 14, color: "#666" },
  photoGrid: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  photoThumb: { width: 100, height: 100, borderRadius: 8, overflow: "hidden", position: "relative" },
  thumbImage: { width: "100%", height: "100%" },
  removePhotoBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  removePhotoBtnText: { color: "#fff", fontSize: 12 },
  addPhotoBtn: {
    width: 100,
    height: 100,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#ccc",
    borderStyle: "dashed",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  addPhotoIcon: { fontSize: 32 },
  addPhotoText: { fontSize: 11, color: "#666" },
  reviewCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  reviewLabel: { fontSize: 14, color: "#666" },
  reviewValue: { fontSize: 14, fontWeight: "500", color: "#1A2B4A", maxWidth: "60%", textAlign: "right" },
  navButtons: { flexDirection: "row", gap: 12, marginTop: 16 },
  primaryButton: {
    flex: 1,
    backgroundColor: "#0468B1",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondaryButton: {
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    alignItems: "center",
  },
  secondaryButtonText: { fontSize: 15, color: "#1A2B4A" },
  successContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    gap: 20,
    backgroundColor: "#f4f6f9",
  },
  homeButton: {
    backgroundColor: "#0468B1",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    width: "100%",
    maxWidth: 300,
  },
  photoButtons: {
    flexDirection: "row",
    gap: 12,
  },
  photoOptionBtn: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#0468B1",
    padding: 16,
    alignItems: "center",
    gap: 8,
  },
  photoOptionIcon: { fontSize: 28 },
  photoOptionText: { fontSize: 13, color: "#0468B1", fontWeight: "500" },
  successIcon: { fontSize: 72 },
  successTitle: { fontSize: 22, fontWeight: "700", color: "#1A2B4A", textAlign: "center" },
  successText: { fontSize: 16, color: "#666", textAlign: "center", lineHeight: 24 },
});