import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Alert, ActivityIndicator, Image, Modal, Linking, Platform,
  Dimensions, FlatList, type NativeSyntheticEvent,
} from "react-native";
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
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
import api, { API_BASE } from "../services/api";
import * as Device from 'expo-device';
import * as Cellular from 'expo-cellular';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { addToQueue, syncQueue, getQueue, removeFromQueue, queuePhotosForReport, saveDirectSubmittedRecord } from "../utils/offlineQueue";
import { haversineKm, milesToKm, saveCrisisMeta, loadCrisisMeta } from "../utils/geo";
import NetInfo from "@react-native-community/netinfo";
import StepIndicator from "../components/StepIndicator";
import type { DamageLevel, QueuedPhoto, ProcessedPhoto } from "../types";

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
const MAP_STYLE_URL = `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`;
const ANSWERS_KEY = 'cr_draft_answers';

const OFFLINE_COUNTRY_FALLBACK = [
  { code: "AF", name: "Afghanistan" }, { code: "BD", name: "Bangladesh" },
  { code: "CM", name: "Cameroon" },   { code: "CD", name: "Congo (DRC)" },
  { code: "ET", name: "Ethiopia" },   { code: "GT", name: "Guatemala" },
  { code: "HT", name: "Haiti" },      { code: "IN", name: "India" },
  { code: "IQ", name: "Iraq" },       { code: "KE", name: "Kenya" },
  { code: "LB", name: "Lebanon" },    { code: "LY", name: "Libya" },
  { code: "MM", name: "Myanmar" },    { code: "NP", name: "Nepal" },
  { code: "NG", name: "Nigeria" },    { code: "PK", name: "Pakistan" },
  { code: "PH", name: "Philippines" },{ code: "SO", name: "Somalia" },
  { code: "SS", name: "South Sudan" },{ code: "SY", name: "Syria" },
  { code: "TR", name: "Turkey" },     { code: "UA", name: "Ukraine" },
  { code: "YE", name: "Yemen" },
];

const { width: _screenWidthRaw } = Dimensions.get('window');
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round(screenWidth / 375 * size);

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
  if (!ring || ring.length === 0) return [0, 0];
  const pts =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  if (pts.length === 0) return [0, 0];
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const data: OverpassResponse = await res.json();
    return buildBuildingsFC(data);
  } catch {
    clearTimeout(timeoutId);
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
  transport_comm: "Transport and Communication Infrastructure",
  community: "Community Infrastructure",
  public_spaces: "Public Spaces / Recreation Infrastructure",
  other: "Other",
};

const DISASTER_LABELS: Record<string, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  tsunami: "Tsunami",
  hurricane_cyclone: "Hurricane or Cyclone",
  wildfire: "Wildfire",
  explosion: "Explosion",
  chemical_incident: "Chemical Incident",
  conflict: "Conflict",
  civil_unrest: "Civil Unrest",
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
  cash: "Cash or financial assistance",
  healthcare: "Access to healthcare and essential medicines",
  shelter: "Shelter, housing repair, or temporary accommodation",
  livelihoods: "Restoration of livelihoods or income sources",
  wash: "Water, sanitation, and hygiene (toilets, washing facilities)",
  basic_services: "Restoration of basic services and infrastructure (electricity, roads, schools)",
  protection: "Protection services and psychosocial support",
  local_support: "Support from local authorities and community organizations",
  other: "Other — please specify",
};

// Maps raw state values → i18n keys for the review section
const Q1_KEY_MAP: Record<string, string> = {
  minimal: "report.minimal",
  partial:  "report.partial",
  complete: "report.complete",
};
const Q2_KEY_MAP: Record<string, string> = {
  residential:    "Q2_OPT_RESIDENTIAL",
  commercial:     "Q2_OPT_COMMERCIAL",
  government:     "Q2_OPT_GOVERNMENT",
  utility:        "Q2_OPT_UTILITY",
  transport_comm: "Q2_OPT_TRANSPORT_COMM",
  community:      "Q2_OPT_COMMUNITY",
  public_spaces:  "Q2_OPT_PUBLIC_SPACES",
  other:          "Q2_OPT_OTHER",
};
const Q4_KEY_MAP: Record<string, string> = {
  earthquake:        "Q4_OPT_EARTHQUAKE",
  flood:             "Q4_OPT_FLOOD",
  tsunami:           "Q4_OPT_TSUNAMI",
  hurricane_cyclone: "Q4_OPT_HURRICANE_CYCLONE",
  wildfire:          "Q4_OPT_WILDFIRE",
  explosion:         "Q4_OPT_EXPLOSION",
  chemical_incident: "Q4_OPT_CHEMICAL_INCIDENT",
  conflict:          "Q4_OPT_CONFLICT",
  civil_unrest:      "Q4_OPT_CIVIL_UNREST",
};
const Q5_KEY_MAP: Record<string, string> = {
  yes:       "Q5_OPT_YES",
  no:        "Q5_OPT_NO",
  partially: "Q5_OPT_PARTIALLY",
};
const Q6_KEY_MAP: Record<string, string> = {
  no_damage: "Q6_OPT_NO_DAMAGE",
  minor:     "Q6_OPT_MINOR",
  moderate:  "Q6_OPT_MODERATE",
  severe:    "Q6_OPT_SEVERE",
  destroyed: "Q6_OPT_DESTROYED",
  unknown:   "Q6_OPT_UNKNOWN",
};
const Q7_KEY_MAP: Record<string, string> = {
  fully_functional:     "Q7_OPT_FULLY_FUNCTIONAL",
  partially_functional: "Q7_OPT_PARTIALLY_FUNCTIONAL",
  largely_disrupted:    "Q7_OPT_LARGELY_DISRUPTED",
  not_functioning:      "Q7_OPT_NOT_FUNCTIONING",
  unknown:              "Q7_OPT_UNKNOWN",
};
const Q8_KEY_MAP: Record<string, string> = {
  food_water:     "Q8_OPT_FOOD_WATER",
  cash:           "Q8_OPT_CASH",
  healthcare:     "Q8_OPT_HEALTHCARE",
  shelter:        "Q8_OPT_SHELTER",
  livelihoods:    "Q8_OPT_LIVELIHOODS",
  wash:           "Q8_OPT_WASH",
  basic_services: "Q8_OPT_BASIC_SVC",
  protection:     "Q8_OPT_PROTECTION",
  local_support:  "Q8_OPT_LOCAL_SUPPORT",
  other:          "Q8_OPT_OTHER",
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
        { value: 'earthquake', label: t('Q4_OPT_EARTHQUAKE', 'Earthquake') },
        { value: 'flood', label: t('Q4_OPT_FLOOD', 'Flood') },
        { value: 'tsunami', label: t('Q4_OPT_TSUNAMI', 'Tsunami') },
        { value: 'hurricane_cyclone', label: t('Q4_OPT_HURRICANE_CYCLONE', 'Hurricane or Cyclone') },
        { value: 'wildfire', label: t('Q4_OPT_WILDFIRE', 'Wildfire') },
      ],
    },
    {
      groupLabel: t('questions.q4.group_technological'),
      options: [
        { value: 'explosion', label: t('Q4_OPT_EXPLOSION', 'Explosion') },
        { value: 'chemical_incident', label: t('Q4_OPT_CHEMICAL_INCIDENT', 'Chemical Incident') },
      ],
    },
    {
      groupLabel: t('questions.q4.group_humanmade'),
      options: [
        { value: 'conflict', label: t('questions.q4.opt_conflict') },
        { value: 'civil_unrest', label: t('Q4_OPT_CIVIL_UNREST', 'Civil Unrest') },
      ],
    },
  ];
  const insets = useSafeAreaInsets();

  // Step
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [fromReview, setFromReview] = useState(false);
  const [locationChangedForReview, setLocationChangedForReview] = useState(false);
  const [showLocationChangedNote, setShowLocationChangedNote] = useState(false);

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
  const [submitTimedOut, setSubmitTimedOut] = useState(false);
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);
  const [activeThumbnailIndex, setActiveThumbnailIndex] = useState<number | null>(null);
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(null);
  const [showDupeWarning, setShowDupeWarning] = useState(false);
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisCenterLat, setCrisisCenterLat] = useState<number | null>(null);
  const [crisisCenterLng, setCrisisCenterLng] = useState<number | null>(null);
  const [crisisRadiusMiles, setCrisisRadiusMiles] = useState<number>(50);
  const [showOutsideAreaWarning, setShowOutsideAreaWarning] = useState(false);
  // Logic 1 — country derived from selected location coordinates
  const [reportLocationCountry, setReportLocationCountry] = useState<string | null>(null);
  // GPS geo-fence — hard block when selection is > 50 mi from reporter's GPS
  const [gpsGeofenceBlocked, setGpsGeofenceBlocked] = useState(false);
  // Logic 2 — country picker for offline_no_gps scenario
  const [offlineReportCountry, setOfflineReportCountry] = useState<string | null>(null);
  const [offlineCountries, setOfflineCountries] = useState<Array<{code:string;name:string}>>([]);
  const [showCountryModal, setShowCountryModal] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);
  const [questionPackage, setQuestionPackage] = useState<ActivePackage | null>(null);

  // Building footprint source — fetched once from public settings
  const [footprintSource, setFootprintSource] = useState<string>("osm");

  // Map refs
  const cameraRef = useRef<CameraRef | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortController = useRef<AbortController | null>(null);
  const buildingTappedRef = useRef(false);
  const isMountedRef = useRef(true);
  // Stores the local_id of the most recently queued offline report so the delete
  // and retry handlers can reference the specific queue entry.
  const queuedLocalIdRef = useRef<string | null>(null);
  const reviewScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setFlowStartedAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    const init = async () => {
      const cached = await loadCrisisMeta();
      if (cached) {
        setCrisisCenterLat(cached.map_center_lat);
        setCrisisCenterLng(cached.map_center_lng);
        setCrisisRadiusMiles(cached.map_default_radius_miles);
      }
      try {
        const crisisRes = await api.get("/api/crises/active");
        const list = Array.isArray(crisisRes.data) ? crisisRes.data : (crisisRes.data?.items ?? []);
        if (list.length > 0) {
          const first = list[0];
          setCrisisId(first.id);
          setCrisisCenterLat(first.map_center_lat ?? null);
          setCrisisCenterLng(first.map_center_lng ?? null);
          setCrisisRadiusMiles(first.map_default_radius_miles ?? 50);
          await saveCrisisMeta({
            id: first.id,
            map_center_lat: first.map_center_lat ?? null,
            map_center_lng: first.map_center_lng ?? null,
            map_default_radius_miles: first.map_default_radius_miles ?? 50,
            cached_at: new Date().toISOString(),
          });
        } else {
          setCrisisError(true);
        }
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

  // Geo-fence: warn reporter if selected location is outside the crisis radius (soft warning)
  useEffect(() => {
    const lat = selectedBuilding ? selectedBuilding.centroid[1] : gpsCoords?.lat ?? null;
    const lng = selectedBuilding ? selectedBuilding.centroid[0] : gpsCoords?.lng ?? null;
    if (!lat || !lng || !crisisCenterLat || !crisisCenterLng) {
      setShowOutsideAreaWarning(false);
      return;
    }
    setShowOutsideAreaWarning(
      haversineKm(lat, lng, crisisCenterLat, crisisCenterLng) > milesToKm(crisisRadiusMiles)
    );
  }, [selectedBuilding, gpsCoords, crisisCenterLat, crisisCenterLng, crisisRadiusMiles]);

  // GPS geo-fence: hard block when selected location is > 50 mi from reporter's current GPS
  useEffect(() => {
    if (!locationGpsCoords) { setGpsGeofenceBlocked(false); return; }
    const selLat = selectedBuilding ? selectedBuilding.centroid[1] : pinCoords?.lat ?? null;
    const selLng = selectedBuilding ? selectedBuilding.centroid[0] : pinCoords?.lng ?? null;
    if (selLat === null || selLng === null) { setGpsGeofenceBlocked(false); return; }
    setGpsGeofenceBlocked(
      haversineKm(selLat, selLng, locationGpsCoords.lat, locationGpsCoords.lng) > milesToKm(50)
    );
  }, [selectedBuilding, pinCoords, locationGpsCoords]);

  // Logic 1: reverse geocode country from selected building, pin drop, or GPS position
  const reverseGeocodeCountry = useCallback(async (lat: number, lng: number) => {
    if (!MAPTILER_KEY) return;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(
        `https://api.maptiler.com/geocoding/${lng.toFixed(6)},${lat.toFixed(6)}.json?key=${MAPTILER_KEY}&types=country`,
        { signal: ctrl.signal }
      );
      clearTimeout(tid);
      if (!r.ok) return;
      const data = await r.json() as { features?: Array<{ id?: string; properties?: { short_code?: string } }> };
      const feature = data?.features?.[0];
      const fromId = feature?.id?.split?.('.')?.[1]?.toUpperCase();
      const fromShort = feature?.properties?.short_code?.toUpperCase();
      const code = fromId || fromShort;
      if (code && /^[A-Z]{2}$/.test(code)) setReportLocationCountry(code);
    } catch { /* silent — onboarding country is the fallback */ }
  }, []);

  useEffect(() => {
    if (!selectedBuilding) return;
    void reverseGeocodeCountry(selectedBuilding.centroid[1], selectedBuilding.centroid[0]);
  }, [selectedBuilding, reverseGeocodeCountry]);

  useEffect(() => {
    if (!pinCoords) return;
    void reverseGeocodeCountry(pinCoords.lat, pinCoords.lng);
  }, [pinCoords, reverseGeocodeCountry]);

  // GPS-only path: geocode when GPS arrives but no building/pin has been selected yet
  useEffect(() => {
    if (!locationGpsCoords || selectedBuilding || pinCoords) return;
    void reverseGeocodeCountry(locationGpsCoords.lat, locationGpsCoords.lng);
  }, [locationGpsCoords, reverseGeocodeCountry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Logic 2: load country list and pre-fill when offline_no_gps is detected
  useEffect(() => {
    if (locationScenario !== 'offline_no_gps') return;
    AsyncStorage.getItem('cr_countries_cache').then((raw) => {
      try {
        const list = raw ? (JSON.parse(raw) as Array<{code:string;name:string;is_active?:boolean}>)
          .filter(c => c.is_active !== false) : [];
        setOfflineCountries(list.length ? list : OFFLINE_COUNTRY_FALLBACK);
      } catch {
        setOfflineCountries(OFFLINE_COUNTRY_FALLBACK);
      }
    });
    AsyncStorage.getItem('cr_country_code').then((code) => {
      if (code) setOfflineReportCountry(code);
    });
  }, [locationScenario]);

  // Version-gated question package sync — loads cache immediately, only re-downloads if version changed
  useEffect(() => {
    const checkAndSyncQuestions = async () => {
      const langCode = await AsyncStorage.getItem('cr_language') || 'en';

      // Load cached package immediately so questions render without waiting for network
      const cachedStr = await AsyncStorage.getItem('cr_question_package');
      const cachedVersion = await AsyncStorage.getItem('cr_question_content_version');
      if (cachedStr) {
        try {
          setQuestionPackage(JSON.parse(cachedStr));
        } catch {
          // Corrupt cache — ignore; will be replaced below
        }
      }

      // Check current version from backend
      try {
        const versionRes = await api.get('/api/question-packages/version');
        const latestVersion = String(versionRes.data.content_version ?? versionRes.data.version ?? '');

        if (latestVersion && latestVersion === cachedVersion) {
          // Version matches — no download needed
          return;
        }

        // Version differs or no cache — download full package
        const response = await api.get<ActivePackage>(`/api/question-packages/active?lang=${langCode}`);
        if (response.data) {
          setQuestionPackage(response.data);
          await AsyncStorage.setItem('cr_question_package', JSON.stringify(response.data));
          await AsyncStorage.setItem('cr_question_content_version', latestVersion || response.data.version);
        }
      } catch (error) {
        // Network error — use cached package silently
        console.warn('Question package sync failed, using cache:', error);
      }
    };

    checkAndSyncQuestions();
  }, []);

  // Cleanup debounce timer on unmount; mark component as unmounted
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (searchDebounceTimer.current) clearTimeout(searchDebounceTimer.current);
      searchAbortController.current?.abort();
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
        online = netState.isConnected === true && netState.isInternetReachable !== false;
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
      const nowOnline = state.isConnected === true && state.isInternetReachable !== false;

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

  // Scroll review page to top when entering the review step
  useEffect(() => {
    if (step === 'review') {
      reviewScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    }
  }, [step]);

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
        console.warn("Notification permission denied — report will sync on next app open");
        return;
      }

      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId) {
        console.warn("EAS projectId not found — push token registration skipped");
        return;
      }
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
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
      console.warn("Push token registration failed:", err);
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
    if (!bounds || bounds.length < 4) return;

    const [west, south, east, north] = bounds;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      const fc = await fetchBuildingsForBounds(west, south, east, north);
      if (fc && isMountedRef.current) setBuildingsFC(fc);
    }, 1000);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);

    if (searchDebounceTimer.current) clearTimeout(searchDebounceTimer.current);

    if (query.trim().length < 3) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    searchDebounceTimer.current = setTimeout(async () => {
      // Cancel the previous in-flight request so a stale response
      // can never overwrite results for the current query.
      searchAbortController.current?.abort();
      searchAbortController.current = new AbortController();

      if (isMountedRef.current) setSearchLoading(true);
      try {
        const encoded = encodeURIComponent(query);
        const response = await fetch(
          `https://api.maptiler.com/geocoding/${encoded}.json?key=${MAPTILER_KEY}&limit=5`,
          { signal: searchAbortController.current.signal }
        );
        const data = await response.json();
        const results = (data.features ?? []).map((f: any) => ({
          id: f.id,
          place_name: f.place_name ?? f.text ?? '',
          center: f.center as [number, number],
        }));
        if (isMountedRef.current) {
          setSearchResults(results);
          setShowSearchResults(results.length > 0);
        }
      } catch (err) {
        // Ignore AbortError — it means a newer query superseded this one.
        if (err instanceof Error && err.name !== 'AbortError' && isMountedRef.current) {
          setSearchResults([]);
          setShowSearchResults(false);
        }
      } finally {
        if (isMountedRef.current) setSearchLoading(false);
      }
    }, 350);
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
    const geom = f.geometry as GeoJSON.Geometry;
    // Only handle Polygon geometry — MultiPolygon buildings from Overpass are skipped
    if (!geom || geom.type !== 'Polygon') return;
    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    if (!ring || ring.length < 3) return;
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
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
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
    // Hard GPS fence: if a specific building/pin is selected and it's > 50 mi from reporter's GPS, block
    if (gpsGeofenceBlocked) return false;
    if (locationScenario === 'online_gps') {
      return !!(gpsCoords || locationGpsCoords || selectedBuilding || pinCoords);
    }
    if (locationScenario === 'online_no_gps') {
      return !!(selectedBuilding || pinCoords || locationAddress?.trim());
    }
    if (locationScenario === 'offline_gps') {
      return !!locationGpsCoords;
    }
    if (locationScenario === 'offline_no_gps') {
      return !!(locationAddress?.trim());
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
    // width/height are declared here so the conversion result can populate them,
    // avoiding a separate manipulateAsync call just for dimensions (OOM risk on
    // low-RAM devices when multiple large temp files coexist).
    let formatConverted = false;
    let width = 0;
    let height = 0;
    if (needsConversion) {
      try {
        const converted = await ImageManipulator.manipulateAsync(
          uri,
          [],
          { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        workingUri = converted.uri;
        width = converted.width;
        height = converted.height;
        formatConverted = true;
      } catch {
        Alert.alert('Cannot Use This Photo', t('photoScreen.validationFormat'));
        return null;
      }
    }

    // --- STEP 4: Get image dimensions (skipped when conversion already returned them) ---
    if (width === 0 || height === 0) {
      try {
        const imageInfo = await ImageManipulator.manipulateAsync(workingUri, []);
        width = imageInfo.width;
        height = imageInfo.height;
      } catch {
        // Cannot get dimensions — continue with 0,0
      }
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
      t('photoScreen.replaceTitle'),
      t('photoScreen.replaceSource'),
      [
        {
          text: t('report.takePhoto'),
          onPress: async () => {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
              Alert.alert(
                t('photoScreen.cameraAccessTitle'),
                t('photoScreen.cameraAccessMsg'),
                [
                  { text: t('photoScreen.openSettings'), onPress: () => Linking.openSettings() },
                  { text: t('tandc.declineAlertButton'), style: 'cancel' },
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
          text: t('report.uploadPhoto'),
          onPress: async () => {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== 'granted') {
              Alert.alert(
                t('photoScreen.galleryAccessTitle'),
                t('photoScreen.galleryAccessMsg'),
                [
                  { text: t('photoScreen.openSettings'), onPress: () => Linking.openSettings() },
                  { text: t('tandc.declineAlertButton'), style: 'cancel' },
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
        { text: t('photoScreen.removeCancel'), style: 'cancel' },
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
      case 2:
        if (infrastructureTypes.length === 0) return false;
        if (infrastructureTypes.includes("other") && infrastructureOther.trim().length === 0) return false;
        return true;
      case 3: return infrastructureName.trim().length > 0;
      case 4: return !!disasterType;
      case 5: return !!debrisBlocking;
      case 6: return !!electricityCondition;
      case 7: return !!healthServicesCondition;
      case 8:
        if (pressingNeeds.length === 0) return false;
        if (pressingNeeds.includes("other") && pressingNeedsOther.trim().length === 0) return false;
        return true;
      default: return false;
    }
  };

  const handleDamageBack = () => {
    setShowQuestionHint(false);
    if (damageQuestion === 1) {
      if (fromReview) {
        setFromReview(false);
        setStep('review');
        return;
      }
      setStep("location");
      return;
    }
    setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = async () => {
    if (damageQuestion === 3) {
      setShowLocationChangedNote(false);
    }
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
      // Keep the last 200 entries — older ones have already passed the 7-day duplicate window
      await AsyncStorage.setItem("cr_submitted_locations", JSON.stringify(locs.slice(-200)));
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
    setLocationChangedForReview(false);
    setShowLocationChangedNote(false);
    setSubmitTimedOut(false);
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

  const doSubmit = async (submitTappedAt: string, isCurrentlyOnline: boolean) => {
    setShowDupeWarning(false);
    setSubmitting(true);

    const deviceId = await SecureStore.getItemAsync("cr_device_id");
    const osDeviceId = await SecureStore.getItemAsync("cr_os_device_id");
    const netState = await NetInfo.fetch();
    const networkType = netState.type || 'unknown';
    let mcc: string | null = null;
    try { mcc = await Cellular.getMobileCountryCodeAsync(); } catch { /* WiFi-only or no SIM */ }
    const appVersion = Constants.expoConfig?.version || (Constants as any).manifest?.version || '1.0.0';
    const reporterCountry = await AsyncStorage.getItem('cr_country_code');
    const deviceModel = Device.modelName || 'Unknown';
    const deviceBrand = Device.brand || null;
    const deviceOsVersion = Device.osVersion || null;
    const reportPayload = {
      crisis_id: crisisId ?? undefined,
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
      platform: Platform.OS === 'android' ? 'Native App Android' : 'Native App iOS',
      submitted_at: submitTappedAt,
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
        location_note: locationNote || null,
        location_entry_method: locationMethod ?? (
          selectedBuilding ? 'map_selection' :
          pinCoords ? 'pin_drop' :
          (locationAddress || locationLandmark || locationBuildingName) ? 'manual' :
          null
        ),
        location_internet_available: isOnlineAtLocation,
        building_name_osm: selectedBuilding?.name || null,
        building_centroid_lat: selectedBuilding?.centroid
          ? selectedBuilding.centroid[1]
          : null,
        building_centroid_lng: selectedBuilding?.centroid
          ? selectedBuilding.centroid[0]
          : null,
      },
      offline_map_pack_used: false,
      building_name: editableBuildingName || selectedBuilding?.name || undefined,
      building_type: selectedBuilding?.building ?? undefined,
      gps_accuracy: locationGpsCoords?.accuracy ?? undefined,
      reporter_id: reporterId || undefined,
      device_id: deviceId || null,
      os_device_id: osDeviceId || null,
      app_version: appVersion,
      device_model: deviceModel,
      device_brand: deviceBrand,
      device_os_version: deviceOsVersion,
      network_type_at_submission: networkType,
      mcc,
      reporter_country: reportLocationCountry || offlineReportCountry || reporterCountry || null,
      language_code: languageCode,
      question_package_version: questionPackage?.version ?? null,
      question_package_translation_version: questionPackage?.translation_version ?? null,
      photos_metadata: photos.map((photo, index) => ({
        index,
        original_size_kb: photo.originalSize ? Math.round(photo.originalSize / 1024) : null,
        final_size_kb: photo.finalSize ? Math.round(photo.finalSize / 1024) : null,
        compression_applied: photo.compressionApplied || false,
        compression_ratio: (photo.originalSize && photo.finalSize && photo.originalSize > 0)
          ? Math.round((photo.finalSize / photo.originalSize) * 100) / 100
          : null,
        mime_type: photo.mimeType || null,
        exif_date_taken: photo.exif?.dateTaken || null,
        exif_width: photo.exif?.width || null,
        exif_height: photo.exif?.height || null,
      })),
      question_answers: Object.entries(additionalAnswers).map(([questionId, answer]) => ({
        question_id: questionId,
        answer: Array.isArray(answer) ? null : answer,
        answers: Array.isArray(answer) ? answer : null,
      })),
      was_queued: false,
    };

    const queueReport = async () => {
      await registerPushToken();
      const queuedPhotos: QueuedPhoto[] = photos.map((p, i) => ({
        uri: p.uri,
        filename: `photo_${i}.jpg`,
        content_type: p.mimeType,
        display_order: i,
      }));
      // ReportSubmitRequest type predates multi-type infra fields — cast to bypass
      const localId = await addToQueue({ ...reportPayload, was_queued: true } as any, queuedPhotos);
      // Store so the delete and retry handlers can reference this specific queue entry
      queuedLocalIdRef.current = localId;
      await saveSubmittedLocation();
      if (!isMountedRef.current) return;
      setSubmittedReportId(null);
      setWasQueued(true);
      setSubmitted(true);
    };

    try {
      if (!isCurrentlyOnline) {
        await queueReport();
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let onlineReportId: string | null = null;
      try {
        const response = await api.post("/api/reports", reportPayload, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        onlineReportId = response.data.report_id;

        for (let i = 0; i < photos.length; i++) {
          const formData = new FormData();
          formData.append("report_id", onlineReportId!);
          formData.append("display_order", String(i));
          formData.append("file", { uri: photos[i].uri, name: `photo_${i}.jpg`, type: photos[i].mimeType } as any);
          // 120 s per photo — generous for 2G/EDGE field networks; no global Axios timeout
          await api.post("/api/photos", formData, {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 120000,
          });
        }

        await saveSubmittedLocation();
        await saveDirectSubmittedRecord(onlineReportId!, {
          damage_level: damageLevel,
          gps_latitude: reportPayload.location.gps_latitude,
          gps_longitude: reportPayload.location.gps_longitude,
          location_address: reportPayload.location.location_address,
          location_landmark: reportPayload.location.location_landmark,
          building_name: reportPayload.location.location_building_name,
          photo_count: photos.length,
          infrastructure_type: infrastructureTypes[0] ?? null,
        });
        if (isMountedRef.current) {
          setSubmittedReportId(onlineReportId);
          setWasQueued(false);
          setSubmitted(true);
        }
      } catch {
        clearTimeout(timeoutId);
        if (onlineReportId) {
          // Report reached the server; only photo uploads failed.
          // Queue photos only — re-submitting the full report would create a duplicate.
          await registerPushToken();
          const queuedPhotos: QueuedPhoto[] = photos.map((p, i) => ({
            uri: p.uri,
            filename: `photo_${i}.jpg`,
            content_type: p.mimeType,
            display_order: i,
          }));
          await queuePhotosForReport(onlineReportId, queuedPhotos);
          await saveSubmittedLocation();
          await saveDirectSubmittedRecord(onlineReportId, {
            damage_level: damageLevel,
            gps_latitude: reportPayload.location.gps_latitude,
            gps_longitude: reportPayload.location.gps_longitude,
            location_address: reportPayload.location.location_address,
            location_landmark: reportPayload.location.location_landmark,
            building_name: reportPayload.location.location_building_name,
            photo_count: photos.length,
            infrastructure_type: infrastructureTypes[0] ?? null,
          });
          if (isMountedRef.current) {
            setSubmittedReportId(onlineReportId);
            setWasQueued(true);
            setSubmitted(true);
          }
        } else {
          await queueReport();
        }
      }
    } finally {
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    const submitTappedAt = new Date().toISOString();
    const otherInfraEmpty = infrastructureTypes.includes("other") && infrastructureOther.trim().length === 0;
    const otherNeedsEmpty = pressingNeeds.includes("other") && pressingNeedsOther.trim().length === 0;
    if (!damageLevel || infrastructureTypes.length === 0 || otherInfraEmpty || !infrastructureName.trim() || !disasterType || !debrisBlocking || !electricityCondition || !healthServicesCondition || pressingNeeds.length === 0 || otherNeedsEmpty || photos.length === 0) {
      Alert.alert("Required Fields", "Please complete all required fields.");
      return;
    }

    let isCurrentlyOnline = false;
    try {
      const netState = await NetInfo.fetch();
      isCurrentlyOnline = netState.isConnected === true && netState.isInternetReachable !== false;
    } catch {
      isCurrentlyOnline = false;
    }

    const isDupe = await checkDuplicate();
    if (isDupe) {
      setShowDupeWarning(true);
      return;
    }

    if (isCurrentlyOnline) {
      try {
        const params = new URLSearchParams();
        if (selectedBuilding?.id) {
          params.append('building_id', String(selectedBuilding.id));
        }
        if (gpsCoords?.lat) {
          params.append('lat', String(gpsCoords.lat));
          params.append('lng', String(gpsCoords.lng));
        } else if (locationGpsCoords?.lat) {
          params.append('lat', String(locationGpsCoords.lat));
          params.append('lng', String(locationGpsCoords.lng));
        }

        if (params.toString()) {
          const dupRes = await api.get(`/api/reports/duplicate-check?${params.toString()}`);
          if (dupRes.data?.is_duplicate) {
            const confirmed = await new Promise<boolean>((resolve) => {
              Alert.alert(
                t('locationScreen.duplicateWarningTitle'),
                t('locationScreen.duplicateWarningBody'),
                [
                  {
                    text: t('locationScreen.duplicateWarningGoBack'),
                    style: 'cancel',
                    onPress: () => resolve(false),
                  },
                  {
                    text: t('locationScreen.duplicateWarningContinue'),
                    onPress: () => resolve(true),
                  },
                ]
              );
            });
            if (!confirmed) {
              return;
            }
          }
        }
      } catch {
        // Duplicate check failed — proceed without warning
      }
    }

    await doSubmit(submitTappedAt, isCurrentlyOnline);
  };

  // ── Early returns ─────────────────────────────────────────────────────────────

  // Tier 1 — Successful submission confirmation
  if (submitted && !wasQueued) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#FFFFFF' }}
        contentContainerStyle={[styles.confirmContainer, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }]}
      >
        <View style={styles.confirmIconCircleOnline}>
          <MaterialIcons name="check" size={scale(44)} color="#FFFFFF" />
        </View>

        <Text style={styles.confirmTitleLarge}>{t('review.confirmationTitle')}</Text>

        <Text style={styles.confirmSubtitle}>
          {t('review.confirmationMessage')}
        </Text>

        <View style={styles.confirmSummaryCard}>
          <Text style={styles.confirmSummaryHeader}>{t('review.report_summary_header')}</Text>
          <View style={styles.confirmSummaryRow}>
            <Text style={styles.confirmSummaryLabel}>{t('review.confirm_damage_level')}</Text>
            <Text style={styles.confirmSummaryValue}>{t(Q1_KEY_MAP[damageLevel] ?? damageLevel, { defaultValue: DAMAGE_LABELS[damageLevel] ?? damageLevel })}</Text>
          </View>
          <View style={styles.confirmSummaryRow}>
            <Text style={styles.confirmSummaryLabel}>{t('review.confirm_location')}</Text>
            <Text style={styles.confirmSummaryValue} numberOfLines={2}>
              {editableBuildingName || selectedBuilding?.name || locationAddress || locationLandmark || locationBuildingName || '—'}
            </Text>
          </View>
          <View style={[styles.confirmSummaryRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.confirmSummaryLabel}>{t('review.confirm_submitted')}</Text>
            <Text style={styles.confirmSummaryValue}>
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <View style={styles.confirmSummaryFootNote}>
            <MaterialIcons name="info-outline" size={scale(14)} color="#9CA3AF" />
            <Text style={styles.confirmSummaryFootNoteText}>{t('review.confirm_received_note')}</Text>
          </View>
        </View>

        <View style={styles.confirmScreenButtons}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => { resetForm(); setStep('photos'); }}
          >
            <LinearGradient
              colors={['#0468B1', '#00508A']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.confirmGradientBtn}
            >
              <Text style={styles.confirmPrimaryBtnText}>
                {t('review.confirmationSubmitAnother')}
              </Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.confirmSecondaryBtn}
            onPress={() => { resetForm(); navigation.navigate("Home"); }}
          >
            <Text style={styles.confirmSecondaryBtnText}>
              {t('review.confirmationGoHome')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.confirmTextLink}
            onPress={() => { resetForm(); navigation.navigate("MyReports"); }}
          >
            <Text style={styles.confirmTextLinkText}>{t('review.confirm_view_reports')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // Tier 2 — Offline queue confirmation
  if (submitted && wasQueued) {
    const retryUpload = async () => {
      const netState = await NetInfo.fetch();
      if (netState.isConnected === true && netState.isInternetReachable !== false) {
        try {
          await syncQueue(API_BASE);
          // syncQueue swallows errors internally — verify the item is actually gone
          // before transitioning to the success screen
          const queue = await getQueue();
          const stillQueued = queue.some(item => item.local_id === queuedLocalIdRef.current);
          if (!stillQueued) {
            // Item was removed from queue → sync succeeded
            setWasQueued(false);
          } else {
            Alert.alert(t('review.still_offline_title'), t('review.still_offline_body'));
          }
        } catch {
          Alert.alert(t('review.still_offline_title'), t('review.still_offline_body'));
        }
      } else {
        Alert.alert('Still offline', 'Internet is not available yet. Your report is saved and will send automatically.');
      }
    };

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#FFFFFF' }}
        contentContainerStyle={[styles.confirmContainer, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }]}
      >
        <View style={styles.confirmIconCircleOffline}>
          <MaterialIcons name="cloud-upload" size={scale(44)} color="#FFFFFF" />
        </View>

        <Text style={styles.confirmTitleLarge}>{t('review.queueTitle')}</Text>

        <Text style={styles.confirmSubtitle}>
          {t('review.queueMessage')}
        </Text>

        {Platform.OS === 'android' && (
          <Text style={styles.queuePlatformNote}>{t('review.queueAndroidNote')}</Text>
        )}

        {/* Pending sync card */}
        <View style={styles.offlineSyncCard}>
          <View style={styles.offlineSyncAccent} />
          <Text style={styles.offlineSyncHeader}>{t('review.queue_pending_sync')}</Text>
          <View style={styles.offlineSyncRow}>
            <MaterialIcons name="wifi-off" size={scale(18)} color="#F5A623" />
            <Text style={styles.offlineSyncText}>{t('review.queue_currently_offline')}</Text>
          </View>
          <View style={styles.offlineSyncRow}>
            <MaterialIcons name="cloud" size={scale(18)} color="#F5A623" />
            <Text style={styles.offlineSyncText}>{t('review.queue_waiting_upload')}</Text>
          </View>
          <View style={styles.offlineSyncRow}>
            <Text style={styles.offlineSyncLabel}>{t('review.queueSummaryLocation')}</Text>
            <Text style={styles.offlineSyncValue} numberOfLines={1}>
              {editableBuildingName || selectedBuilding?.name || locationAddress || locationLandmark || locationBuildingName || '—'}
            </Text>
          </View>
          <View style={styles.offlineSyncRow}>
            <Text style={styles.offlineSyncLabel}>{t('review.queueSummaryDamage')}</Text>
            <Text style={styles.offlineSyncValue}>{t(Q1_KEY_MAP[damageLevel] ?? damageLevel, { defaultValue: DAMAGE_LABELS[damageLevel] ?? damageLevel })}</Text>
          </View>
          <Text style={styles.offlineSyncNote}>{t('review.queue_auto_upload')}</Text>
        </View>

        <View style={styles.confirmScreenButtons}>
          <TouchableOpacity activeOpacity={0.85} onPress={retryUpload}>
            <LinearGradient
              colors={['#0468B1', '#00508A']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.confirmGradientBtn}
            >
              <MaterialIcons name="refresh" size={scale(18)} color="#FFFFFF" />
              <Text style={styles.confirmRetryBtnText}>{t('review.queueRetry')}</Text>
            </LinearGradient>
          </TouchableOpacity>
          <Text style={styles.confirmRetryHelper}>{t('review.queue_retry_helper')}</Text>

          <TouchableOpacity
            style={styles.confirmSecondaryBtn}
            onPress={() => { resetForm(); setStep('photos'); }}
          >
            <Text style={styles.confirmSecondaryBtnText}>{t('review.queueSubmitAnother')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.confirmSecondaryBtn}
            onPress={() => { resetForm(); navigation.navigate("Home"); }}
          >
            <Text style={styles.confirmSecondaryBtnText}>{t('review.queueGoHome')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.confirmTextLink}
            onPress={() => {
              Alert.alert(
                t('review.delete_report_title'),
                t('review.delete_report_body'),
                [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('review.delete_confirm'),
                    style: 'destructive',
                    onPress: async () => {
                      // Remove the queue entry before navigating away
                      if (queuedLocalIdRef.current) {
                        await removeFromQueue(queuedLocalIdRef.current);
                        queuedLocalIdRef.current = null;
                      }
                      resetForm();
                      navigation.navigate('Home');
                    },
                  },
                ]
              );
            }}
          >
            <Text style={styles.confirmDeleteText}>{t('review.delete_report_link')}</Text>
          </TouchableOpacity>
          <Text style={styles.confirmDeleteWarning}>{t('review.delete_report_warning')}</Text>
        </View>
      </ScrollView>
    );
  }

  if (crisisLoading) {
    return (
      <View style={styles.successContainer}>
        <ActivityIndicator size="large" color="#0468B1" />
      </View>
    );
  }

  // crisisError / missing crisisId does NOT block the form.
  // The backend resolves crisis automatically (auto-picks first active crisis
  // when crisis_id is omitted from the payload). If truly no crisis exists,
  // the submit API call returns a 404 at that point with a clear error.

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
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.backBtnTouch} onPress={() => navigation.goBack()}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("report.title")}</Text>
        <View style={styles.backBtnTouch} />
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
                        <MaterialIcons name="location-on" size={scale(36)} color="#0468B1" />
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

                {/* Instruction pill overlay */}
                {!selectedBuilding && !pinDropActive && (
                  <View style={styles.mapInstructionPill} pointerEvents="none">
                    <MaterialIcons name="info-outline" size={scale(14)} color="#0468B1" />
                    <Text style={styles.mapInstructionText}>Tap a building or drop a pin to select location</Text>
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
                  <MaterialIcons name="my-location" size={scale(24)} color="#FFFFFF" />
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
                    <Text style={styles.selectionCardTitle}>SELECTED LOCATION</Text>
                    <Text style={styles.selectionCardName}>
                      {selectedBuilding.name || "Unnamed building"}
                    </Text>
                    {selectedBuilding.building !== "yes" && (
                      <Text style={styles.selectionCardMeta}>Type: {selectedBuilding.building}</Text>
                    )}
                    <View style={styles.selectionCardCoordsRow}>
                      <MaterialIcons name="satellite-alt" size={scale(12)} color="#717782" />
                      <Text style={styles.selectionCardCoords}>
                        {selectedBuilding.centroid[1].toFixed(5)}° N, {selectedBuilding.centroid[0].toFixed(5)}° E — GPS captured
                      </Text>
                    </View>
                  </View>
                )}

                {/* GPS-only info card (when GPS captured without building) */}
                {gpsCoords && !selectedBuilding && (
                  <View style={styles.selectionCard}>
                    <Text style={styles.selectionCardTitle}>GPS LOCATION CAPTURED</Text>
                    <View style={styles.selectionCardCoordsRow}>
                      <MaterialIcons name="satellite-alt" size={scale(12)} color="#717782" />
                      <Text style={styles.selectionCardCoords}>
                        {gpsCoords.lat.toFixed(5)}° N, {gpsCoords.lng.toFixed(5)}° E
                      </Text>
                    </View>
                  </View>
                )}

                {/* GPS geo-fence: hard error — location too far from reporter's GPS */}
                {gpsGeofenceBlocked && (
                  <View style={styles.geofenceErrorBanner}>
                    <MaterialIcons name="location-off" size={scale(16)} color="#E53E3E" />
                    <Text style={styles.geofenceErrorText}>
                      {t('locationScreen.tooFarFromGps')}
                    </Text>
                  </View>
                )}

                {/* Outside crisis area warning (soft, dismissible) */}
                {showOutsideAreaWarning && !gpsGeofenceBlocked && (
                  <View style={styles.outsideAreaWarning}>
                    <MaterialIcons name="warning" size={scale(14)} color="#E07B00" />
                    <Text style={styles.outsideAreaWarningText}>
                      {t('report.location_outside_crisis_area')}
                    </Text>
                    <TouchableOpacity onPress={() => setShowOutsideAreaWarning(false)}>
                      <MaterialIcons name="close" size={scale(14)} color="#E07B00" />
                    </TouchableOpacity>
                  </View>
                )}

                {/* GPS capture button */}
                <TouchableOpacity
                  style={[styles.gpsButton, gpsCapturing && styles.buttonDisabled]}
                  onPress={handleGetGPS}
                  disabled={gpsCapturing}
                >
                  {!gpsCapturing && <MaterialIcons name="location-on" size={scale(18)} color="#0468B1" />}
                  <Text style={styles.gpsButtonText}>
                    {gpsCapturing ? "Getting location…" : "Use My GPS Location"}
                  </Text>
                </TouchableOpacity>

                {/* Manual location toggle */}
                <TouchableOpacity onPress={() => setManualExpanded(!manualExpanded)}>
                  <Text style={styles.manualToggle}>
                    {manualExpanded ? `${t('locationScreen.hideManualEntry')} ▲` : `${t('locationScreen.expandManualEntry')} ▼`}
                  </Text>
                </TouchableOpacity>

                {manualExpanded && (
                  <View style={{ gap: 8 }}>
                    <TextInput
                      style={styles.input}
                      placeholder={t('locationScreen.manualAddress')}
                      value={locationAddress}
                      onChangeText={setLocationAddress}
                    />
                    <TextInput
                      style={styles.input}
                      placeholder={t('locationScreen.manualLandmarkPlaceholder')}
                      value={locationLandmark}
                      onChangeText={setLocationLandmark}
                    />
                    <TextInput
                      style={styles.input}
                      placeholder={t('locationScreen.manualBuildingName')}
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
                <MaterialIcons name="wifi-off" size={scale(20)} color="#FFFFFF" style={{ marginTop: 1 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.offlineBannerPrimary}>
                    {t('locationScreen.offlineBanner')}
                  </Text>
                  <Text style={styles.offlineBannerSecondary}>
                    Your GPS coordinates are still being recorded in the background
                  </Text>
                </View>
              </View>

              {/* GPS status indicator */}
              {locationScenario === 'offline_gps' && locationGpsCoords && (
                <View style={styles.gpsIndicator}>
                  <View style={styles.gpsDot} />
                  <MaterialIcons name="location-on" size={scale(14)} color="#38A169" />
                  <Text style={styles.gpsIndicatorText}>
                    {t('locationScreen.gpsRecorded')}
                  </Text>
                </View>
              )}
              {locationScenario === 'offline_no_gps' && (
                <View style={styles.gpsIndicator}>
                  <MaterialIcons name="warning-amber" size={scale(14)} color="#E65100" />
                  <Text style={[styles.gpsIndicatorText, styles.gpsIndicatorUnavailable]}>
                    {t('locationScreen.gpsUnavailable')}
                  </Text>
                </View>
              )}

              {/* Logic 2: Country picker — only for offline_no_gps (no coords to reverse-geocode from) */}
              {locationScenario === 'offline_no_gps' && (
                <>
                  <Text style={styles.manualFieldLabel}>{t('locationScreen.countryLabel')}</Text>
                  <TouchableOpacity style={styles.countryPickerBtn} onPress={() => setShowCountryModal(true)}>
                    <Text style={styles.countryPickerText}>
                      {offlineCountries.find(c => c.code === offlineReportCountry)?.name
                        || offlineReportCountry
                        || t('locationScreen.selectCountry')}
                    </Text>
                    <MaterialIcons name="arrow-drop-down" size={scale(22)} color="#717782" />
                  </TouchableOpacity>
                  <Text style={styles.manualFieldHint}>{t('locationScreen.countryHint')}</Text>

                  <Modal visible={showCountryModal} animationType="slide" transparent={false}>
                    <View style={{ flex: 1, backgroundColor: '#FFFFFF', paddingTop: insets.top + 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#EBEBEB' }}>
                        <TextInput
                          style={[styles.manualInput, { flex: 1, marginBottom: 0 }]}
                          placeholder={t('locationScreen.countrySearch')}
                          value={countrySearch}
                          onChangeText={setCountrySearch}
                          autoFocus
                        />
                        <TouchableOpacity onPress={() => { setShowCountryModal(false); setCountrySearch(''); }} style={{ marginLeft: 12 }}>
                          <MaterialIcons name="close" size={scale(22)} color="#1B1C1C" />
                        </TouchableOpacity>
                      </View>
                      <FlatList
                        data={offlineCountries.filter(c =>
                          c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
                          c.code.toLowerCase().includes(countrySearch.toLowerCase())
                        )}
                        keyExtractor={c => c.code}
                        keyboardShouldPersistTaps="handled"
                        renderItem={({ item }) => (
                          <TouchableOpacity
                            style={{ paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                            onPress={() => { setOfflineReportCountry(item.code); setShowCountryModal(false); setCountrySearch(''); }}
                          >
                            <Text style={{ fontSize: 15, color: '#1B1C1C' }}>{item.name}</Text>
                            {offlineReportCountry === item.code && (
                              <MaterialIcons name="check" size={scale(18)} color="#0468B1" />
                            )}
                          </TouchableOpacity>
                        )}
                      />
                    </View>
                  </Modal>
                </>
              )}

              {/* Manual entry fields */}
              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualAddress')}{locationScenario === 'offline_no_gps' ? ' *' : ''}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualAddressPlaceholder')}
                value={locationAddress}
                onChangeText={setLocationAddress}
                multiline={false}
              />
              <Text style={styles.manualFieldHint}>e.g. 14 Ataturk Street, Kadikoy</Text>

              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualLandmark')}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualLandmarkPlaceholder')}
                value={locationLandmark}
                onChangeText={setLocationLandmark}
                multiline={false}
              />
              <Text style={styles.manualFieldHint}>e.g. Near the school next to the central market</Text>

              <Text style={styles.manualFieldLabel}>{t('locationScreen.manualBuildingName')}</Text>
              <TextInput
                style={styles.manualInput}
                placeholder={t('locationScreen.manualBuildingNamePlaceholder')}
                value={locationBuildingName}
                onChangeText={setLocationBuildingName}
                multiline={false}
              />
              <Text style={styles.manualFieldHint}>e.g. Residential Block 4B, Al-Nour Mosque</Text>

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
            <View style={[styles.footerBar, { paddingBottom: insets.bottom + 16 }]}>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={!isLocationValid()}
                onPress={() => {
                  if (!isLocationValid()) return;
                  if (fromReview) {
                    setFromReview(false);
                    if (locationChangedForReview) {
                      setLocationChangedForReview(false);
                      setDamageQuestion(3);
                      setInfrastructureName('');
                      setShowLocationChangedNote(true);
                      setStep('damage');
                      return;
                    }
                    setStep('review');
                    return;
                  }
                  setStep('damage');
                }}
              >
                <LinearGradient
                  colors={isLocationValid() ? ['#0468B1', '#00508A'] : ['#E4E2E1', '#E4E2E1']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.footerGradientBtn}
                >
                  <Text style={[styles.footerPillBtnText, !isLocationValid() && styles.footerPillBtnTextDisabled]}>
                    Next
                  </Text>
                  <MaterialIcons name="arrow-forward" size={scale(20)} color={isLocationValid() ? '#FFFFFF' : '#9CA3AF'} />
                </LinearGradient>
              </TouchableOpacity>
              {/* Offline scenarios don't show back — user taps header back arrow */}
              {(locationScenario === 'online_gps' || locationScenario === 'online_no_gps') && (
                <TouchableOpacity
                  style={styles.footerTextBackBtn}
                  onPress={() => setStep("photos")}
                >
                  <Text style={styles.footerTextBackBtnText}>← Back</Text>
                </TouchableOpacity>
              )}
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
              <TouchableOpacity
                style={[styles.primaryButton, { flex: 1 }]}
                onPress={async () => {
                  setShowDupeWarning(false);
                  const t2 = new Date().toISOString();
                  let online = false;
                  try {
                    const netState = await NetInfo.fetch();
                    online = netState.isConnected === true && netState.isInternetReachable !== false;
                  } catch { online = false; }
                  await doSubmit(t2, online);
                }}
              >
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
              <MaterialIcons name="visibility" size={scale(22)} color="#414751" style={styles.optionIconView} />
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
              <MaterialIcons name="sync" size={scale(22)} color="#414751" style={styles.optionIconView} />
              <Text style={styles.optionLabel}>{t('photoScreen.replaceButton')}</Text>
            </TouchableOpacity>

            <View style={styles.optionDivider} />

            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => {
                setShowPhotoOptions(false);
                handleRemovePhoto(activeThumbnailIndex!);
              }}
            >
              <MaterialIcons name="delete-outline" size={scale(22)} color="#E53E3E" style={styles.optionIconView} />
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
                  if (fromReview && infrastructureName) {
                    setLocationChangedForReview(true);
                  }
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

      {/* All other steps inside ScrollView + sticky footer */}
      {step !== "location" && step !== "review" && (
        <>
          <ScrollView style={styles.content} contentContainerStyle={[styles.contentPadding, { paddingBottom: 24 }]}>

            {/* ── STEP 1: PHOTOS ── */}
            {step === "photos" && (
              <View style={styles.step}>
                <Text style={styles.stepLabel}>STEP 1 OF 5 — ADD PHOTO</Text>

                {/* Empty state */}
                {photos.length === 0 && (
                  <View style={styles.photoEmptyBox}>
                    <View style={styles.photoEmptyIconCircle}>
                      <MaterialIcons name="add-a-photo" size={scale(28)} color="#717782" />
                    </View>
                    <Text style={styles.photoEmptyText}>No photo added yet</Text>
                  </View>
                )}

                {/* Photo grid — shown when 1+ photos */}
                {photos.length > 0 && (
                  <View style={styles.photoGrid3Col}>
                    {[0, 1, 2].map((slotIndex) => {
                      const photo = photos[slotIndex];
                      const isActiveNextSlot = !photo && photos.length === slotIndex;
                      return (
                        <TouchableOpacity
                          key={slotIndex}
                          style={[
                            styles.photoGridCell,
                            photo
                              ? styles.photoGridCellFilled
                              : isActiveNextSlot
                                ? styles.photoGridCellActive
                                : styles.photoGridCellInactive,
                          ]}
                          onPress={() => {
                            if (photo) { handlePhotoTap(slotIndex); }
                            else if (photos.length === slotIndex) { setShowPhotoOptions(true); }
                          }}
                          activeOpacity={photo ? 0.85 : 0.6}
                          disabled={!photo && photos.length !== slotIndex}
                        >
                          {photo ? (
                            <>
                              <Image source={{ uri: photo.uri }} style={styles.photoGridImage} />
                              <TouchableOpacity
                                style={styles.photoDeleteBadge}
                                onPress={() => handleRemovePhoto(slotIndex)}
                              >
                                <Text style={styles.photoDeleteBadgeText}>✕</Text>
                              </TouchableOpacity>
                            </>
                          ) : (
                            <Text style={[
                              styles.photoGridPlus,
                              isActiveNextSlot ? styles.photoGridPlusActive : styles.photoGridPlusInactive,
                            ]}>+</Text>
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Status text */}
                {photos.length > 0 && photos.length < 3 && (
                  <Text style={styles.photoStatusText}>
                    {photos.length} of 3 photos added. You can add up to 3.
                  </Text>
                )}

                {/* Max reached banner */}
                {photos.length === 3 && (
                  <View style={styles.photoMaxBanner}>
                    <MaterialIcons name="warning-amber" size={scale(18)} color="#8C5B00" />
                    <Text style={styles.photoMaxBannerText}>{t('photoScreen.maxPhotos')}</Text>
                  </View>
                )}

                {/* Action buttons */}
                {photos.length < 3 && (
                  <View style={styles.photoActionsCol}>
                    <TouchableOpacity style={styles.photoActionPill} onPress={handleTakePhoto}>
                      <MaterialIcons name="camera-alt" size={scale(20)} color="#0468B1" />
                      <Text style={styles.photoActionPillText}>{t("report.takePhoto")}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.photoActionPill} onPress={handlePickPhoto}>
                      <MaterialIcons name="photo-library" size={scale(20)} color="#0468B1" />
                      <Text style={styles.photoActionPillText}>{t("report.uploadPhoto")}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Photo tips */}
                <View style={styles.photoTipsContainer}>
                  <Text style={styles.photoTipsHeader}>{t('photoScreen.guidelines.title')}</Text>
                  {[
                    t('photoScreen.guidelines.g1'),
                    t('photoScreen.guidelines.g2'),
                    t('photoScreen.guidelines.g3'),
                    t('photoScreen.guidelines.g4'),
                  ].map((tip, index) => (
                    <View key={index} style={styles.photoTipRow}>
                      <MaterialIcons name="check-circle" size={scale(18)} color="#006D37" style={{ marginTop: 1 }} />
                      <Text style={styles.photoTipText}>{tip}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* ── STEP 3: QUESTIONS ── */}
            {step === "damage" && (
              <View style={styles.step}>
                {/* Question progress */}
                <Text style={styles.questionProgressLabel}>
                  {t('report.question_number', { number: damageQuestion, total: 8 + additionalQuestions.length })}
                </Text>
                <View style={styles.questionProgressTrack}>
                  <View style={[styles.questionProgressFill, {
                    width: `${(Math.min(damageQuestion, 8 + additionalQuestions.length) / (8 + additionalQuestions.length)) * 100}%` as any,
                  }]} />
                </View>

                {damageQuestion === 1 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(1, t('questions.q1.title'))}</Text>
                    {qOptions(1, [
                      { value: "minimal", label: t('questions.q1.opt_minimal') },
                      { value: "partial", label: t('questions.q1.opt_partial') },
                      { value: "complete", label: t('questions.q1.opt_complete') },
                    ]).map(({ value, label }) => {
                      const isSelected = damageLevel === value;
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { setDamageLevel(value as DamageLevel); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                            {isSelected && <View style={styles.optionCardRadioDot} />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {damageQuestion === 2 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(2, t('questions.q2.title'))}</Text>
                    <Text style={styles.questionSubtitle}>{t('questions.q2.hint')}</Text>
                    {qOptions(2, [
                      { value: "residential",   label: t('questions.q2.opt_residential') },
                      { value: "commercial",    label: t('questions.q2.opt_commercial') },
                      { value: "government",    label: t('questions.q2.opt_government') },
                      { value: "utility",       label: t('questions.q2.opt_utility') },
                      { value: "transport_comm",label: t('questions.q2.opt_transport') },
                      { value: "community",     label: t('questions.q2.opt_community') },
                      { value: "public_spaces", label: t('questions.q2.opt_public_spaces') },
                      { value: "other",         label: t('questions.q2.opt_other') },
                    ]).map(({ value, label }) => {
                      const isSelected = infrastructureTypes.includes(value);
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { toggleInfraType(value); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardCheckbox, isSelected && styles.optionCardCheckboxSelected]}>
                            {isSelected && <Text style={styles.optionCardCheckmark}>✓</Text>}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
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
                    <Text style={styles.questionTitleLarge}>{qTitle(3, t('questions.q3.title'))}</Text>
                    {showLocationChangedNote && (
                      <View style={styles.locationChangedNote}>
                        <Text style={styles.locationChangedNoteText}>{t('review.locationChangedNote')}</Text>
                      </View>
                    )}
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
                    <Text style={styles.questionTitleLarge}>{qTitle(4, t('questions.q4.title'))}</Text>
                    {Q4_GROUPS.map((group) => (
                      <View key={group.groupLabel}>
                        <Text style={styles.q4GroupLabel}>{group.groupLabel}</Text>
                        {group.options.map(({ value, label }) => {
                          const isSelected = disasterType === value;
                          return (
                            <TouchableOpacity
                              key={value}
                              style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                              onPress={() => { setDisasterType(value); setShowQuestionHint(false); }}
                            >
                              <View style={styles.optionCardLeft}>
                                <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                              </View>
                              <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                                {isSelected && <View style={styles.optionCardRadioDot} />}
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ))}
                  </>
                )}

                {damageQuestion === 5 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(5, t('questions.q5.title'))}</Text>
                    {qOptions(5, [
                      { value: "yes", label: t('Q5_OPT_YES', 'Yes') },
                      { value: "no", label: t('Q5_OPT_NO', 'No') },
                    ]).map(({ value, label }) => {
                      const isSelected = debrisBlocking === value;
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { setDebrisBlocking(value); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                            {isSelected && <View style={styles.optionCardRadioDot} />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {damageQuestion === 6 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(6, t('questions.q6.title'))}</Text>
                    {qOptions(6, [
                      { value: "no_damage", label: t('Q6_OPT_NO_DAMAGE', 'No damage observed') },
                      { value: "minor", label: t('Q6_OPT_MINOR', 'Minor damage — service disruptions but quickly repairable') },
                      { value: "moderate", label: t('Q6_OPT_MODERATE', 'Moderate damage — partial outages requiring repairs') },
                      { value: "severe", label: t('Q6_OPT_SEVERE', 'Severe damage — major infrastructure damaged, prolonged outages') },
                      { value: "destroyed", label: t('Q6_OPT_DESTROYED', 'Completely destroyed — no electricity infrastructure functioning') },
                      { value: "unknown", label: t('Q6_OPT_UNKNOWN', 'Unknown / cannot be assessed') },
                    ]).map(({ value, label }) => {
                      const isSelected = electricityCondition === value;
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { setElectricityCondition(value); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                            {isSelected && <View style={styles.optionCardRadioDot} />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {damageQuestion === 7 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(7, t('questions.q7.title'))}</Text>
                    {qOptions(7, [
                      { value: "fully_functional",    label: t('Q7_OPT_FULLY_FUNCTIONAL', 'Fully functional') },
                      { value: "partially_functional", label: t('Q7_OPT_PARTIALLY_FUNCTIONAL', 'Partially functional') },
                      { value: "largely_disrupted",    label: t('Q7_OPT_LARGELY_DISRUPTED', 'Largely disrupted') },
                      { value: "not_functioning", label: t('Q7_OPT_NOT_FUNCTIONING', 'Not functioning at all') },
                      { value: "unknown",       label: t('Q7_OPT_UNKNOWN', 'Unknown') },
                    ]).map(({ value, label }) => {
                      const isSelected = healthServicesCondition === value;
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { setHealthServicesCondition(value); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                            {isSelected && <View style={styles.optionCardRadioDot} />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}

                {damageQuestion === 8 && (
                  <>
                    <Text style={styles.questionTitleLarge}>{qTitle(8, t('questions.q8.title'))}</Text>
                    <Text style={styles.questionSubtitle}>{t('questions.q8.hint')}</Text>
                    {qOptions(8, [
                      { value: "food_water", label: t('Q8_OPT_FOOD_WATER', 'Food assistance and safe drinking water') },
                      { value: "cash",       label: t('Q8_OPT_CASH', 'Cash or financial assistance') },
                      { value: "healthcare", label: t('Q8_OPT_HEALTHCARE', 'Access to healthcare and essential medicines') },
                      { value: "shelter", label: t('Q8_OPT_SHELTER', 'Shelter, housing repair, or temporary accommodation') },
                      { value: "livelihoods", label: t('Q8_OPT_LIVELIHOODS', 'Restoration of livelihoods or income sources') },
                      { value: "wash", label: t('Q8_OPT_WASH', 'Water, sanitation, and hygiene (toilets, washing facilities)') },
                      { value: "basic_services", label: t('Q8_OPT_BASIC_SVC', 'Restoration of basic services and infrastructure (electricity, roads, schools)') },
                      { value: "protection", label: t('Q8_OPT_PROTECTION', 'Protection services and psychosocial support') },
                      { value: "local_support", label: t('Q8_OPT_LOCAL_SUPPORT', 'Support from local authorities and community organizations') },
                      { value: "other", label: t('Q8_OPT_OTHER', 'Other — please specify') },
                    ]).map(({ value, label }) => {
                      const isSelected = pressingNeeds.includes(value);
                      return (
                        <TouchableOpacity
                          key={value}
                          style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                          onPress={() => { togglePressingNeed(value); setShowQuestionHint(false); }}
                        >
                          <View style={styles.optionCardLeft}>
                            <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{label}</Text>
                          </View>
                          <View style={[styles.optionCardCheckbox, isSelected && styles.optionCardCheckboxSelected]}>
                            {isSelected && <Text style={styles.optionCardCheckmark}>✓</Text>}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
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
                      <Text style={styles.questionTitleLarge}>{aq.question_text}</Text>

                      {qType === 'single_select' && (aq.options ?? []).map((opt) => {
                        const isSelected = additionalAnswers[qKey] === opt.option_value;
                        return (
                          <TouchableOpacity
                            key={opt.option_value}
                            style={[styles.optionCard, isSelected && styles.optionCardSelected]}
                            onPress={() => {
                              setAdditionalAnswers((prev) => ({ ...prev, [qKey]: opt.option_value }));
                              setShowQuestionHint(false);
                            }}
                          >
                            <View style={styles.optionCardLeft}>
                              <Text style={[styles.optionCardTitle, isSelected && styles.optionCardTitleSelected]}>{opt.option_text}</Text>
                            </View>
                            <View style={[styles.optionCardRadio, isSelected && styles.optionCardRadioSelected]}>
                              {isSelected && <View style={styles.optionCardRadioDot} />}
                            </View>
                          </TouchableOpacity>
                        );
                      })}

                      {qType === 'multi_select' && (aq.options ?? []).map((opt) => {
                        const current = (additionalAnswers[qKey] as string[]) ?? [];
                        const selected = current.includes(opt.option_value);
                        return (
                          <TouchableOpacity
                            key={opt.option_value}
                            style={[styles.optionCard, selected && styles.optionCardSelected]}
                            onPress={() => {
                              const updated = selected
                                ? current.filter((v) => v !== opt.option_value)
                                : [...current, opt.option_value];
                              setAdditionalAnswers((prev) => ({ ...prev, [qKey]: updated }));
                              setShowQuestionHint(false);
                            }}
                          >
                            <View style={styles.optionCardLeft}>
                              <Text style={[styles.optionCardTitle, selected && styles.optionCardTitleSelected]}>{opt.option_text}</Text>
                            </View>
                            <View style={[styles.optionCardCheckbox, selected && styles.optionCardCheckboxSelected]}>
                              {selected && <Text style={styles.optionCardCheckmark}>✓</Text>}
                            </View>
                          </TouchableOpacity>
                        );
                      })}

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
                        <Text style={styles.questionHint}>{t('questions.answerHint')}</Text>
                      )}
                    </View>
                  );
                })()}

                {showQuestionHint && damageQuestion <= 8 && !isDamageQuestionAnswered() && (
                  <Text style={styles.questionHint}>Please answer this question to continue.</Text>
                )}
              </View>
            )}

          </ScrollView>

          {/* Sticky footer — photos step */}
          {step === "photos" && (
            <View style={[styles.footerBar, { paddingBottom: insets.bottom + 16 }]}>
              <TouchableOpacity
                onPress={() => {
                  if (!photos.length) return;
                  if (fromReview) { setFromReview(false); setStep('review'); return; }
                  setStep('location');
                }}
                disabled={photos.length === 0}
                activeOpacity={0.85}
              >
                <LinearGradient
                  colors={photos.length === 0 ? ['#E4E2E1', '#E4E2E1'] : ['#0468B1', '#00508A']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.footerGradientBtn}
                >
                  <Text style={[styles.footerPillBtnText, photos.length === 0 && styles.footerPillBtnTextDisabled]}>
                    Next
                  </Text>
                  <MaterialIcons name="arrow-forward" size={scale(20)} color={photos.length === 0 ? '#9CA3AF' : '#FFFFFF'} />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {/* Sticky footer — questions step */}
          {step === "damage" && (
            <View style={[styles.footerBar, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.footerDamageRow}>
                <TouchableOpacity
                  style={styles.footerBackPill}
                  onPress={handleDamageBack}
                >
                  <MaterialIcons name="arrow-back" size={scale(18)} color="#0468B1" />
                  <Text style={styles.footerBackPillText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1 }}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (damageQuestion > 8) { handleAdditionalNext(); return; }
                    if (!isDamageQuestionAnswered()) { setShowQuestionHint(true); return; }
                    setShowQuestionHint(false);
                    handleDamageNext();
                  }}
                >
                  <LinearGradient
                    colors={['#0468B1', '#00508A']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.footerGradientBtnFlex}
                  >
                    <Text style={styles.footerPillBtnText}>Next</Text>
                    <MaterialIcons name="arrow-forward" size={scale(18)} color="#FFFFFF" />
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </>
      )}

      {/* Step 4 — Review */}
      {step === 'review' && (
        <View style={styles.reviewContainer}>
          <StepIndicator currentStep={4} />

          {/* Scrollable content */}
          <ScrollView
            ref={reviewScrollRef}
            style={styles.reviewScroll}
            contentContainerStyle={styles.reviewScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.reviewIntroText}>
              Please review your report before submitting. Tap any section to edit.
            </Text>

            {/* Single white card containing all sections */}
            <View style={styles.reviewCard}>

              {/* ── SECTION 1: PHOTOS ── */}
              <View style={styles.reviewCardSection}>
                <View style={styles.reviewSectionHeader}>
                  <Text style={styles.reviewSectionTitle}>{t('review.photosSection')}</Text>
                  <TouchableOpacity
                    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
                    onPress={() => { setFromReview(true); setStep('photos'); }}
                  >
                    <Text style={styles.reviewEditLink}>{t('review.editLink')} </Text>
                  </TouchableOpacity>
                </View>
                {photos.length > 0 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.reviewPhotoRow}>
                    {photos.map((photo, index) => (
                      <TouchableOpacity
                        key={index}
                        onPress={() => setViewerPhoto(photo.uri)}
                        style={styles.reviewPhotoThumb}
                      >
                        <Image source={{ uri: photo.uri }} style={styles.reviewPhotoThumbImage} />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                ) : (
                  <Text style={styles.reviewPhotoRequired}>{t('review.photoRequired')}</Text>
                )}
              </View>

              <View style={styles.reviewCardDivider} />

              {/* ── SECTION 2: LOCATION ── */}
              <View style={styles.reviewCardSection}>
                <View style={styles.reviewSectionHeader}>
                  <Text style={styles.reviewSectionTitle}>{t('review.locationSection')}</Text>
                  <TouchableOpacity
                    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
                    onPress={() => { setFromReview(true); setStep('location'); }}
                  >
                    <Text style={styles.reviewEditLink}>{t('review.editLink')} </Text>
                  </TouchableOpacity>
                </View>

                {selectedBuilding && (
                  <>
                    <View style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{t('review.locationBuilding')}</Text>
                      <Text style={styles.reviewValue}>{editableBuildingName || selectedBuilding.name || '—'}</Text>
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
                        <Text style={[styles.reviewValue, styles.reviewMono]}>{String(selectedBuilding.id).substring(0, 16)}</Text>
                      </View>
                    ) : null}
                  </>
                )}

                {!selectedBuilding && pinDropActive && pinCoords && (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>{t('review.locationPinDrop')}</Text>
                    <Text style={styles.reviewValue}>{pinCoords.lat.toFixed(5)}, {pinCoords.lng.toFixed(5)}</Text>
                  </View>
                )}

                {!selectedBuilding && !pinDropActive && (
                  <>
                    <Text style={styles.reviewManualNote}>{t('review.locationManualNote')}</Text>
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

                {locationNote ? (
                  <View style={styles.reviewRow}>
                    <Text style={styles.reviewLabel}>{t('review.locationNote')}</Text>
                    <Text style={styles.reviewValue}>{locationNote}</Text>
                  </View>
                ) : null}

                <View style={[styles.reviewRow, { borderBottomWidth: 0 }]}>
                  <Text style={styles.reviewLabel}>{t('review.locationGPS')}</Text>
                  <Text style={[
                    styles.reviewValue,
                    (gpsCoords || locationGpsCoords) ? styles.reviewGPSCaptured : styles.reviewGPSUnavailable,
                  ]}>
                    {(gpsCoords || locationGpsCoords)
                      ? `${t('review.locationGPSCaptured')} (${(locationGpsCoords?.lat ?? gpsCoords?.lat ?? 0).toFixed(4)}, ${(locationGpsCoords?.lng ?? gpsCoords?.lng ?? 0).toFixed(4)})`
                      : t('review.locationGPSUnavailable')
                    }
                  </Text>
                </View>
              </View>

              <View style={styles.reviewCardDivider} />

              {/* ── SECTION 3: QUESTIONS ── */}
              <View style={styles.reviewCardSection}>
                <View style={styles.reviewSectionHeader}>
                  <Text style={styles.reviewSectionTitle}>{t('review.questionsSection')}</Text>
                  <TouchableOpacity
                    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
                    onPress={() => { setFromReview(true); setDamageQuestion(1); setStep('damage'); }}
                  >
                    <Text style={styles.reviewEditLink}>{t('review.editLink')} </Text>
                  </TouchableOpacity>
                </View>

                {[
                  { label: t('review.q1Label'), value: t(Q1_KEY_MAP[damageLevel] ?? damageLevel, { defaultValue: DAMAGE_LABELS[damageLevel] ?? damageLevel }) },
                  { label: t('review.q2Label'), value: [...infrastructureTypes.map((v) => t(Q2_KEY_MAP[v] ?? v, { defaultValue: INFRA_LABELS[v] ?? v })), ...(infrastructureOther ? [`${t('questions.q2.opt_other_prefix', { defaultValue: 'Other' })}: ${infrastructureOther}`] : [])].join(', ') },
                  { label: t('review.q3Label'), value: infrastructureName },
                  { label: t('review.q4Label'), value: t(Q4_KEY_MAP[disasterType] ?? disasterType, { defaultValue: DISASTER_LABELS[disasterType] ?? disasterType }) },
                  { label: t('review.q5Label'), value: t(Q5_KEY_MAP[debrisBlocking] ?? debrisBlocking, { defaultValue: DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking }) },
                  { label: t('review.q6Label'), value: t(Q6_KEY_MAP[electricityCondition] ?? electricityCondition, { defaultValue: ELECTRICITY_LABELS[electricityCondition] ?? electricityCondition }) },
                  { label: t('review.q7Label'), value: t(Q7_KEY_MAP[healthServicesCondition] ?? healthServicesCondition, { defaultValue: HEALTH_LABELS[healthServicesCondition] ?? healthServicesCondition }) },
                  { label: t('review.q8Label'), value: [...pressingNeeds.map((v) => t(Q8_KEY_MAP[v] ?? v, { defaultValue: PRESSING_NEEDS_LABELS[v] ?? v })), ...(pressingNeedsOther ? [`${t('questions.q2.opt_other_prefix', { defaultValue: 'Other' })}: ${pressingNeedsOther}`] : [])].join(', ') },
                ].map((item, index) => (
                  item.value ? (
                    <View key={index} style={styles.reviewRow}>
                      <Text style={styles.reviewLabel}>{item.label}</Text>
                      <Text style={styles.reviewValue}>{item.value}</Text>
                    </View>
                  ) : null
                ))}

                {additionalQuestions.length > 0 &&
                  Object.entries(additionalAnswers).map(([qId, answer]) => {
                    const aq = additionalQuestions.find((q: any) => q.id === qId);
                    if (!aq) return null;
                    const displayValue = Array.isArray(answer) ? answer.join(', ') : String(answer);
                    return (
                      <View key={qId} style={styles.reviewRow}>
                        <Text style={styles.reviewLabel}>{(aq as any).text ?? (aq as any).question_text ?? qId}</Text>
                        <Text style={styles.reviewValue}>{displayValue}</Text>
                      </View>
                    );
                  })
                }
              </View>

            </View>

            <View style={{ height: 100 }} />
          </ScrollView>

          {/* ── STICKY SUBMIT BUTTON ── */}
          <View style={[styles.reviewSubmitContainer, { paddingBottom: insets.bottom + 16 }]}>
            {(gpsCoords || locationGpsCoords) && (
              <View style={styles.reviewGpsRow}>
                <View style={styles.reviewGpsDot} />
                <Text style={styles.reviewGpsText}>{t('review.gps_captured_note')}</Text>
              </View>
            )}
            {photos.length === 0 && (
              <Text style={styles.reviewPhotoRequired}>{t('review.photoRequired')}</Text>
            )}
            {submitTimedOut && (
              <View style={styles.submitTimeoutBox}>
                <Text style={styles.submitTimeoutText}>{t('review.submitTimeout')}</Text>
                <TouchableOpacity
                  style={styles.submitRetryBtn}
                  onPress={() => { setSubmitTimedOut(false); handleSubmit(); }}
                >
                  <Text style={styles.submitRetryBtnText}>{t('review.submitRetry')}</Text>
                </TouchableOpacity>
              </View>
            )}
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleSubmit}
              disabled={submitting || photos.length === 0}
            >
              <LinearGradient
                colors={(submitting || photos.length === 0) ? ['#E4E2E1', '#E4E2E1'] : ['#0468B1', '#00508A']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.footerGradientBtn}
              >
                {submitting
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <>
                      <Text style={[styles.reviewSubmitBtnText, (photos.length === 0) && styles.footerPillBtnTextDisabled]}>
                        {t('review.submitButton')}
                      </Text>
                      <MaterialIcons name="send" size={scale(18)} color={(photos.length === 0) ? '#9CA3AF' : '#FFFFFF'} />
                    </>
                }
              </LinearGradient>
            </TouchableOpacity>
            <Text style={styles.reviewPrivacyNote}>
              Your report is encrypted and shared only with authorized UNDP staff.
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── CONTAINER & HEADER ──────────────────────────────────────────────────────
  container: { flex: 1, backgroundColor: '#F6F3F2' },
  header: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    minHeight: 56,
  },
  backBtnTouch: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  backBtn: { color: '#0468B1', fontSize: scale(24), fontWeight: '600' },
  headerTitle: {
    fontSize: scale(17),
    fontWeight: '600',
    color: '#1B1C1C',
    flex: 1,
    textAlign: 'center',
  },

  // ── SHARED SCROLL & STEP ────────────────────────────────────────────────────
  content: { flex: 1 },
  contentPadding: { paddingHorizontal: screenWidth * 0.06, paddingTop: 16 },
  step: { gap: 16 },
  stepLabel: {
    fontSize: scale(10),
    fontWeight: '700',
    color: '#717782',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  // ── FOOTER BAR (sticky for all steps) ──────────────────────────────────────
  footerBar: {
    backgroundColor: '#F6F3F2',
    paddingTop: 12,
    paddingHorizontal: screenWidth * 0.06,
  },
  footerPillBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    alignItems: 'center',
    justifyContent: 'center',
    width: screenWidth * 0.88,
    alignSelf: 'center',
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  footerPillBtnDisabled: {
    backgroundColor: '#E4E2E1',
    elevation: 0,
    shadowOpacity: 0,
  },
  footerPillBtnText: {
    color: '#FFFFFF',
    fontSize: scale(16),
    fontWeight: '700',
  },
  footerPillBtnTextDisabled: {
    color: '#9CA3AF',
  },
  footerPillBtnFlex: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  footerDamageRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  footerBackPill: {
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: '#0468B1',
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
    minWidth: 44,
  },
  footerBackPillText: {
    color: '#0468B1',
    fontSize: scale(15),
    fontWeight: '700',
  },
  footerGradientBtn: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    elevation: 3,
    shadowColor: '#0468B1',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  footerGradientBtnFlex: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    elevation: 3,
    shadowColor: '#0468B1',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  footerTextBackBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
    marginTop: 4,
  },
  footerTextBackBtnText: {
    color: '#717782',
    fontSize: scale(14),
    fontWeight: '600',
  },

  // ── STEP 1 — PHOTOS ────────────────────────────────────────────────────────
  photoEmptyBox: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#C1C7D2',
    backgroundColor: '#FAFAFA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoEmptyIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#EAEAEA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoEmptyText: {
    fontSize: scale(14),
    color: '#717782',
    fontWeight: '500',
    marginTop: 8,
  },

  // Photo 3-col grid
  photoGrid3Col: {
    flexDirection: 'row',
    gap: 10,
  },
  photoGridCell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoGridCellFilled: {
    borderWidth: 0,
  },
  photoGridCellActive: {
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#0468B1',
    backgroundColor: 'rgba(4,104,177,0.05)',
  },
  photoGridCellInactive: {
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#C1C7D2',
    backgroundColor: '#F6F3F2',
  },
  photoGridImage: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  photoGridPlus: {
    fontSize: scale(28),
    lineHeight: scale(32),
  },
  photoGridPlusActive: { color: '#0468B1' },
  photoGridPlusInactive: { color: '#C1C7D2' },
  photoDeleteBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E53E3E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoDeleteBadgeText: {
    color: '#FFFFFF',
    fontSize: scale(12),
    fontWeight: '700',
    lineHeight: scale(14),
  },
  photoStatusText: {
    fontSize: scale(13),
    color: '#717782',
    marginBottom: 4,
  },
  photoMaxBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFDDB4',
    borderRadius: 12,
    padding: 12,
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 4,
  },
  photoMaxBannerIcon: {
    fontSize: scale(18),
    color: '#8C5B00',
  },
  photoMaxBannerText: {
    fontSize: scale(13),
    fontWeight: '600',
    color: '#6C4500',
    flex: 1,
  },
  photoActionsCol: {
    gap: 12,
  },
  photoActionPill: {
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: '#0468B1',
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 44,
  },
  photoActionPillIcon: {
    fontSize: scale(20),
  },
  photoActionPillText: {
    color: '#0468B1',
    fontSize: scale(15),
    fontWeight: '700',
  },

  // Photo tips
  photoTipsContainer: {
    backgroundColor: '#F6F3F2',
    borderRadius: 16,
    padding: 20,
    marginTop: 8,
  },
  photoTipsHeader: {
    fontSize: scale(10),
    fontWeight: '800',
    color: '#1B1C1C',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  photoTipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 14,
  },
  photoTipIcon: {
    fontSize: scale(20),
    color: '#006D37',
    lineHeight: scale(20) * 1.5,
  },
  photoTipText: {
    flex: 1,
    fontSize: scale(14),
    color: '#414751',
    lineHeight: scale(14) * 1.5,
  },

  // ── STEP 3 — QUESTIONS ─────────────────────────────────────────────────────
  questionProgressLabel: {
    fontSize: scale(10),
    fontWeight: '700',
    color: '#0468B1',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  questionProgressTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E4E2E1',
    marginBottom: 24,
  },
  questionProgressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0468B1',
  },
  questionTitleLarge: {
    fontSize: scale(24),
    fontWeight: '800',
    color: '#1B1C1C',
    lineHeight: scale(24) * 1.2,
    marginBottom: 8,
  },
  questionSubtitle: {
    fontSize: scale(15),
    color: '#414751',
    lineHeight: scale(15) * 1.5,
    marginBottom: 8,
  },

  // Option cards — single + multi select
  optionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    minHeight: 44,
    marginBottom: 8,
  },
  optionCardSelected: {
    backgroundColor: 'rgba(4,104,177,0.06)',
    borderLeftWidth: 4,
    borderLeftColor: '#0468B1',
    borderRadius: 12,
    elevation: 0,
  },
  optionCardLeft: { flex: 1 },
  optionCardTitle: {
    fontSize: scale(16),
    fontWeight: '700',
    color: '#1B1C1C',
  },
  optionCardTitleSelected: {
    color: '#0468B1',
  },
  optionCardRadio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#C1C7D2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionCardRadioSelected: {
    backgroundColor: '#0468B1',
    borderColor: '#0468B1',
  },
  optionCardRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  optionCardCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#C1C7D2',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionCardCheckboxSelected: {
    backgroundColor: '#0468B1',
    borderColor: '#0468B1',
  },
  optionCardCheckmark: {
    color: '#FFFFFF',
    fontSize: scale(13),
    fontWeight: '700',
  },

  // 2-column grid options (Q6, Q7)
  optionGrid2Col: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  optionGridCell: {
    backgroundColor: '#F0EDED',
    borderRadius: 10,
    padding: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    width: (screenWidth * 0.88 - 10) / 2,
    minHeight: 44,
  },
  optionGridCellSelected: {
    backgroundColor: '#0468B1',
  },
  optionGridCellText: {
    fontSize: scale(13),
    fontWeight: '500',
    color: '#1B1C1C',
    textAlign: 'center',
  },
  optionGridCellTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  // Shared form elements
  input: {
    backgroundColor: '#E4E2E1',
    borderRadius: 4,
    padding: 14,
    fontSize: scale(14),
    color: '#1B1C1C',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  charCounter: { fontSize: scale(12), color: '#9CA3AF', textAlign: 'right' },
  hintText: { fontSize: scale(14), color: '#666' },
  q4GroupLabel: {
    fontSize: scale(12),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },
  questionHint: {
    fontSize: scale(13),
    color: '#E53E3E',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 4,
  },
  questionBlock: { gap: 4 },
  questionTitle: {
    fontSize: scale(17),
    fontWeight: '600',
    color: '#1B1C1C',
    marginBottom: 4,
  },

  // ── STEP 2 — LOCATION ──────────────────────────────────────────────────────
  locationContainer: { flex: 1, backgroundColor: '#FFFFFF' },
  locationLoadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  gpsUnavailableNote: {
    backgroundColor: '#FFF8E1',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#FFE082',
  },
  gpsUnavailableNoteText: { fontSize: scale(13), color: '#F57F17', lineHeight: 18 },

  // Map wrapper
  mapWrapper: { flex: 1, position: 'relative' },

  // Search overlay
  searchContainer: { position: 'absolute', top: 12, left: 12, right: 12, zIndex: 10 },
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
  searchInput: { flex: 1, fontSize: scale(15), color: '#333333', paddingVertical: 0 },
  searchSpinner: { marginLeft: 8 },
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
  searchResultText: { fontSize: scale(14), color: '#333333', lineHeight: 20 },
  searchNoResults: { fontSize: scale(14), color: '#888888', padding: 16, textAlign: 'center' },

  // Map overlays
  zoomHint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(26,43,74,0.82)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    zIndex: 10,
  },
  zoomHintText: { color: '#fff', fontSize: scale(12), fontWeight: '500' },
  microsoftNote: {
    position: 'absolute',
    bottom: 46,
    left: 8,
    right: 8,
    backgroundColor: 'rgba(235,248,255,0.95)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    zIndex: 10,
    borderWidth: 1,
    borderColor: '#0468B1',
  },
  microsoftNoteText: { color: '#0468B1', fontSize: scale(11) },

  // GPS FAB
  mapRecentreBtn: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#0468B1',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    zIndex: 5,
  },
  mapRecentreIcon: { fontSize: scale(24), color: '#FFFFFF' },

  // Instruction pill
  mapInstructionPill: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center' as const,
    zIndex: 15,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 9999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  mapInstructionText: {
    fontSize: scale(12),
    fontWeight: '500',
    color: '#1B1C1C',
  },

  // Pin marker
  pinMarker: { alignItems: 'center', justifyContent: 'center' },
  pinMarkerIcon: { fontSize: scale(32), lineHeight: 36 },

  // Bottom panel (building name / pin note / location note)
  mapBottomPanel: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 0,
    paddingHorizontal: screenWidth * 0.06,
    paddingTop: 16,
    paddingBottom: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
  },
  pinInfoRow: { paddingVertical: 8, marginBottom: 4 },
  pinInfoLabel: { fontSize: scale(13), color: '#717782', marginBottom: 2 },
  pinInfoCoords: { fontSize: scale(14), fontWeight: '600', color: '#0468B1', marginBottom: 4 },
  pinInfoHint: { fontSize: scale(12), color: '#9CA3AF', fontStyle: 'italic' },
  panelFieldLabel: {
    fontSize: scale(13),
    fontWeight: '600',
    color: '#414751',
    marginBottom: 4,
    marginTop: 8,
  },
  panelInput: {
    backgroundColor: '#E4E2E1',
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: scale(14),
    color: '#1B1C1C',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    minHeight: 44,
  },

  // Location panel (scrollable area below map — online)
  locationPanel: {
    flexShrink: 0,
    maxHeight: 220,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
  },
  locationPanelContent: { paddingHorizontal: screenWidth * 0.06, paddingTop: 20, paddingBottom: 16, gap: 10 },

  // Building selection card
  selectionCard: {
    backgroundColor: '#F6F3F2',
    borderRadius: 12,
    padding: 12,
    gap: 2,
  },
  selectionCardTitle: { fontSize: scale(10), fontWeight: '700', color: '#717782', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
  selectionCardName: { fontSize: scale(17), fontWeight: '700', color: '#1B1C1C', marginBottom: 2 },
  selectionCardMeta: { fontSize: scale(12), color: '#717782' },
  selectionCardCoordsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  selectionCardCoords: { fontSize: scale(11), color: '#717782', flex: 1 },
  outsideAreaWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: scale(8),
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFD54F',
    borderRadius: scale(8),
    padding: scale(10),
    marginTop: scale(4),
  },
  outsideAreaWarningText: {
    flex: 1,
    fontSize: scale(12),
    color: '#795548',
    lineHeight: scale(17),
  },
  geofenceErrorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: scale(8),
    backgroundColor: '#FFF5F5',
    borderWidth: 1,
    borderColor: '#FC8181',
    borderRadius: scale(8),
    padding: scale(10),
    marginTop: scale(4),
  },
  geofenceErrorText: {
    flex: 1,
    fontSize: scale(12),
    color: '#C53030',
    lineHeight: scale(17),
  },
  countryPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: scale(8),
    paddingHorizontal: scale(12),
    paddingVertical: scale(10),
    backgroundColor: '#FAFAFA',
    marginBottom: scale(4),
  },
  countryPickerText: {
    fontSize: scale(14),
    color: '#1B1C1C',
    flex: 1,
  },
  manualToggle: { fontSize: scale(13), color: '#0468B1', textDecorationLine: 'underline' },

  // GPS button
  gpsButton: {
    borderWidth: 1.5,
    borderColor: '#0468B1',
    backgroundColor: 'transparent',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  gpsButtonText: { color: '#0468B1', fontWeight: '700', fontSize: scale(15) },

  // Offline location
  offlineBanner: {
    backgroundColor: '#F5A623',
    paddingHorizontal: screenWidth * 0.06,
    paddingVertical: 14,
    marginBottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  offlineBannerIcon: { fontSize: scale(20), color: '#FFFFFF', lineHeight: scale(22) },
  offlineBannerPrimary: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: scale(20),
    marginBottom: 2,
  },
  offlineBannerSecondary: {
    fontSize: scale(12),
    color: 'rgba(255,255,255,0.9)',
    lineHeight: scale(17),
  },
  gpsIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: screenWidth * 0.06,
    paddingVertical: 12,
    marginTop: 4,
    marginBottom: 4,
    backgroundColor: 'rgba(125,219,157,0.15)',
    borderRadius: 12,
    marginHorizontal: screenWidth * 0.06,
    gap: 8,
  },
  gpsDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#38A169' },
  gpsIndicatorText: { fontSize: scale(12), color: '#414751', flex: 1 },
  gpsIndicatorUnavailable: { color: '#E65100' },
  manualContainer: { flex: 1 },
  manualContent: {
    paddingHorizontal: screenWidth * 0.06,
    paddingTop: 8,
    paddingBottom: 24,
  },
  manualFieldLabel: {
    fontSize: scale(14),
    fontWeight: '600',
    color: '#1B1C1C',
    marginTop: 24,
    marginBottom: 8,
  },
  manualInput: {
    backgroundColor: '#E4E2E1',
    borderRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: scale(14),
    color: '#1B1C1C',
    minHeight: 48,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  manualRequiredNote: {
    fontSize: scale(13),
    color: '#E53E3E',
    marginTop: 12,
    textAlign: 'center',
  },
  manualFieldHint: {
    fontSize: scale(12),
    color: '#9CA3AF',
    fontStyle: 'italic',
    marginTop: 4,
    marginBottom: 4,
  },

  // Legacy — kept so existing unchanged JSX compiles
  locationNextContainer: {
    paddingHorizontal: screenWidth * 0.06,
    paddingTop: 12,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  navButtons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  primaryButton: {
    flex: 1,
    backgroundColor: '#0468B1',
    borderRadius: 28,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { backgroundColor: '#E4E2E1' },
  primaryButtonText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '700' },
  secondaryButton: {
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 20,
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#0468B1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { fontSize: scale(15), color: '#0468B1', fontWeight: '700' },

  // ── STEP 4 — REVIEW ────────────────────────────────────────────────────────
  reviewContainer: { flex: 1, backgroundColor: '#F6F3F2' },
  reviewScroll: { flex: 1 },
  reviewScrollContent: {
    paddingHorizontal: screenWidth * 0.04,
    paddingTop: 16,
    paddingBottom: 8,
  },
  reviewIntroText: {
    fontSize: scale(14),
    color: '#717782',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: scale(14) * 1.5,
  },

  // Single white review card
  reviewCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    marginHorizontal: screenWidth * 0.01,
    overflow: 'hidden',
  },
  reviewCardSection: { padding: 20 },
  reviewCardDivider: { height: 1, backgroundColor: '#F6F3F2', marginHorizontal: 0 },

  reviewSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reviewSectionTitle: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#1B1C1C',
  },
  reviewEditLink: {
    fontSize: scale(13),
    color: '#0468B1',
    fontWeight: '600',
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F6F3F2',
  },
  reviewLabel: {
    backgroundColor: '#F6F3F2',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    fontSize: scale(10),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1,
    flex: 1,
    marginRight: 8,
  },
  reviewValue: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#1B1C1C',
    flex: 1.5,
    textAlign: 'right',
  },
  reviewMono: { fontFamily: 'monospace', fontSize: scale(12), color: '#666666' },
  reviewGPSCaptured: { color: '#38A169', fontSize: scale(12) },
  reviewGPSUnavailable: { color: '#E65100', fontSize: scale(12) },
  reviewManualNote: {
    fontSize: scale(12),
    color: '#888888',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  reviewPhotoRow: { flexDirection: 'row', marginTop: 4 },
  reviewPhotoThumb: { width: 90, height: 90, borderRadius: 8, marginRight: 10, overflow: 'hidden' },
  reviewPhotoThumbImage: { width: '100%', height: '100%' },
  reviewPhotoRequired: { fontSize: scale(13), color: '#E53E3E', marginTop: 4, textAlign: 'center' },

  // Review submit footer
  reviewSubmitContainer: {
    paddingHorizontal: screenWidth * 0.06,
    paddingTop: 12,
    backgroundColor: '#F6F3F2',
  },
  reviewGpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  reviewGpsDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#38A169' },
  reviewGpsText: { fontSize: scale(12), color: '#38A169' },
  reviewSubmitBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  reviewSubmitBtnDisabled: {
    backgroundColor: '#E4E2E1',
    elevation: 0,
    shadowOpacity: 0,
  },
  reviewSubmitBtnText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '700' },
  reviewPrivacyNote: {
    fontSize: scale(11),
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 4,
  },

  // ── STEP 5 — CONFIRMATION (ONLINE) ─────────────────────────────────────────
  confirmContainer: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  confirmIconCircleOnline: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#27AE60',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    elevation: 8,
    shadowColor: '#27AE60',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  confirmIconCheck: { fontSize: scale(44), color: '#FFFFFF', lineHeight: scale(52) },
  confirmTitleLarge: {
    fontSize: scale(32),
    fontWeight: '900',
    color: '#1B1C1C',
    textAlign: 'center',
    marginTop: 0,
    marginBottom: 12,
  },
  confirmSubtitle: {
    fontSize: scale(16),
    color: '#414751',
    textAlign: 'center',
    maxWidth: screenWidth * 0.75,
    lineHeight: scale(16) * 1.5,
    marginBottom: 32,
  },

  confirmSummaryCard: {
    width: '100%',
    backgroundColor: '#F6F3F2',
    borderRadius: 16,
    padding: 20,
    marginBottom: 32,
  },
  confirmSummaryHeader: {
    fontSize: scale(10),
    fontWeight: '800',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 16,
  },
  confirmSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(4,104,177,0.1)',
    gap: 8,
  },
  confirmSummaryLabel: { fontSize: scale(11), color: '#717782' },
  confirmSummaryValue: { fontSize: scale(14), fontWeight: '600', color: '#1B1C1C', flex: 1, textAlign: 'right' },
  confirmSummaryFootNote: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 6,
  },
  confirmSummaryFootNoteText: {
    fontSize: scale(12),
    color: '#9CA3AF',
    fontStyle: 'italic',
    flex: 1,
  },

  confirmScreenButtons: { width: '100%', gap: 12 },
  confirmGradientBtn: {
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  confirmPrimaryBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  confirmPrimaryBtnText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '700' },
  confirmSecondaryBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  confirmSecondaryBtnText: { color: '#0468B1', fontSize: scale(16), fontWeight: '600' },
  confirmTextLink: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  confirmTextLinkText: { color: '#0468B1', fontSize: scale(14), fontWeight: '600' },

  // ── STEP 5 — CONFIRMATION (OFFLINE) ────────────────────────────────────────
  confirmIconCircleOffline: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#F5A623',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    elevation: 8,
    shadowColor: '#F5A623',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  offlineSyncCard: {
    width: '100%',
    backgroundColor: 'rgba(245,166,35,0.08)',
    borderRadius: 16,
    padding: 20,
    paddingLeft: 26,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: 'rgba(245,166,35,0.2)',
    overflow: 'hidden',
    position: 'relative',
  },
  offlineSyncAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 6,
    backgroundColor: '#F5A623',
  },
  offlineSyncHeader: {
    fontSize: scale(10),
    fontWeight: '800',
    color: '#F5A623',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  offlineSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  offlineSyncIcon: { fontSize: scale(16) },
  offlineSyncText: { fontSize: scale(13), color: '#414751' },
  offlineSyncLabel: { fontSize: scale(13), color: '#717782', flex: 1 },
  offlineSyncValue: { fontSize: scale(13), fontWeight: '600', color: '#1B1C1C', flex: 1.5, textAlign: 'right' },
  offlineSyncNote: { fontSize: scale(12), color: '#717782', fontStyle: 'italic', marginTop: 4 },

  confirmRetryBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#0468B1',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  confirmRetryBtnText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '700' },
  confirmRetryHelper: {
    fontSize: scale(11),
    color: '#717782',
    textAlign: 'center',
    marginTop: -4,
  },
  confirmDeleteText: { color: '#E53E3E', fontSize: scale(14), fontWeight: '700', textAlign: 'center' },
  confirmDeleteWarning: {
    fontSize: scale(10),
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
    marginTop: -4,
  },

  queuePlatformNote: {
    fontSize: scale(13),
    color: '#0468B1',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
    paddingHorizontal: 8,
  },

  // ── LOADING / ERROR SCREENS ─────────────────────────────────────────────────
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 20,
    backgroundColor: '#F6F3F2',
  },
  homeButton: {
    backgroundColor: '#0468B1',
    borderRadius: 28,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 300,
    paddingHorizontal: 24,
  },
  successTitle: { fontSize: scale(22), fontWeight: '700', color: '#1B1C1C', textAlign: 'center' },
  successText: { fontSize: scale(16), color: '#666', textAlign: 'center', lineHeight: 24 },
  errorText: { fontSize: scale(16), color: '#E53E3E', textAlign: 'center', lineHeight: 24 },

  // ── MODALS ─────────────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalBox: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 24,
    width: '100%',
    maxWidth: 380,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  modalTitle: { fontSize: scale(17), fontWeight: '700', color: '#1B1C1C', marginBottom: 12 },
  modalBody: { fontSize: scale(15), color: '#444', lineHeight: 22, marginBottom: 20 },
  modalButtons: { flexDirection: 'row', gap: 12 },

  optionIconView: { width: 36 },

  // Photo action sheet
  optionsOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  optionsSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  optionsHandle: {
    width: 36, height: 4, backgroundColor: '#E0E0E0', borderRadius: 2,
    alignSelf: 'center', marginBottom: 8,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, minHeight: 52 },
  optionIcon: { fontSize: scale(20), width: 36 },
  optionLabel: { fontSize: scale(16), color: '#333333' },
  optionLabelDanger: { color: '#E53E3E' },
  optionDivider: { height: 1, backgroundColor: '#F0F0F0' },
  optionCancel: { justifyContent: 'center', marginTop: 4 },
  optionLabelCancel: { fontSize: scale(16), color: '#888888', textAlign: 'center', width: '100%' },

  // Full-screen photo viewer
  viewerContainer: { flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' },
  viewerClose: { position: 'absolute', top: 48, right: 20, zIndex: 10, padding: 8, minWidth: 44, minHeight: 44 },
  viewerCloseText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '600' },
  viewerImage: { width: '100%', height: '100%' },

  // Building confirmation sheet
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  confirmSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  confirmHandle: {
    width: 36, height: 4, backgroundColor: '#E0E0E0', borderRadius: 2,
    alignSelf: 'center', marginBottom: 16,
  },
  confirmTitle: { fontSize: scale(17), fontWeight: 'bold', color: '#1B1C1C', marginBottom: 16 },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  confirmLabel: { fontSize: scale(13), color: '#888888', flex: 1 },
  confirmValue: { fontSize: scale(14), color: '#333333', flex: 2, textAlign: 'right' },
  confirmButtons: { flexDirection: 'row', gap: 12, marginTop: 20 },
  confirmCancelBtn: {
    flex: 1, height: 48, borderRadius: 24,
    borderWidth: 1.5, borderColor: '#0468B1',
    justifyContent: 'center', alignItems: 'center',
  },
  confirmCancelText: { color: '#0468B1', fontSize: scale(15), fontWeight: '600' },
  confirmConfirmBtn: {
    flex: 1, height: 48, borderRadius: 24,
    backgroundColor: '#0468B1',
    justifyContent: 'center', alignItems: 'center',
  },
  confirmConfirmText: { color: '#FFFFFF', fontSize: scale(15), fontWeight: '600' },

  // Location changed / timeout notes
  locationChangedNote: {
    backgroundColor: '#FFF8E1',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#FFB300',
  },
  locationChangedNoteText: { fontSize: scale(13), color: '#F57F17', lineHeight: 18 },
  submitTimeoutBox: {
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#FF6D00',
  },
  submitTimeoutText: { fontSize: scale(13), color: '#E65100', lineHeight: 18, marginBottom: 8 },
  submitRetryBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#0468B1',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  submitRetryBtnText: { color: '#FFFFFF', fontSize: scale(13), fontWeight: '600' },

  // Legacy — kept to prevent TypeScript errors from any remaining references
  stepTitle: { fontSize: scale(17), fontWeight: '600', color: '#1B1C1C' },
  questionProgress: { fontSize: scale(13), fontWeight: '600', color: '#0468B1', textAlign: 'center' },
  removePhotoBtn: { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  removePhotoBtnText: { color: '#fff', fontSize: scale(12) },
  photoButtons: { flexDirection: 'row', gap: 12 },
  photoOptionBtn: { flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1.5, borderColor: '#0468B1', padding: 16, alignItems: 'center', gap: 8 },
  photoOptionIcon: { fontSize: scale(28) },
  photoOptionText: { fontSize: scale(13), color: '#0468B1', fontWeight: '500' },
  photoSlotsRow: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 24, marginTop: 16, gap: 12 },
  photoSlot: { flex: 1, aspectRatio: 1, borderRadius: 12, overflow: 'hidden' },
  photoSlotEmpty: { borderWidth: 2, borderColor: '#D0D0D0', borderStyle: 'dashed', backgroundColor: '#F6F3F2', justifyContent: 'center', alignItems: 'center' },
  photoSlotFilled: { borderWidth: 0 },
  photoSlotInner: { justifyContent: 'center', alignItems: 'center', flex: 1 },
  photoSlotPlus: { fontSize: scale(28), color: '#BBBBBB', lineHeight: scale(32) },
  photoThumb: { width: '100%', height: '100%', borderRadius: 12 },
  maxPhotosNote: { textAlign: 'center', fontSize: scale(13), color: '#9CA3AF', marginTop: 12, marginHorizontal: 24 },
  photoButtonsRow: { marginTop: 12, marginHorizontal: 24, gap: 10 },
  guidelinesTitle: { fontSize: scale(13), fontWeight: '600', color: '#414751', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  guidelineRow: { flexDirection: 'row', marginBottom: 8, alignItems: 'flex-start' },
  guidelineBullet: { fontSize: scale(14), color: '#0468B1', marginRight: 8, lineHeight: scale(20) },
  guidelineText: { flex: 1, fontSize: scale(13), color: '#414751', lineHeight: scale(20) },
  radioCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#C1C7D2', marginRight: 12, justifyContent: 'center', alignItems: 'center' },
  radioCircleSelected: { borderColor: '#0468B1', backgroundColor: '#0468B1' },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' },
  radioLabel: { flex: 1, fontSize: scale(15), color: '#1B1C1C', lineHeight: scale(21) },
  radioLabelSelected: { color: '#0468B1', fontWeight: '500' },
  checkbox: { width: 22, height: 22, borderWidth: 2, borderColor: '#C1C7D2', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { borderColor: '#0468B1', backgroundColor: '#0468B1' },
  checkmark: { color: '#fff', fontSize: scale(13), fontWeight: '700' },
  checkRowText: { flex: 1, fontSize: scale(15), color: '#1B1C1C' },
  optionBtnSelected: { borderColor: '#0468B1', backgroundColor: '#E8F4FD' },
  optionText: { fontSize: scale(16), fontWeight: '600', color: '#1B1C1C' },
  typeBtn: { width: '47%', padding: 12, borderRadius: 8, borderWidth: 1.5, borderColor: '#E4E2E1', backgroundColor: '#fff', alignItems: 'center' },
  typeBtnSelected: { borderColor: '#0468B1', backgroundColor: '#E8F4FD' },
  typeBtnText: { fontSize: scale(13), fontWeight: '500', color: '#1B1C1C' },
  typeBtnTextSelected: { color: '#0468B1' },
  textarea: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#E4E2E1', padding: 12, fontSize: scale(15), minHeight: 100, textAlignVertical: 'top' },
  addPhotoBtn: { width: 100, height: 100, borderRadius: 8, borderWidth: 2, borderColor: '#C1C7D2', borderStyle: 'dashed', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', gap: 4 },
  addPhotoIcon: { fontSize: scale(32) },
  addPhotoText: { fontSize: scale(11), color: '#717782' },
  fieldLabel: { fontSize: scale(14), fontWeight: '500', color: '#717782' },
  queueSummaryLabel: { fontSize: scale(13), color: '#9CA3AF', flex: 1 },
  queueSummaryValue: { fontSize: scale(14), color: '#1B1C1C', flex: 2, textAlign: 'right' },
});
