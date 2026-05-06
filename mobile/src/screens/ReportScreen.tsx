import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect } from "react";
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


const DAMAGE_LABELS: Record<string, string> = {
  minimal: "Minimal / No damage",
  partial: "Partially damaged",
  complete: "Completely damaged",
};

const INFRA_LABELS: Record<string, string> = {
  residential: "Residential Infrastructure",
  commercial: "Commercial Infrastructure",
  government: "Government Building",
  utility: "Utility Infrastructure",
  transport_communication: "Transport & Communication Infrastructure",
  community: "Community Infrastructure",
  public_spaces: "Public Spaces / Recreation Infrastructure",
  other: "Other",
};

const DISASTER_LABELS: Record<string, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  cyclone: "Cyclone / Typhoon / Hurricane",
  landslide: "Landslide",
  fire: "Fire",
  conflict: "Conflict / War",
  other: "Other",
};

const DEBRIS_LABELS: Record<string, string> = {
  yes: "Yes",
  no: "No",
  partially: "Partially",
};

interface ReportScreenProps {
  navigation: any;
}

export default function ReportScreen({ navigation }: ReportScreenProps) {
  const { t } = useTranslation();
  const { reporterId, languageCode } = useAuthStore();

  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [damageLevel, setDamageLevel] = useState<DamageLevel | "">("");
  const [infrastructureTypes, setInfrastructureTypes] = useState<string[]>([]);
  const [infrastructureOther, setInfrastructureOther] = useState("");
  const [infrastructureName, setInfrastructureName] = useState("");
  const [disasterType, setDisasterType] = useState("");
  const [debrisBlocking, setDebrisBlocking] = useState("");
  const [damageQuestion, setDamageQuestion] = useState(1);
  const [photos, setPhotos] = useState<{ uri: string; filename: string; type: string }[]>([]);
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [wasQueued, setWasQueued] = useState(false);
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    api.get("/api/crises/active")
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
        if (list.length > 0) {
          setCrisisId(list[0].id);
        } else {
          setCrisisError(true);
        }
      })
      .catch(() => setCrisisError(true))
      .finally(() => setCrisisLoading(false));
  }, []);

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

  const toggleInfraType = (value: string) => {
    setInfrastructureTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const isDamageQuestionAnswered = (): boolean => {
    switch (damageQuestion) {
      case 1: return !!damageLevel;
      case 2: return infrastructureTypes.length > 0;
      case 3: return infrastructureName.trim().length > 0;
      case 4: return !!disasterType;
      case 5: return !!debrisBlocking;
      default: return false;
    }
  };

  const handleDamageBack = () => {
    if (damageQuestion === 1) setStep("location");
    else setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = () => {
    if (damageQuestion < 5) setDamageQuestion((q) => q + 1);
    else setStep("review");
  };

  const handleSubmit = async () => {
    if (!damageLevel || infrastructureTypes.length === 0 || !infrastructureName.trim() || !disasterType || !debrisBlocking || photos.length === 0) {
      Alert.alert("Required Fields", "Please complete all required fields.");
      return;
    }

    setSubmitting(true);

    const reportPayload = {
      crisis_id: crisisId!,
      damage_level: damageLevel as DamageLevel,
      infrastructure_types: infrastructureTypes,
      ...(infrastructureTypes.includes("other") && { infrastructure_other: infrastructureOther }),
      infrastructure_name: infrastructureName,
      disaster_type: disasterType,
      debris_blocking: debrisBlocking,
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

  if (crisisLoading) {
    return (
      <View style={styles.successContainer}>
        <ActivityIndicator size="large" color="#0468B1" />
      </View>
    );
  }

  if (crisisError || !crisisId) {
    return (
      <View style={styles.successContainer}>
        <Text style={styles.errorText}>
          No active crisis found. Please try again later.
        </Text>
        <TouchableOpacity style={styles.homeButton} onPress={() => navigation.goBack()}>
          <Text style={styles.primaryButtonText}>Go Back</Text>
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
            <Text style={styles.questionProgress}>Question {damageQuestion} of 5</Text>

            {/* Q1 — Damage level */}
            {damageQuestion === 1 && (
              <>
                <Text style={styles.stepTitle}>How bad is the damage? *</Text>
                {([
                  { value: "minimal" as DamageLevel, label: "Minimal / No damage" },
                  { value: "partial" as DamageLevel, label: "Partially damaged" },
                  { value: "complete" as DamageLevel, label: "Completely damaged" },
                ]).map(({ value, label }) => (
                  <TouchableOpacity
                    key={value}
                    style={[styles.optionBtn, damageLevel === value && styles.optionBtnSelected]}
                    onPress={() => setDamageLevel(value)}
                  >
                    <Text style={styles.optionIcon}>
                      {value === "minimal" ? "🟢" : value === "partial" ? "🟠" : "🔴"}
                    </Text>
                    <Text style={styles.optionText}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* Q2 — Infrastructure type (multi-select) */}
            {damageQuestion === 2 && (
              <>
                <Text style={styles.stepTitle}>What type of infrastructure is this? *</Text>
                <Text style={styles.hintText}>Select all that apply.</Text>
                {[
                  { value: "residential", label: "Residential Infrastructure" },
                  { value: "commercial", label: "Commercial Infrastructure" },
                  { value: "government", label: "Government Building" },
                  { value: "utility", label: "Utility Infrastructure" },
                  { value: "transport_communication", label: "Transport and Communication Infrastructure" },
                  { value: "community", label: "Community Infrastructure" },
                  { value: "public_spaces", label: "Public Spaces / Recreation Infrastructure" },
                  { value: "other", label: "Other (please specify)" },
                ].map(({ value, label }) => (
                  <TouchableOpacity
                    key={value}
                    style={styles.checkRow}
                    onPress={() => toggleInfraType(value)}
                  >
                    <View style={[styles.checkbox, infrastructureTypes.includes(value) && styles.checkboxSelected]}>
                      {infrastructureTypes.includes(value) && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkRowText}>{label}</Text>
                  </TouchableOpacity>
                ))}
                {infrastructureTypes.includes("other") && (
                  <TextInput
                    style={[styles.input, { marginTop: 8 }]}
                    placeholder="Please specify (max 100 characters)"
                    value={infrastructureOther}
                    onChangeText={(t) => setInfrastructureOther(t.slice(0, 100))}
                    maxLength={100}
                  />
                )}
              </>
            )}

            {/* Q3 — Infrastructure name */}
            {damageQuestion === 3 && (
              <>
                <Text style={styles.stepTitle}>What is the name of this infrastructure? *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Main Street Bridge"
                  value={infrastructureName}
                  onChangeText={(t) => setInfrastructureName(t.slice(0, 200))}
                  maxLength={200}
                />
                <Text style={styles.charCounter}>{infrastructureName.length} / 200</Text>
              </>
            )}

            {/* Q4 — Disaster type */}
            {damageQuestion === 4 && (
              <>
                <Text style={styles.stepTitle}>What type of disaster caused this damage? *</Text>
                {[
                  { value: "earthquake", label: "Earthquake" },
                  { value: "flood", label: "Flood" },
                  { value: "cyclone", label: "Cyclone / Typhoon / Hurricane" },
                  { value: "landslide", label: "Landslide" },
                  { value: "fire", label: "Fire" },
                  { value: "conflict", label: "Conflict / War" },
                  { value: "other", label: "Other" },
                ].map(({ value, label }) => (
                  <TouchableOpacity
                    key={value}
                    style={[styles.optionBtn, disasterType === value && styles.optionBtnSelected]}
                    onPress={() => setDisasterType(value)}
                  >
                    <Text style={styles.optionText}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* Q5 — Debris blocking */}
            {damageQuestion === 5 && (
              <>
                <Text style={styles.stepTitle}>Is there debris blocking access? *</Text>
                {[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                  { value: "partially", label: "Partially" },
                ].map(({ value, label }) => (
                  <TouchableOpacity
                    key={value}
                    style={[styles.optionBtn, debrisBlocking === value && styles.optionBtnSelected]}
                    onPress={() => setDebrisBlocking(value)}
                  >
                    <Text style={styles.optionText}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            <View style={styles.navButtons}>
              <TouchableOpacity style={styles.secondaryButton} onPress={handleDamageBack}>
                <Text style={styles.secondaryButtonText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, !isDamageQuestionAnswered() && styles.buttonDisabled]}
                onPress={handleDamageNext}
                disabled={!isDamageQuestionAnswered()}
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
                <Text style={styles.reviewValue}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Infrastructure</Text>
                <Text style={styles.reviewValue}>
                  {infrastructureTypes.map((t) => INFRA_LABELS[t] ?? t).join(", ")}
                </Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Infrastructure Name</Text>
                <Text style={styles.reviewValue}>{infrastructureName}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Disaster Type</Text>
                <Text style={styles.reviewValue}>{DISASTER_LABELS[disasterType] ?? disasterType}</Text>
              </View>
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>Debris Blocking</Text>
                <Text style={styles.reviewValue}>{DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking}</Text>
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
                onPress={() => { setDamageQuestion(5); setStep("damage"); }}
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
  errorText: { fontSize: 16, color: "#d32f2f", textAlign: "center", lineHeight: 24 },
  questionProgress: { fontSize: 13, fontWeight: "600", color: "#0468B1", textAlign: "center" },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: "#ccc",
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxSelected: { borderColor: "#0468B1", backgroundColor: "#0468B1" },
  checkmark: { color: "#fff", fontSize: 13, fontWeight: "700" },
  checkRowText: { flex: 1, fontSize: 15, color: "#1A2B4A" },
  charCounter: { fontSize: 12, color: "#999", textAlign: "right" },
});