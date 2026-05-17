import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useRef } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Alert, ActivityIndicator, Image, Modal,
  type NativeSyntheticEvent,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import {
  Map as MLMap,
  Camera,
  GeoJSONSource,
  Layer,
  type CameraRef,
  type ViewStateChangeEvent,
  type PressEventWithFeatures,
} from "@maplibre/maplibre-react-native";
import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { addToQueue } from "../utils/offlineQueue";
import type { DamageLevel, QueuedPhoto } from "../types";

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`;

// ── Overpass types ─────────────────────────────────────────────────────────────

interface OverpassNode { type: "node"; id: number; lat: number; lon: number; }
interface OverpassWay { type: "way"; id: number; nodes: number[]; tags?: Record<string, string>; }
interface OverpassOther { type: "relation" | "area"; id: number; tags?: Record<string, string>; }
type OverpassElement = OverpassNode | OverpassWay | OverpassOther;
interface OverpassResponse { elements: OverpassElement[]; }

// ── GeoJSON helpers ────────────────────────────────────────────────────────────

function buildBuildingsFC(data: OverpassResponse): GeoJSON.FeatureCollection {
  const nodes = new Map<number, [number, number]>();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const features: GeoJSON.Feature[] = [];
  for (const el of data.elements) {
    if (el.type !== "way") continue;
    const way = el as OverpassWay;
    if (!way.tags?.building) continue;

    const ring: [number, number][] = [];
    for (const nodeId of way.nodes) {
      const coord = nodes.get(nodeId);
      if (coord) ring.push(coord);
    }
    if (ring.length < 3) continue;

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);

    features.push({
      type: "Feature",
      properties: {
        osm_id: way.id,
        name: way.tags?.name ?? "",
        building: way.tags?.building ?? "yes",
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  return { type: "FeatureCollection", features };
}

function computeCentroid(ring: number[][]): [number, number] {
  const pts =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lng, lat];
}

async function fetchBuildingsForBounds(
  west: number, south: number, east: number, north: number
): Promise<GeoJSON.FeatureCollection | null> {
  const query =
    `[out:json][timeout:25][bbox:${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}];` +
    `(way["building"];relation["building"]["type"="multipolygon"];);out body;>;out skel qt;`;
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    });
    if (!res.ok) return null;
    const data: OverpassResponse = await res.json();
    return buildBuildingsFC(data);
  } catch {
    return null;
  }
}

// ── Question package types ────────────────────────────────────────────────────

interface ApiOption { option_text: string; option_value: string; }
interface ApiQuestion { question_text: string; order_index: number; options: ApiOption[]; }
interface ActivePackage { version: string; questions: ApiQuestion[]; }

// ── Label maps ────────────────────────────────────────────────────────────────

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

const ELECTRICITY_LABELS: Record<string, string> = {
  no_damage: "No damage observed",
  minor: "Minor damage — service disruptions but quickly repairable",
  moderate: "Moderate damage — partial outages requiring repairs",
  severe: "Severe damage — major infrastructure damaged, prolonged outages",
  destroyed: "Completely destroyed — no electricity infrastructure functioning",
  unknown: "Unknown / cannot be assessed",
};

const HEALTH_LABELS: Record<string, string> = {
  fully_functional: "Fully functional",
  partially_functional: "Partially functional",
  largely_disrupted: "Largely disrupted",
  not_functioning: "Not functioning at all",
  unknown: "Unknown",
};

const PRESSING_NEEDS_LABELS: Record<string, string> = {
  food_water: "Food assistance and safe drinking water",
  cash_financial: "Cash or financial assistance",
  healthcare: "Access to healthcare and essential medicines",
  shelter: "Shelter, housing repair, or temporary accommodation",
  livelihoods: "Restoration of livelihoods or income sources",
  wash: "Water, sanitation, and hygiene (toilets, washing facilities)",
  basic_services: "Restoration of basic services and infrastructure (electricity, roads, schools)",
  protection: "Protection services and psychosocial support",
  local_support: "Support from local authorities and community organizations",
  other: "Other — please specify",
};

interface ReportScreenProps { navigation: any; }

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReportScreen({ navigation }: ReportScreenProps) {
  const { t } = useTranslation();
  const { reporterId, languageCode } = useAuthStore();
  const insets = useSafeAreaInsets();

  // Step
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");

  // Damage form
  const [damageLevel, setDamageLevel] = useState<DamageLevel | "">("");
  const [infrastructureTypes, setInfrastructureTypes] = useState<string[]>([]);
  const [infrastructureOther, setInfrastructureOther] = useState("");
  const [infrastructureName, setInfrastructureName] = useState("");
  const [disasterType, setDisasterType] = useState("");
  const [debrisBlocking, setDebrisBlocking] = useState("");
  const [electricityCondition, setElectricityCondition] = useState("");
  const [healthServicesCondition, setHealthServicesCondition] = useState("");
  const [pressingNeeds, setPressingNeeds] = useState<string[]>([]);
  const [pressingNeedsOther, setPressingNeedsOther] = useState("");
  const [damageQuestion, setDamageQuestion] = useState(1);
  const [photos, setPhotos] = useState<{ uri: string; filename: string; type: string }[]>([]);

  // Location
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<{
    id: number;
    name: string;
    building: string;
    centroid: [number, number];
  } | null>(null);
  const [buildingsFC, setBuildingsFC] = useState<GeoJSON.FeatureCollection | null>(null);
  const [selectedBuildingFC, setSelectedBuildingFC] = useState<GeoJSON.FeatureCollection | null>(null);
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");
  const [locationBuildingName, setLocationBuildingName] = useState("");
  const [manualExpanded, setManualExpanded] = useState(false);
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [mapZoom, setMapZoom] = useState(2);

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [wasQueued, setWasQueued] = useState(false);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(null);
  const [showDupeWarning, setShowDupeWarning] = useState(false);
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);
  const [questionPackage, setQuestionPackage] = useState<ActivePackage | null>(null);

  // Map refs
  const cameraRef = useRef<CameraRef | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const init = async () => {
      try {
        const crisisRes = await api.get("/api/crises/active");
        const list = Array.isArray(crisisRes.data) ? crisisRes.data : (crisisRes.data?.items ?? []);
        if (list.length > 0) setCrisisId(list[0].id);
        else setCrisisError(true);
      } catch {
        setCrisisError(true);
      }
      try {
        const pkgRes = await api.get<ActivePackage>("/api/question-packages/active");
        setQuestionPackage(pkgRes.data);
      } catch {
        // silent — hardcoded question text and options remain active as fallback
      }
      setCrisisLoading(false);
    };
    init();
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // ── Question package helpers ──────────────────────────────────────────────────

  const qTitle = (n: number, fallback: string): string => {
    const found = questionPackage?.questions.find((q) => q.order_index === n);
    return found ? found.question_text : fallback;
  };

  const qOptions = (
    n: number,
    fallback: Array<{ value: string; label: string }>
  ): Array<{ value: string; label: string }> => {
    const found = questionPackage?.questions.find((q) => q.order_index === n);
    if (found?.options?.length)
      return found.options.map((o) => ({ value: o.option_value, label: o.option_text }));
    return fallback;
  };

  // ── Map handlers ─────────────────────────────────────────────────────────────

  const handleMapLoaded = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      cameraRef.current?.flyTo({
        center: [loc.coords.longitude, loc.coords.latitude],
        zoom: 15,
        duration: 1000,
      });
    } catch {
      // Silent — map remains at world view
    }
  };

  const handleRegionChange = (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const { zoom, bounds } = event.nativeEvent;
    setMapZoom(zoom);
    if (zoom < 14) return;

    const [west, south, east, north] = bounds;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      const fc = await fetchBuildingsForBounds(west, south, east, north);
      if (fc) setBuildingsFC(fc);
    }, 1000);
  };

  const handleBuildingPress = (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
    const { features } = event.nativeEvent;
    if (!features?.length) return;

    const f = features[0];
    const props = f.properties as { osm_id: number; name: string; building: string };
    const geom = f.geometry as GeoJSON.Polygon;
    const ring = geom.coordinates[0];
    const [centLng, centLat] = computeCentroid(ring);

    setSelectedBuilding({
      id: props.osm_id,
      name: props.name ?? "",
      building: props.building ?? "yes",
      centroid: [centLng, centLat],
    });
    setGpsCoords({ lat: centLat, lng: centLng });
    setSelectedBuildingFC({ type: "FeatureCollection", features: [f] });
  };

  // ── Location actions ──────────────────────────────────────────────────────────

  const handleGetGPS = async () => {
    setGpsCapturing(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;
      setGpsCoords({ lat, lng });
      setSelectedBuilding(null);
      setSelectedBuildingFC(null);
      cameraRef.current?.flyTo({ center: [lng, lat], zoom: 16, duration: 800 });
    } catch {
      Alert.alert("GPS Error", "Could not get location.");
    } finally {
      setGpsCapturing(false);
    }
  };

  const isLocationValid = (): boolean =>
    !!gpsCoords ||
    locationAddress.trim().length > 0 ||
    locationLandmark.trim().length > 0 ||
    locationBuildingName.trim().length > 0;

  // ── Photo handlers ────────────────────────────────────────────────────────────

  const handleTakePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert("Permission needed", "Please allow camera access in settings.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setPhotos((prev) => [...prev, { uri: asset.uri, filename: `photo_${Date.now()}.jpg`, type: "image/jpeg" }]);
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
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setPhotos((prev) => [...prev, { uri: asset.uri, filename: `photo_${Date.now()}.jpg`, type: "image/jpeg" }]);
      }
    } catch (e) {
      Alert.alert("Gallery Error", String(e));
    }
  };

  // ── Damage handlers ───────────────────────────────────────────────────────────

  const toggleInfraType = (value: string) => {
    setInfrastructureTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const togglePressingNeed = (value: string) => {
    setPressingNeeds((prev) =>
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
      case 6: return !!electricityCondition;
      case 7: return !!healthServicesCondition;
      case 8: return pressingNeeds.length > 0;
      default: return false;
    }
  };

  const handleDamageBack = () => {
    if (damageQuestion === 1) setStep("location");
    else setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = () => {
    if (damageQuestion < 8) setDamageQuestion((q) => q + 1);
    else setStep("review");
  };

  // ── Submit ────────────────────────────────────────────────────────────────────

  const checkDuplicate = async (): Promise<boolean> => {
    if (!gpsCoords || !crisisId) return false;
    try {
      const raw = await AsyncStorage.getItem("cr_submitted_locations");
      if (!raw) return false;
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number }> = JSON.parse(raw);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return locs.some(
        (l) =>
          l.crisis_id === crisisId &&
          Math.abs(l.lat - gpsCoords.lat) < 0.001 &&
          Math.abs(l.lng - gpsCoords.lng) < 0.001 &&
          l.timestamp > cutoff
      );
    } catch {
      return false;
    }
  };

  const saveSubmittedLocation = async () => {
    if (!gpsCoords || !crisisId) return;
    try {
      const raw = await AsyncStorage.getItem("cr_submitted_locations");
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number }> =
        raw ? JSON.parse(raw) : [];
      locs.push({ lat: gpsCoords.lat, lng: gpsCoords.lng, crisis_id: crisisId, timestamp: Date.now() });
      await AsyncStorage.setItem("cr_submitted_locations", JSON.stringify(locs));
    } catch { /* non-critical */ }
  };

  const resetForm = () => {
    setDamageLevel("");
    setInfrastructureTypes([]);
    setInfrastructureOther("");
    setInfrastructureName("");
    setDisasterType("");
    setDebrisBlocking("");
    setElectricityCondition("");
    setHealthServicesCondition("");
    setPressingNeeds([]);
    setPressingNeedsOther("");
    setDamageQuestion(1);
    setPhotos([]);
    setGpsCoords(null);
    setSelectedBuilding(null);
    setBuildingsFC(null);
    setSelectedBuildingFC(null);
    setLocationAddress("");
    setLocationLandmark("");
    setLocationBuildingName("");
    setManualExpanded(false);
    setSubmitted(false);
    setWasQueued(false);
    setSubmittedReportId(null);
    setStep("photos");
  };

  const buildLocationAddress = (): string | null => {
    if (selectedBuilding) {
      const parts = [
        selectedBuilding.name,
        selectedBuilding.building !== "yes" ? selectedBuilding.building : "",
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" — ") : null;
    }
    return locationAddress || null;
  };

  const doSubmit = async () => {
    setShowDupeWarning(false);
    setSubmitting(true);

    const reportPayload = {
      crisis_id: crisisId!,
      damage_level: damageLevel as DamageLevel,
      infrastructure_types: infrastructureTypes,
      ...(infrastructureTypes.includes("other") && { infrastructure_other: infrastructureOther }),
      infrastructure_name: infrastructureName,
      disaster_type: disasterType,
      debris_blocking: debrisBlocking,
      electricity_condition: electricityCondition,
      health_services_condition: healthServicesCondition,
      pressing_needs: pressingNeeds,
      ...(pressingNeeds.includes("other") && { pressing_needs_other: pressingNeedsOther }),
      platform: "android" as const,
      submitted_at: new Date().toISOString(),
      building_id: selectedBuilding ? String(selectedBuilding.id) : null,
      location: {
        gps_latitude: gpsCoords?.lat ?? null,
        gps_longitude: gpsCoords?.lng ?? null,
        gps_accuracy_meters: null,
        gps_available: !!gpsCoords,
        location_address: buildLocationAddress(),
        location_landmark: locationLandmark || null,
        location_building_name: locationBuildingName || null,
      },
      reporter_id: reporterId || undefined,
      language_code: languageCode,
      question_package_version: questionPackage?.version ?? null,
      was_queued: false,
    };

    try {
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      for (let i = 0; i < photos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", { uri: photos[i].uri, name: photos[i].filename, type: photos[i].type } as any);
        await api.post("/api/photos", formData, { headers: { "Content-Type": "multipart/form-data" } });
      }

      await saveSubmittedLocation();
      setSubmittedReportId(reportId as string);
      setWasQueued(false);
      setSubmitted(true);
    } catch {
      const queuedPhotos: QueuedPhoto[] = photos.map((p, i) => ({
        uri: p.uri,
        filename: p.filename,
        content_type: p.type,
        display_order: i,
      }));
      // ReportSubmitRequest type predates multi-type infra fields — cast to bypass
      await addToQueue({ ...reportPayload, was_queued: true } as any, queuedPhotos);
      await saveSubmittedLocation();
      setSubmittedReportId(null);
      setWasQueued(true);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!damageLevel || infrastructureTypes.length === 0 || !infrastructureName.trim() || !disasterType || !debrisBlocking || !electricityCondition || !healthServicesCondition || pressingNeeds.length === 0 || photos.length === 0) {
      Alert.alert("Required Fields", "Please complete all required fields.");
      return;
    }
    const isDupe = await checkDuplicate();
    if (isDupe) {
      setShowDupeWarning(true);
      return;
    }
    await doSubmit();
  };

  // ── Early returns ─────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <View style={styles.successContainer}>
        <View style={styles.confirmCheckCircle}>
          <Text style={styles.confirmCheckIcon}>✓</Text>
        </View>
        <Text style={styles.successTitle}>
          {wasQueued ? "Report Saved" : "Report Submitted"}
        </Text>
        <Text style={styles.successText}>
          {wasQueued
            ? "Your report has been saved and will be sent automatically when you reconnect to the internet."
            : "Thank you for helping UNDP map crisis damage. Your report has been received and is now part of the crisis map."}
        </Text>
        <View style={styles.confirmRefBadge}>
          <Text style={styles.confirmRefText}>
            {wasQueued
              ? "Your report is queued"
              : `Report ref: ${(submittedReportId ?? "").slice(0, 8).toUpperCase()}`}
          </Text>
        </View>
        <TouchableOpacity style={styles.homeButton} onPress={resetForm}>
          <Text style={styles.primaryButtonText}>Submit Another Report</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate("Home")}>
          <Text style={styles.goHomeText}>Go to Home</Text>
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
        <Text style={styles.errorText}>No active crisis found. Please try again later.</Text>
        <TouchableOpacity style={styles.homeButton} onPress={() => navigation.goBack()}>
          <Text style={styles.primaryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const stepNumber = step === "photos" ? 1 : step === "location" ? 2 : step === "damage" ? 3 : 4;

  // ── Render ─────────────────────────────────────────────────────────────────────

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

      {/* Step 2 — Location (map-based, outside ScrollView) */}
      {step === "location" && (
        <View style={{ flex: 1 }}>
          {/* Map fills most of the screen */}
          <View style={{ flex: 1 }}>
            <MLMap
              mapStyle={MAP_STYLE_URL}
              style={{ flex: 1 }}
              onRegionDidChange={handleRegionChange}
              onDidFinishLoadingMap={handleMapLoaded}
            >
              <Camera
                ref={cameraRef}
                initialViewState={{ center: [0, 20], zoom: 2 }}
              />

              {/* Default building footprints */}
              {buildingsFC && (
                <GeoJSONSource id="buildings" data={buildingsFC} onPress={handleBuildingPress}>
                  <Layer
                    id="buildings-fill"
                    type="fill"
                    paint={{ "fill-color": "#CBD5E0", "fill-opacity": 0.5 }}
                  />
                  <Layer
                    id="buildings-outline"
                    type="line"
                    paint={{ "line-color": "#718096", "line-width": 0.6 }}
                  />
                </GeoJSONSource>
              )}

              {/* Selected building highlight */}
              {selectedBuildingFC && (
                <GeoJSONSource id="selected-building" data={selectedBuildingFC}>
                  <Layer
                    id="selected-building-fill"
                    type="fill"
                    paint={{ "fill-color": "#0468B1", "fill-opacity": 0.7 }}
                  />
                  <Layer
                    id="selected-building-outline"
                    type="line"
                    paint={{ "line-color": "#0468B1", "line-width": 2 }}
                  />
                </GeoJSONSource>
              )}
            </MLMap>

            {/* Zoom hint overlay */}
            {mapZoom < 14 && (
              <View style={styles.zoomHint} pointerEvents="none">
                <Text style={styles.zoomHintText}>Zoom in to see and select buildings</Text>
              </View>
            )}
          </View>

          {/* Bottom panel */}
          <ScrollView
            style={styles.locationPanel}
            contentContainerStyle={styles.locationPanelContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.stepTitle}>{t("report.location")}</Text>

            {/* Building selection info card */}
            {selectedBuilding && (
              <View style={styles.selectionCard}>
                <Text style={styles.selectionCardTitle}>Building Selected</Text>
                <Text style={styles.selectionCardName}>
                  {selectedBuilding.name || "Unnamed building"}
                </Text>
                {selectedBuilding.building !== "yes" && (
                  <Text style={styles.selectionCardMeta}>Type: {selectedBuilding.building}</Text>
                )}
                <Text style={styles.selectionCardCoords}>
                  {selectedBuilding.centroid[1].toFixed(6)}, {selectedBuilding.centroid[0].toFixed(6)}
                </Text>
              </View>
            )}

            {/* GPS-only info card (when GPS captured without building) */}
            {gpsCoords && !selectedBuilding && (
              <View style={styles.selectionCard}>
                <Text style={styles.selectionCardTitle}>GPS Location Captured</Text>
                <Text style={styles.selectionCardCoords}>
                  {gpsCoords.lat.toFixed(6)}, {gpsCoords.lng.toFixed(6)}
                </Text>
              </View>
            )}

            {/* GPS capture button */}
            <TouchableOpacity
              style={[styles.gpsButton, gpsCapturing && styles.buttonDisabled]}
              onPress={handleGetGPS}
              disabled={gpsCapturing}
            >
              <Text style={styles.gpsButtonText}>
                {gpsCapturing ? "Getting location…" : "📍 Use My GPS Location"}
              </Text>
            </TouchableOpacity>

            {/* Manual location toggle */}
            <TouchableOpacity onPress={() => setManualExpanded(!manualExpanded)}>
              <Text style={styles.manualToggle}>
                {manualExpanded ? "Hide manual entry ▲" : "Enter location manually instead ▼"}
              </Text>
            </TouchableOpacity>

            {manualExpanded && (
              <View style={{ gap: 8 }}>
                <TextInput
                  style={styles.input}
                  placeholder="Address"
                  value={locationAddress}
                  onChangeText={setLocationAddress}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Landmark (e.g. Near central market)"
                  value={locationLandmark}
                  onChangeText={setLocationLandmark}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Building Name"
                  value={locationBuildingName}
                  onChangeText={setLocationBuildingName}
                />
              </View>
            )}

            <View style={styles.navButtons}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep("photos")}>
                <Text style={styles.secondaryButtonText}>← Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryButton, !isLocationValid() && styles.buttonDisabled]}
                onPress={() => setStep("damage")}
                disabled={!isLocationValid()}
              >
                <Text style={styles.primaryButtonText}>Next →</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      )}

      {/* Duplicate submission warning modal */}
      <Modal visible={showDupeWarning} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Report already submitted for this location</Text>
            <Text style={styles.modalBody}>
              It looks like you may have already submitted a report for this building. Submitting again could create a duplicate. Are you sure you want to continue?
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setShowDupeWarning(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryButton, { flex: 1 }]} onPress={doSubmit}>
                <Text style={styles.primaryButtonText}>Submit Anyway</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* All other steps inside ScrollView */}
      {step !== "location" && (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentPadding}>

          {/* Step 1 — Photos */}
          {step === "photos" && (
            <View style={styles.step}>
              <Text style={styles.stepTitle}>{t("report.photos")} *</Text>
              <Text style={styles.hintText}>Add up to 3 photos. At least 1 required.</Text>

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
                  <TouchableOpacity style={styles.photoOptionBtn} onPress={handleTakePhoto}>
                    <Text style={styles.photoOptionIcon}>📷</Text>
                    <Text style={styles.photoOptionText}>{t("report.takePhoto")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.photoOptionBtn} onPress={handlePickPhoto}>
                    <Text style={styles.photoOptionIcon}>🖼️</Text>
                    <Text style={styles.photoOptionText}>{t("report.uploadPhoto")}</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, photos.length === 0 && styles.buttonDisabled]}
                onPress={() => photos.length > 0 && setStep("location")}
                disabled={photos.length === 0}
              >
                <Text style={styles.primaryButtonText}>Next →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Step 3 — Damage Assessment */}
          {step === "damage" && (
            <View style={styles.step}>
              <Text style={styles.questionProgress}>Question {damageQuestion} of 8</Text>

              {damageQuestion === 1 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(1, "How bad is the damage? *")}</Text>
                  {qOptions(1, [
                    { value: "minimal", label: "Minimal / No damage" },
                    { value: "partial", label: "Partially damaged" },
                    { value: "complete", label: "Completely damaged" },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity
                      key={value}
                      style={[styles.optionBtn, damageLevel === value && styles.optionBtnSelected]}
                      onPress={() => setDamageLevel(value as DamageLevel)}
                    >
                      <Text style={styles.optionIcon}>
                        {value === "minimal" ? "🟢" : value === "partial" ? "🟠" : "🔴"}
                      </Text>
                      <Text style={styles.optionText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {damageQuestion === 2 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(2, "What type of infrastructure is this? *")}</Text>
                  <Text style={styles.hintText}>Select all that apply.</Text>
                  {qOptions(2, [
                    { value: "residential", label: "Residential Infrastructure" },
                    { value: "commercial", label: "Commercial Infrastructure" },
                    { value: "government", label: "Government Building" },
                    { value: "utility", label: "Utility Infrastructure" },
                    { value: "transport_communication", label: "Transport and Communication Infrastructure" },
                    { value: "community", label: "Community Infrastructure" },
                    { value: "public_spaces", label: "Public Spaces / Recreation Infrastructure" },
                    { value: "other", label: "Other (please specify)" },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity key={value} style={styles.checkRow} onPress={() => toggleInfraType(value)}>
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

              {damageQuestion === 3 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(3, "What is the name of this infrastructure? *")}</Text>
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

              {damageQuestion === 4 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(4, "What type of disaster caused this damage? *")}</Text>
                  {qOptions(4, [
                    { value: "earthquake", label: "Earthquake" },
                    { value: "flood", label: "Flood" },
                    { value: "cyclone", label: "Cyclone / Typhoon / Hurricane" },
                    { value: "landslide", label: "Landslide" },
                    { value: "fire", label: "Fire" },
                    { value: "conflict", label: "Conflict / War" },
                    { value: "other", label: "Other" },
                  ]).map(({ value, label }) => (
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

              {damageQuestion === 5 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(5, "Is there debris blocking access? *")}</Text>
                  {qOptions(5, [
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" },
                    { value: "partially", label: "Partially" },
                  ]).map(({ value, label }) => (
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

              {damageQuestion === 6 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(6, "What is the current condition of electricity infrastructure in your community following the crisis? *")}</Text>
                  {qOptions(6, [
                    { value: "no_damage", label: "No damage observed" },
                    { value: "minor", label: "Minor damage — service disruptions but quickly repairable" },
                    { value: "moderate", label: "Moderate damage — partial outages requiring repairs" },
                    { value: "severe", label: "Severe damage — major infrastructure damaged, prolonged outages" },
                    { value: "destroyed", label: "Completely destroyed — no electricity infrastructure functioning" },
                    { value: "unknown", label: "Unknown / cannot be assessed" },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity
                      key={value}
                      style={[styles.optionBtn, electricityCondition === value && styles.optionBtnSelected]}
                      onPress={() => setElectricityCondition(value)}
                    >
                      <Text style={styles.optionText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {damageQuestion === 7 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(7, "How would you rate the overall functioning of health services in your community since the event? *")}</Text>
                  {qOptions(7, [
                    { value: "fully_functional", label: "Fully functional" },
                    { value: "partially_functional", label: "Partially functional" },
                    { value: "largely_disrupted", label: "Largely disrupted" },
                    { value: "not_functioning", label: "Not functioning at all" },
                    { value: "unknown", label: "Unknown" },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity
                      key={value}
                      style={[styles.optionBtn, healthServicesCondition === value && styles.optionBtnSelected]}
                      onPress={() => setHealthServicesCondition(value)}
                    >
                      <Text style={styles.optionText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {damageQuestion === 8 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(8, "What are the most pressing needs in your community right now? *")}</Text>
                  <Text style={styles.hintText}>Select all that apply. At least one required.</Text>
                  {qOptions(8, [
                    { value: "food_water", label: "Food assistance and safe drinking water" },
                    { value: "cash_financial", label: "Cash or financial assistance" },
                    { value: "healthcare", label: "Access to healthcare and essential medicines" },
                    { value: "shelter", label: "Shelter, housing repair, or temporary accommodation" },
                    { value: "livelihoods", label: "Restoration of livelihoods or income sources" },
                    { value: "wash", label: "Water, sanitation, and hygiene (toilets, washing facilities)" },
                    { value: "basic_services", label: "Restoration of basic services and infrastructure (electricity, roads, schools)" },
                    { value: "protection", label: "Protection services and psychosocial support" },
                    { value: "local_support", label: "Support from local authorities and community organizations" },
                    { value: "other", label: "Other — please specify" },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity key={value} style={styles.checkRow} onPress={() => togglePressingNeed(value)}>
                      <View style={[styles.checkbox, pressingNeeds.includes(value) && styles.checkboxSelected]}>
                        {pressingNeeds.includes(value) && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                      <Text style={styles.checkRowText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                  {pressingNeeds.includes("other") && (
                    <View>
                      <TextInput
                        style={[styles.input, { marginTop: 8 }]}
                        placeholder="Please specify (max 100 characters)"
                        value={pressingNeedsOther}
                        onChangeText={(txt) => setPressingNeedsOther(txt.slice(0, 100))}
                        maxLength={100}
                      />
                      <Text style={styles.charCounter}>{pressingNeedsOther.length} / 100</Text>
                    </View>
                  )}
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
                    {infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v).join(", ")}
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
                  <Text style={styles.reviewLabel}>Electricity</Text>
                  <Text style={styles.reviewValue}>{ELECTRICITY_LABELS[electricityCondition] ?? electricityCondition}</Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Health Services</Text>
                  <Text style={styles.reviewValue}>{HEALTH_LABELS[healthServicesCondition] ?? healthServicesCondition}</Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Pressing Needs</Text>
                  <Text style={styles.reviewValue}>
                    {pressingNeeds.map((v) => PRESSING_NEEDS_LABELS[v] ?? v).join(", ")}
                    {pressingNeeds.includes("other") && pressingNeedsOther ? ` (${pressingNeedsOther})` : ""}
                  </Text>
                </View>
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>Photos</Text>
                  <Text style={styles.reviewValue}>{photos.length} photo(s)</Text>
                </View>
                {selectedBuilding && (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Location</Text>
                    <Text style={styles.reviewValue}>
                      {selectedBuilding.name || "Building selected"}
                    </Text>
                  </View>
                )}
                {gpsCoords && !selectedBuilding && (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>GPS</Text>
                    <Text style={styles.reviewValue}>
                      {gpsCoords.lat.toFixed(4)}, {gpsCoords.lng.toFixed(4)}
                    </Text>
                  </View>
                )}
                {locationAddress && !gpsCoords ? (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>Address</Text>
                    <Text style={styles.reviewValue}>{locationAddress}</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.navButtons}>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => { setDamageQuestion(8); setStep("damage"); }}
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
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

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

  // Location step
  locationPanel: { flexShrink: 0, maxHeight: 340, backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: "#e0e0e0" },
  locationPanelContent: { padding: 14, gap: 10 },
  zoomHint: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    backgroundColor: "rgba(26,43,74,0.82)",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    zIndex: 10,
  },
  zoomHintText: { color: "#fff", fontSize: 12, fontWeight: "500" },
  selectionCard: {
    backgroundColor: "#E8F4FD",
    borderWidth: 1.5,
    borderColor: "#0468B1",
    borderRadius: 8,
    padding: 12,
    gap: 2,
  },
  selectionCardTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#0468B1",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  selectionCardName: { fontSize: 15, fontWeight: "600", color: "#1A2B4A" },
  selectionCardMeta: { fontSize: 12, color: "#718096" },
  selectionCardCoords: { fontSize: 11, color: "#718096", fontVariant: ["tabular-nums"] },
  manualToggle: { fontSize: 13, color: "#0468B1", textDecorationLine: "underline" },

  // Damage / shared
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
  input: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e0e0e0",
    padding: 12,
    fontSize: 15,
  },
  hintText: { fontSize: 14, color: "#666" },

  // GPS button (reused for location panel)
  gpsButton: {
    backgroundColor: "#1A2B4A",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
  },
  gpsButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },

  // Photos
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
  photoButtons: { flexDirection: "row", gap: 12 },
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

  // Review
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

  // Nav
  navButtons: { flexDirection: "row", gap: 12, marginTop: 8 },
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

  // Success / error screens
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
  successTitle: { fontSize: 22, fontWeight: "700", color: "#1A2B4A", textAlign: "center" },
  successText: { fontSize: 16, color: "#666", textAlign: "center", lineHeight: 24 },
  errorText: { fontSize: 16, color: "#d32f2f", textAlign: "center", lineHeight: 24 },
  confirmCheckCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#22c55e",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmCheckIcon: { fontSize: 44, color: "#fff", lineHeight: 52 },
  confirmRefBadge: {
    backgroundColor: "#f4f6f9",
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  confirmRefText: { fontSize: 14, color: "#666", letterSpacing: 0.5 },
  goHomeText: { fontSize: 15, color: "#666", textDecorationLine: "underline" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalBox: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 24,
    width: "100%",
    maxWidth: 380,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  modalTitle: { fontSize: 17, fontWeight: "700", color: "#1A2B4A", marginBottom: 12 },
  modalBody: { fontSize: 15, color: "#444", lineHeight: 22, marginBottom: 20 },
  modalButtons: { flexDirection: "row", gap: 12 },
  questionProgress: { fontSize: 13, fontWeight: "600", color: "#0468B1", textAlign: "center" },

  // Unused legacy keys kept to avoid StyleSheet warnings if referenced elsewhere
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  typeBtn: { width: "47%", padding: 12, borderRadius: 8, borderWidth: 1.5, borderColor: "#e0e0e0", backgroundColor: "#fff", alignItems: "center" },
  typeBtnSelected: { borderColor: "#0468B1", backgroundColor: "#E8F4FD" },
  typeBtnText: { fontSize: 13, fontWeight: "500", color: "#1A2B4A" },
  typeBtnTextSelected: { color: "#0468B1" },
  textarea: { backgroundColor: "#fff", borderRadius: 8, borderWidth: 1, borderColor: "#e0e0e0", padding: 12, fontSize: 15, minHeight: 100, textAlignVertical: "top" },
  addPhotoBtn: { width: 100, height: 100, borderRadius: 8, borderWidth: 2, borderColor: "#ccc", borderStyle: "dashed", backgroundColor: "#fff", alignItems: "center", justifyContent: "center", gap: 4 },
  addPhotoIcon: { fontSize: 32 },
  addPhotoText: { fontSize: 11, color: "#666" },
  fieldLabel: { fontSize: 14, fontWeight: "500", color: "#666" },
});
