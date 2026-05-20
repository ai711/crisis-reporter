import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Alert, ActivityIndicator, Image, Modal, Linking, Platform,
  type NativeSyntheticEvent,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import {
  Map as MLMap,
  Camera,
  GeoJSONSource,
  Layer,
  UserLocation,
  Marker,
  type CameraRef,
  type ViewStateChangeEvent,
  type PressEventWithFeatures,
} from "@maplibre/maplibre-react-native";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { addToQueue } from "../utils/offlineQueue";
import NetInfo from "@react-native-community/netinfo";
import StepIndicator from "../components/StepIndicator";
import type { DamageLevel, QueuedPhoto, ProcessedPhoto } from "../types";

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
const MAP_STYLE_URL = `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`;
const ANSWERS_KEY = 'cr_draft_answers';

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
interface ApiQuestion {
  question_text: string;
  order_index: number;
  options: ApiOption[];
  type?: 'single_select' | 'multi_select' | 'free_text';
  is_mandatory?: boolean;
  max_length?: number;
}
interface ActivePackage { version: string; translation_version?: string; questions: ApiQuestion[]; }

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

  const Q4_GROUPS = [
    {
      groupLabel: t('questions.q4.group_natural'),
      options: [
        { value: 'earthquake', label: t('questions.q4.opt_earthquake') },
        { value: 'flood', label: t('questions.q4.opt_flood') },
        { value: 'tsunami', label: t('questions.q4.opt_tsunami') },
        { value: 'hurricane_cyclone', label: t('questions.q4.opt_hurricane_cyclone') },
        { value: 'wildfire', label: t('questions.q4.opt_wildfire') },
      ],
    },
    {
      groupLabel: t('questions.q4.group_technological'),
      options: [
        { value: 'explosion', label: t('questions.q4.opt_explosion') },
        { value: 'chemical_incident', label: t('questions.q4.opt_chemical_incident') },
      ],
    },
    {
      groupLabel: t('questions.q4.group_humanmade'),
      options: [
        { value: 'conflict', label: t('questions.q4.opt_conflict') },
        { value: 'civil_unrest', label: t('questions.q4.opt_civil_unrest') },
      ],
    },
  ];
  const insets = useSafeAreaInsets();

  // Step
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [fromReview, setFromReview] = useState(false);

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
  const [showQuestionHint, setShowQuestionHint] = useState(false);
  const [additionalAnswers, setAdditionalAnswers] = useState<Record<string, string | string[]>>({});
  const [additionalQuestion, setAdditionalQuestion] = useState(0);
  const [photos, setPhotos] = useState<ProcessedPhoto[]>([]);

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

  // Search bar state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ id: string; place_name: string; center: [number, number] }>
  >([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  // Building confirmation popup state
  const [pendingBuilding, setPendingBuilding] = useState<{
    id: number;
    name: string;
    building: string;
    centroid: [number, number];
    feature: GeoJSON.Feature;
  } | null>(null);
  const [showBuildingConfirm, setShowBuildingConfirm] = useState(false);

  // Editable building name (pre-filled from OSM on confirm)
  const [editableBuildingName, setEditableBuildingName] = useState('');

  // Location screen scenario state
  const [locationScenario, setLocationScenario] = useState<
    'loading' | 'online_gps' | 'online_no_gps' | 'offline_gps' | 'offline_no_gps'
  >('loading');
  const [locationGpsCoords, setLocationGpsCoords] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
  } | null>(null);
  const [isOnlineAtLocation, setIsOnlineAtLocation] = useState(true);
  const [locationNote, setLocationNote] = useState('');
  const [locationMethod, setLocationMethod] = useState<
    'map_selection' | 'pin_drop' | 'manual' | null
  >(null);
  const [pinDropActive, setPinDropActive] = useState(false);
  const [pinCoords, setPinCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Submit
  const [flowStartedAt, setFlowStartedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [wasQueued, setWasQueued] = useState(false);
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);
  const [activeThumbnailIndex, setActiveThumbnailIndex] = useState<number | null>(null);
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(null);
  const [showDupeWarning, setShowDupeWarning] = useState(false);
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);
  const [questionPackage, setQuestionPackage] = useState<ActivePackage | null>(null);

  // Building footprint source — fetched once from public settings
  const [footprintSource, setFootprintSource] = useState<string>("osm");

  // Map refs
  const cameraRef = useRef<CameraRef | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildingTappedRef = useRef(false);

  useEffect(() => {
    setFlowStartedAt(new Date().toISOString());
  }, []);

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
        const settingsRes = await api.get("/api/settings/public");
        setFootprintSource(settingsRes.data?.building_footprint_source ?? "osm");
      } catch { /* silent — OSM fallback remains active */ }
      setCrisisLoading(false);
    };
    init();
  }, []);

  // Cache-first question package loading — AsyncStorage first, then API for latest
  useEffect(() => {
    const loadQuestionPackage = async () => {
      // Step 1: read from AsyncStorage cache written by HomeScreen on every app open
      try {
        const cached = await AsyncStorage.getItem('cr_question_package');
        if (cached) {
          setQuestionPackage(JSON.parse(cached));
        }
      } catch {
        // cache read failed — continue to API fetch
      }

      // Step 2: fetch latest from API (non-blocking, updates cache if newer)
      try {
        const langCode = (await AsyncStorage.getItem('cr_language')) ?? 'en';
        const response = await api.get<ActivePackage>(`/api/question-packages/active?lang=${langCode}`);
        if (response.data) {
          setQuestionPackage(response.data);
          await AsyncStorage.setItem('cr_question_package', JSON.stringify(response.data));
        }
      } catch {
        // API unavailable — cached package or hardcoded fallbacks remain active
      }
    };

    loadQuestionPackage();
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Scenario detection — runs each time the reporter arrives at the location step
  useEffect(() => {
    if (step !== 'location') return;

    const detectScenario = async () => {
      setLocationScenario('loading');

      // Check 1: Internet connectivity
      let online = false;
      try {
        const netState = await NetInfo.fetch();
        online = !!(netState.isConnected && netState.isInternetReachable);
      } catch {
        online = false;
      }
      setIsOnlineAtLocation(online);

      // Check 2: GPS — attempt to get current position (8 s timeout so UI is not blocked)
      let gpsResult: { lat: number; lng: number; accuracy: number } | null = null;
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
          ]);
          if (pos && 'coords' in pos) {
            gpsResult = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy ?? 0,
            };
          }
        }
      } catch {
        gpsResult = null;
      }

      if (gpsResult) {
        setLocationGpsCoords(gpsResult);
      }

      if (online && gpsResult) {
        setLocationScenario('online_gps');
      } else if (online && !gpsResult) {
        setLocationScenario('online_no_gps');
      } else if (!online && gpsResult) {
        setLocationScenario('offline_gps');
      } else {
        setLocationScenario('offline_no_gps');
      }
    };

    detectScenario();
  }, [step]);

  // Connectivity transition listener — scoped to location step only
  useEffect(() => {
    if (step !== 'location') return;

    const unsubscribe = NetInfo.addEventListener((state) => {
      const nowOnline = !!(state.isConnected && state.isInternetReachable);

      if (!nowOnline && (locationScenario === 'online_gps' || locationScenario === 'online_no_gps')) {
        setLocationScenario('loading');
        setTimeout(() => {
          if (locationGpsCoords) {
            setLocationScenario('offline_gps');
          } else {
            setLocationScenario('offline_no_gps');
          }
          setIsOnlineAtLocation(false);
        }, 300);
      }

      if (nowOnline && (locationScenario === 'offline_gps' || locationScenario === 'offline_no_gps')) {
        setIsOnlineAtLocation(true);
        if (locationGpsCoords) {
          setLocationScenario('online_gps');
        } else {
          setLocationScenario('online_no_gps');
        }
      }
    });

    return () => unsubscribe();
  }, [step, locationScenario, locationGpsCoords]);

  // Pre-fill Q3 infrastructure name from OSM building name when entering questions step
  useEffect(() => {
    if (step === 'damage' && infrastructureName === '') {
      const prefill = editableBuildingName?.trim() || selectedBuilding?.name?.trim() || '';
      if (prefill) {
        setInfrastructureName(prefill.slice(0, 200));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Answer crash-recovery — runs once on mount
  useEffect(() => {
    const checkDraftRecovery = async () => {
      try {
        const saved = await AsyncStorage.getItem(ANSWERS_KEY);
        if (!saved) return;
        const draft = JSON.parse(saved);
        if (!draft.damageLevel) {
          await AsyncStorage.removeItem(ANSWERS_KEY);
          return;
        }
        Alert.alert(
          t('questions.recoveryTitle'),
          t('questions.recoveryMessage'),
          [
            {
              text: t('questions.recoveryStartFresh'),
              style: 'destructive',
              onPress: async () => { await AsyncStorage.removeItem(ANSWERS_KEY); },
            },
            {
              text: t('questions.recoveryContinue'),
              onPress: () => {
                if (draft.damageLevel) setDamageLevel(draft.damageLevel);
                if (draft.infrastructureTypes) setInfrastructureTypes(draft.infrastructureTypes);
                if (draft.infrastructureOther) setInfrastructureOther(draft.infrastructureOther);
                if (draft.infrastructureName) setInfrastructureName(draft.infrastructureName);
                if (draft.disasterType) setDisasterType(draft.disasterType);
                if (draft.debrisBlocking) setDebrisBlocking(draft.debrisBlocking);
                if (draft.electricityCondition) setElectricityCondition(draft.electricityCondition);
                if (draft.healthServicesCondition) setHealthServicesCondition(draft.healthServicesCondition);
                if (draft.pressingNeeds) setPressingNeeds(draft.pressingNeeds);
                if (draft.pressingNeedsOther) setPressingNeedsOther(draft.pressingNeedsOther);
                if (draft.additionalAnswers) setAdditionalAnswers(draft.additionalAnswers);
                setStep('damage');
                if (draft.damageQuestion) setDamageQuestion(draft.damageQuestion);
                if (draft.additionalQuestion) setAdditionalQuestion(draft.additionalQuestion);
              },
            },
          ]
        );
      } catch {
        // Recovery check failed — proceed normally
      }
    };
    checkDraftRecovery();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Additional questions — those beyond the 8 core questions (order_index > 8)
  const additionalQuestions = useMemo(() => {
    if (!questionPackage?.questions) return [];
    return questionPackage.questions.filter((q) => q.order_index > 8);
  }, [questionPackage]);

  // Per-question answer persistence — called after each successful Next tap
  const saveDraftAnswers = async () => {
    try {
      const draft = {
        damageQuestion,
        damageLevel,
        infrastructureTypes,
        infrastructureOther,
        infrastructureName,
        disasterType,
        debrisBlocking,
        electricityCondition,
        healthServicesCondition,
        pressingNeeds,
        pressingNeedsOther,
        additionalAnswers,
        additionalQuestion,
        savedAt: new Date().toISOString(),
      };
      await AsyncStorage.setItem(ANSWERS_KEY, JSON.stringify(draft));
    } catch {
      // Non-blocking — if save fails, continue
    }
  };

  // ── Push token registration ───────────────────────────────────────────────────

  const registerPushToken = async () => {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== "granted") {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== "granted") {
        console.log("Notification permission denied — report will sync on next app open");
        return;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: Constants.expoConfig?.extra?.eas?.projectId as string,
      });
      const pushToken = tokenData.data;

      const reporterId = await SecureStore.getItemAsync("cr_reporter_id");
      if (reporterId) {
        await api.post("/api/push-tokens", {
          reporter_id: reporterId,
          token: pushToken,
          platform: "android",
        });
      }

      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("crisis-reports", {
          name: "Crisis Reports",
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: "#0468B1",
        });
      }
    } catch (err) {
      // Non-blocking — push token failure never prevents report submission
      console.log("Push token registration failed:", err);
    }
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

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.trim().length < 3) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }
    setSearchLoading(true);
    try {
      const encoded = encodeURIComponent(query);
      const response = await fetch(
        `https://api.maptiler.com/geocoding/${encoded}.json?key=${MAPTILER_KEY}&limit=5`
      );
      const data = await response.json();
      const results = (data.features ?? []).map((f: any) => ({
        id: f.id,
        place_name: f.place_name ?? f.text ?? '',
        center: f.center as [number, number],
      }));
      setSearchResults(results);
      setShowSearchResults(results.length > 0);
    } catch {
      setSearchResults([]);
      setShowSearchResults(false);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchResultSelect = (result: { center: [number, number]; place_name: string }) => {
    setSearchQuery(result.place_name);
    setShowSearchResults(false);
    setSearchResults([]);
    cameraRef.current?.easeTo({
      center: result.center,
      zoom: 16,
      duration: 600,
    });
  };

  const handleBuildingPress = (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
    buildingTappedRef.current = true;
    const { features } = event.nativeEvent;
    if (!features?.length) return;

    const f = features[0];
    const props = f.properties as { osm_id: number; name: string; building: string };
    const geom = f.geometry as GeoJSON.Polygon;
    const ring = geom.coordinates[0];
    const [centLng, centLat] = computeCentroid(ring);

    setPendingBuilding({
      id: props.osm_id,
      name: props.name ?? "",
      building: props.building ?? "yes",
      centroid: [centLng, centLat],
      feature: f,
    });
    setShowBuildingConfirm(true);
  };

  const handleMapPress = (event: any) => {
    if (buildingTappedRef.current) {
      buildingTappedRef.current = false;
      return;
    }

    const coords = event.geometry?.coordinates ??
      event.nativeEvent?.geometry?.coordinates;
    if (!coords || coords.length < 2) return;

    const [lng, lat] = coords;
    setPinCoords({ lat, lng });
    setPinDropActive(true);
    setLocationMethod('pin_drop');

    setSelectedBuilding(null);
    setEditableBuildingName('');
  };

  // ── Location actions ──────────────────────────────────────────────────────────

  const handleGetGPS = async () => {
    setGpsCapturing(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location Access Needed",
          "Location access is not available. You can enable it in your phone settings. You can still continue by entering your location manually below.",
          [
            { text: "Open Settings", onPress: () => Linking.openSettings() },
            { text: "OK", style: "cancel" },
          ]
        );
        setManualExpanded(true);
        return;
      }
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

  const isLocationValid = (): boolean => {
    if (locationScenario === 'online_gps' || locationScenario === 'online_no_gps') {
      return !!(selectedBuilding || pinCoords || gpsCoords || locationGpsCoords);
    }
    if (locationScenario === 'offline_gps' || locationScenario === 'offline_no_gps') {
      return !!(
        locationAddress?.trim() ||
        locationLandmark?.trim() ||
        locationBuildingName?.trim()
      );
    }
    return false;
  };

  // ── Photo handlers ────────────────────────────────────────────────────────────

  const processPhoto = async (uri: string, mimeType?: string): Promise<ProcessedPhoto | null> => {

    // --- STEP 1: Determine format ---
    const uriLower = uri.toLowerCase();
    const detectedType = mimeType?.toLowerCase() ?? '';

    if (
      uriLower.endsWith('.gif') ||
      detectedType.includes('gif')
    ) {
      Alert.alert('Cannot Use This Photo', t('photoScreen.validationGif'));
      return null;
    }

    if (
      uriLower.endsWith('.dng') ||
      uriLower.endsWith('.raw') ||
      uriLower.endsWith('.cr2') ||
      uriLower.endsWith('.nef') ||
      uriLower.endsWith('.arw') ||
      detectedType.includes('raw') ||
      detectedType.includes('x-adobe-dng')
    ) {
      Alert.alert('Cannot Use This Photo', t('photoScreen.validationFormat'));
      return null;
    }

    const needsConversion =
      uriLower.endsWith('.heic') ||
      uriLower.endsWith('.heif') ||
      uriLower.endsWith('.bmp') ||
      uriLower.endsWith('.tiff') ||
      uriLower.endsWith('.tif') ||
      detectedType.includes('heic') ||
      detectedType.includes('heif') ||
      detectedType.includes('bmp') ||
      detectedType.includes('tiff');

    // --- STEP 2: Get original file info ---
    let workingUri = uri;
    let originalSize = 0;

    try {
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists) {
        Alert.alert('Cannot Use This Photo', t('photoScreen.validationEmpty'));
        return null;
      }
      originalSize = (fileInfo as any).size ?? 0;
    } catch {
      // If we cannot read file info, continue — originalSize stays 0
    }

    // --- STEP 3: Format conversion if needed ---
    let formatConverted = false;
    if (needsConversion) {
      try {
        const converted = await ImageManipulator.manipulateAsync(
          uri,
          [],
          { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        workingUri = converted.uri;
        formatConverted = true;
      } catch {
        Alert.alert('Cannot Use This Photo', t('photoScreen.validationFormat'));
        return null;
      }
    }

    // --- STEP 4: Get image dimensions ---
    let width = 0;
    let height = 0;
    try {
      const imageInfo = await ImageManipulator.manipulateAsync(workingUri, []);
      width = imageInfo.width;
      height = imageInfo.height;
    } catch {
      // Cannot get dimensions — continue with 0,0
    }

    if (width > 0 && height > 0 && (width < 100 || height < 100)) {
      Alert.alert('Cannot Use This Photo', t('photoScreen.validationTooSmall'));
      return null;
    }

    // --- STEP 5: Blank image check ---
    // A genuinely blank capture is typically under 5 KB
    if (originalSize > 0 && originalSize < 5 * 1024) {
      Alert.alert('Cannot Use This Photo', t('photoScreen.validationBlank'));
      return null;
    }

    // --- STEP 6: Duplicate detection ---
    const isDuplicate = photos.some((p) => p.originalUri === uri || p.uri === uri);
    if (isDuplicate) {
      Alert.alert('Duplicate Photo', t('photoScreen.validationDuplicate'));
      return null;
    }

    // --- STEP 7: Size-based compression ---
    let finalUri = workingUri;
    let compressionApplied = false;
    let finalSize = originalSize;

    const MB = 1024 * 1024;

    if (originalSize > 8 * MB) {
      // Above 8 MB: compress to ~1.5 MB target
      try {
        const compressed = await ImageManipulator.manipulateAsync(
          workingUri,
          [],
          { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
        );
        finalUri = compressed.uri;
        compressionApplied = true;
        const info = await FileSystem.getInfoAsync(finalUri);
        finalSize = (info as any).size ?? originalSize;
      } catch {
        finalUri = workingUri;
      }
    } else if (originalSize >= 1.5 * MB) {
      // 1.5 MB to 8 MB: compress to ~1 MB target
      try {
        const compressed = await ImageManipulator.manipulateAsync(
          workingUri,
          [],
          { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
        );
        finalUri = compressed.uri;
        compressionApplied = true;
        const info = await FileSystem.getInfoAsync(finalUri);
        finalSize = (info as any).size ?? originalSize;
      } catch {
        finalUri = workingUri;
      }
    }
    // Under 1.5 MB: no compression — use as-is

    // --- STEP 8: EXIF extraction ---
    // expo-image-manipulator does not expose EXIF directly.
    // GPS and device fields require expo-media-library — deferred to a future prompt.
    const exif: ProcessedPhoto['exif'] = {
      dateTaken: new Date().toISOString(),
      dateDigitised: new Date().toISOString(),
      gpsLat: null,
      gpsLng: null,
      make: null,
      model: null,
      width: width || null,
      height: height || null,
    };

    return {
      uri: finalUri,
      originalUri: uri,
      mimeType: 'image/jpeg',
      originalSize,
      finalSize,
      compressionApplied,
      formatConverted,
      exif,
    };
  };

  const handleTakePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert(
          "Camera Access Needed",
          "Camera access is not available. You can enable it in your phone settings, or upload a photo from your gallery instead.",
          [
            { text: "Open Settings", onPress: () => Linking.openSettings() },
            { text: "OK", style: "cancel" },
          ]
        );
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1 });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const processed = await processPhoto(asset.uri, asset.mimeType ?? '');
        if (processed) {
          setPhotos((prev) => [...prev, processed]);
        }
      }
    } catch (e) {
      Alert.alert("Camera Error", String(e));
    }
  };

  const handlePickPhoto = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert(
          "Gallery Access Needed",
          "Gallery access is not available. You can enable it in your phone settings, or take a new photo using your camera instead.",
          [
            { text: "Open Settings", onPress: () => Linking.openSettings() },
            { text: "OK", style: "cancel" },
          ]
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1 });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const processed = await processPhoto(asset.uri, asset.mimeType ?? '');
        if (processed) {
          setPhotos((prev) => [...prev, processed]);
        }
      }
    } catch (e) {
      Alert.alert("Gallery Error", String(e));
    }
  };

  const handlePhotoTap = (index: number) => {
    setActiveThumbnailIndex(index);
    setShowPhotoOptions(true);
  };

  const handleRemovePhoto = (index: number) => {
    Alert.alert(
      t('photoScreen.removeTitle'),
      undefined,
      [
        {
          text: t('photoScreen.removeCancel'),
          style: 'cancel',
        },
        {
          text: t('photoScreen.removeConfirm'),
          style: 'destructive',
          onPress: () => {
            setPhotos((prev) => prev.filter((_, i) => i !== index));
          },
        },
      ]
    );
  };

  const handleReplacePhoto = async (index: number) => {
    Alert.alert(
      'Replace Photo',
      'Choose a source',
      [
        {
          text: 'Take a Photo',
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
              Alert.alert(
                'Camera Access Needed',
                'Camera access is not available. You can enable it in your phone settings.',
                [
                  { text: 'Open Settings', onPress: () => Linking.openSettings() },
                  { text: 'OK', style: 'cancel' },
                ]
              );
              return;
            }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: ["images"],
              allowsEditing: false,
              quality: 1,
            });
            if (!result.canceled && result.assets?.[0]) {
              const processed = await processPhoto(result.assets[0].uri, result.assets[0].mimeType ?? '');
              if (processed) {
                setPhotos((prev) => {
                  const updated = [...prev];
                  updated[index] = processed;
                  return updated;
                });
              }
            }
          },
        },
        {
          text: 'Upload from Gallery',
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== 'granted') {
              Alert.alert(
                'Gallery Access Needed',
                'Gallery access is not available. You can enable it in your phone settings.',
                [
                  { text: 'Open Settings', onPress: () => Linking.openSettings() },
                  { text: 'OK', style: 'cancel' },
                ]
              );
              return;
            }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              allowsEditing: false,
              quality: 1,
            });
            if (!result.canceled && result.assets?.[0]) {
              const processed = await processPhoto(result.assets[0].uri, result.assets[0].mimeType ?? '');
              if (processed) {
                setPhotos((prev) => {
                  const updated = [...prev];
                  updated[index] = processed;
                  return updated;
                });
              }
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
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
    setShowQuestionHint(false);
    if (damageQuestion === 1) setStep("location");
    else setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = async () => {
    if (damageQuestion < 8) {
      setDamageQuestion((q) => q + 1);
    } else if (additionalQuestions.length > 0) {
      setAdditionalQuestion(1);
      setDamageQuestion(9);
    } else {
      setStep("review");
    }
    await saveDraftAnswers();
  };

  const handleAdditionalNext = async () => {
    const aq = additionalQuestions[additionalQuestion - 1];
    const qKey = String(aq?.order_index ?? additionalQuestion);
    if (aq?.is_mandatory && !additionalAnswers[qKey]) {
      setShowQuestionHint(true);
      return;
    }
    setShowQuestionHint(false);
    if (additionalQuestion < additionalQuestions.length) {
      setAdditionalQuestion((q) => q + 1);
      setDamageQuestion((q) => q + 1);
    } else {
      setStep("review");
    }
    await saveDraftAnswers();
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
    setShowQuestionHint(false);
    setAdditionalAnswers({});
    setAdditionalQuestion(0);
    AsyncStorage.removeItem(ANSWERS_KEY).catch(() => {});
    setPhotos([]);
    setGpsCoords(null);
    setSelectedBuilding(null);
    setBuildingsFC(null);
    setSelectedBuildingFC(null);
    setLocationAddress("");
    setLocationLandmark("");
    setLocationBuildingName("");
    setManualExpanded(false);
    setLocationScenario('loading');
    setLocationGpsCoords(null);
    setIsOnlineAtLocation(true);
    setLocationNote('');
    setLocationMethod(null);
    setPinDropActive(false);
    setPinCoords(null);
    setPendingBuilding(null);
    setShowBuildingConfirm(false);
    setEditableBuildingName('');
    setSearchQuery('');
    setSearchResults([]);
    setShowSearchResults(false);
    setFromReview(false);
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

    // TODO: MCC reading requires expo-cellular — install with: expo install expo-cellular
    // mcc, mnc, carrier_name are intentionally omitted until expo-cellular is added
    const reportPayload = {
      crisis_id: crisisId!,
      flow_started_at: flowStartedAt ?? new Date().toISOString(),
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
        gps_latitude: selectedBuilding
          ? (gpsCoords?.lat ?? null)
          : (pinCoords?.lat ?? gpsCoords?.lat ?? locationGpsCoords?.lat ?? null),
        gps_longitude: selectedBuilding
          ? (gpsCoords?.lng ?? null)
          : (pinCoords?.lng ?? gpsCoords?.lng ?? locationGpsCoords?.lng ?? null),
        gps_accuracy_meters: locationGpsCoords?.accuracy ?? null,
        gps_available: !!gpsCoords || !!locationGpsCoords || !!pinCoords,
        location_address: buildLocationAddress(),
        location_landmark: locationLandmark || null,
        location_building_name: locationBuildingName || null,
      },
      location_note: locationNote || undefined,
      location_method: locationMethod ?? (
        selectedBuilding ? 'map_selection' :
        pinCoords ? 'pin_drop' :
        (locationAddress || locationLandmark || locationBuildingName) ? 'manual' :
        undefined
      ),
      internet_available_at_location: isOnlineAtLocation,
      offline_map_pack_used: false,
      building_name: editableBuildingName || selectedBuilding?.name || undefined,
      building_name_osm: selectedBuilding?.name ?? undefined,
      building_type: selectedBuilding?.building ?? undefined,
      gps_accuracy: locationGpsCoords?.accuracy ?? undefined,
      reporter_id: reporterId || undefined,
      language_code: languageCode,
      question_package_version: questionPackage?.version ?? null,
      question_package_translation_version: questionPackage?.translation_version ?? null,
      photos: photos.map((photo, index) => ({
        uri: photo.uri,
        index,
        original_size: photo.originalSize,
        final_size: photo.finalSize,
        compression_applied: photo.compressionApplied,
        format_converted: photo.formatConverted,
        mime_type: photo.mimeType,
        exif_date_taken: photo.exif.dateTaken,
        exif_width: photo.exif.width,
        exif_height: photo.exif.height,
      })),
      additional_answers: Object.entries(additionalAnswers).map(([questionId, answer]) => ({
        question_id: questionId,
        answer: Array.isArray(answer) ? undefined : answer,
        answers: Array.isArray(answer) ? answer : undefined,
      })),
      was_queued: false,
    };

    try {
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      for (let i = 0; i < photos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", { uri: photos[i].uri, name: `photo_${i}.jpg`, type: photos[i].mimeType } as any);
        await api.post("/api/photos", formData, { headers: { "Content-Type": "multipart/form-data" } });
      }

      await saveSubmittedLocation();
      setSubmittedReportId(reportId as string);
      setWasQueued(false);
      setSubmitted(true);
    } catch {
      await registerPushToken();
      const queuedPhotos: QueuedPhoto[] = photos.map((p, i) => ({
        uri: p.uri,
        filename: `photo_${i}.jpg`,
        content_type: p.mimeType,
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

  const getStepNumber = (s: string): number => {
    switch (s) {
      case 'photos':    return 1;
      case 'location':  return 2;
      case 'damage':
      case 'questions': return 3;
      case 'review':    return 4;
      case 'submit':    return 5;
      default:          return 1;
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("report.title")}</Text>
      </View>

      {step !== 'review' && <StepIndicator currentStep={getStepNumber(step)} />}

      {/* Step 2 — Location */}
      {step === "location" && (
        <View style={styles.locationContainer}>

          {/* Loading — scenario detection in progress */}
          {locationScenario === 'loading' && (
            <View style={styles.locationLoadingContainer}>
              <ActivityIndicator color="#0468B1" size="large" />
            </View>
          )}

          {/* Online scenarios — show map */}
          {(locationScenario === 'online_gps' || locationScenario === 'online_no_gps') && (
            <View style={{ flex: 1 }}>
              {/* GPS unavailable inline note — Scenario 2 only */}
              {locationScenario === 'online_no_gps' && (
                <View style={styles.gpsUnavailableNote}>
                  <Text style={styles.gpsUnavailableNoteText}>
                    {t('locationScreen.gpsUnavailableOnline')}
                  </Text>
                </View>
              )}

              {/* Map fills most of the screen */}
              <View style={styles.mapWrapper}>
                <MLMap
                  mapStyle={MAP_STYLE_URL}
                  style={{ flex: 1 }}
                  onRegionDidChange={handleRegionChange}
                  onDidFinishLoadingMap={handleMapLoaded}
                  onPress={handleMapPress}
                >
                  <Camera
                    ref={cameraRef}
                    initialViewState={{ center: [0, 20], zoom: 2 }}
                  />
                  {locationScenario === 'online_gps' && (
                    <UserLocation animated heading />
                  )}

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

                  {/* Pin drop marker — tap anywhere on the map to reposition */}
                  {pinDropActive && pinCoords && (
                    <Marker
                      id="pin-drop"
                      lngLat={[pinCoords.lng, pinCoords.lat]}
                      anchor="bottom"
                    >
                      <View style={styles.pinMarker}>
                        <Text style={styles.pinMarkerIcon}>📍</Text>
                      </View>
                    </Marker>
                  )}
                </MLMap>

                {/* Search bar overlay */}
                <View style={styles.searchContainer} pointerEvents="box-none">
                  <View style={styles.searchInputRow}>
                    <TextInput
                      style={styles.searchInput}
                      placeholder={t('locationScreen.searchPlaceholder')}
                      placeholderTextColor="#999999"
                      value={searchQuery}
                      onChangeText={handleSearch}
                      returnKeyType="search"
                      clearButtonMode="while-editing"
                    />
                    {searchLoading && (
                      <ActivityIndicator
                        color="#0468B1"
                        style={styles.searchSpinner}
                        size="small"
                      />
                    )}
                  </View>

                  {showSearchResults && (
                    <View style={styles.searchResultsList}>
                      {searchResults.length === 0 ? (
                        <Text style={styles.searchNoResults}>
                          {t('locationScreen.searchResultsEmpty')}
                        </Text>
                      ) : (
                        searchResults.map((result) => (
                          <TouchableOpacity
                            key={result.id}
                            style={styles.searchResultItem}
                            onPress={() => handleSearchResultSelect(result)}
                          >
                            <Text style={styles.searchResultText} numberOfLines={2}>
                              {result.place_name}
                            </Text>
                          </TouchableOpacity>
                        ))
                      )}
                    </View>
                  )}
                </View>

                {/* Zoom hint overlay */}
                {mapZoom < 14 && (
                  <View style={styles.zoomHint} pointerEvents="none">
                    <Text style={styles.zoomHintText}>Zoom in to see and select buildings</Text>
                  </View>
                )}

                {/* Microsoft Building Footprints active note */}
                {footprintSource === "microsoft" && (
                  <View style={styles.microsoftNote} pointerEvents="none">
                    <Text style={styles.microsoftNoteText}>
                      Microsoft Building Footprints active — building selection uses ML-detected footprints.
                    </Text>
                  </View>
                )}

                {/* GPS recentre overlay button */}
                <TouchableOpacity
                  style={styles.mapRecentreBtn}
                  onPress={() => {
                    if (locationGpsCoords) {
                      cameraRef.current?.easeTo({
                        center: [locationGpsCoords.lng, locationGpsCoords.lat],
                        zoom: 16,
                        duration: 500,
                      });
                    }
                  }}
                >
                  <Text style={styles.mapRecentreIcon}>◎</Text>
                </TouchableOpacity>
              </View>

              {/* Editable building name + location note — shown after building confirmed or pin dropped */}
              {(selectedBuilding || pinDropActive) && (
                <View style={styles.mapBottomPanel}>
                  <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 200 }}>
                    {pinDropActive && !selectedBuilding && (
                      <View style={styles.pinInfoRow}>
                        <Text style={styles.pinInfoLabel}>Pin location</Text>
                        <Text style={styles.pinInfoCoords}>
                          {pinCoords?.lat.toFixed(5)}, {pinCoords?.lng.toFixed(5)}
                        </Text>
                        <Text style={styles.pinInfoHint}>
                          Tap anywhere on the map to move the pin
                        </Text>
                      </View>
                    )}

                    {selectedBuilding && (
                      <>
                        <Text style={styles.panelFieldLabel}>{t('locationScreen.editBuildingName')}</Text>
                        <TextInput
                          style={styles.panelInput}
                          value={editableBuildingName}
                          onChangeText={setEditableBuildingName}
                          placeholder={t('locationScreen.buildingNameLabel')}
                          placeholderTextColor="#999999"
                        />
                      </>
                    )}

                    <Text style={styles.panelFieldLabel}>{t('locationScreen.locationNote')}</Text>
                    <TextInput
                      style={[styles.panelInput, { height: 72 }]}
                      value={locationNote}
                      onChangeText={setLocationNote}
                      placeholder={t('locationScreen.locationNoteHint')}
                      placeholderTextColor="#999999"
                      multiline
                      numberOfLines={3}
                    />
                  </ScrollView>
                </View>
              )}

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
              </ScrollView>
            </View>
          )}

          {/* Offline scenarios — hide map, show manual entry */}
          {(locationScenario === 'offline_gps' || locationScenario === 'offline_no_gps') && (
            <ScrollView style={styles.manualContainer} contentContainerStyle={styles.manualContent}>
              {/* Amber offline banner */}
              <View style={styles.offlineBanner}>
                <Text style={styles.offlineBannerText}>
                  {t('locationScreen.offlineBanner')}
                </Text>
              </View>

              {/* GPS status indicator */}
              {locationScenario === 'offline_gps' && locationGpsCoords && (
                <View style={styles.gpsIndicator}>
                  <Text style={styles.gpsIndicatorText}>
                    📍 {t('locationScreen.gpsRecorded')}
                  </Text>
                </View>
              )}
              {locationScenario === 'offline_no_gps' && (
                <View style={styles.gpsIndicator}>
                  <Text style={[styles.gpsIndicatorText, styles.gpsIndicatorUnavailable]}>
                    ⚠️ {t('locationScreen.gpsUnavailable')}
                  </Text>
                </View>
              )}

              {/* Manual entry fields */}
              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualAddress')}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualAddressPlaceholder')}
                value={locationAddress}
                onChangeText={setLocationAddress}
                multiline={false}
              />

              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualLandmark')}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualLandmarkPlaceholder')}
                value={locationLandmark}
                onChangeText={setLocationLandmark}
                multiline={false}
              />

              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualBuildingName')}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualBuildingNamePlaceholder')}
                value={locationBuildingName}
                onChangeText={setLocationBuildingName}
                multiline={false}
              />

              {/* At least one field required note */}
              {!locationAddress && !locationLandmark && !locationBuildingName && (
                <Text style={styles.manualRequiredNote}>
                  {t('locationScreen.manualAtLeastOne')}
                </Text>
              )}
            </ScrollView>
          )}

          {/* Footer — Back and Next for all non-loading scenarios */}
          {locationScenario !== 'loading' && (
            <View style={[styles.locationNextContainer, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.navButtons}>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep("photos")}>
                  <Text style={styles.secondaryButtonText}>← Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, !isLocationValid() && styles.buttonDisabled]}
                  onPress={() => isLocationValid() && setStep("damage")}
                  disabled={!isLocationValid()}
                >
                  <Text style={styles.primaryButtonText}>Next →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
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

      {/* Photo options modal */}
      <Modal
        visible={showPhotoOptions}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPhotoOptions(false)}
      >
        <TouchableOpacity
          style={styles.optionsOverlay}
          activeOpacity={1}
          onPress={() => setShowPhotoOptions(false)}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.optionsSheet, { paddingBottom: insets.bottom + 8 }]}>
            <View style={styles.optionsHandle} />

            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => {
                setShowPhotoOptions(false);
                if (activeThumbnailIndex !== null && photos[activeThumbnailIndex]) {
                  setViewerPhoto(photos[activeThumbnailIndex].uri);
                }
              }}
            >
              <Text style={styles.optionIcon}>🔍</Text>
              <Text style={styles.optionLabel}>View</Text>
            </TouchableOpacity>

            <View style={styles.optionDivider} />

            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => {
                setShowPhotoOptions(false);
                handleReplacePhoto(activeThumbnailIndex!);
              }}
            >
              <Text style={styles.optionIcon}>🔄</Text>
              <Text style={styles.optionLabel}>Replace</Text>
            </TouchableOpacity>

            <View style={styles.optionDivider} />

            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => {
                setShowPhotoOptions(false);
                handleRemovePhoto(activeThumbnailIndex!);
              }}
            >
              <Text style={styles.optionIcon}>🗑️</Text>
              <Text style={[styles.optionLabel, styles.optionLabelDanger]}>Remove</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.optionRow, styles.optionCancel]}
              onPress={() => setShowPhotoOptions(false)}
            >
              <Text style={styles.optionLabelCancel}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Building confirmation popup */}
      <Modal
        visible={showBuildingConfirm}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setShowBuildingConfirm(false);
          setPendingBuilding(null);
        }}
      >
        <TouchableOpacity
          style={styles.confirmOverlay}
          activeOpacity={1}
          onPress={() => {
            setShowBuildingConfirm(false);
            setPendingBuilding(null);
          }}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.confirmSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.confirmHandle} />
            <Text style={styles.confirmTitle}>{t('locationScreen.confirmBuilding')}</Text>

            {pendingBuilding?.name ? (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmLabel}>{t('locationScreen.buildingNameLabel')}</Text>
                <Text style={styles.confirmValue}>{pendingBuilding.name}</Text>
              </View>
            ) : null}

            {pendingBuilding?.building && pendingBuilding.building !== 'yes' ? (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmLabel}>{t('locationScreen.buildingTypeLabel')}</Text>
                <Text style={styles.confirmValue}>{pendingBuilding.building}</Text>
              </View>
            ) : null}

            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>{t('locationScreen.buildingCoordsLabel')}</Text>
              <Text style={styles.confirmValue}>
                {pendingBuilding?.centroid[1].toFixed(5)}, {pendingBuilding?.centroid[0].toFixed(5)}
              </Text>
            </View>

            <View style={styles.confirmButtons}>
              <TouchableOpacity
                style={styles.confirmCancelBtn}
                onPress={() => {
                  setShowBuildingConfirm(false);
                  setPendingBuilding(null);
                }}
              >
                <Text style={styles.confirmCancelText}>{t('locationScreen.cancelButton')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.confirmConfirmBtn}
                onPress={async () => {
                  if (!pendingBuilding) return;
                  setSelectedBuilding({
                    id: pendingBuilding.id,
                    name: pendingBuilding.name,
                    building: pendingBuilding.building,
                    centroid: pendingBuilding.centroid,
                  });
                  setEditableBuildingName(pendingBuilding.name ?? '');
                  setGpsCoords({ lat: pendingBuilding.centroid[1], lng: pendingBuilding.centroid[0] });
                  setSelectedBuildingFC({ type: "FeatureCollection", features: [pendingBuilding.feature] });
                  setLocationMethod('map_selection');
                  cameraRef.current?.easeTo({
                    center: pendingBuilding.centroid,
                    zoom: 17,
                    duration: 400,
                  });

                  try {
                    const params = new URLSearchParams();
                    if (pendingBuilding.id) params.append('building_id', String(pendingBuilding.id));
                    if (pendingBuilding.centroid[1] !== undefined) params.append('lat', String(pendingBuilding.centroid[1]));
                    if (pendingBuilding.centroid[0] !== undefined) params.append('lng', String(pendingBuilding.centroid[0]));

                    const dupRes = await api.get(`/api/reports/duplicate-check?${params.toString()}`);
                    if (dupRes.data?.is_duplicate) {
                      Alert.alert(
                        t('locationScreen.duplicateWarningTitle'),
                        t('locationScreen.duplicateWarningBody'),
                        [
                          {
                            text: t('locationScreen.duplicateWarningGoBack'),
                            style: 'cancel',
                            onPress: () => {
                              setSelectedBuilding(null);
                              setEditableBuildingName('');
                              setPendingBuilding(null);
                              setShowBuildingConfirm(false);
                            },
                          },
                          {
                            text: t('locationScreen.duplicateWarningContinue'),
                            onPress: () => {
                              setShowBuildingConfirm(false);
                              setPendingBuilding(null);
                            },
                          },
                        ]
                      );
                      return;
                    }
                  } catch {
                    // Duplicate check failed (offline or error) — proceed without warning
                  }

                  setShowBuildingConfirm(false);
                  setPendingBuilding(null);
                }}
              >
                <Text style={styles.confirmConfirmText}>{t('locationScreen.confirmBuildingButton')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Full-screen photo viewer */}
      <Modal
        visible={!!viewerPhoto}
        transparent={false}
        animationType="fade"
        onRequestClose={() => setViewerPhoto(null)}
        statusBarTranslucent
      >
        <View style={styles.viewerContainer}>
          <TouchableOpacity
            style={styles.viewerClose}
            onPress={() => setViewerPhoto(null)}
          >
            <Text style={styles.viewerCloseText}>✕ Close</Text>
          </TouchableOpacity>
          {viewerPhoto && (
            <Image
              source={{ uri: viewerPhoto }}
              style={styles.viewerImage}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>

      {/* All other steps inside ScrollView */}
      {step !== "location" && step !== "review" && (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentPadding}>

          {/* Step 1 — Photos */}
          {step === "photos" && (
            <View style={styles.step}>
              <Text style={styles.stepTitle}>{t("report.photos")} *</Text>
              <Text style={styles.hintText}>Add up to 3 photos. At least 1 required.</Text>

              {/* Photo slots — always show all 3 */}
              <View style={styles.photoSlotsRow}>
                {[0, 1, 2].map((slotIndex) => {
                  const photo = photos[slotIndex];
                  return (
                    <TouchableOpacity
                      key={slotIndex}
                      style={[styles.photoSlot, photo ? styles.photoSlotFilled : styles.photoSlotEmpty]}
                      onPress={() => {
                        if (photo) {
                          handlePhotoTap(slotIndex);
                        } else if (photos.length === slotIndex) {
                          setShowPhotoOptions(true);
                        }
                      }}
                      activeOpacity={photo ? 0.85 : 0.6}
                      disabled={!photo && photos.length !== slotIndex}
                    >
                      {photo ? (
                        <Image
                          source={{ uri: photo.uri }}
                          style={styles.photoThumb}
                        />
                      ) : (
                        <View style={styles.photoSlotInner}>
                          <Text style={styles.photoSlotPlus}>+</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {photos.length < 3 ? (
                <View style={styles.photoButtonsRow}>
                  <TouchableOpacity style={styles.photoOptionBtn} onPress={handleTakePhoto}>
                    <Text style={styles.photoOptionIcon}>📷</Text>
                    <Text style={styles.photoOptionText}>{t("report.takePhoto")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.photoOptionBtn} onPress={handlePickPhoto}>
                    <Text style={styles.photoOptionIcon}>🖼️</Text>
                    <Text style={styles.photoOptionText}>{t("report.uploadPhoto")}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text style={styles.maxPhotosNote}>{t('photoScreen.maxPhotos')}</Text>
              )}

              {/* Photo guidelines */}
              <View style={styles.guidelinesContainer}>
                <Text style={styles.guidelinesTitle}>{t('photoScreen.guidelines.title')}</Text>
                {[
                  t('photoScreen.guidelines.g1'),
                  t('photoScreen.guidelines.g2'),
                  t('photoScreen.guidelines.g3'),
                  t('photoScreen.guidelines.g4'),
                ].map((guideline, index) => (
                  <View key={index} style={styles.guidelineRow}>
                    <Text style={styles.guidelineBullet}>•</Text>
                    <Text style={styles.guidelineText}>{guideline}</Text>
                  </View>
                ))}
              </View>

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
              <Text style={styles.questionProgress}>
                {t('questions.progressLabel', { current: damageQuestion, total: 8 + additionalQuestions.length })}
              </Text>

              {damageQuestion === 1 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(1, t('questions.q1.title'))}</Text>
                  {qOptions(1, [
                    { value: "minimal", label: t('questions.q1.opt_minimal') },
                    { value: "partial", label: t('questions.q1.opt_partial') },
                    { value: "complete", label: t('questions.q1.opt_complete') },
                  ]).map(({ value, label }) => {
                    const isSelected = damageLevel === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={styles.radioRow}
                        onPress={() => { setDamageLevel(value as DamageLevel); setShowQuestionHint(false); }}
                      >
                        <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                          {isSelected && <View style={styles.radioDot} />}
                        </View>
                        <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {damageQuestion === 2 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(2, t('questions.q2.title'))}</Text>
                  <Text style={styles.hintText}>{t('questions.q2.hint')}</Text>
                  {qOptions(2, [
                    { value: "residential", label: t('questions.q2.opt_residential') },
                    { value: "commercial", label: t('questions.q2.opt_commercial') },
                    { value: "government", label: t('questions.q2.opt_government') },
                    { value: "educational", label: t('questions.q2.opt_educational') },
                    { value: "healthcare", label: t('questions.q2.opt_healthcare') },
                    { value: "critical_infrastructure", label: t('questions.q2.opt_critical_infrastructure') },
                    { value: "agricultural", label: t('questions.q2.opt_agricultural') },
                    { value: "public_spaces", label: t('questions.q2.opt_public_spaces') },
                    { value: "other", label: t('questions.q2.opt_other') },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity key={value} style={styles.checkRow} onPress={() => { toggleInfraType(value); setShowQuestionHint(false); }}>
                      <View style={[styles.checkbox, infrastructureTypes.includes(value) && styles.checkboxSelected]}>
                        {infrastructureTypes.includes(value) && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                      <Text style={styles.checkRowText}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                  {infrastructureTypes.includes("other") && (
                    <TextInput
                      style={[styles.input, { marginTop: 8 }]}
                      placeholder={t('questions.otherSpecifyPlaceholder')}
                      value={infrastructureOther}
                      onChangeText={(t) => setInfrastructureOther(t.slice(0, 100))}
                      maxLength={100}
                    />
                  )}
                </>
              )}

              {damageQuestion === 3 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(3, t('questions.q3.title'))}</Text>
                  <TextInput
                    style={styles.input}
                    placeholder={t('questions.q3.placeholder')}
                    value={infrastructureName}
                    onChangeText={(t) => setInfrastructureName(t.slice(0, 200))}
                    maxLength={200}
                  />
                  <Text style={styles.charCounter}>{infrastructureName.length} / 200</Text>
                </>
              )}

              {damageQuestion === 4 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(4, t('questions.q4.title'))}</Text>
                  {Q4_GROUPS.map((group) => (
                    <View key={group.groupLabel}>
                      <Text style={styles.q4GroupLabel}>{group.groupLabel}</Text>
                      {group.options.map(({ value, label }) => {
                        const isSelected = disasterType === value;
                        return (
                          <TouchableOpacity
                            key={value}
                            style={styles.radioRow}
                            onPress={() => { setDisasterType(value); setShowQuestionHint(false); }}
                          >
                            <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                              {isSelected && <View style={styles.radioDot} />}
                            </View>
                            <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                              {label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </>
              )}

              {damageQuestion === 5 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(5, t('questions.q5.title'))}</Text>
                  {qOptions(5, [
                    { value: "yes", label: t('questions.q5.opt_yes') },
                    { value: "no", label: t('questions.q5.opt_no') },
                  ]).map(({ value, label }) => {
                    const isSelected = debrisBlocking === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={styles.radioRow}
                        onPress={() => { setDebrisBlocking(value); setShowQuestionHint(false); }}
                      >
                        <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                          {isSelected && <View style={styles.radioDot} />}
                        </View>
                        <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {damageQuestion === 6 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(6, t('questions.q6.title'))}</Text>
                  {qOptions(6, [
                    { value: "no_damage", label: t('questions.q6.opt_no_damage') },
                    { value: "minor", label: t('questions.q6.opt_minor') },
                    { value: "moderate", label: t('questions.q6.opt_moderate') },
                    { value: "severe", label: t('questions.q6.opt_severe') },
                    { value: "destroyed", label: t('questions.q6.opt_destroyed') },
                    { value: "unknown", label: t('questions.q6.opt_unknown') },
                  ]).map(({ value, label }) => {
                    const isSelected = electricityCondition === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={styles.radioRow}
                        onPress={() => { setElectricityCondition(value); setShowQuestionHint(false); }}
                      >
                        <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                          {isSelected && <View style={styles.radioDot} />}
                        </View>
                        <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {damageQuestion === 7 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(7, t('questions.q7.title'))}</Text>
                  {qOptions(7, [
                    { value: "fully_functional", label: t('questions.q7.opt_fully') },
                    { value: "partially_functional", label: t('questions.q7.opt_partially') },
                    { value: "largely_disrupted", label: t('questions.q7.opt_largely') },
                    { value: "not_functioning", label: t('questions.q7.opt_not_functioning') },
                    { value: "unknown", label: t('questions.q7.opt_unknown') },
                  ]).map(({ value, label }) => {
                    const isSelected = healthServicesCondition === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={styles.radioRow}
                        onPress={() => { setHealthServicesCondition(value); setShowQuestionHint(false); }}
                      >
                        <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                          {isSelected && <View style={styles.radioDot} />}
                        </View>
                        <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}

              {damageQuestion === 8 && (
                <>
                  <Text style={styles.stepTitle}>{qTitle(8, t('questions.q8.title'))}</Text>
                  <Text style={styles.hintText}>{t('questions.q8.hint')}</Text>
                  {qOptions(8, [
                    { value: "food_water", label: t('questions.q8.opt_food_water') },
                    { value: "cash_financial", label: t('questions.q8.opt_cash') },
                    { value: "healthcare", label: t('questions.q8.opt_healthcare') },
                    { value: "shelter", label: t('questions.q8.opt_shelter') },
                    { value: "livelihoods", label: t('questions.q8.opt_livelihoods') },
                    { value: "wash", label: t('questions.q8.opt_wash') },
                    { value: "basic_services", label: t('questions.q8.opt_basic_services') },
                    { value: "protection", label: t('questions.q8.opt_protection') },
                    { value: "local_support", label: t('questions.q8.opt_local_support') },
                    { value: "other", label: t('questions.q8.opt_other') },
                  ]).map(({ value, label }) => (
                    <TouchableOpacity key={value} style={styles.checkRow} onPress={() => { togglePressingNeed(value); setShowQuestionHint(false); }}>
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
                        placeholder={t('questions.otherSpecifyPlaceholder')}
                        value={pressingNeedsOther}
                        onChangeText={(txt) => setPressingNeedsOther(txt.slice(0, 100))}
                        maxLength={100}
                      />
                      <Text style={styles.charCounter}>{pressingNeedsOther.length} / 100</Text>
                    </View>
                  )}
                </>
              )}

              {/* Additional dashboard-configured questions (order_index > 8) */}
              {damageQuestion > 8 && (() => {
                const aq = additionalQuestions[additionalQuestion - 1];
                if (!aq) return null;
                const qKey = String(aq.order_index);
                const qType = aq.type ?? 'single_select';
                return (
                  <View style={styles.questionBlock}>
                    <Text style={styles.questionTitle}>{aq.question_text}</Text>

                    {/* Single select */}
                    {qType === 'single_select' && (aq.options ?? []).map((opt) => {
                      const isSelected = additionalAnswers[qKey] === opt.option_value;
                      return (
                        <TouchableOpacity
                          key={opt.option_value}
                          style={styles.radioRow}
                          onPress={() => {
                            setAdditionalAnswers((prev) => ({ ...prev, [qKey]: opt.option_value }));
                            setShowQuestionHint(false);
                          }}
                        >
                          <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                            {isSelected && <View style={styles.radioDot} />}
                          </View>
                          <Text style={[styles.radioLabel, isSelected && styles.radioLabelSelected]}>
                            {opt.option_text}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}

                    {/* Multi select */}
                    {qType === 'multi_select' && (aq.options ?? []).map((opt) => {
                      const current = (additionalAnswers[qKey] as string[]) ?? [];
                      const selected = current.includes(opt.option_value);
                      return (
                        <TouchableOpacity
                          key={opt.option_value}
                          style={styles.checkRow}
                          onPress={() => {
                            const updated = selected
                              ? current.filter((v) => v !== opt.option_value)
                              : [...current, opt.option_value];
                            setAdditionalAnswers((prev) => ({ ...prev, [qKey]: updated }));
                            setShowQuestionHint(false);
                          }}
                        >
                          <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                            {selected && <Text style={styles.checkmark}>✓</Text>}
                          </View>
                          <Text style={styles.checkRowText}>{opt.option_text}</Text>
                        </TouchableOpacity>
                      );
                    })}

                    {/* Free text */}
                    {qType === 'free_text' && (
                      <TextInput
                        style={styles.input}
                        value={(additionalAnswers[qKey] as string) ?? ''}
                        onChangeText={(text) => {
                          setAdditionalAnswers((prev) => ({
                            ...prev,
                            [qKey]: text.slice(0, aq.max_length ?? 200),
                          }));
                        }}
                        multiline
                        maxLength={aq.max_length ?? 200}
                        placeholder="Enter your answer..."
                        placeholderTextColor="#999999"
                      />
                    )}

                    {showQuestionHint && !additionalAnswers[qKey] && aq.is_mandatory && (
                      <Text style={styles.questionHint}>
                        {t('questions.answerHint')}
                      </Text>
                    )}
                  </View>
                );
              })()}

              {showQuestionHint && damageQuestion <= 8 && !isDamageQuestionAnswered() && (
                <Text style={styles.questionHint}>
                  Please answer this question to continue.
                </Text>
              )}

              <View style={styles.navButtons}>
                <TouchableOpacity style={styles.secondaryButton} onPress={handleDamageBack}>
                  <Text style={styles.secondaryButtonText}>← Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => {
                    if (damageQuestion > 8) {
                      handleAdditionalNext();
                      return;
                    }
                    if (!isDamageQuestionAnswered()) {
                      setShowQuestionHint(true);
                      return;
                    }
                    setShowQuestionHint(false);
                    handleDamageNext();
                  }}
                >
                  <Text style={styles.primaryButtonText}>Next →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

        </ScrollView>
      )}

      {/* Step 4 — Review */}
      {step === 'review' && (
        <View style={styles.reviewContainer}>
          <StepIndicator currentStep={4} />

          {/* Scrollable content */}
          <ScrollView
            style={styles.reviewScroll}
            contentContainerStyle={styles.reviewScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.reviewTitle}>{t('review.title')}</Text>

            {/* ── SECTION 1: PHOTOS ── */}
            <View style={styles.reviewSection}>
              <View style={styles.reviewSectionHeader}>
                <Text style={styles.reviewSectionTitle}>{t('review.photosSection')}</Text>
                <TouchableOpacity
                  onPress={() => {
                    setFromReview(true);
                    setStep('photos');
                  }}
                >
                  <Text style={styles.reviewEditLink}>{t('review.editLink')}</Text>
                </TouchableOpacity>
              </View>

              {/* Photo thumbnails row */}
              {photos.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  style={styles.reviewPhotoRow}>
                  {photos.map((photo, index) => (
                    <TouchableOpacity
                      key={index}
                      onPress={() => setViewerPhoto(photo.uri)}
                      style={styles.reviewPhotoThumb}
                    >
                      <Image
                        source={{ uri: photo.uri }}
                        style={styles.reviewPhotoThumbImage}
                      />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : (
                <Text style={styles.reviewPhotoRequired}>
                  {t('review.photoRequired')}
                </Text>
              )}
            </View>

            {/* ── SECTION 2: LOCATION ── */}
            <View style={styles.reviewSection}>
              <View style={styles.reviewSectionHeader}>
                <Text style={styles.reviewSectionTitle}>{t('review.locationSection')}</Text>
                <TouchableOpacity
                  onPress={() => {
                    setFromReview(true);
                    setStep('location');
                  }}
                >
                  <Text style={styles.reviewEditLink}>{t('review.editLink')}</Text>
                </TouchableOpacity>
              </View>

              {/* Map selection path */}
              {selectedBuilding && (
                <>
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>{t('review.locationBuilding')}</Text>
                    <Text style={styles.reviewValue}>
                      {editableBuildingName || selectedBuilding.name || '—'}
                    </Text>
                  </View>
                  {selectedBuilding.building ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationBuildingType')}</Text>
                      <Text style={styles.reviewValue}>{selectedBuilding.building}</Text>
                    </View>
                  ) : null}
                  {selectedBuilding.id ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationFootprintId')}</Text>
                      <Text style={[styles.reviewValue, styles.reviewMono]}>
                        {String(selectedBuilding.id).substring(0, 16)}
                      </Text>
                    </View>
                  ) : null}
                </>
              )}

              {/* Pin drop path */}
              {!selectedBuilding && pinDropActive && pinCoords && (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>{t('review.locationPinDrop')}</Text>
                  <Text style={styles.reviewValue}>
                    {pinCoords.lat.toFixed(5)}, {pinCoords.lng.toFixed(5)}
                  </Text>
                </View>
              )}

              {/* Manual entry path */}
              {!selectedBuilding && !pinDropActive && (
                <>
                  <Text style={styles.reviewManualNote}>
                    {t('review.locationManualNote')}
                  </Text>
                  {locationAddress ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationAddress')}</Text>
                      <Text style={styles.reviewValue}>{locationAddress}</Text>
                    </View>
                  ) : null}
                  {locationLandmark ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationLandmark')}</Text>
                      <Text style={styles.reviewValue}>{locationLandmark}</Text>
                    </View>
                  ) : null}
                  {locationBuildingName ? (
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationBuildingName')}</Text>
                      <Text style={styles.reviewValue}>{locationBuildingName}</Text>
                    </View>
                  ) : null}
                </>
              )}

              {/* Location note (all paths) */}
              {locationNote ? (
                <View style={styles.reviewRow}>
                  <Text style={styles.reviewLabel}>{t('review.locationNote')}</Text>
                  <Text style={styles.reviewValue}>{locationNote}</Text>
                </View>
              ) : null}

              {/* GPS indicator (all paths) */}
              <View style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>{t('review.locationGPS')}</Text>
                <Text style={[
                  styles.reviewValue,
                  (gpsCoords || locationGpsCoords)
                    ? styles.reviewGPSCaptured
                    : styles.reviewGPSUnavailable
                ]}>
                  {(gpsCoords || locationGpsCoords)
                    ? `${t('review.locationGPSCaptured')} (${
                        (locationGpsCoords?.lat ?? gpsCoords?.lat ?? 0).toFixed(4)
                      }, ${
                        (locationGpsCoords?.lng ?? gpsCoords?.lng ?? 0).toFixed(4)
                      })`
                    : t('review.locationGPSUnavailable')
                  }
                </Text>
              </View>
            </View>

            {/* ── SECTION 3: QUESTIONS ── */}
            <View style={styles.reviewSection}>
              <View style={styles.reviewSectionHeader}>
                <Text style={styles.reviewSectionTitle}>{t('review.questionsSection')}</Text>
                <TouchableOpacity
                  onPress={() => {
                    setFromReview(true);
                    setDamageQuestion(1);
                    setStep('damage');
                  }}
                >
                  <Text style={styles.reviewEditLink}>{t('review.editLink')}</Text>
                </TouchableOpacity>
              </View>

              {/* Core questions Q1–Q8 */}
              {[
                { label: t('review.q1Label'), value: damageLevel },
                { label: t('review.q2Label'), value: [
                  ...infrastructureTypes,
                  ...(infrastructureOther ? [`Other: ${infrastructureOther}`] : [])
                ].join(', ') },
                { label: t('review.q3Label'), value: infrastructureName },
                { label: t('review.q4Label'), value: disasterType },
                { label: t('review.q5Label'), value: debrisBlocking },
                { label: t('review.q6Label'), value: electricityCondition },
                { label: t('review.q7Label'), value: healthServicesCondition },
                { label: t('review.q8Label'), value: [
                  ...pressingNeeds,
                  ...(pressingNeedsOther ? [`Other: ${pressingNeedsOther}`] : [])
                ].join(', ') },
              ].map((item, index) => (
                item.value ? (
                  <View key={index} style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>{item.label}</Text>
                    <Text style={styles.reviewValue}>{item.value}</Text>
                  </View>
                ) : null
              ))}

              {/* Additional question answers */}
              {additionalQuestions.length > 0 &&
                Object.entries(additionalAnswers).map(([qId, answer]) => {
                  const aq = additionalQuestions.find((q: any) => q.id === qId);
                  if (!aq) return null;
                  const displayValue = Array.isArray(answer)
                    ? answer.join(', ')
                    : String(answer);
                  return (
                    <View key={qId} style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>
                        {(aq as any).text ?? (aq as any).question_text ?? qId}
                      </Text>
                      <Text style={styles.reviewValue}>{displayValue}</Text>
                    </View>
                  );
                })
              }
            </View>

            {/* Bottom padding so content clears the sticky Submit button */}
            <View style={{ height: 100 }} />
          </ScrollView>

          {/* ── STICKY SUBMIT BUTTON ── always visible at bottom */}
          <View style={[styles.reviewSubmitContainer, { paddingBottom: insets.bottom + 16 }]}>
            {/* Show error if no photos */}
            {photos.length === 0 && (
              <Text style={styles.reviewPhotoRequired}>
                {t('review.photoRequired')}
              </Text>
            )}
            <TouchableOpacity
              style={[
                styles.reviewSubmitBtn,
                (submitting || photos.length === 0) && styles.reviewSubmitBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={submitting || photos.length === 0}
            >
              {submitting
                ? <ActivityIndicator color="#FFFFFF" />
                : <Text style={styles.reviewSubmitBtnText}>
                    {t('review.submitButton')}
                  </Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },
  header: {
    backgroundColor: "#FFFFFF",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#E8EDF2",
  },
  backBtn: { color: "#0468B1", fontSize: 22 },
  headerTitle: { color: "#0468B1", fontSize: 18, fontWeight: "700", flex: 1, textAlign: "center" },
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
  microsoftNote: {
    position: "absolute",
    bottom: 46,
    left: 8,
    right: 8,
    backgroundColor: "rgba(235, 248, 255, 0.95)",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    zIndex: 10,
    borderWidth: 1,
    borderColor: "#63B3ED",
  },
  microsoftNoteText: { color: "#2B6CB0", fontSize: 11 },
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
  q4GroupLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
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

  // Photos — slot grid
  photoSlotsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 24,
    marginTop: 16,
    gap: 12,
  },
  photoSlot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  photoSlotEmpty: {
    borderWidth: 2,
    borderColor: '#D0D0D0',
    borderStyle: 'dashed',
    backgroundColor: '#FAFAFA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photoSlotFilled: {
    borderWidth: 0,
  },
  photoSlotInner: {
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
  },
  photoSlotPlus: {
    fontSize: 28,
    color: '#BBBBBB',
    lineHeight: 32,
  },
  photoThumb: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  maxPhotosNote: {
    textAlign: 'center',
    fontSize: 13,
    color: '#888888',
    marginTop: 12,
    marginHorizontal: 24,
  },
  photoButtonsRow: {
    marginTop: 12,
    marginHorizontal: 24,
    gap: 10,
  },

  // Photo action sheet
  optionsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  optionsSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  optionsHandle: {
    width: 36, height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 8,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    minHeight: 52,
  },
  optionIcon: { fontSize: 20, width: 36 },
  optionLabel: { fontSize: 16, color: '#333333' },
  optionLabelDanger: { color: '#D32F2F' },
  optionDivider: { height: 1, backgroundColor: '#F0F0F0' },
  optionCancel: { justifyContent: 'center', marginTop: 4 },
  optionLabelCancel: {
    fontSize: 16, color: '#888888',
    textAlign: 'center', width: '100%',
  },

  // Full-screen viewer
  viewerContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  viewerCloseText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },

  // Legacy photo grid (kept to avoid removal errors)
  photoGrid: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
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
  reviewContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  reviewScroll: {
    flex: 1,
  },
  reviewScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  reviewTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333333',
    marginBottom: 20,
  },
  reviewSection: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#EEEEEE',
  },
  reviewSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reviewSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reviewEditLink: {
    fontSize: 14,
    color: '#0468B1',
    fontWeight: '600',
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  reviewLabel: {
    fontSize: 13,
    color: '#888888',
    flex: 1,
    marginRight: 8,
  },
  reviewValue: {
    fontSize: 14,
    color: '#333333',
    flex: 2,
    textAlign: 'right',
  },
  reviewMono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#666666',
  },
  reviewGPSCaptured: {
    color: '#2E7D32',
    fontSize: 12,
  },
  reviewGPSUnavailable: {
    color: '#E65100',
    fontSize: 12,
  },
  reviewManualNote: {
    fontSize: 12,
    color: '#888888',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  reviewPhotoRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  reviewPhotoThumb: {
    width: 80,
    height: 80,
    borderRadius: 10,
    marginRight: 10,
    overflow: 'hidden',
  },
  reviewPhotoThumbImage: {
    width: '100%',
    height: '100%',
  },
  reviewPhotoRequired: {
    fontSize: 13,
    color: '#D32F2F',
    marginTop: 4,
    textAlign: 'center',
  },
  reviewSubmitContainer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
  },
  reviewSubmitBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reviewSubmitBtnDisabled: {
    backgroundColor: '#B0C4D8',
  },
  reviewSubmitBtnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },

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

  // Radio button single-select styles
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    minHeight: 44,
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#CCCCCC',
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioCircleSelected: {
    borderColor: '#0468B1',
    backgroundColor: '#0468B1',
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  radioLabel: {
    flex: 1,
    fontSize: 15,
    color: '#333333',
    lineHeight: 21,
  },
  radioLabelSelected: {
    color: '#0468B1',
    fontWeight: '500',
  },

  // Inline validation hint
  questionHint: {
    fontSize: 13,
    color: '#D32F2F',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 4,
  },

  // Additional questions block
  questionBlock: {
    gap: 4,
  },
  questionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1A2B4A',
    marginBottom: 4,
  },

  // Location screen scenario styles
  locationContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  locationLoadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gpsUnavailableNote: {
    backgroundColor: '#FFF8E1',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#FFE082',
  },
  gpsUnavailableNoteText: {
    fontSize: 13,
    color: '#F57F17',
    lineHeight: 18,
  },
  offlineBanner: {
    backgroundColor: '#F5A623',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 8,
  },
  offlineBannerText: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '600',
    lineHeight: 20,
  },
  gpsIndicator: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 8,
  },
  gpsIndicatorText: {
    fontSize: 13,
    color: '#2E7D32',
    lineHeight: 18,
  },
  gpsIndicatorUnavailable: {
    color: '#E65100',
  },
  manualContainer: {
    flex: 1,
  },
  manualContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 24,
  },
  manualFieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333333',
    marginTop: 16,
    marginBottom: 6,
  },
  manualInput: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    color: '#333333',
    minHeight: 48,
    backgroundColor: '#FFFFFF',
  },
  manualRequiredNote: {
    fontSize: 13,
    color: '#E65100',
    marginTop: 12,
    textAlign: 'center',
  },
  locationNextContainer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
  },

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

  // Map wrapper — needs position: relative for absolute search overlay
  mapWrapper: {
    flex: 1,
    position: 'relative',
  },

  // Search bar overlay
  searchContainer: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    zIndex: 10,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#333333',
    paddingVertical: 0,
  },
  searchSpinner: {
    marginLeft: 8,
  },
  searchResultsList: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginTop: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
    overflow: 'hidden',
  },
  searchResultItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    minHeight: 48,
    justifyContent: 'center',
  },
  searchResultText: {
    fontSize: 14,
    color: '#333333',
    lineHeight: 20,
  },
  searchNoResults: {
    fontSize: 14,
    color: '#888888',
    padding: 16,
    textAlign: 'center',
  },

  // GPS recentre overlay button
  mapRecentreBtn: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    zIndex: 5,
  },
  mapRecentreIcon: {
    fontSize: 22,
    color: '#0468B1',
  },

  // Pin drop annotation
  pinMarker: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinMarkerIcon: {
    fontSize: 32,
    lineHeight: 36,
  },

  // Pin info in bottom panel
  pinInfoRow: {
    paddingVertical: 8,
    marginBottom: 4,
  },
  pinInfoLabel: {
    fontSize: 13,
    color: '#888888',
    marginBottom: 2,
  },
  pinInfoCoords: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0468B1',
    marginBottom: 4,
  },
  pinInfoHint: {
    fontSize: 12,
    color: '#999999',
    fontStyle: 'italic',
  },

  // Map bottom panel — editable building name + location note
  mapBottomPanel: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  panelFieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555555',
    marginBottom: 4,
    marginTop: 8,
  },
  panelInput: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#333333',
    backgroundColor: '#FAFAFA',
    minHeight: 44,
  },

  // Building confirmation bottom sheet
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  confirmSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  confirmHandle: {
    width: 36, height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#333333',
    marginBottom: 16,
  },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  confirmLabel: {
    fontSize: 13,
    color: '#888888',
    flex: 1,
  },
  confirmValue: {
    fontSize: 14,
    color: '#333333',
    flex: 2,
    textAlign: 'right',
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  confirmCancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  confirmCancelText: {
    color: '#0468B1',
    fontSize: 15,
    fontWeight: '600',
  },
  confirmConfirmBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  confirmConfirmText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },

  // Photo guidelines
  guidelinesContainer: {
    marginTop: 20,
    marginHorizontal: 24,
    padding: 16,
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
  },
  guidelinesTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555555',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  guidelineRow: {
    flexDirection: 'row',
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  guidelineBullet: {
    fontSize: 14,
    color: '#0468B1',
    marginRight: 8,
    lineHeight: 20,
  },
  guidelineText: {
    flex: 1,
    fontSize: 13,
    color: '#555555',
    lineHeight: 20,
  },
});
