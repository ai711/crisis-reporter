import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// B2 — Geocoding search bar (styles are embedded in the Lit web component — no CSS import needed)
// Requires VITE_MAPTILER_KEY to be set in .env for search to function
import { GeocodingControl } from "@maptiler/geocoding-control/maplibregl";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { validatePhoto } from "../utils/photoValidation";
import { compressPhoto } from "../utils/photoCompression";
import { extractExif } from "../utils/exifExtraction";
import SubmissionStepper, { type StepperStep } from "../components/SubmissionStepper";
import type { DamageLevel, QueuedPhoto, ReportSubmitRequest } from "../types";
import { addToQueue, isIndexedDBAvailable, requestSyncNotificationPermission } from "../utils/offlineQueue";
import { saveDraftPhotos, loadDraftPhotos, clearDraftPhotos } from "../utils/draftPhotoStore";
import { generateUUID } from "../utils/uuid";
import { haversineKm, milesToKm, saveCrisisMeta, loadCrisisMeta, saveFenceRadiusMeta, loadFenceRadiusMeta, getGpsFenceRadius, type FenceRadiusMeta } from "../utils/geo";
import { WEB_SESSION_ID } from "../utils/sessionId";
import { fetchAndCacheCountries, type CachedCountry } from "../utils/countryListCache";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
const MAP_STYLE = `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`;
const DRAFT_KEY = "cr_report_draft";

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as never[] };

function isMobileBrowser(): boolean {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    // L4: navigator.platform is deprecated; iPadOS 13+ reports "Macintosh" UA with touch points
    (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent))
  );
}

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
  transport_comm: "Transport & Communication Infrastructure",
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

const Q4_OPTIONS = [
  {
    category: "Natural Hazards",
    options: [
      { value: "earthquake", label: "Earthquake" },
      { value: "flood", label: "Flood" },
      { value: "tsunami", label: "Tsunami" },
      { value: "hurricane_cyclone", label: "Hurricane or Cyclone" },
      { value: "wildfire", label: "Wildfire" },
    ],
  },
  {
    category: "Technological or Industrial Hazards",
    options: [
      { value: "explosion", label: "Explosion" },
      { value: "chemical_incident", label: "Chemical Incident" },
    ],
  },
  {
    category: "Human-Made Crises",
    options: [
      { value: "conflict", label: "Conflict" },
      { value: "civil_unrest", label: "Civil Unrest" },
    ],
  },
];

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

// Maps PRESSING_NEEDS_LABELS keys to their UPPERCASE seed keys (non-trivial mappings only)
const Q8_KEY_MAP: Record<string, string> = {
  food_water:      "Q8_OPT_FOOD_WATER",
  cash:            "Q8_OPT_CASH",
  healthcare:      "Q8_OPT_HEALTHCARE",
  shelter:         "Q8_OPT_SHELTER",
  livelihoods:     "Q8_OPT_LIVELIHOODS",
  wash:            "Q8_OPT_WASH",
  basic_services:  "Q8_OPT_BASIC_SVC",
  protection:      "Q8_OPT_PROTECTION",
  local_support:   "Q8_OPT_LOCAL_SUPPORT",
  other:           "Q8_OPT_OTHER",
};

// ── Question package types ─────────────────────────────────────────────────────

interface ApiOption { option_text: string; option_value: string; }
interface ApiQuestion {
  question_text: string;
  order_index: number;
  options: ApiOption[];
  is_additional?: boolean;
  is_mandatory?: boolean;
  country_codes?: string[];
  conditional_on_q4?: string[];
  question_type?: string; // single_select | multi_select | text
}

const isMultiQuestion = (q: ApiQuestion) => q.question_type === "multi_select" || q.question_type === "multi";
interface ActivePackage {
  version: string;
  content_version?: string;
  translation_version?: string;
  questions: ApiQuestion[];
}

// ── Overpass types ─────────────────────────────────────────────────────────────

interface OverpassNode { type: "node"; id: number; lat: number; lon: number; }
interface OverpassWay { type: "way"; id: number; nodes: number[]; tags?: Record<string, string>; }
interface OverpassOther { type: "relation" | "area"; id: number; tags?: Record<string, string>; }
type OverpassElement = OverpassNode | OverpassWay | OverpassOther;
interface OverpassResponse { elements: OverpassElement[]; }

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildingsGeoJSON(data: OverpassResponse): Parameters<maplibregl.GeoJSONSource["setData"]>[0] {
  const nodes = new Map<number, [number, number]>();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const features: Array<{
    type: "Feature";
    properties: { osm_id: number; name: string; building: string };
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
  }> = [];

  for (const el of data.elements) {
    if (el.type !== "way" || !el.tags?.building) continue;
    const ring: [number, number][] = [];
    for (const nodeId of el.nodes) {
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
        osm_id: el.id,
        name: (el as OverpassWay).tags?.name || "",
        building: (el as OverpassWay).tags?.building || "yes",
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  return { type: "FeatureCollection", features } as Parameters<maplibregl.GeoJSONSource["setData"]>[0];
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

async function fetchBuildingsForMap(mapInstance: maplibregl.Map): Promise<void> {
  const bounds = mapInstance.getBounds();
  const s = bounds.getSouth().toFixed(6);
  const w = bounds.getWest().toFixed(6);
  const n = bounds.getNorth().toFixed(6);
  const e = bounds.getEast().toFixed(6);
  const query = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];(way["building"];relation["building"]["type"="multipolygon"];);out body;>;out skel qt;`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return;
    const data: OverpassResponse = await res.json();
    (mapInstance.getSource("buildings") as maplibregl.GeoJSONSource | undefined)?.setData(
      buildingsGeoJSON(data)
    );
  } catch { clearTimeout(timeoutId); /* silent — buildings are non-critical */ }
}

function getStepperStep(
  step: "photos" | "location" | "damage" | "review",
  submitting: boolean
): StepperStep {
  if (submitting) return "submit";
  switch (step) {
    case "photos": return "photo";
    case "location": return "location";
    case "damage": return "questions";
    case "review": return "review";
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reporterId, countryCode, languageCode } = useAuthStore();

  const q4CategoryLabels: Record<string, string> = {
    "Natural Hazards": t('report.q4_category_natural'),
    "Technological or Industrial Hazards": t('report.q4_category_tech'),
    "Human-Made Crises": t('report.q4_category_human'),
  };
  const isMobile = isMobileBrowser() || window.innerWidth <= 768;

  // Captured once at component mount — the moment the reporter tapped "Report an Incident"
  const [submissionStartTime] = useState<string>(() => new Date().toISOString());

  // Form state
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
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [viewingPhotoUrl, setViewingPhotoUrl] = useState<string | null>(null);

  // Photo UI state
  const [photoError, setPhotoError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [dropExtraMessage, setDropExtraMessage] = useState("");
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<File | null>(null);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);

  // Location state — GPS (actual device coordinates, never overwritten by building centroid)
  const [gpsLatitude, setGpsLatitude] = useState<number | null>(null);
  const [gpsLongitude, setGpsLongitude] = useState<number | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [gpsDenied, setGpsDenied] = useState(false);

  // Location state — building selection (G5: centroid kept separate from device GPS)
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [selectedBuildingName, setSelectedBuildingName] = useState("");
  const [buildingNameOsm, setBuildingNameOsm] = useState(""); // immutable OSM name captured at confirm
  const [selectedBuildingType, setSelectedBuildingType] = useState("");
  const [buildingCentroidLat, setBuildingCentroidLat] = useState<number | null>(null);
  const [buildingCentroidLng, setBuildingCentroidLng] = useState<number | null>(null);

  // Location state — confirmation popup (B3)
  const [pendingBuilding, setPendingBuilding] = useState<{
    id: string;
    name: string;
    type: string;
    lat: number;
    lng: number;
  } | null>(null);

  // Location state — pin drop (B6)
  const [pinDropCoords, setPinDropCoords] = useState<{ lat: number; lng: number } | null>(null);

  // Location state — manual text entry
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");
  const [locationBuildingName, setLocationBuildingName] = useState("");
  const [manualExpanded, setManualExpanded] = useState(false);

  // Location state — optional note (B7)
  const [locationNote, setLocationNote] = useState("");

  // Location state — inline duplicate warning (B10)
  const [showDuplicateInlineWarning, setShowDuplicateInlineWarning] = useState(false);
  // Location state — geo-fence warning
  const [crisisCenterLat, setCrisisCenterLat] = useState<number | null>(null);
  const [crisisCenterLng, setCrisisCenterLng] = useState<number | null>(null);
  const [crisisRadiusMiles, setCrisisRadiusMiles] = useState<number>(50);
  const [showOutsideAreaWarning, setShowOutsideAreaWarning] = useState(false);
  // Logic 1 — country derived from selected location coordinates
  const [reportLocationCountry, setReportLocationCountry] = useState<string | null>(null);
  // GPS geo-fence — hard block when selection > configured radius from reporter GPS
  const [gpsGeofenceBlocked, setGpsGeofenceBlocked] = useState(false);
  const [fenceRadiusMeta, setFenceRadiusMeta] = useState<FenceRadiusMeta | null>(() => loadFenceRadiusMeta());
  // Logic 2 — country picker for offline + no GPS
  const [offlineReportCountry, setOfflineReportCountry] = useState<string | null>(null);
  const [offlineCountries, setOfflineCountries] = useState<CachedCountry[]>([]);
  const [showCountryModal, setShowCountryModal] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");

  // Location state — metadata flags (G7/G9/G11)
  const [locationEntryMethod, setLocationEntryMethod] = useState<
    "map_selection" | "pin_drop" | "manual_text" | null
  >(null);
  const [locationInternetAvailable, setLocationInternetAvailable] = useState<boolean>(
    navigator.onLine
  );
  // D1/F2 — true when offline on arrival; stays true for the rest of the step
  const [locationOffline, setLocationOffline] = useState(false);
  // F2/F3 — true only when connection drops after the map was already loaded
  const [connectionLostMidSession, setConnectionLostMidSession] = useState(false);
  // C5 — explicit GPS availability flag (null = not yet determined)
  const [gpsAvailable, setGpsAvailable] = useState<boolean | null>(null);

  // Map state
  const [locationMapZoom, setLocationMapZoom] = useState(2);
  const [buildingsLoading, setBuildingsLoading] = useState(false);

  // Camera state
  const [cameraDenied, setCameraDenied] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // UI state
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [preparingPhotos, setPreparingPhotos] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [wasQueued, setWasQueued] = useState(false);
  const [, setSubmittedReportId] = useState<string | null>(null);
  const [showDupeWarning, setShowDupeWarning] = useState(false);
  const [error, setError] = useState("");
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [, setCrisisError] = useState(false);
  const [questionPackage, setQuestionPackage] = useState<ActivePackage | null>(null);
  const [showAnswerPrompt, setShowAnswerPrompt] = useState(false);
  const [editingFromReview, setEditingFromReview] = useState(false);
  const [additionalAnswers, setAdditionalAnswers] = useState<Record<number, string | string[]>>({});

  // F38 — local temp report ID generated at mount; refreshed on each new submission
  const [localReportId, setLocalReportId] = useState<string>(
    () => `CR-WEB-TMP-${generateUUID()}`
  );

  // Building footprint source — fetched once from public settings, cached for session
  const [footprintSource, setFootprintSource] = useState<string>("osm");

  // C22 — submission timestamp captured at exact tap moment, stored in state so modal can reuse it
  const [submissionSubmittedAt, setSubmissionSubmittedAt] = useState<string>("");

  // A5/A6/A7 — review step photo interactions
  const [reviewPhotoIndex, setReviewPhotoIndex] = useState<number | null>(null);
  const [reviewPhotoError, setReviewPhotoError] = useState<string>("");

  // B21 — cascading Q3 flag when location/building changes during review edit
  const [locationChangedFlag, setLocationChangedFlag] = useState(false);
  const [prevBuildingId, setPrevBuildingId] = useState<string>("");

  // E32/E34/E35 — submit error type (no offline queue on web)
  const [submitError, setSubmitError] = useState<"no_internet" | "timeout" | "server_error" | null>(null);

  // Draft restore banner state
  const [draftPrompt, setDraftPrompt] = useState<"idle" | "showing" | "dismissed">("idle");
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M2: pagehide (iOS Safari) draft-save — holds a closure over the latest state
  const saveDraftNowRef = useRef<() => void>(() => {});

  // Refs
  const isSubmittedRef = useRef(false);
  // Synchronous mutex — prevents double-tap submitting two reports before React state updates
  const isSubmitInFlightRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpsMarkerRef = useRef<maplibregl.Marker | null>(null); // B9
  const pinMarkerRef = useRef<maplibregl.Marker | null>(null); // B6
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const submitErrorRef = useRef<HTMLDivElement>(null);

  // Scroll content to top whenever the review step becomes active.
  // requestAnimationFrame defers until after React finishes painting the new step,
  // ensuring the scrollable div has its final content height before we reset scroll.
  useEffect(() => {
    if (step === "review") {
      requestAnimationFrame(() => {
        contentScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
  }, [step]);

  // Scroll the error banner into view whenever a submit error appears.
  useEffect(() => {
    if (!submitError) return;
    requestAnimationFrame(() => {
      submitErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [submitError]);

  // Manage blob URLs for photo previews — create once per photos change, revoke on cleanup
  useEffect(() => {
    const urls = photos.map((f) => URL.createObjectURL(f));
    setPhotoUrls(urls);
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [photos]);

  // Manage blob URL for the full-screen photo viewer
  useEffect(() => {
    if (!viewingPhoto) { setViewingPhotoUrl(null); return; }
    const url = URL.createObjectURL(viewingPhoto);
    setViewingPhotoUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [viewingPhoto]);

  useEffect(() => {
    const init = async () => {
      const cached = loadCrisisMeta();
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
          saveCrisisMeta({
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
      try {
        const fenceRes = await api.get("/api/settings/fence-radius");
        const meta: FenceRadiusMeta = { ...fenceRes.data, cached_at: new Date().toISOString() };
        saveFenceRadiusMeta(meta);
        setFenceRadiusMeta(meta);
      } catch { /* silent — cached value or 50 mi fallback remains active */ }
      setCrisisLoading(false);
    };
    init();
  }, []);

  // Geo-fence: warn reporter if selected location is outside the crisis radius (soft warning)
  useEffect(() => {
    const lat = buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude;
    const lng = buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude;
    if (!lat || !lng || !crisisCenterLat || !crisisCenterLng) {
      setShowOutsideAreaWarning(false);
      return;
    }
    setShowOutsideAreaWarning(
      haversineKm(lat, lng, crisisCenterLat, crisisCenterLng) > milesToKm(crisisRadiusMiles)
    );
  }, [buildingCentroidLat, buildingCentroidLng, pinDropCoords, gpsLatitude, gpsLongitude, crisisCenterLat, crisisCenterLng, crisisRadiusMiles]);

  // GPS geo-fence: hard block when selected location > dashboard-configured radius from reporter's GPS
  useEffect(() => {
    if (gpsLatitude === null || gpsLongitude === null) { setGpsGeofenceBlocked(false); return; }
    const selLat = buildingCentroidLat ?? pinDropCoords?.lat ?? null;
    const selLng = buildingCentroidLng ?? pinDropCoords?.lng ?? null;
    if (selLat === null || selLng === null) { setGpsGeofenceBlocked(false); return; }
    const radius = getGpsFenceRadius(countryCode || localStorage.getItem("cr_country"), fenceRadiusMeta);
    setGpsGeofenceBlocked(haversineKm(selLat, selLng, gpsLatitude, gpsLongitude) > milesToKm(radius));
  }, [buildingCentroidLat, buildingCentroidLng, pinDropCoords, gpsLatitude, gpsLongitude, fenceRadiusMeta, countryCode]);

  // Logic 1: silent reverse geocode when building, pin, or GPS coords are confirmed
  const reverseGeocodeCountry = async (lat: number, lng: number): Promise<void> => {
    if (!MAPTILER_KEY) return;
    try {
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(
        `https://api.maptiler.com/geocoding/${lng.toFixed(6)},${lat.toFixed(6)}.json?key=${MAPTILER_KEY}&types=country`,
        { signal: ctrl.signal }
      );
      window.clearTimeout(tid);
      if (!r.ok) return;
      const data = await r.json() as { features?: Array<{ id?: string; properties?: { short_code?: string } }> };
      const feature = data?.features?.[0];
      const fromId = feature?.id?.split?.('.')?.[1]?.toUpperCase();
      const fromShort = feature?.properties?.short_code?.toUpperCase();
      const code = fromId || fromShort;
      if (code && /^[A-Z]{2}$/.test(code)) setReportLocationCountry(code);
    } catch { /* silent — onboarding country is the fallback */ }
  };

  useEffect(() => {
    if (buildingCentroidLat !== null && buildingCentroidLng !== null) {
      void reverseGeocodeCountry(buildingCentroidLat, buildingCentroidLng);
    }
  }, [buildingCentroidLat, buildingCentroidLng]);

  useEffect(() => {
    if (pinDropCoords) void reverseGeocodeCountry(pinDropCoords.lat, pinDropCoords.lng);
  }, [pinDropCoords]);

  // GPS-only: geocode when GPS acquired but no building/pin yet
  useEffect(() => {
    if (gpsLatitude !== null && gpsLongitude !== null && buildingCentroidLat === null && !pinDropCoords) {
      void reverseGeocodeCountry(gpsLatitude, gpsLongitude);
    }
  }, [gpsLatitude, gpsLongitude]); // eslint-disable-line react-hooks/exhaustive-deps

  // Logic 2: load country list and pre-fill when offline + no GPS
  useEffect(() => {
    if (!locationOffline || gpsLatitude !== null) return;
    fetchAndCacheCountries().then(({ data }) => {
      if (data) setOfflineCountries(data.filter(c => c.is_active !== false));
    });
    setOfflineReportCountry(countryCode || localStorage.getItem("cr_country") || null);
  }, [locationOffline, gpsLatitude]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load question package from localStorage first; fall back to network on first visit.
  // Cache key includes the language code so a language switch always fetches a fresh package.
  useEffect(() => {
    if (step !== "damage") return;
    const loadPackage = async () => {
      const langCode = languageCode || localStorage.getItem("cr_language") || "en";
      const pkgCacheKey = `cr_question_package_${langCode}`;
      try {
        const cached = localStorage.getItem(pkgCacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as ActivePackage;
          setQuestionPackage(parsed);
          return;
        }
      } catch { /* corrupted cache — fall through to network */ }
      try {
        const res = await api.get<ActivePackage>("/api/question-packages/active", {
          params: { lang: langCode },
        });
        setQuestionPackage(res.data);
        try {
          localStorage.setItem(pkgCacheKey, JSON.stringify(res.data));
        } catch { /* localStorage full — silent */ }
      } catch {
        // silent — bundled hardcoded questions remain as fallback
      }
    };
    loadPackage();
  }, [step, languageCode]);

  // Pre-fill Q3 infrastructure name with OSM building name captured at location step
  useEffect(() => {
    if (step === "damage" && buildingNameOsm && !infrastructureName) {
      setInfrastructureName(buildingNameOsm);
    }
  }, [step, buildingNameOsm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map initialisation — runs whenever location step becomes active
  useEffect(() => {
    // D1 — do not create a map instance when the reporter arrived offline
    if (step !== "location" || (locationOffline && !connectionLostMidSession) || !mapContainerRef.current || mapRef.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAPTILER_KEY ? MAP_STYLE : OSM_STYLE,
      center: [20, 10],
      zoom: 2,
    });
    mapRef.current = mapInstance;

    mapInstance.addControl(new maplibregl.NavigationControl(), "top-right");

    // B2 — Geocoding search bar via Maptiler control (requires VITE_MAPTILER_KEY)
    if (MAPTILER_KEY) {
      const gc = new GeocodingControl({
        apiKey: MAPTILER_KEY,
        language: languageCode || "en",
        country: countryCode || undefined,
        flyTo: true,
      });
      mapInstance.addControl(gc, "top-left");
    }

    mapInstance.on("load", () => {
      // B9/C3 — Centre on GPS if already captured, otherwise fit to reporter's country
      if (gpsLatitude !== null && gpsLongitude !== null) {
        mapInstance.flyTo({ center: [gpsLongitude, gpsLatitude], zoom: 16 });
        // Re-add blue dot for GPS already captured before this map mount
        if (gpsMarkerRef.current) gpsMarkerRef.current.remove();
        const el = document.createElement("div");
        el.style.cssText =
          "width:16px;height:16px;background:#0468B1;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(4,104,177,0.2);";
        gpsMarkerRef.current = new maplibregl.Marker({ element: el })
          .setLngLat([gpsLongitude, gpsLatitude])
          .addTo(mapInstance);
      } else {
        // C3 — Fit to reporter's country bounding box; silent fallback to world view
        const cc = countryCode || localStorage.getItem("cr_country") || "";
        if (cc && MAPTILER_KEY) {
          // M1: AbortSignal.timeout() not available on iOS < 16 — use AbortController
          const bboxCtrl = new AbortController();
          const bboxTid = window.setTimeout(() => bboxCtrl.abort(), 5000);
          fetch(
            `https://api.maptiler.com/geocoding/${encodeURIComponent(cc)}.json?key=${MAPTILER_KEY}&types=country`,
            { signal: bboxCtrl.signal }
          )
            .then((r) => { window.clearTimeout(bboxTid); return r.ok ? r.json() : null; })
            .then((data: { features?: Array<{ bbox?: number[]; center?: [number, number] }> } | null) => {
              const feature = data?.features?.[0];
              if (!feature) return;
              // If GPS was acquired while this request was in-flight, don't override it
              if (gpsMarkerRef.current) return;
              const bbox = feature.bbox;
              if (bbox && bbox.length === 4) {
                mapInstance.fitBounds(
                  [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
                  { padding: 40, duration: 800, maxZoom: 10 }
                );
              } else if (feature.center) {
                mapInstance.flyTo({ center: feature.center, zoom: 6, duration: 800 });
              }
            })
            .catch(() => { window.clearTimeout(bboxTid); /* silent — map stays at world view */ });
        }
      }

      mapInstance.addSource("buildings", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });
      mapInstance.addSource("selected-building", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });

      mapInstance.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        paint: { "fill-color": "#CBD5E0", "fill-opacity": 0.5 },
      });
      mapInstance.addLayer({
        id: "buildings-outline",
        type: "line",
        source: "buildings",
        paint: { "line-color": "#718096", "line-width": 0.6 },
      });
      mapInstance.addLayer({
        id: "selected-building-fill",
        type: "fill",
        source: "selected-building",
        paint: { "fill-color": "#0468B1", "fill-opacity": 0.7 },
      });
      mapInstance.addLayer({
        id: "selected-building-outline",
        type: "line",
        source: "selected-building",
        paint: { "line-color": "#0468B1", "line-width": 2 },
      });

      // B3 — Building tap: set pending (shows confirmation popup), do NOT commit yet
      mapInstance.on("click", "buildings-fill", (e) => {
        if (!e.features?.length) return;
        const f = e.features[0];
        const props = f.properties as { osm_id: number; name: string; building: string };
        const geom = f.geometry as { type: "Polygon"; coordinates: number[][][] };
        const [centLng, centLat] = computeCentroid(geom.coordinates[0]);

        // Highlight on map immediately as visual feedback
        (mapInstance.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: props, geometry: geom }],
        } as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);

        setShowDuplicateInlineWarning(false);
        setPendingBuilding({
          id: String(props.osm_id),
          name: props.name || "",
          type: props.building || "yes",
          lat: centLat,
          lng: centLng,
        });
      });

      // B6 — Click on blank area: drop a draggable pin
      mapInstance.on("click", (e) => {
        const features = mapInstance.queryRenderedFeatures(e.point, { layers: ["buildings-fill"] });
        if (features && features.length > 0) return; // building click handled above

        if (pinMarkerRef.current) pinMarkerRef.current.remove();

        const marker = new maplibregl.Marker({ draggable: true, color: "#0468B1" })
          .setLngLat([e.lngLat.lng, e.lngLat.lat])
          .addTo(mapInstance);

        pinMarkerRef.current = marker;

        const coords = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        setPinDropCoords(coords);
        setLocationEntryMethod("pin_drop");

        marker.on("dragend", () => {
          const lngLat = marker.getLngLat();
          setPinDropCoords({ lat: lngLat.lat, lng: lngLat.lng });
        });

        // Clear any building selection
        setSelectedBuildingId(null);
        setBuildingCentroidLat(null);
        setBuildingCentroidLng(null);
        setBuildingNameOsm("");
        setSelectedBuildingName("");
        setSelectedBuildingType("");
        setPendingBuilding(null);
        setShowDuplicateInlineWarning(false);
        (mapInstance.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)
          ?.setData(EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
      });

      mapInstance.on("mouseenter", "buildings-fill", () => {
        mapInstance.getCanvas().style.cursor = "pointer";
      });
      mapInstance.on("mouseleave", "buildings-fill", () => {
        mapInstance.getCanvas().style.cursor = "";
      });

      mapInstance.on("moveend", () => {
        const zoom = mapInstance.getZoom();
        setLocationMapZoom(zoom);
        if (zoom >= 14) {
          if (debounceTimer.current) clearTimeout(debounceTimer.current);
          debounceTimer.current = setTimeout(() => {
            setBuildingsLoading(true);
            fetchBuildingsForMap(mapInstance).finally(() => setBuildingsLoading(false));
          }, 1000);
        }
      });

      const initialZoom = mapInstance.getZoom();
      setLocationMapZoom(initialZoom);
      if (initialZoom >= 14) {
        setBuildingsLoading(true);
        fetchBuildingsForMap(mapInstance).finally(() => setBuildingsLoading(false));
      }
    });

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      gpsMarkerRef.current?.remove();
      pinMarkerRef.current?.remove();
      mapInstance.remove();
      mapRef.current = null;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGeolocationDenied = () => {
    setGpsCapturing(false);
    setGpsDenied(true);
    setGpsAvailable(false);
    setManualExpanded(true);
  };

  const triggerGeolocation = async () => {
    if (!navigator.geolocation) {
      handleGeolocationDenied();
      return;
    }
    let permState: PermissionState = "prompt";
    try {
      const result = await navigator.permissions.query({ name: "geolocation" });
      permState = result.state;
    } catch { /* Firefox / Safari */ }
    if (permState === "denied") {
      handleGeolocationDenied();
      return;
    }
    setGpsCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setGpsLatitude(lat);
        setGpsLongitude(lng);
        setGpsAccuracy(pos.coords.accuracy);
        setGpsDenied(false);
        setGpsAvailable(true);

        // GPS button clears building/pin selection — reporter is re-anchoring to their device position
        setSelectedBuildingId(null);
        setBuildingCentroidLat(null);
        setBuildingCentroidLng(null);
        setBuildingNameOsm("");
        setSelectedBuildingName("");
        setSelectedBuildingType("");
        setPendingBuilding(null);
        setPinDropCoords(null);
        setShowDuplicateInlineWarning(false);
        setLocationEntryMethod(null);

        if (pinMarkerRef.current) {
          pinMarkerRef.current.remove();
          pinMarkerRef.current = null;
        }

        (mapRef.current?.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)
          ?.setData(EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 16 });

        // B9 — Blue GPS dot marker
        if (mapRef.current) {
          if (gpsMarkerRef.current) gpsMarkerRef.current.remove();
          const el = document.createElement("div");
          el.style.cssText =
            "width:16px;height:16px;background:#0468B1;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(4,104,177,0.2);";
          gpsMarkerRef.current = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .addTo(mapRef.current);
        }

        setGpsCapturing(false);
      },
      handleGeolocationDenied,
      { timeout: 10000, enableHighAccuracy: true }
    );
  };

  // B3 — Confirm building selection from popup
  const handleBuildingConfirm = () => {
    if (!pendingBuilding) return;
    setSelectedBuildingId(pendingBuilding.id);
    setBuildingCentroidLat(pendingBuilding.lat);
    setBuildingCentroidLng(pendingBuilding.lng);
    setBuildingNameOsm(pendingBuilding.name); // immutable OSM name
    setSelectedBuildingName(pendingBuilding.name); // pre-fills editable field
    setSelectedBuildingType(pendingBuilding.type);
    setLocationEntryMethod("map_selection");

    // Clear pin drop if one was placed
    setPinDropCoords(null);
    if (pinMarkerRef.current) {
      pinMarkerRef.current.remove();
      pinMarkerRef.current = null;
    }

    setPendingBuilding(null);
    setShowDuplicateInlineWarning(false);
    checkDuplicateOnSelection(pendingBuilding.lat, pendingBuilding.lng, pendingBuilding.id);
  };

  // B3 — Cancel building selection from popup
  const handleBuildingCancel = () => {
    setPendingBuilding(null);
    setShowDuplicateInlineWarning(false);
    // Restore previous confirmed selection highlight (or clear if none)
    if (!selectedBuildingId) {
      (mapRef.current?.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)
        ?.setData(EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
    }
  };

  // B10 — Inline duplicate check on building selection (non-blocking)
  const checkDuplicateOnSelection = (lat: number, lng: number, buildingId: string) => {
    try {
      const raw = localStorage.getItem("cr_submitted_locations");
      if (!raw || !crisisId) return;
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number; building_id?: string }> =
        JSON.parse(raw);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const isDupe = locs.some(
        (l) =>
          l.crisis_id === crisisId &&
          (l.building_id === buildingId ||
            (Math.abs(l.lat - lat) < 0.001 && Math.abs(l.lng - lng) < 0.001)) &&
          l.timestamp > cutoff
      );
      if (isDupe) setShowDuplicateInlineWarning(true);
    } catch { /* non-critical */ }
  };

  const checkCameraPermission = async (): Promise<"granted" | "denied" | "prompt"> => {
    try {
      const result = await navigator.permissions.query({ name: "camera" as PermissionName });
      return result.state;
    } catch {
      return "prompt";
    }
  };

  const handleTakePhoto = async () => {
    if (cameraDenied) return;
    const permState = await checkCameraPermission();
    if (permState === "denied") {
      setCameraDenied(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      setCameraStream(stream);
      setCameraActive(true);
      setCameraDenied(false);
    } catch {
      setCameraDenied(true);
    }
  };

  const handleCapturePhoto = () => {
    if (!videoRef.current || !canvasRef.current || !cameraStream) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" });
          void validateAndAddPhoto(file);
        }
        cameraStream.getTracks().forEach((t) => t.stop());
        setCameraStream(null);
        setCameraActive(false);
      },
      "image/jpeg",
      0.9
    );
  };

  const handleCameraCancel = () => {
    cameraStream?.getTracks().forEach((t) => t.stop());
    setCameraStream(null);
    setCameraActive(false);
  };

  // A1/G9 — Record internet state on step arrival; gate offline scenario; auto-trigger GPS
  useEffect(() => {
    if (step !== "location") return;
    const online = navigator.onLine;
    setLocationInternetAvailable(online);
    if (!online) {
      // Offline on arrival — suppress map, show amber banner, auto-expand manual fields
      setLocationOffline(true);
      setManualExpanded(true);
    }
    if (gpsLatitude === null) {
      void triggerGeolocation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // F2/F3 — Detect mid-session connection drops while on the location step
  useEffect(() => {
    if (step !== "location") return;
    const handleOffline = () => {
      setLocationOffline(true);
      setManualExpanded(true);
      setConnectionLostMidSession(true);
    };
    const handleOnline = () => {
      // Do not re-show map — reporter may have already entered manual data.
      // Just clear the "connection lost" inline message.
      setConnectionLostMidSession(false);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [step]);

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach((t) => t.stop());
    };
  }, [cameraStream]);

  useEffect(() => {
    if (cameraActive && videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraActive, cameraStream]);

  // M2: Keep saveDraftNowRef.current pointing at a fresh closure over the latest state.
  // pagehide (fired by iOS Safari on navigation away) calls this for an immediate save.
  useEffect(() => {
    saveDraftNowRef.current = () => {
      if (isSubmittedRef.current) return;
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          savedAt: new Date().toISOString(),
          step, damageQuestion, damageLevel,
          infrastructureTypes, infrastructureOther, infrastructureName,
          disasterType, debrisBlocking, electricityCondition,
          healthServicesCondition, pressingNeeds, pressingNeedsOther,
          additionalAnswers,
          locationAddress, locationLandmark, locationBuildingName, locationNote,
          gpsLatitude, gpsLongitude,
          selectedBuildingId, selectedBuildingName,
          buildingCentroidLat, buildingCentroidLng,
          pinDropCoords, locationEntryMethod,
        }));
      } catch { /* localStorage full or unavailable */ }
      if (photos.length > 0) void saveDraftPhotos(photos);
    };
  }); // no deps — runs every render so the closure is always fresh

  // beforeunload fires on browser back, tab close, URL change, and external link clicks.
  // pagehide is the iOS Safari equivalent — beforeunload is unreliable there.
  // Neither fires on React router navigate() calls — those are client-side.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isSubmittedRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // Required for Chrome — triggers the browser's generic prompt
    };
    // M2: pagehide fires reliably on iOS Safari; save draft immediately from the ref
    const handlePageHide = () => { saveDraftNowRef.current(); };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  // ── Draft auto-save ──────────────────────────────────────────────────────────

  // On mount: clear any existing draft — restore feature is temporarily hidden.
  useEffect(() => {
    try {
      localStorage.removeItem(DRAFT_KEY);
      void clearDraftPhotos();
    } catch { /* ignore */ }
  }, []);

  // Save immediately whenever the user advances a step or damage sub-question.
  useEffect(() => {
    if (isSubmittedRef.current || draftPrompt === "showing") return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        step, damageQuestion, damageLevel,
        infrastructureTypes, infrastructureOther, infrastructureName,
        disasterType, debrisBlocking, electricityCondition,
        healthServicesCondition, pressingNeeds, pressingNeedsOther,
        additionalAnswers,
        locationAddress, locationLandmark, locationBuildingName, locationNote,
        gpsLatitude, gpsLongitude,
        selectedBuildingId, selectedBuildingName,
        buildingCentroidLat, buildingCentroidLng,
        pinDropCoords, locationEntryMethod,
      }));
    } catch { /* localStorage full or unavailable */ }
    if (photos.length > 0) void saveDraftPhotos(photos);
  }, [step, damageQuestion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced save (1.2 s) triggered by changes to text / selection fields within a step.
  useEffect(() => {
    if (isSubmittedRef.current || draftPrompt === "showing") return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          savedAt: new Date().toISOString(),
          step, damageQuestion, damageLevel,
          infrastructureTypes, infrastructureOther, infrastructureName,
          disasterType, debrisBlocking, electricityCondition,
          healthServicesCondition, pressingNeeds, pressingNeedsOther,
          additionalAnswers,
          locationAddress, locationLandmark, locationBuildingName, locationNote,
          gpsLatitude, gpsLongitude,
          selectedBuildingId, selectedBuildingName,
          buildingCentroidLat, buildingCentroidLng,
          pinDropCoords, locationEntryMethod,
        }));
      } catch { /* ignore */ }
    }, 1200);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [ // eslint-disable-line react-hooks/exhaustive-deps
    damageLevel, infrastructureTypes, infrastructureOther, infrastructureName,
    disasterType, debrisBlocking, electricityCondition,
    healthServicesCondition, pressingNeeds, pressingNeedsOther,
    additionalAnswers,
    locationAddress, locationLandmark, locationBuildingName, locationNote,
    gpsLatitude, gpsLongitude, selectedBuildingId, selectedBuildingName,
    buildingCentroidLat, buildingCentroidLng, pinDropCoords, locationEntryMethod,
  ]);

  // Save photo blobs to IndexedDB whenever photos change so draft restore has them.
  useEffect(() => {
    if (isSubmittedRef.current || draftPrompt === "showing") return;
    void saveDraftPhotos(photos);
  }, [photos]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Photo validation wiring ──────────────────────────────────────────────────

  const validateAndAddPhoto = async (file: File) => {
    const result = await validatePhoto(file, photos);
    if (result.ok) {
      setPhotos((prev) => [...prev, result.file].slice(0, 3));
      setPhotoError("");
    } else {
      setPhotoError(result.reason);
    }
  };

  const validateAndReplacePhoto = async (file: File, index: number) => {
    const othersExcludingSlot = photos.filter((_, i) => i !== index);
    const result = await validatePhoto(file, othersExcludingSlot);
    if (result.ok) {
      setPhotos((prev) => {
        const next = [...prev];
        next[index] = result.file;
        return next;
      });
      setPhotoError("");
    } else {
      setPhotoError(result.reason);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - photos.length;
    const toProcess = files.slice(0, remaining);
    if (files.length > remaining) {
      setDropExtraMessage(
        `Only ${remaining} photo${remaining !== 1 ? "s" : ""} accepted — extras were not added.`
      );
      setTimeout(() => setDropExtraMessage(""), 4000);
    }
    toProcess.forEach((f) => void validateAndAddPhoto(f));
    e.target.value = "";
  };

  const handleReplaceInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && replaceIndex !== null) {
      void validateAndReplacePhoto(file, replaceIndex);
    }
    setReplaceIndex(null);
    setSelectedPhotoIndex(null);
    setReviewPhotoIndex(null);
    e.target.value = "";
  };

  const handlePhotoRemove = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    setSelectedPhotoIndex(null);
    setPhotoError("");
  };

  // ── Drag-and-drop handlers (desktop only) ────────────────────────────────────

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    const remainingSlots = 3 - photos.length;
    const filesToProcess = droppedFiles.slice(0, remainingSlots);
    if (droppedFiles.length > remainingSlots) {
      setDropExtraMessage(
        `Only ${remainingSlots} photo${remainingSlots !== 1 ? "s" : ""} accepted — extras were not added.`
      );
      setTimeout(() => setDropExtraMessage(""), 4000);
    }
    filesToProcess.forEach((file) => void validateAndAddPhoto(file));
  };

  // ── Question helpers ──────────────────────────────────────────────────────────
  //
  // Resolution order for question text / option labels:
  //  1. Language package (i18n) via key "Q{n}_LABEL" / "Q{n}_OPT_{VALUE}" — loaded
  //     when the reporter's selected language is non-English.  These keys are published
  //     by the backend's language-package system when translators approve them.
  //  2. Question package API text (question_text / option_text from the backend).
  //     This is English by default.
  //  3. Hardcoded English fallback string passed at the call-site.

  const qTitle = (n: number, fallback: string): string => {
    // Try language package first (key: Q1_LABEL, Q2_LABEL, …)
    const langKey = `Q${n}_LABEL`;
    const langVal = t(langKey, { defaultValue: "" });
    if (langVal) return langVal;
    // Fall back to question package text (English) or hardcoded fallback
    const found = questionPackage?.questions.find((q) => q.order_index === n);
    return found ? found.question_text : fallback;
  };

  const qOptions = (
    n: number,
    fallback: Array<{ value: string; label: string }>
  ): Array<{ value: string; label: string }> => {
    const found = questionPackage?.questions.find((q) => q.order_index === n);
    const source = found?.options?.length
      ? found.options.map((o) => ({ value: o.option_value, label: o.option_text }))
      : fallback;
    // Overlay language-package translation for each option (key: Q1_OPT_MINIMAL, …)
    return source.map((o) => {
      const langKey = `Q${n}_OPT_${o.value.toUpperCase()}`;
      const langVal = t(langKey, { defaultValue: "" });
      return { value: o.value, label: langVal || o.label };
    });
  };

  // ── Duplicate / submit helpers ────────────────────────────────────────────────

  // D26/D27 — backend query for logged-in; sessionStorage for anonymous (current session only)
  const checkDuplicate = async (): Promise<boolean> => {
    const lat = buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude;
    const lng = buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude;
    if (!lat || !lng || !crisisId) return false;

    if (reporterId) {
      // Logged-in reporter: query backend
      try {
        const res = await api.get<{ is_duplicate?: boolean }>("/api/reports/duplicate-check", {
          params: { lat, lng, building_id: selectedBuildingId, crisis_id: crisisId },
        });
        return !!res.data.is_duplicate;
      } catch {
        return false; // silent — proceed on error
      }
    } else {
      // Anonymous: check sessionStorage for current session only
      try {
        const sessionReports: Array<{
          building_id: string | null;
          lat: number | null;
          lng: number | null;
        }> = JSON.parse(sessionStorage.getItem("cr_session_reports") || "[]");
        return sessionReports.some(
          (r) =>
            (selectedBuildingId && r.building_id === selectedBuildingId) ||
            (r.lat !== null && Math.abs(r.lat - lat) < 0.0001 &&
             r.lng !== null && Math.abs(r.lng - lng) < 0.0001)
        );
      } catch {
        return false;
      }
    }
  };

  const saveSubmittedLocation = () => {
    const lat = buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude;
    const lng = buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude;
    if (!lat || !lng || !crisisId) return;
    try {
      const raw = localStorage.getItem("cr_submitted_locations");
      const locs: Array<{
        lat: number;
        lng: number;
        crisis_id: string;
        timestamp: number;
        building_id?: string;
      }> = raw ? JSON.parse(raw) : [];
      locs.push({
        lat,
        lng,
        crisis_id: crisisId,
        timestamp: Date.now(),
        ...(selectedBuildingId ? { building_id: selectedBuildingId } : {}),
      });
      localStorage.setItem("cr_submitted_locations", JSON.stringify(locs.slice(-200)));
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
    setPhotoError("");
    setIsDragging(false);
    setDropExtraMessage("");
    setSelectedPhotoIndex(null);
    setViewingPhoto(null);
    setReplaceIndex(null);
    setGpsLatitude(null);
    setGpsLongitude(null);
    setGpsAccuracy(null);
    setGpsDenied(false);
    setCameraDenied(false);
    setSelectedBuildingId(null);
    setSelectedBuildingName("");
    setBuildingNameOsm("");
    setSelectedBuildingType("");
    setBuildingCentroidLat(null);
    setBuildingCentroidLng(null);
    setPendingBuilding(null);
    setPinDropCoords(null);
    if (pinMarkerRef.current) { pinMarkerRef.current.remove(); pinMarkerRef.current = null; }
    if (gpsMarkerRef.current) { gpsMarkerRef.current.remove(); gpsMarkerRef.current = null; }
    setLocationAddress("");
    setLocationLandmark("");
    setLocationBuildingName("");
    setLocationNote("");
    setShowDuplicateInlineWarning(false);
    setLocationEntryMethod(null);
    setLocationInternetAvailable(navigator.onLine);
    setLocationOffline(false);
    setConnectionLostMidSession(false);
    setGpsAvailable(null);
    setManualExpanded(false);
    setSubmitted(false);
    setWasQueued(false);
    setSubmittedReportId(null);
    setError("");
    setShowAnswerPrompt(false);
    setEditingFromReview(false);
    setAdditionalAnswers({});
    setLocalReportId(`CR-WEB-TMP-${generateUUID()}`);
    setSubmissionSubmittedAt("");
    setReviewPhotoIndex(null);
    setReviewPhotoError("");
    setLocationChangedFlag(false);
    setPrevBuildingId("");
    setSubmitError(null);
    clearDraft();
    setStep("photos");
  };

  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    void clearDraftPhotos();
    setDraftPrompt("dismissed");
  };

  const restoreDraft = () => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Record<string, unknown>;
      if (typeof d.step === "string" && ["photos", "location", "damage", "review"].includes(d.step))
        setStep(d.step as "photos" | "location" | "damage" | "review");
      if (typeof d.damageLevel === "string") setDamageLevel(d.damageLevel as DamageLevel | "");
      if (Array.isArray(d.infrastructureTypes)) setInfrastructureTypes(d.infrastructureTypes as string[]);
      if (typeof d.infrastructureOther === "string") setInfrastructureOther(d.infrastructureOther);
      if (typeof d.infrastructureName === "string") setInfrastructureName(d.infrastructureName);
      if (typeof d.disasterType === "string") setDisasterType(d.disasterType);
      if (typeof d.debrisBlocking === "string") setDebrisBlocking(d.debrisBlocking);
      if (typeof d.electricityCondition === "string") setElectricityCondition(d.electricityCondition);
      if (typeof d.healthServicesCondition === "string") setHealthServicesCondition(d.healthServicesCondition);
      if (Array.isArray(d.pressingNeeds)) setPressingNeeds(d.pressingNeeds as string[]);
      if (typeof d.pressingNeedsOther === "string") setPressingNeedsOther(d.pressingNeedsOther);
      if (typeof d.damageQuestion === "number") setDamageQuestion(d.damageQuestion);
      if (d.additionalAnswers && typeof d.additionalAnswers === "object" && !Array.isArray(d.additionalAnswers))
        setAdditionalAnswers(d.additionalAnswers as Record<number, string | string[]>);
      if (typeof d.locationAddress === "string") setLocationAddress(d.locationAddress);
      if (typeof d.locationLandmark === "string") setLocationLandmark(d.locationLandmark);
      if (typeof d.locationBuildingName === "string") setLocationBuildingName(d.locationBuildingName);
      if (typeof d.locationNote === "string") setLocationNote(d.locationNote);
      if (typeof d.gpsLatitude === "number") setGpsLatitude(d.gpsLatitude);
      if (typeof d.gpsLongitude === "number") setGpsLongitude(d.gpsLongitude);
      if (typeof d.selectedBuildingId === "string") setSelectedBuildingId(d.selectedBuildingId);
      if (typeof d.selectedBuildingName === "string") setSelectedBuildingName(d.selectedBuildingName);
      if (typeof d.buildingCentroidLat === "number") setBuildingCentroidLat(d.buildingCentroidLat);
      if (typeof d.buildingCentroidLng === "number") setBuildingCentroidLng(d.buildingCentroidLng);
      if (d.pinDropCoords && typeof d.pinDropCoords === "object") {
        const p = d.pinDropCoords as { lat?: number; lng?: number };
        if (typeof p.lat === "number" && typeof p.lng === "number")
          setPinDropCoords({ lat: p.lat, lng: p.lng });
      }
      if (typeof d.locationEntryMethod === "string")
        setLocationEntryMethod(d.locationEntryMethod as "map_selection" | "pin_drop" | "manual_text" | null);
    } catch { /* corrupted draft — ignore */ }
    void loadDraftPhotos().then((saved) => {
      if (saved.length > 0) setPhotos(saved);
    });
    setDraftPrompt("dismissed");
  };

  // G5 — Valid if location is sufficiently specified.
  // When map is available (online), building footprint or pin drop is required — GPS alone is not sufficient.
  // When offline, address text is required.
  const isLocationValid = (): boolean => {
    if (gpsGeofenceBlocked) return false;
    if (locationOffline && !connectionLostMidSession) return locationAddress.trim().length > 0;
    if (buildingCentroidLat !== null || pinDropCoords !== null) return true;
    return locationAddress.trim().length > 0 || locationLandmark.trim().length > 0 || locationBuildingName.trim().length > 0;
  };

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

  const additionalQuestions = useMemo(() => {
    if (!questionPackage) return [];
    const reporterCountry = (localStorage.getItem("cr_country") || countryCode || "").toUpperCase();
    return (questionPackage.questions || [])
      .filter((q) => q.is_additional ?? q.order_index > 8)
      .filter((q) => !q.country_codes?.length || q.country_codes.includes(reporterCountry))
      .filter((q) => !q.conditional_on_q4 || q.conditional_on_q4.includes(disasterType || ""));
  }, [questionPackage, disasterType, countryCode]);

  const totalQuestions = 8 + additionalQuestions.length;

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
      default: {
        const aq = additionalQuestions[damageQuestion - 9];
        if (!aq || aq.is_mandatory === false) return true;
        const ans = additionalAnswers[damageQuestion];
        return isMultiQuestion(aq)
          ? Array.isArray(ans) && (ans as string[]).length > 0
          : typeof ans === "string" && ans.trim().length > 0;
      }
    }
  };

  const handleDamageBack = () => {
    if (damageQuestion === 1) setStep("location");
    else setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = () => {
    if (!isDamageQuestionAnswered()) {
      setShowAnswerPrompt(true);
      return;
    }
    setShowAnswerPrompt(false);

    // B21 — locationChangedFlag was set when building changed during review edit of location;
    // Q3 was forced — once confirmed, clear flag and return directly to review
    if (damageQuestion === 3 && locationChangedFlag) {
      setLocationChangedFlag(false);
      setEditingFromReview(false);
      setStep("review");
      return;
    }

    if (editingFromReview && damageQuestion === totalQuestions) {
      setEditingFromReview(false);
      setStep("review");
      return;
    }
    if (damageQuestion < totalQuestions) setDamageQuestion((q) => q + 1);
    else setStep("review");
  };

  const buildLocationAddress = (): string | null => {
    if (selectedBuildingId) {
      const parts = [
        selectedBuildingName,
        selectedBuildingType && selectedBuildingType !== "yes" ? selectedBuildingType : "",
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(" — ") : null;
    }
    return locationAddress || null;
  };

  // C22 — submitTapTime is captured at the exact moment the reporter taps Submit in handleSubmit
  const doSubmit = async (submitTapTime: string) => {
    setShowDupeWarning(false);
    setSubmitError(null);
    setError("");

    // Phase 1 — compress photos and extract EXIF (both run before the network call)
    setPreparingPhotos(true);
    let compressionResults;
    try {
      compressionResults = await Promise.all(photos.map(compressPhoto));
    } catch (compressionError) {
      console.error('Photo compression failed:', compressionError);
      setSubmitError('server_error');
      setSubmitting(false);
      setPreparingPhotos(false);
      return;
    }
    const compressedPhotos = compressionResults.map((r) => r.file);
    const photoMetadata = compressionResults.map((r) => ({
      compressed: r.compressed,
      original_size_kb: r.original_size_kb,
      compressed_size_kb: r.compressed_size_kb,
    }));
    const exifResults = await Promise.all(photos.map(extractExif)) as Array<Record<string, unknown>>;
    setPreparingPhotos(false);

    // E32 — Active probe before transmission: navigator.onLine is unreliable (true behind captive portals).
    // M1: AbortSignal.timeout() is iOS 16+ only — use AbortController for wider compatibility.
    const isCurrentlyOnline = await (async () => {
      const healthCtrl = new AbortController();
      const healthTid = window.setTimeout(() => healthCtrl.abort(), 5000);
      try {
        const r = await fetch(`${API_URL}/api/health`, {
          method: "GET",
          cache: "no-store",
          signal: healthCtrl.signal,
        });
        window.clearTimeout(healthTid);
        return r.ok;
      } catch {
        window.clearTimeout(healthTid);
        return false;
      }
    })();
    const reportPayload = {
      ...(crisisId ? { crisis_id: crisisId } : {}), // omit if not resolved — backend auto-assigns
      local_report_id: localReportId,
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
      platform: "web" as const,
      submission_started_at: submissionStartTime,
      submission_submitted_at: submitTapTime,
      submitted_at: new Date().toISOString(),
      photo_metadata: JSON.stringify(photoMetadata),
      photo_exif_data: JSON.stringify(exifResults),
      location: {
        // G5 — Actual device GPS (never overwritten by building centroid)
        gps_latitude: gpsLatitude,
        gps_longitude: gpsLongitude,
        gps_accuracy_meters: gpsAccuracy,
        // C5 — explicit flags
        gps_available: gpsAvailable ?? true,
        gps_denied: gpsDenied,
        // G5 — Building footprint centroid (separate from device GPS)
        building_centroid_lat: buildingCentroidLat,
        building_centroid_lng: buildingCentroidLng,
        building_name_osm: buildingNameOsm || null,
        building_name_reporter: selectedBuildingName || null,
        building_type: selectedBuildingType || null,
        // B6 — Pin drop coordinates
        pin_drop_lat: pinDropCoords?.lat ?? null,
        pin_drop_lng: pinDropCoords?.lng ?? null,
        // Manual text entry
        location_address: buildLocationAddress(),
        location_landmark: locationLandmark || null,
        location_building_name: locationBuildingName || null,
        // B7 — Optional location note
        location_note: locationNote || null,
        // G7/G9/G11 — Metadata flags
        location_entry_method: locationEntryMethod,
        location_internet_available: locationInternetAvailable,
      },
      building_id: selectedBuildingId || null,
      reporter_id: (typeof reporterId === 'string' &&
                    !reporterId.startsWith('local_'))
        ? reporterId
        : null,
      device_id: WEB_SESSION_ID,
      language_code: languageCode,
      reporter_country: reportLocationCountry || offlineReportCountry || countryCode || localStorage.getItem("cr_country") || null,
      question_package_version: questionPackage?.version ?? null,
      question_package_content_version: questionPackage?.content_version ?? questionPackage?.version ?? null,
      question_package_translation_version: questionPackage?.translation_version ?? null,
      question_answers: (() => {
        const getQ4Label = (v: string) => {
          const translated = t(`disaster_types.${v}`, { defaultValue: "" });
          if (translated) return translated;
          for (const g of Q4_OPTIONS) {
            const o = g.options.find((x) => x.value === v);
            if (o) return o.label;
          }
          return v;
        };
        const rows: Array<Record<string, unknown>> = [
          { question_order: 1, option_value: damageLevel, option_text: DAMAGE_LABELS[damageLevel] ?? damageLevel },
          { question_order: 2, option_values: infrastructureTypes, option_texts: infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v), other_text: infrastructureOther || null },
          { question_order: 3, free_text: infrastructureName },
          { question_order: 4, option_value: disasterType, option_text: getQ4Label(disasterType) },
          { question_order: 5, option_value: debrisBlocking, option_text: DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking },
          { question_order: 6, option_value: electricityCondition, option_text: ELECTRICITY_LABELS[electricityCondition] ?? electricityCondition },
          { question_order: 7, option_value: healthServicesCondition, option_text: HEALTH_LABELS[healthServicesCondition] ?? healthServicesCondition },
          { question_order: 8, option_values: pressingNeeds, option_texts: pressingNeeds.map((v) => PRESSING_NEEDS_LABELS[v] ?? v), other_text: pressingNeedsOther || null },
          ...additionalQuestions.map((q, i) => {
            const ans = additionalAnswers[9 + i];
            if (q.question_type === "text") {
              return { question_order: 9 + i, question_text: q.question_text, free_text: typeof ans === "string" ? ans.trim() : "" };
            }
            return Array.isArray(ans)
              ? { question_order: 9 + i, question_text: q.question_text, option_values: ans }
              : { question_order: 9 + i, question_text: q.question_text, option_value: ans };
          }),
        ];
        return rows.filter((a) => a.option_value || (Array.isArray(a.option_values) && (a.option_values as string[]).length > 0) || a.free_text);
      })(),
      was_queued: false,
    };

    // Offline path — queue the report and exit early before any network call
    if (!isCurrentlyOnline) {
      // M4: Safari private mode enforces a 0-byte IndexedDB quota — check before writing
      const idbOk = await isIndexedDBAvailable();
      if (!idbOk) {
        setError(
          "Offline storage is unavailable. This can happen in private/incognito browsing mode. " +
          "Please open Crisis Reporter in a regular browser window to submit your report offline."
        );
        setSubmitError("server_error");
        setSubmitting(false);
        return;
      }
      try {
        const queuedPhotos: QueuedPhoto[] = compressedPhotos.map((file, i) => ({
          blob: file,
          filename: `photo_${i}.jpg`,
          content_type: file.type || "image/jpeg",
          display_order: i,
        }));
        await addToQueue({ ...reportPayload, was_queued: true } as unknown as ReportSubmitRequest, queuedPhotos);
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        // Request notification permission so we can alert when this report uploads later
        void requestSyncNotificationPermission();
        setWasQueued(true);
        setSubmitted(true);
      } catch {
        setSubmitError("server_error");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Phase 2 — transmit
    setSubmitting(true);

    // E34 — 30-second hard timeout on the report creation request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // Progress, so a failure part-way through queues only what didn't reach the server
    let serverReportId: string | undefined;
    let photosUploaded = 0;

    try {
      const response = await api.post("/api/reports", reportPayload, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const reportId = response.data.report_id as string;
      serverReportId = reportId;

      for (let i = 0; i < compressedPhotos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", compressedPhotos[i]);
        await api.post("/api/photos", formData, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 120000,
        });
        photosUploaded = i + 1;
      }

      saveSubmittedLocation();

      // Persist submitted report to localStorage so My Reports survives browser restarts.
      // Fields match the SessionReport interface consumed by MyReportsPage.
      try {
        const localReports: Array<Record<string, unknown>> = JSON.parse(
          localStorage.getItem("cr_local_reports") || "[]"
        );
        localReports.push({
          id: reportId,
          damage_level: damageLevel,
          gps_latitude: buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude,
          gps_longitude: buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude,
          location_address: buildLocationAddress() || null,
          submitted_at: submitTapTime,
          created_at: new Date().toISOString(),
        });
        // Cap at 100 entries — oldest dropped first
        if (localReports.length > 100) localReports.splice(0, localReports.length - 100);
        localStorage.setItem("cr_local_reports", JSON.stringify(localReports));
      } catch { /* non-critical */ }

      // D27 — also write to sessionStorage for the within-session duplicate check
      try {
        const sessionReports: Array<Record<string, unknown>> = JSON.parse(
          sessionStorage.getItem("cr_session_reports") || "[]"
        );
        sessionReports.push({
          id: reportId,
          building_id: selectedBuildingId || null,
          lat: buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude,
          lng: buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude,
          submitted_at: submitTapTime,
        });
        sessionStorage.setItem("cr_session_reports", JSON.stringify(sessionReports));
      } catch { /* non-critical */ }

      setSubmittedReportId(reportId);
      isSubmittedRef.current = true;
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      void clearDraftPhotos();
      setSubmitted(true);
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isTimeout = isAbort || (err instanceof Error && (err as { code?: string }).code === "ECONNABORTED");
      const axiosErr = err as { response?: { status?: number; data?: unknown }; code?: string };
      const isNetworkError = !axiosErr?.response && (
        !navigator.onLine ||
        axiosErr?.code === "ERR_NETWORK" ||
        (err instanceof Error && err.message === "Network Error")
      );
      // Server overloaded or unreachable — the report is fine, it just couldn't get
      // through. Queue it for automatic retry instead of asking the reporter to resubmit.
      const status = axiosErr?.response?.status;
      const isServerSide = status !== undefined && (status >= 500 || status === 408 || status === 429);
      if (isTimeout || isNetworkError || isServerSide) {
        try {
          const queuedPhotos: QueuedPhoto[] = compressedPhotos.map((file, i) => ({
            blob: file,
            filename: `photo_${i}.jpg`,
            content_type: file.type || "image/jpeg",
            display_order: i,
          })).slice(photosUploaded);
          await addToQueue(
            { ...reportPayload, was_queued: true } as unknown as ReportSubmitRequest,
            queuedPhotos,
            serverReportId,
          );
          try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
          void requestSyncNotificationPermission();
          isSubmittedRef.current = true;
          setWasQueued(true);
          setSubmitted(true);
        } catch {
          // Queue unavailable (e.g. private browsing) — the draft is kept for a manual retry
          setSubmitError(isTimeout ? "timeout" : isServerSide ? "server_error" : "no_internet");
        }
      } else {
        // Log full error to console so 422 validation detail is visible in DevTools
        if (axiosErr?.response) {
          console.error("[ReportPage] submit error", axiosErr.response.status, axiosErr.response.data);
        } else {
          console.error("[ReportPage] submit error", err);
        }
        setSubmitError("server_error");
        setError(t("report.error"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    // Guard: synchronous mutex prevents a second tap from racing through before
    // React's async state update (preparingPhotos / submitting) reaches the DOM.
    if (isSubmitInFlightRef.current) return;
    isSubmitInFlightRef.current = true;

    try {
      // C22 — Timestamp 2: captured at the exact moment the reporter taps Submit
      const submitTapTime = new Date().toISOString();
      setSubmissionSubmittedAt(submitTapTime);

      if (!damageLevel || infrastructureTypes.length === 0 || !infrastructureName.trim() || !disasterType || !debrisBlocking || !electricityCondition || !healthServicesCondition || pressingNeeds.length === 0 || photos.length === 0) {
        setError(t('report.validation_incomplete'));
        return;
      }
      // D26/D27 — async duplicate check (backend for logged-in, sessionStorage for anonymous)
      const isDupe = await checkDuplicate();
      if (isDupe) {
        setShowDupeWarning(true);
        return;
      }
      await doSubmit(submitTapTime);
    } finally {
      // Release mutex — doSubmit manages its own submitting state for the button UI
      isSubmitInFlightRef.current = false;
    }
  };

  // ── Offline queue confirmation screen ─────────────────────────────────────────

  if (submitted && wasQueued) {
    const locationSummary = selectedBuildingName
      ? selectedBuildingName
      : pinDropCoords
        ? `${pinDropCoords.lat.toFixed(5)}, ${pinDropCoords.lng.toFixed(5)}`
        : locationAddress || t('report.review_not_specified');

    return (
      <div style={styles.container}>
        <div style={styles.successContainer}>
          {/* Cloud icon */}
          <div style={{ ...styles.confirmCheckCircle, background: "linear-gradient(135deg, #F5A623 0%, #E89010 100%)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#FFFFFF", fontVariationSettings: "'FILL' 1, 'wght' 700" }}>cloud_upload</span>
          </div>

          <h2 style={styles.successTitle}>{t('review.queueTitle')}</h2>
          <p style={styles.successText}>{t('review.queueMessage')}</p>

          {/* Pending sync card */}
          <div style={{ width: "100%", background: "#FFF8EE", border: "1px solid #F5A623", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column" as const, gap: 12, position: "relative" as const, overflow: "hidden", marginBottom: 28 }}>
            <div style={{ position: "absolute" as const, top: 0, left: 0, bottom: 0, width: 4, background: "#F5A623", borderRadius: "4px 0 0 4px" }} />
            <p style={{ fontSize: 10, fontWeight: 700, color: "#B07310", textTransform: "uppercase" as const, letterSpacing: "0.1em", margin: 0 }}>{t('review.queue_pending_sync')}</p>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ background: "#FEF3E0", borderRadius: 8, padding: 8, flexShrink: 0 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#F5A623", display: "block" }}>location_on</span>
              </div>
              <div style={{ textAlign: "left" as const }}>
                <span style={{ fontSize: 12, color: "#9B6A10", display: "block" }}>{t('review.queueSummaryLocation')}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{locationSummary}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ background: "#FEF3E0", borderRadius: 8, padding: 8, flexShrink: 0 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#F5A623", display: "block" }}>home_repair_service</span>
              </div>
              <div style={{ textAlign: "left" as const }}>
                <span style={{ fontSize: 12, color: "#9B6A10", display: "block" }}>{t('review.queueSummaryDamage')}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</span>
              </div>
            </div>
            <p style={{ fontSize: 13, color: "#9B6A10", margin: 0, fontStyle: "italic", textAlign: "left" as const }}>{t('review.queue_auto_upload')}</p>
          </div>

          {/* Action buttons */}
          <div style={{ width: "100%", display: "flex", flexDirection: "column" as const, gap: 12 }}>
            <button
              style={{ width: "100%", height: 56, background: "linear-gradient(to bottom, #0468B1, #00508A)", color: "#FFFFFF", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 12px rgba(4,104,177,0.25)" }}
              onClick={resetForm}
            >
              {t('review.queueSubmitAnother')}
            </button>
            <button
              style={{ width: "100%", height: 56, background: "transparent", border: "2px solid #0468B1", borderRadius: 12, fontSize: 16, fontWeight: 700, color: "#0468B1", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => navigate("/")}
            >
              {t('review.queueGoHome')}
            </button>
            <button
              style={{ width: "100%", height: 48, background: "transparent", border: "none", fontSize: 15, fontWeight: 600, color: "#0468B1", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => navigate("/my-reports")}
            >
              {t('navigation.my_reports', 'View My Reports')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Online success screen ──────────────────────────────────────────────────────

  if (submitted && !wasQueued) {
    const locationSummary = selectedBuildingName
      ? selectedBuildingName
      : pinDropCoords
        ? `${pinDropCoords.lat.toFixed(5)}, ${pinDropCoords.lng.toFixed(5)}`
        : locationAddress || t('report.review_not_specified');
    const incidentSummary = [DAMAGE_LABELS[damageLevel] ?? damageLevel, ...infrastructureTypes.slice(0, 1).map((v) => INFRA_LABELS[v] ?? v)].join(" — ");

    return (
      <div style={styles.container}>
        <div style={styles.successContainer}>
          {/* Check circle */}
          <div style={styles.confirmCheckCircle}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#FFFFFF", fontVariationSettings: "'FILL' 1, 'wght' 700" }}>check</span>
          </div>

          <h2 style={styles.successTitle}>{t('report.success_title')}!</h2>
          <p style={styles.successText}>{t("confirmation.success_message")}</p>

          {/* Report summary card */}
          <div style={{ width: "100%", background: "#F6F3F2", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column" as const, gap: 20, position: "relative" as const, overflow: "hidden", marginBottom: 28 }}>
            <div style={{ position: "absolute" as const, top: 0, left: 0, bottom: 0, width: 4, background: "#0468B1", opacity: 0.25, borderRadius: "4px 0 0 4px" }} />
            <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase" as const, letterSpacing: "0.1em", margin: 0 }}>{t('report.success_report_summary')}</p>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ background: "#E4E2E1", borderRadius: 8, padding: 8, flexShrink: 0 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#0468B1", display: "block" }}>location_on</span>
              </div>
              <div style={{ textAlign: "left" as const }}>
                <span style={{ fontSize: 12, color: "#717782", display: "block" }}>{t('report.success_location_label')}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{locationSummary}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ background: "#E4E2E1", borderRadius: 8, padding: 8, flexShrink: 0 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#0468B1", display: "block" }}>home_repair_service</span>
              </div>
              <div style={{ textAlign: "left" as const }}>
                <span style={{ fontSize: 12, color: "#717782", display: "block" }}>{t('report.success_incident_label')}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{incidentSummary}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ background: "#E4E2E1", borderRadius: 8, padding: 8, flexShrink: 0 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#0468B1", display: "block" }}>schedule</span>
              </div>
              <div style={{ textAlign: "left" as const }}>
                <span style={{ fontSize: 12, color: "#717782", display: "block" }}>{t('report.success_status_label')}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{t('report.success_submitted_now')}</span>
              </div>
            </div>
            <div style={{ borderTop: "1px solid rgba(193,199,210,0.4)", paddingTop: 16 }}>
              <p style={{ fontSize: 13, color: "#717782", display: "flex", alignItems: "center", gap: 8, margin: 0, fontStyle: "italic", textAlign: "left" as const }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, flexShrink: 0 }}>info</span>
                {t('report.success_report_id_note')}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ width: "100%", display: "flex", flexDirection: "column" as const, gap: 12 }}>
            <button
              style={{ width: "100%", height: 56, background: "linear-gradient(to bottom, #0468B1, #00508A)", color: "#FFFFFF", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 12px rgba(4,104,177,0.25)" }}
              onClick={resetForm}
            >
              {t('report.submit_another')}
            </button>
            <button
              style={{ width: "100%", height: 56, background: "transparent", border: "2px solid #0468B1", borderRadius: 12, fontSize: 16, fontWeight: 700, color: "#0468B1", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => navigate("/")}
            >
              {t('common.go_home')}
            </button>
            <button
              style={{ width: "100%", height: 48, background: "transparent", border: "none", fontSize: 15, fontWeight: 600, color: "#0468B1", cursor: "pointer", fontFamily: "inherit" }}
              onClick={() => navigate("/my-reports")}
            >
              {t('navigation.my_reports', 'View My Reports')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (crisisLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.centeredMessage}>
          <div style={{ fontSize: 16, color: "#666" }}>{t('common.loading')}</div>
        </div>
      </div>
    );
  }

  // Note: crisisError / missing crisisId does NOT block the form.
  // The backend resolves crisis automatically (auto-picks first active crisis
  // when crisis_id is omitted from the payload). If truly no crisis exists,
  // the submit API call will return a 404 with a clear error at that point.
  // We still pass crisisId when we have it (better duplicate detection, map
  // scoping) but the form is never blocked by its absence.

  // ── Guidelines ────────────────────────────────────────────────────────────────
  const GUIDELINES = [
    t("photo_guidelines.guideline_1"),
    t("photo_guidelines.guideline_2"),
    t("photo_guidelines.guideline_3"),
    t("photo_guidelines.guideline_4"),
  ];

  // ── Photo step sub-components ─────────────────────────────────────────────────

  const renderPhotoGrid = () => (
    <div style={styles.photoGrid}>
      {photos.map((photo, index) => (
        <div
          key={index}
          style={{ position: "relative" as const, aspectRatio: "1", borderRadius: 12, overflow: "visible", cursor: "pointer" }}
          onClick={() => setSelectedPhotoIndex(selectedPhotoIndex === index ? null : index)}
        >
          <img
            src={photoUrls[index] ?? ""}
            style={{ width: "100%", height: "100%", objectFit: "cover" as const, borderRadius: 12, display: "block" }}
            alt={`Photo ${index + 1}`}
          />
          <button
            style={styles.thumbRemoveBtn}
            onClick={(e) => { e.stopPropagation(); handlePhotoRemove(index); }}
            aria-label="Remove photo"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#FFFFFF", lineHeight: 1, display: "block" }}>close</span>
          </button>
          {selectedPhotoIndex === index && (
            <div style={styles.thumbPopover} onClick={(e) => e.stopPropagation()}>
              <button
                style={styles.thumbAction}
                onClick={() => {
                  setViewingPhoto(photo);
                  setSelectedPhotoIndex(null);
                }}
              >
                {t('report.photo_action_view')}
              </button>
              <button
                style={styles.thumbAction}
                onClick={() => {
                  setReplaceIndex(index);
                  setSelectedPhotoIndex(null);
                  replaceInputRef.current?.click();
                }}
              >
                {t('report.photo_action_replace')}
              </button>
              <button
                style={{ ...styles.thumbAction, color: "#E53E3E" }}
                onClick={() => handlePhotoRemove(index)}
              >
                {t('report.photo_action_remove')}
              </button>
            </div>
          )}
        </div>
      ))}
      {photos.length < 3 && (
        <div
          style={styles.photoSlotActive}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          aria-label="Add photo"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 32, color: "#0468B1" }}>add</span>
        </div>
      )}
      {photos.length < 2 && (
        <div style={styles.photoSlotFaded} aria-hidden="true">
          <span className="material-symbols-outlined" style={{ fontSize: 32, color: "#C1C7D2" }}>add</span>
        </div>
      )}
    </div>
  );

  const renderPhotoActionButtons = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {isMobile && !cameraDenied && (
        <button
          style={styles.photoActionBtn}
          onClick={() => void handleTakePhoto()}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>photo_camera</span>
          {t('report.take_photo_btn')}
        </button>
      )}
      {cameraDenied && (
        <div style={styles.denialBox}>
          <p style={styles.denialMsg}>{t('report.camera_denied_msg')}</p>
        </div>
      )}
      <button
        style={styles.photoActionBtn}
        onClick={() => fileInputRef.current?.click()}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>image</span>
        {t('report.upload_photo_btn')}
      </button>
      {!isMobile && (
        <p style={{ fontSize: 12, color: "#717782", margin: 0, textAlign: "center" as const }}>
          {t('report.drag_photo_here')}
        </p>
      )}
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("report.title")}</h1>
        <div style={{ minWidth: 44, flexShrink: 0 }} />
      </div>

      {/* 5-step labeled stepper */}
      <SubmissionStepper currentStep={getStepperStep(step, submitting)} />

      {/* Draft restore banner */}
      {draftPrompt === "showing" && (() => {
        let savedLabel = "";
        try {
          const raw = localStorage.getItem(DRAFT_KEY);
          if (raw) {
            const d = JSON.parse(raw) as { savedAt?: string };
            if (d.savedAt) {
              savedLabel = new Date(d.savedAt).toLocaleString(undefined, {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
              });
            }
          }
        } catch { /* ignore */ }
        return (
          <div style={{
            display: "flex", alignItems: "center", flexWrap: "wrap" as const,
            gap: 10, padding: "10px 16px",
            background: "#FFF8E1", borderBottom: "1px solid #FFE082",
            fontSize: 13, color: "#5D4037",
          }}>
            <span style={{ flex: 1, minWidth: 160 }}>
              📝 Unsaved draft{savedLabel ? ` from ${savedLabel}` : ""}. Resume?
            </span>
            <button
              onClick={restoreDraft}
              style={{
                background: "#0468B1", color: "#fff", border: "none",
                borderRadius: 6, padding: "6px 14px", fontSize: 13,
                fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Resume
            </button>
            <button
              onClick={clearDraft}
              style={{
                background: "transparent", color: "#5D4037", border: "1px solid #BCAAA4",
                borderRadius: 6, padding: "6px 14px", fontSize: 13,
                fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              Discard
            </button>
          </div>
        );
      })()}

      {/* Content */}
      <div ref={contentScrollRef} style={{ ...styles.content, overflow: (step === "location" && (!locationOffline || connectionLostMidSession)) ? "hidden" : "auto" }}>

        {/* Step 1 — Photos */}
        {step === "photos" && (
          <div style={{ padding: "20px 16px 96px", display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {/* Step label */}
            <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", letterSpacing: "0.1em", textTransform: "uppercase" as const, margin: 0 }}>
              {t('report.step_1_of_5')}
            </p>

            {/* Photo content: empty state placeholder or 3-slot grid */}
            {photos.length === 0 ? (
              <div
                style={{
                  width: "100%",
                  aspectRatio: "4 / 2.8",
                  border: isDragging ? "2px dashed #0468B1" : "2px dashed #C1C7D2",
                  borderRadius: 16,
                  display: "flex",
                  flexDirection: "column" as const,
                  alignItems: "center",
                  justifyContent: "center",
                  background: isDragging ? "rgba(4,104,177,0.04)" : "#FFFFFF",
                  gap: 8,
                }}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                {isDragging ? (
                  <span style={{ color: "#0468B1", fontWeight: 600, fontSize: 15 }}>{t('report.drop_photo_here')}</span>
                ) : (
                  <>
                    <div style={{ width: 48, height: 48, background: "#EAEAE7", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 24, color: "#717782" }}>no_photography</span>
                    </div>
                    <p style={{ fontSize: 14, fontWeight: 500, color: "#717782", margin: 0 }}>{t('report.no_photo_added')}</p>
                  </>
                )}
              </div>
            ) : (
              renderPhotoGrid()
            )}

            {/* Photo count (1–2 photos) */}
            {photos.length > 0 && photos.length < 3 && (
              <p style={{ fontSize: 14, color: "#717782", margin: 0 }}>
                {t('report.photos_added_count', { count: photos.length })}
              </p>
            )}

            {/* Max photos amber banner */}
            {photos.length === 3 && (
              <div style={{ background: "#FFF3CD", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#6C4500", fontVariationSettings: "'FILL' 1" }}>warning</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#6C4500" }}>{t('report.max_photos_reached')}</span>
              </div>
            )}

            {/* Action buttons (hidden when max photos reached) */}
            {photos.length < 3 && renderPhotoActionButtons()}

            {dropExtraMessage && (
              <p style={{ fontSize: 13, color: "#717782", margin: 0 }}>{dropExtraMessage}</p>
            )}
            {photoError && (
              <p style={{ fontSize: "0.85rem", color: "#E53E3E", margin: 0 }}>{photoError}</p>
            )}

            {/* Photo Tips card */}
            <div style={{ background: "#F6F3F2", borderRadius: 16, padding: "16px 20px", display: "flex", flexDirection: "column" as const, gap: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", letterSpacing: "0.1em", textTransform: "uppercase" as const, margin: 0 }}>
                {t('report.photo_tips_title')}
              </p>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
                {GUIDELINES.map((text, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#006D37", flexShrink: 0 }}>check</span>
                    <span style={{ fontSize: 14, color: "#1B1C1C", fontWeight: 500, lineHeight: 1.4 }}>{text}</span>
                  </div>
                ))}
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/bmp,image/tiff"
              multiple
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
          </div>
        )}

        {/* Step 2 — Location */}
        {step === "location" && (
          <div style={{ height: locationOffline && !connectionLostMidSession ? "auto" : "100%", display: "flex", flexDirection: "column", minHeight: "100%" }}>

            {/* D2/E1 — Amber banner: offline on arrival OR mid-session drop */}
            {locationOffline && (
              <div style={{
                background: "#F5A623",
                padding: "12px 20px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                flexShrink: 0,
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#FFFFFF", marginTop: 1, flexShrink: 0 }}>wifi_off</span>
                <div>
                  <p style={{ color: "#FFFFFF", fontWeight: 600, fontSize: 14, margin: 0, lineHeight: 1.3 }}>
                    {t("location.offline_banner")}
                  </p>
                  <p style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, margin: "4px 0 0" }}>
                    {t("location.offline_gps_background", "Your GPS coordinates are still being recorded in the background")}
                  </p>
                </div>
              </div>
            )}

            {/* D1 — Map area: suppressed when offline on arrival; kept when mid-session drop */}
            {(!locationOffline || connectionLostMidSession) && (
            <div style={{ flex: 1, position: "relative", minHeight: 260 }}>
              <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />

              {/* Instruction pill — sits below geocoding search bar (top-left, ~44px tall) */}
              <div style={{
                position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)",
                zIndex: 10, background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)",
                borderRadius: 9999, padding: "8px 16px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#0468B1" }}>info</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: "#1B1C1C" }}>
                  {t('report.location_tap_hint', 'Tap a building or drop a pin')}
                </span>
              </div>

              {/* Building footprints loading indicator */}
              {buildingsLoading && (
                <div style={{
                  position: "absolute", top: 54, left: "50%", transform: "translateX(-50%)",
                  zIndex: 10, background: "rgba(4,104,177,0.88)", backdropFilter: "blur(8px)",
                  borderRadius: 9999, padding: "5px 14px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#fff" }}>pending</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#fff" }}>
                    {t('report.loading_buildings', 'Loading footprints…')}
                  </span>
                </div>
              )}

              {/* Floating GPS recenter button */}
              <div style={{ position: "absolute", bottom: 24, right: 16, zIndex: 10 }}>
                <button
                  onClick={() => void triggerGeolocation()}
                  style={{
                    width: 52, height: 52, borderRadius: "50%",
                    background: "#0468B1", color: "#fff", border: "none",
                    cursor: "pointer", boxShadow: "0 4px 16px rgba(4,104,177,0.35)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                  title={t('report.gps_button')}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 24 }}>my_location</span>
                </button>
              </div>

              {locationMapZoom < 14 && (
                <div style={styles.zoomHint}>{t('report.location_zoom_hint')}</div>
              )}

              {/* Microsoft Building Footprints active note */}
              {footprintSource === "microsoft" && (
                <div style={{
                  position: "absolute",
                  bottom: 8,
                  left: 8,
                  right: 8,
                  background: "rgba(235, 248, 255, 0.95)",
                  border: "1px solid #63B3ED",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: "0.75rem",
                  color: "#2B6CB0",
                  zIndex: 10,
                  pointerEvents: "none",
                }}>
                  {t('report.msft_footprints_note')}
                </div>
              )}

              {/* B3/B11 — Desktop: floating confirmation card */}
              {pendingBuilding && !isMobile && (
                <div style={styles.confirmCardDesktop}>
                  <div style={styles.confirmBuildingName}>
                    {pendingBuilding.name || t('report.unnamed_building')}
                  </div>
                  <div style={styles.confirmBuildingType}>
                    {pendingBuilding.type !== "yes"
                      ? pendingBuilding.type.replace(/_/g, " ")
                      : "Building"}
                  </div>
                  <div style={styles.confirmBuildingCoords}>
                    {Math.abs(pendingBuilding.lat).toFixed(5)}°{pendingBuilding.lat >= 0 ? "N" : "S"},{" "}
                    {Math.abs(pendingBuilding.lng).toFixed(5)}°{pendingBuilding.lng >= 0 ? "E" : "W"}
                  </div>
                  <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid #E2E8F0" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={styles.confirmCancelBtn} onClick={handleBuildingCancel}>{t('common.cancel')}</button>
                    <button style={styles.confirmConfirmBtn} onClick={handleBuildingConfirm}>{t('common.confirm')}</button>
                  </div>
                </div>
              )}
            </div>
            )} {/* end map area gate */}

            {/* B3/B12 — Mobile: bottom sheet confirmation */}
            {pendingBuilding && isMobile && (
              <div style={styles.bottomSheet}>
                <div style={styles.bottomSheetHandle} />
                <div style={styles.confirmBuildingName}>
                  {pendingBuilding.name || t('report.unnamed_building')}
                </div>
                <div style={styles.confirmBuildingType}>
                  {pendingBuilding.type !== "yes"
                    ? pendingBuilding.type.replace(/_/g, " ")
                    : "Building"}
                </div>
                <div style={styles.confirmBuildingCoords}>
                  {Math.abs(pendingBuilding.lat).toFixed(5)}°{pendingBuilding.lat >= 0 ? "N" : "S"},{" "}
                  {Math.abs(pendingBuilding.lng).toFixed(5)}°{pendingBuilding.lng >= 0 ? "E" : "W"}
                </div>
                <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid #E2E8F0" }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={styles.confirmCancelBtn} onClick={handleBuildingCancel}>{t('common.cancel')}</button>
                  <button style={styles.confirmConfirmBtn} onClick={handleBuildingConfirm}>{t('common.confirm')}</button>
                </div>
              </div>
            )}

            {/* Bottom panel */}
            <div style={{
              ...styles.locationPanel,
              ...(locationOffline && !connectionLostMidSession ? {
                maxHeight: "none",
                overflowY: "visible",
                flex: 1,
              } : {}),
            }}>

              {/* Offline form header label */}
              {locationOffline && !connectionLostMidSession && (
                <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
                  {t('report.step_2_of_5', 'Step 2 of 5 — Enter Location Manually')}
                </p>
              )}

              {/* F2/F3 — Connection lost mid-session (map still visible above) */}
              {connectionLostMidSession && (
                <div style={{
                  background: "#FEF3C7",
                  border: "1px solid #F5A623",
                  borderRadius: 8,
                  padding: "10px 14px",
                  color: "#92400E",
                  fontSize: "0.875rem",
                }}>
                  {t("location.connection_lost")}
                </div>
              )}

              {/* D4 — GPS captured while offline (green status card) */}
              {locationOffline && gpsLatitude !== null && (
                <div style={{
                  background: "rgba(0,109,55,0.07)",
                  border: "1px solid rgba(0,109,55,0.18)",
                  borderRadius: 12, padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 22, color: "#006d37", display: "block" }}>location_on</span>
                    <div style={{
                      position: "absolute", top: -2, right: -2,
                      width: 9, height: 9, borderRadius: "50%",
                      background: "#4ADE80", border: "2px solid #fff",
                    }} />
                  </div>
                  <p style={{ fontSize: 12, fontWeight: 500, color: "#006d37", margin: 0, lineHeight: 1.4 }}>
                    {t("location.offline_gps_captured", "GPS location captured — will be attached to your report")}
                  </p>
                </div>
              )}

              {/* E3 — No internet and no GPS */}
              {locationOffline && gpsLatitude === null && (
                <p style={{ color: "#717782", fontSize: "0.8rem", margin: "0 0 4px" }}>
                  {t("location.offline_no_gps")}
                </p>
              )}

              {/* Logic 2: Country picker — only when offline + no GPS (no coords to reverse-geocode from) */}
              {locationOffline && gpsLatitude === null && (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ ...styles.fieldLabel, display: "block", marginBottom: 4 }}>
                    {t("location.country_label")}
                  </label>
                  <div style={{ position: "relative" }}>
                    <button
                      style={{ width: "100%", textAlign: "left", padding: "10px 36px 10px 12px", border: "1px solid #D1D5DB", borderRadius: 8, background: "#FAFAFA", fontSize: 14, color: offlineReportCountry ? "#1B1C1C" : "#9CA3AF", cursor: "pointer", fontFamily: "inherit" }}
                      onClick={() => setShowCountryModal(true)}
                    >
                      {offlineCountries.find(c => c.code === offlineReportCountry)?.name || offlineReportCountry || t("location.select_country")}
                    </button>
                    <span className="material-symbols-outlined" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 20, color: "#717782", pointerEvents: "none" }}>expand_more</span>
                  </div>
                  <p style={{ fontSize: 11, color: "#9CA3AF", margin: "4px 0 0" }}>{t("location.country_hint")}</p>

                  {/* Country search modal */}
                  {showCountryModal && (
                    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9000, display: "flex", alignItems: "flex-end" }} onClick={() => { setShowCountryModal(false); setCountrySearch(""); }}>
                      <div style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxHeight: "75vh", display: "flex", flexDirection: "column", padding: "20px 0 0" }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: "0 16px 12px", borderBottom: "1px solid #EBEBEB" }}>
                          <input
                            autoFocus
                            style={{ width: "100%", padding: "10px 14px", border: "1px solid #D1D5DB", borderRadius: 8, fontSize: 14, boxSizing: "border-box" }}
                            placeholder={t("location.country_search")}
                            value={countrySearch}
                            onChange={e => setCountrySearch(e.target.value)}
                          />
                        </div>
                        <div style={{ overflowY: "auto", flex: 1 }}>
                          {offlineCountries
                            .filter(c => c.name.toLowerCase().includes(countrySearch.toLowerCase()) || c.code.toLowerCase().includes(countrySearch.toLowerCase()))
                            .map(c => (
                              <button
                                key={c.code}
                                style={{ width: "100%", textAlign: "left", padding: "14px 20px", border: "none", borderBottom: "1px solid #F3F4F6", background: offlineReportCountry === c.code ? "#EBF4FF" : "transparent", fontSize: 15, color: "#1B1C1C", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "inherit" }}
                                onClick={() => { setOfflineReportCountry(c.code); setShowCountryModal(false); setCountrySearch(""); }}
                              >
                                {c.name}
                                {offlineReportCountry === c.code && <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#0468B1" }}>check</span>}
                              </button>
                            ))
                          }
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Selection state card */}
              {selectedBuildingId && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>{t('report.building_selected')}</div>
                  <div style={styles.selectionCardName}>
                    {selectedBuildingName || t('report.unnamed_building')}
                  </div>
                  {selectedBuildingType && selectedBuildingType !== "yes" && (
                    <div style={styles.selectionCardMeta}>
                      {t('report.building_type_label')} {selectedBuildingType.replace(/_/g, " ")}
                    </div>
                  )}
                  {buildingCentroidLat !== null && buildingCentroidLng !== null && (
                    <div style={styles.selectionCardCoords}>
                      <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0468B1" }}>satellite_alt</span>
                      {buildingCentroidLat.toFixed(6)}, {buildingCentroidLng.toFixed(6)}
                    </div>
                  )}
                </div>
              )}
              {!selectedBuildingId && pinDropCoords && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>{t('report.pin_dropped')}</div>
                  <div style={styles.selectionCardCoords}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0468B1" }}>satellite_alt</span>
                    {pinDropCoords.lat.toFixed(6)}, {pinDropCoords.lng.toFixed(6)}
                  </div>
                </div>
              )}
              {!selectedBuildingId && !pinDropCoords && gpsLatitude !== null && gpsLongitude !== null && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>{t('report.gps_captured')}</div>
                  <div style={styles.selectionCardCoords}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0468B1" }}>satellite_alt</span>
                    {gpsLatitude.toFixed(6)}, {gpsLongitude.toFixed(6)}
                  </div>
                  <p style={{ fontSize: 12, color: "#E07B00", margin: "8px 0 0", lineHeight: 1.4 }}>
                    {t('report.gps_captured_select_hint')}
                  </p>
                </div>
              )}

              {/* B10 — Inline duplicate warning (dismissible, non-blocking) */}
              {showDuplicateInlineWarning && (
                <div style={styles.inlineDupeWarning}>
                  <span>
                    {t('report.duplicate_inline_warning')}
                  </span>
                  <button
                    style={styles.inlineDupeDismiss}
                    onClick={() => setShowDuplicateInlineWarning(false)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Outside crisis area warning (non-blocking, dismissible) */}
              {/* GPS geo-fence: hard error — not dismissible */}
              {gpsGeofenceBlocked && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#FFF5F5", border: "1px solid #FC8181", borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#C53030", flexShrink: 0 }}>location_off</span>
                  <span style={{ fontSize: 13, color: "#C53030", lineHeight: "1.5" }}>{t('location.too_far_from_gps')}</span>
                </div>
              )}

              {showOutsideAreaWarning && !gpsGeofenceBlocked && (
                <div style={styles.inlineDupeWarning}>
                  <span>{t('report.location_outside_crisis_area')}</span>
                  <button
                    style={styles.inlineDupeDismiss}
                    onClick={() => setShowOutsideAreaWarning(false)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* B5 — Editable building name (after building confirmed or pin dropped) */}
              {(selectedBuildingId || pinDropCoords) && (
                <div>
                  <label style={styles.fieldLabel}>{t('report.building_name_label')}</label>
                  <input
                    style={styles.input}
                    type="text"
                    placeholder={t('report.building_name_optional_placeholder', 'Building name (optional)')}
                    value={selectedBuildingName}
                    onChange={(e) => setSelectedBuildingName(e.target.value)}
                  />
                </div>
              )}

              {/* B7/B8 — Optional location note (after building confirmed or pin dropped) */}
              {(selectedBuildingId || pinDropCoords) && (
                <div>
                  <label style={styles.fieldLabel}>
                    {t('report.location_note_label')}{" "}
                    <span
                      title="Add the name you know this building by, or any detail that helps identify the exact spot."
                      style={{ cursor: "help", color: "#A0AEC0" }}
                    >
                      ⓘ
                    </span>
                  </label>
                  <textarea
                    style={styles.noteTextarea}
                    rows={2}
                    placeholder={t('report.location_note_placeholder')}
                    value={locationNote}
                    onChange={(e) => setLocationNote(e.target.value)}
                  />
                </div>
              )}

              {/* Online, GPS not yet captured, not denied — asking for permission */}
              {!locationOffline && gpsLatitude === null && !gpsDenied && (
                <p style={styles.permNote}>
                  {t('location.permission_note', 'Crisis Reporter needs your location to help identify the building you are reporting.')}
                </p>
              )}

              {/* C4 — Online but GPS denied: quiet inline note instead of full denial box */}
              {!locationOffline && gpsDenied && (
                <p style={{ color: "#717782", fontSize: "0.8rem", margin: "8px 0", padding: "0 4px" }}>
                  {t("location.gps_unavailable_inline")}
                </p>
              )}

              {!gpsDenied && !locationOffline && (
                <button
                  style={styles.gpsButton}
                  onClick={() => void triggerGeolocation()}
                  disabled={gpsCapturing}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>my_location</span>
                  {gpsCapturing ? t('report.gps_getting') : t('report.gps_button')}
                </button>
              )}

              {!locationOffline && (
                <button
                  style={styles.manualToggle}
                  onClick={() => setManualExpanded(!manualExpanded)}
                >
                  {manualExpanded ? t('report.hide_manual_entry') : t('report.show_manual_entry')}
                </button>
              )}

              {manualExpanded && (
                <div style={{ display: "flex", flexDirection: "column", gap: locationOffline ? 16 : 8 }}>
                  {/* Address */}
                  <div>
                    {locationOffline && <label style={styles.fieldLabel}>{t('report.address_label', 'Address')} *</label>}
                    <input
                      style={styles.input}
                      type="text"
                      placeholder={locationOffline ? t('report.address_placeholder', 'Street address or area name') : 'Address'}
                      value={locationAddress}
                      onChange={(e) => {
                        setLocationAddress(e.target.value);
                        if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                      }}
                    />
                    {locationOffline && (
                      <p style={{ fontSize: 11, color: "#717782", margin: "4px 0 0", fontStyle: "italic" }}>
                        {t('report.address_hint', 'e.g. 14 Ataturk Street, Kadikoy')}
                      </p>
                    )}
                  </div>

                  {/* Nearby Landmark */}
                  <div>
                    {locationOffline && <label style={styles.fieldLabel}>{t('report.landmark_label', 'Nearby Landmark')}</label>}
                    <input
                      style={styles.input}
                      type="text"
                      placeholder={t('report.landmark_placeholder')}
                      value={locationLandmark}
                      onChange={(e) => {
                        setLocationLandmark(e.target.value);
                        if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                      }}
                    />
                    {locationOffline && (
                      <p style={{ fontSize: 11, color: "#717782", margin: "4px 0 0", fontStyle: "italic" }}>
                        {t('report.landmark_hint', 'e.g. Near the school next to the central market')}
                      </p>
                    )}
                  </div>

                  {/* Building Name */}
                  <div>
                    {locationOffline && <label style={styles.fieldLabel}>{t('report.building_name_label_manual', 'Building Name')}</label>}
                    <input
                      style={styles.input}
                      type="text"
                      placeholder={locationOffline ? t('report.building_name_placeholder', 'Name of the specific building or structure') : 'Building Name'}
                      value={locationBuildingName}
                      onChange={(e) => {
                        setLocationBuildingName(e.target.value);
                        if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                      }}
                    />
                    {locationOffline && (
                      <p style={{ fontSize: 11, color: "#717782", margin: "4px 0 0", fontStyle: "italic" }}>
                        {t('report.building_name_hint', 'e.g. Residential Block 4B, Al-Nour Mosque')}
                      </p>
                    )}
                  </div>

                  {locationOffline && !connectionLostMidSession && (
                    <p style={{ fontSize: 11, color: "#717782", margin: 0 }}>
                      {t('report.address_required_offline', '* Address is required to continue when offline')}
                    </p>
                  )}
                </div>
              )}

              {/* H4 — Nav buttons */}
              <div style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                marginTop: 8,
              }}>
                <button
                  style={{
                    width: "100%",
                    height: 48,
                    background: isLocationValid()
                      ? "linear-gradient(135deg, #0468B1, #00508A)"
                      : "#E4E2E1",
                    color: isLocationValid() ? "#fff" : "#717782",
                    border: "none",
                    borderRadius: 12,
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: isLocationValid() ? "pointer" : "not-allowed",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    fontFamily: "inherit",
                  }}
                  disabled={!isLocationValid()}
                  onClick={() => {
                    if (editingFromReview) {
                      if (selectedBuildingId !== prevBuildingId) {
                        setLocationChangedFlag(true);
                        setDamageQuestion(3);
                        setStep("damage");
                      } else {
                        setEditingFromReview(false);
                        setStep("review");
                      }
                    } else {
                      setStep("damage");
                    }
                  }}
                >
                  {t('common.next')}
                </button>
                {!locationOffline && (
                  <button
                    style={{
                      background: "none",
                      border: "none",
                      color: "#717782",
                      fontSize: 14,
                      cursor: "pointer",
                      padding: "10px 0",
                      textAlign: "center" as const,
                      width: "100%",
                      fontFamily: "inherit",
                    }}
                    onClick={() => setStep("photos")}
                  >
                    {t('common.back')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 3 — Damage Assessment */}
        {step === "damage" && (
          <div style={styles.step}>
            <div style={{ marginBottom: 4 }}>
              <p style={styles.questionProgress}>{t('report.question_number', { number: damageQuestion, total: totalQuestions, defaultValue: `Question ${damageQuestion} of ${totalQuestions}` })}</p>
              <div style={{ height: 6, background: "#E4E2E1", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(damageQuestion / totalQuestions) * 100}%`, background: "#0468B1", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
            </div>

            {damageQuestion === 1 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(1, "How bad is the damage? *")}</h2>
                {qOptions(1, [
                  { value: "minimal", label: "Minimal / No damage" },
                  { value: "partial", label: "Partially damaged" },
                  { value: "complete", label: "Completely damaged" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.radioOption,
                      border: damageLevel === value ? "2px solid #0468B1" : "2px solid transparent",
                      background: damageLevel === value ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { setDamageLevel(value as DamageLevel); setShowAnswerPrompt(false); }}
                  >
                    <div style={{
                      ...styles.radioCircle,
                      border: damageLevel === value ? "6px solid #0468B1" : "2px solid #C1C7D2",
                    }} />
                    <span style={styles.radioLabel}>{label}</span>
                  </div>
                ))}
              </>
            )}

            {damageQuestion === 2 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(2, "What type of infrastructure is this? *")}</h2>
                <p style={styles.photoHint}>{t('report.select_all_apply')}</p>
                {qOptions(2, [
                  { value: "residential", label: "Residential Infrastructure" },
                  { value: "commercial", label: "Commercial Infrastructure" },
                  { value: "government", label: "Government Building" },
                  { value: "utility", label: "Utility Infrastructure" },
                  { value: "transport_comm", label: "Transport and Communication Infrastructure" },
                  { value: "community", label: "Community Infrastructure" },
                  { value: "public_spaces", label: "Public Spaces / Recreation Infrastructure" },
                  { value: "other", label: "Other (please specify)" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.checkRow,
                      border: infrastructureTypes.includes(value) ? "2px solid #0468B1" : "2px solid transparent",
                      background: infrastructureTypes.includes(value) ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { toggleInfraType(value); setShowAnswerPrompt(false); }}
                  >
                    <div style={{ ...styles.checkbox, ...(infrastructureTypes.includes(value) ? styles.checkboxSelected : {}) }}>
                      {infrastructureTypes.includes(value) && <span style={styles.checkmark}>✓</span>}
                    </div>
                    <span style={styles.checkRowText}>{label}</span>
                  </div>
                ))}
                {infrastructureTypes.includes("other") && (
                  <div>
                    <textarea
                      autoFocus
                      style={{ ...styles.input, marginTop: 8, resize: "vertical" as const, minHeight: 72 }}
                      maxLength={100}
                      placeholder={t('report.please_specify')}
                      value={infrastructureOther}
                      onChange={(e) => setInfrastructureOther(e.target.value)}
                    />
                    <div style={styles.charCounter}>{infrastructureOther.length} / 100</div>
                  </div>
                )}
              </>
            )}

            {damageQuestion === 3 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(3, "What is the name of this infrastructure? *")}</h2>
                {locationChangedFlag && (
                  <p style={{ color: "#F57C00", fontSize: "0.85rem", margin: "0 0 8px", lineHeight: 1.5 }}>
                    {t('report.location_changed_warning')}
                  </p>
                )}
                <input
                  autoFocus={damageQuestion === 3}
                  style={styles.input}
                  type="text"
                  maxLength={200}
                  placeholder={t('report.q3_infra_name_placeholder', 'e.g. Main Street Bridge')}
                  value={infrastructureName}
                  onChange={(e) => { setInfrastructureName(e.target.value); setShowAnswerPrompt(false); }}
                />
                <div style={styles.charCounter}>{infrastructureName.length} / 200</div>
              </>
            )}

            {damageQuestion === 4 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(4, "What type of disaster caused this damage? *")}</h2>
                {Q4_OPTIONS.map(({ category, options }) => (
                  <div key={category}>
                    <div style={styles.categoryHeading}>{q4CategoryLabels[category] ?? category}</div>
                    {options.map(({ value, label }) => (
                      <div
                        key={value}
                        style={{
                          ...styles.radioOption,
                          border: disasterType === value ? "2px solid #0468B1" : "2px solid transparent",
                          background: disasterType === value ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                        }}
                        onClick={() => { setDisasterType(value); setShowAnswerPrompt(false); }}
                      >
                        <div style={{
                          ...styles.radioCircle,
                          border: disasterType === value ? "6px solid #0468B1" : "2px solid #C1C7D2",
                        }} />
                        <span style={styles.radioLabel}>{t(`disaster_types.${value}`, { defaultValue: label })}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {damageQuestion === 5 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(5, "Is there debris blocking access? *")}</h2>
                {qOptions(5, [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.radioOption,
                      border: debrisBlocking === value ? "2px solid #0468B1" : "2px solid transparent",
                      background: debrisBlocking === value ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { setDebrisBlocking(value); setShowAnswerPrompt(false); }}
                  >
                    <div style={{
                      ...styles.radioCircle,
                      border: debrisBlocking === value ? "6px solid #0468B1" : "2px solid #C1C7D2",
                    }} />
                    <span style={styles.radioLabel}>{label}</span>
                  </div>
                ))}
              </>
            )}

            {damageQuestion === 6 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(6, "What is the current condition of electricity infrastructure in your community following the crisis? *")}</h2>
                {qOptions(6, [
                  { value: "no_damage", label: "No damage observed" },
                  { value: "minor", label: "Minor damage — service disruptions but quickly repairable" },
                  { value: "moderate", label: "Moderate damage — partial outages requiring repairs" },
                  { value: "severe", label: "Severe damage — major infrastructure damaged, prolonged outages" },
                  { value: "destroyed", label: "Completely destroyed — no electricity infrastructure functioning" },
                  { value: "unknown", label: "Unknown / cannot be assessed" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.radioOption,
                      border: electricityCondition === value ? "2px solid #0468B1" : "2px solid transparent",
                      background: electricityCondition === value ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { setElectricityCondition(value); setShowAnswerPrompt(false); }}
                  >
                    <div style={{
                      ...styles.radioCircle,
                      border: electricityCondition === value ? "6px solid #0468B1" : "2px solid #C1C7D2",
                    }} />
                    <span style={styles.radioLabel}>{label}</span>
                  </div>
                ))}
              </>
            )}

            {damageQuestion === 7 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(7, "How would you rate the overall functioning of health services in your community since the event? *")}</h2>
                {qOptions(7, [
                  { value: "fully_functional", label: "Fully functional" },
                  { value: "partially_functional", label: "Partially functional" },
                  { value: "largely_disrupted", label: "Largely disrupted" },
                  { value: "not_functioning", label: "Not functioning at all" },
                  { value: "unknown", label: "Unknown" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.radioOption,
                      border: healthServicesCondition === value ? "2px solid #0468B1" : "2px solid transparent",
                      background: healthServicesCondition === value ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { setHealthServicesCondition(value); setShowAnswerPrompt(false); }}
                  >
                    <div style={{
                      ...styles.radioCircle,
                      border: healthServicesCondition === value ? "6px solid #0468B1" : "2px solid #C1C7D2",
                    }} />
                    <span style={styles.radioLabel}>{label}</span>
                  </div>
                ))}
              </>
            )}

            {damageQuestion === 8 && (
              <>
                <h2 style={styles.questionTitle}>{qTitle(8, "What are the most pressing needs in your community right now? *")}</h2>
                <p style={styles.photoHint}>{t('report.select_at_least_one')}</p>
                {qOptions(8, [
                  { value: "food_water", label: "Food assistance and safe drinking water" },
                  { value: "cash", label: "Cash or financial assistance" },
                  { value: "healthcare", label: "Access to healthcare and essential medicines" },
                  { value: "shelter", label: "Shelter, housing repair, or temporary accommodation" },
                  { value: "livelihoods", label: "Restoration of livelihoods or income sources" },
                  { value: "wash", label: "Water, sanitation, and hygiene (toilets, washing facilities)" },
                  { value: "basic_services", label: "Restoration of basic services and infrastructure (electricity, roads, schools)" },
                  { value: "protection", label: "Protection services and psychosocial support" },
                  { value: "local_support", label: "Support from local authorities and community organizations" },
                  { value: "other", label: "Other — please specify" },
                ]).map(({ value, label }) => (
                  <div
                    key={value}
                    style={{
                      ...styles.checkRow,
                      border: pressingNeeds.includes(value) ? "2px solid #0468B1" : "2px solid transparent",
                      background: pressingNeeds.includes(value) ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                    }}
                    onClick={() => { togglePressingNeed(value); setShowAnswerPrompt(false); }}
                  >
                    <div style={{ ...styles.checkbox, ...(pressingNeeds.includes(value) ? styles.checkboxSelected : {}) }}>
                      {pressingNeeds.includes(value) && <span style={styles.checkmark}>✓</span>}
                    </div>
                    <span style={styles.checkRowText}>{label}</span>
                  </div>
                ))}
                {pressingNeeds.includes("other") && (
                  <div>
                    <textarea
                      autoFocus
                      style={{ ...styles.input, marginTop: 8, resize: "vertical" as const, minHeight: 72 }}
                      maxLength={100}
                      placeholder={t('report.please_specify')}
                      value={pressingNeedsOther}
                      onChange={(e) => setPressingNeedsOther(e.target.value)}
                    />
                    <div style={styles.charCounter}>{pressingNeedsOther.length} / 100</div>
                  </div>
                )}
              </>
            )}

            {/* Additional questions from question package (beyond Q8) */}
            {damageQuestion >= 9 && (() => {
              const aq = additionalQuestions[damageQuestion - 9];
              if (!aq) return null;
              const isMulti = isMultiQuestion(aq);
              const currentVal = additionalAnswers[damageQuestion];
              const selectedValues: string[] = Array.isArray(currentVal) ? currentVal : [];
              const selectedValue: string = typeof currentVal === "string" ? currentVal : "";
              return (
                <>
                  <h2 style={styles.questionTitle}>{t(`Q${aq.order_index}_LABEL`, { defaultValue: aq.question_text })}{aq.is_mandatory === false ? "" : " *"}</h2>
                  {isMulti && <p style={styles.photoHint}>{t('report.select_all_apply')}</p>}
                  {aq.question_type === "text" && (
                    <>
                      <input
                        style={styles.input}
                        type="text"
                        maxLength={200}
                        placeholder={t('report.answer_placeholder')}
                        value={selectedValue}
                        onChange={(e) => {
                          setShowAnswerPrompt(false);
                          setAdditionalAnswers((prev) => ({ ...prev, [damageQuestion]: e.target.value }));
                        }}
                      />
                      <div style={styles.charCounter}>{selectedValue.length} / 200</div>
                    </>
                  )}
                  {aq.options.map((opt) => {
                    const isSelected = isMulti ? selectedValues.includes(opt.option_value) : selectedValue === opt.option_value;
                    return isMulti ? (
                      <div
                        key={opt.option_value}
                        style={{
                          ...styles.checkRow,
                          border: isSelected ? "2px solid #0468B1" : "2px solid transparent",
                          background: isSelected ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                        }}
                        onClick={() => {
                          setShowAnswerPrompt(false);
                          setAdditionalAnswers((prev) => {
                            const cur: string[] = Array.isArray(prev[damageQuestion]) ? prev[damageQuestion] as string[] : [];
                            return {
                              ...prev,
                              [damageQuestion]: cur.includes(opt.option_value)
                                ? cur.filter((v) => v !== opt.option_value)
                                : [...cur, opt.option_value],
                            };
                          });
                        }}
                      >
                        <div style={{ ...styles.checkbox, ...(isSelected ? styles.checkboxSelected : {}) }}>
                          {isSelected && <span style={styles.checkmark}>✓</span>}
                        </div>
                        <span style={styles.checkRowText}>{t(`Q${aq.order_index}_OPT_${opt.option_value.toUpperCase()}`, { defaultValue: opt.option_text })}</span>
                      </div>
                    ) : (
                      <div
                        key={opt.option_value}
                        style={{
                          ...styles.radioOption,
                          border: isSelected ? "2px solid #0468B1" : "2px solid transparent",
                          background: isSelected ? "rgba(4,104,177,0.05)" : "#F6F3F2",
                        }}
                        onClick={() => {
                          setShowAnswerPrompt(false);
                          setAdditionalAnswers((prev) => ({ ...prev, [damageQuestion]: opt.option_value }));
                        }}
                      >
                        <div style={{
                          ...styles.radioCircle,
                          border: isSelected ? "6px solid #0468B1" : "2px solid #C1C7D2",
                        }} />
                        <span style={styles.radioLabel}>{t(`Q${aq.order_index}_OPT_${opt.option_value.toUpperCase()}`, { defaultValue: opt.option_text })}</span>
                      </div>
                    );
                  })}
                </>
              );
            })()}

            {showAnswerPrompt && (
              <p style={{ color: "#E53E3E", fontSize: "0.85rem", margin: "4px 0 0" }}>
                {t('questions.please_select')}
              </p>
            )}

            <div style={styles.navButtonsSticky}>
              <button style={styles.secondaryButton} onClick={handleDamageBack}>{t('common.back')}</button>
              <button
                style={{ ...styles.primaryButton, opacity: 1 }}
                onClick={handleDamageNext}
              >
                {t('common.next')}
              </button>
            </div>

            {editingFromReview && !locationChangedFlag && (
              <button
                style={{ color: "#0468B1", fontSize: "0.85rem", textDecoration: "underline", background: "none", border: "none", cursor: "pointer", marginTop: 4, alignSelf: "flex-start" }}
                onClick={() => { setEditingFromReview(false); setStep("review"); }}
              >
                {t('report.back_to_review')}
              </button>
            )}
          </div>
        )}

        {/* Step 4 — Review and Submit */}
        {step === "review" && (() => {
          // A8 — static map URL helper for map preview
          const reviewMapLat = buildingCentroidLat ?? pinDropCoords?.lat ?? null;
          const reviewMapLng = buildingCentroidLng ?? pinDropCoords?.lng ?? null;
          const staticMapUrl = (lat: number, lng: number) =>
            `https://api.maptiler.com/maps/streets-v2/static/${lng},${lat},15/300x160.png?key=${MAPTILER_KEY}&markers=${lng},${lat}`;

          return (
            <div style={{ maxWidth: 720, margin: "0 auto", padding: "16px 16px 120px", width: "100%", boxSizing: "border-box" as const }}>
              <p style={{ textAlign: "center" as const, fontSize: 13, color: "#717782", marginBottom: 24, lineHeight: 1.5 }}>
                {t('report.review_intro', 'Please review your report before submitting. Tap any section to edit.')}
              </p>

              {/* ── Photos section ── */}
              <div style={styles.reviewSection}>
                <div style={styles.reviewSectionHeader}>
                  <span style={styles.reviewSectionTitle}>{t('report.review_photos')}</span>
                  <button style={styles.editLink} onClick={() => setStep("photos")}>{t('common.edit')}</button>
                </div>
                <div style={styles.reviewCard}>
                  <div style={{ padding: "12px 16px" }}>
                    {photos.length === 0 ? (
                      <div style={styles.reviewPhotoPlaceholder}>📷</div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                        {photos.map((photo, idx) => (
                          <div
                            key={idx}
                            onClick={() => setReviewPhotoIndex(reviewPhotoIndex === idx ? null : idx)}
                            style={{
                              position: "relative" as const,
                              width: 100,
                              height: 100,
                              borderRadius: 10,
                              overflow: "visible" as const,
                              cursor: "pointer",
                              border: "2px solid #E4E2E1",
                              flexShrink: 0,
                            }}
                          >
                            <img
                              src={photoUrls[idx] ?? ""}
                              alt={`Photo ${idx + 1}`}
                              style={{ width: "100%", height: "100%", objectFit: "cover" as const, borderRadius: 6, display: "block" }}
                            />
                            {reviewPhotoIndex === idx && (
                              <div style={styles.thumbPopover} onClick={(e) => e.stopPropagation()}>
                                <button
                                  style={styles.thumbAction}
                                  onClick={() => { setViewingPhoto(photo); setReviewPhotoIndex(null); }}
                                >{t('report.photo_action_view')}</button>
                                <button
                                  style={styles.thumbAction}
                                  onClick={() => {
                                    setReplaceIndex(idx);
                                    setReviewPhotoIndex(null);
                                    replaceInputRef.current?.click();
                                  }}
                                >{t('report.photo_action_replace')}</button>
                                <button
                                  style={{ ...styles.thumbAction, color: "#E53E3E" }}
                                  onClick={() => {
                                    if (photos.length <= 1) {
                                      setReviewPhotoError(t('report.review_photo_required'));
                                      setReviewPhotoIndex(null);
                                      return;
                                    }
                                    handlePhotoRemove(idx);
                                    setReviewPhotoIndex(null);
                                    setReviewPhotoError("");
                                  }}
                                >{t('report.photo_action_remove')}</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {reviewPhotoError && (
                      <p style={{ color: "#E53E3E", fontSize: "0.85rem", margin: "8px 0 0" }}>{reviewPhotoError}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Location section ── */}
              <div style={styles.reviewSection}>
                <div style={styles.reviewSectionHeader}>
                  <span style={styles.reviewSectionTitle}>{t('report.review_location')}</span>
                  <button
                    style={styles.editLink}
                    onClick={() => {
                      setPrevBuildingId(selectedBuildingId || "");
                      setEditingFromReview(true);
                      setStep("location");
                    }}
                  >{t('common.edit')}</button>
                </div>
                <div style={styles.reviewCard}>
                  {/* A8 — static map preview for map_selection or pin_drop */}
                  {(locationEntryMethod === "map_selection" || locationEntryMethod === "pin_drop") &&
                    reviewMapLat !== null && reviewMapLng !== null && MAPTILER_KEY && (
                    <img
                      src={staticMapUrl(reviewMapLat, reviewMapLng)}
                      alt="Selected location"
                      style={{ width: "100%", height: 140, objectFit: "cover" as const, borderRadius: "8px 8px 0 0", display: "block", borderBottom: "1px solid #E2E8F0" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  )}

                  {/* A9 — building name, type, footprint ID, location note */}
                  {selectedBuildingId ? (
                    <>
                      <div style={styles.reviewRow}>
                        <span style={styles.reviewLabel}>{t('report.review_label_building')}</span>
                        <span style={styles.reviewValue}>{selectedBuildingName || t('report.building_selected')}</span>
                      </div>
                      {selectedBuildingType && selectedBuildingType !== "yes" && (
                        <div style={styles.reviewRow}>
                          <span style={styles.reviewLabel}>{t('report.review_label_type')}</span>
                          <span style={styles.reviewValue}>{selectedBuildingType.replace(/_/g, " ")}</span>
                        </div>
                      )}
                      <div style={styles.reviewRow}>
                        <span style={styles.reviewLabel}>{t('report.review_label_footprint_id')}</span>
                        <span style={styles.reviewValue}>{selectedBuildingId}</span>
                      </div>
                    </>
                  ) : pinDropCoords ? (
                    <div style={styles.reviewRow}>
                      <span style={styles.reviewLabel}>{t('report.review_label_pin_location')}</span>
                      <span style={styles.reviewValue}>
                        {pinDropCoords.lat.toFixed(5)}, {pinDropCoords.lng.toFixed(5)}
                      </span>
                    </div>
                  ) : locationEntryMethod === "manual_text" ? (
                    <>
                      {locationAddress && (
                        <div style={styles.reviewRow}>
                          <span style={styles.reviewLabel}>{t('report.review_label_address')}</span>
                          <span style={styles.reviewValue}>{locationAddress}</span>
                        </div>
                      )}
                      {locationLandmark && (
                        <div style={styles.reviewRow}>
                          <span style={styles.reviewLabel}>{t('report.review_label_landmark')}</span>
                          <span style={styles.reviewValue}>{locationLandmark}</span>
                        </div>
                      )}
                      {locationBuildingName && (
                        <div style={styles.reviewRow}>
                          <span style={styles.reviewLabel}>{t('report.review_label_building_name')}</span>
                          <span style={styles.reviewValue}>{locationBuildingName}</span>
                        </div>
                      )}
                      {!locationAddress && !locationLandmark && !locationBuildingName && (
                        <div style={styles.reviewRow}>
                          <span style={styles.reviewValue}>{t('report.review_no_location')}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={styles.reviewRow}>
                      <span style={styles.reviewLabel}>{t('report.review_label_location')}</span>
                      <span style={styles.reviewValue}>{t('report.review_not_specified')}</span>
                    </div>
                  )}

                  {/* A9 — location note */}
                  {locationNote && (
                    <div style={styles.reviewRow}>
                      <span style={styles.reviewLabel}>{t('report.review_label_location_note')}</span>
                      <span style={styles.reviewValue}>{locationNote}</span>
                    </div>
                  )}

                  {/* A10 — GPS captured / unavailable indicator */}
                  <div style={{ ...styles.reviewRow, borderBottom: "none" }}>
                    <span style={styles.reviewLabel}>{t('report.review_label_gps')}</span>
                    <span style={{ ...styles.reviewValue, color: gpsLatitude !== null ? "#38A169" : "#9CA3AF" }}>
                      {gpsLatitude !== null
                        ? `${gpsLatitude.toFixed(5)}, ${gpsLongitude?.toFixed(5)} ✓`
                        : t('report.review_gps_not_available')}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Damage Assessment section ── */}
              <div style={styles.reviewSection}>
                <div style={styles.reviewSectionHeader}>
                  <span style={styles.reviewSectionTitle}>{t('report.review_damage_assessment', 'Damage Assessment')}</span>
                  <button style={styles.editLink} onClick={() => { setEditingFromReview(true); setDamageQuestion(1); setStep("damage"); }}>{t('common.edit')}</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q1')}</p>
                    <p style={styles.reviewDataValue}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</p>
                  </div>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q2')}</p>
                    <p style={styles.reviewDataValue}>{infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v).join(", ")}</p>
                  </div>
                  {infrastructureOther && (
                    <div style={styles.reviewDataCard}>
                      <p style={styles.reviewDataLabel}>{t('report.review_label_q2_other')}</p>
                      <p style={styles.reviewDataValue}>{infrastructureOther}</p>
                    </div>
                  )}
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q3')}</p>
                    <p style={styles.reviewDataValue}>{infrastructureName}</p>
                  </div>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q4')}</p>
                    <p style={styles.reviewDataValue}>{t(`disaster_types.${disasterType}`, { defaultValue: DISASTER_LABELS[disasterType] ?? disasterType })}</p>
                  </div>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q5')}</p>
                    <p style={styles.reviewDataValue}>{DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking}</p>
                  </div>
                </div>
              </div>

              {/* ── Community Impact section ── */}
              <div style={styles.reviewSection}>
                <div style={styles.reviewSectionHeader}>
                  <span style={styles.reviewSectionTitle}>{t('report.review_community_impact', 'Community Impact')}</span>
                  <button style={styles.editLink} onClick={() => { setEditingFromReview(true); setDamageQuestion(6); setStep("damage"); }}>{t('common.edit')}</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q6')}</p>
                    <p style={styles.reviewDataValue}>{t(`Q6_OPT_${electricityCondition.toUpperCase()}`, { defaultValue: ELECTRICITY_LABELS[electricityCondition] ?? electricityCondition })}</p>
                  </div>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q7')}</p>
                    <p style={styles.reviewDataValue}>{t(`Q7_OPT_${healthServicesCondition.toUpperCase()}`, { defaultValue: HEALTH_LABELS[healthServicesCondition] ?? healthServicesCondition })}</p>
                  </div>
                  <div style={styles.reviewDataCard}>
                    <p style={styles.reviewDataLabel}>{t('report.review_q8')}</p>
                    <p style={styles.reviewDataValue}>{pressingNeeds.map((v) => t(Q8_KEY_MAP[v] ?? `Q8_OPT_${v.toUpperCase()}`, { defaultValue: PRESSING_NEEDS_LABELS[v] ?? v })).join(", ")}</p>
                  </div>
                  {pressingNeedsOther && (
                    <div style={styles.reviewDataCard}>
                      <p style={styles.reviewDataLabel}>{t('report.review_label_q8_other')}</p>
                      <p style={styles.reviewDataValue}>{pressingNeedsOther}</p>
                    </div>
                  )}
                  {/* A13 — additional questions from package */}
                  {Object.entries(additionalAnswers).map(([orderIdxStr, answer]) => {
                    const idx = parseInt(orderIdxStr) - 9;
                    const q = additionalQuestions[idx];
                    if (!q) return null;
                    const displayAnswer = Array.isArray(answer)
                      ? (answer as string[]).map((v) => {
                          const opt = q.options?.find((o: ApiOption) => o.option_value === v);
                          return opt ? t(`Q${q.order_index}_OPT_${opt.option_value.toUpperCase()}`, { defaultValue: opt.option_text }) : v;
                        }).join(", ")
                      : (() => {
                          const opt = q.options?.find((o: ApiOption) => o.option_value === String(answer));
                          return opt ? t(`Q${q.order_index}_OPT_${opt.option_value.toUpperCase()}`, { defaultValue: opt.option_text }) : String(answer ?? "—");
                        })();
                    return (
                      <div key={orderIdxStr} style={styles.reviewDataCard}>
                        <p style={styles.reviewDataLabel}>{t(`Q${q.order_index}_LABEL`, { defaultValue: q.question_text })}</p>
                        <p style={styles.reviewDataValue}>{displayAnswer}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div ref={submitErrorRef}>
                {/* E32 — No internet error (amber card) */}
                {submitError === "no_internet" && (
                  <div style={{ background: "#FFF9F0", border: "1px solid rgba(245,166,35,0.3)", borderRadius: 12, padding: "16px", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: "#F5A623" }}>wifi_off</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#F5A623", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>{t('report.error_no_connection')}</span>
                    </div>
                    <p style={{ margin: "0 0 4px", fontSize: 14, color: "#1B1C1C" }}>{t('report.error_no_internet')}</p>
                    <p style={{ margin: "0 0 12px", color: "#717782", fontSize: 13 }}>{t('report.error_no_internet_warning')}</p>
                    <button
                      style={{ color: "#0468B1", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", fontSize: 14, fontWeight: 600, padding: 0, fontFamily: "inherit" }}
                      onClick={() => void handleSubmit()}
                    >{t('common.retry')}</button>
                  </div>
                )}

                {/* E35 — Timeout error */}
                {submitError === "timeout" && (
                  <div style={{ color: "#E53E3E", fontSize: "0.875rem", margin: "8px 0", textAlign: "center" as const }}>
                    <p style={{ margin: "0 0 8px" }}>{t('report.error_timeout')}</p>
                    <button
                      style={{ color: "#0468B1", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", fontSize: "0.875rem" }}
                      onClick={() => void handleSubmit()}
                    >{t('common.retry')}</button>
                  </div>
                )}

                {submitError === "server_error" && error && (
                  <p style={styles.error}>{error}</p>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* A3/I54 — Fixed submit bar: only shown on review step, always visible regardless of scroll */}
      {step === "review" && (
        <div style={{
          position: "fixed" as const,
          bottom: 0,
          left: 0,
          right: 0,
          background: "#F6F3F2",
          padding: `12px 24px env(safe-area-inset-bottom, 16px)`,
          display: "flex",
          flexDirection: "column" as const,
          gap: 8,
          zIndex: 10,
        }}>
          {/* GPS captured indicator */}
          {gpsLatitude !== null && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#006d37", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: "#006d37" }}>
                {t('review.gps_captured_note', 'GPS location captured and attached to this report')}
              </span>
            </div>
          )}
          {/* Submit button */}
          <button
            style={{
              width: "100%",
              height: 48,
              background: (preparingPhotos || submitting || photos.length === 0) ? "#E4E2E1" : "linear-gradient(135deg, #0468B1, #00508A)",
              color: (preparingPhotos || submitting || photos.length === 0) ? "#717782" : "#FFFFFF",
              border: "none",
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 700,
              cursor: (preparingPhotos || submitting || photos.length === 0) ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontFamily: "inherit",
              boxShadow: (preparingPhotos || submitting || photos.length === 0) ? "none" : "0 4px 12px rgba(4,104,177,0.3)",
              transition: "opacity 0.15s",
            }}
            onClick={() => void handleSubmit()}
            disabled={preparingPhotos || submitting || photos.length === 0}
          >
            {preparingPhotos ? t('report.preparing_photos') : submitting ? t("report.submitting") : t("report.submit")}
            {!preparingPhotos && !submitting && (
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>arrow_forward</span>
            )}
          </button>
          {/* Privacy note */}
          <p style={{ textAlign: "center" as const, fontSize: 11, color: "#717782", lineHeight: 1.5, margin: 0 }}>
            {t('report.review_privacy_note', 'Your report will be reviewed by UNDP and used to coordinate crisis response')}
          </p>
        </div>
      )}

      {/* Photo step fixed footer */}
      {step === "photos" && (
        <div style={{
          position: "fixed" as const,
          bottom: 0,
          left: 0,
          right: 0,
          background: "#F6F3F2",
          padding: "16px 24px",
          display: "flex",
          zIndex: 10,
        }}>
          <button
            style={{
              flex: 1,
              height: 48,
              background: photos.length > 0 ? "linear-gradient(135deg, #0468B1, #00508A)" : "#E4E2E1",
              color: photos.length > 0 ? "#FFFFFF" : "#717782",
              border: "none",
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 700,
              cursor: photos.length > 0 ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontFamily: "inherit",
              boxShadow: photos.length > 0 ? "0 4px 12px rgba(4,104,177,0.3)" : "none",
            }}
            disabled={photos.length === 0}
            onClick={() => setStep("location")}
          >
            {t('common.next')}
          </button>
        </div>
      )}

      {/* Always-rendered replace file input — used from both photo step and review step */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/bmp,image/tiff"
        style={{ display: "none" }}
        onChange={handleReplaceInputChange}
      />

      {/* Camera preview overlay */}
      {cameraActive && (
        <div style={styles.cameraOverlay}>
          <video ref={videoRef} autoPlay playsInline muted style={styles.cameraVideo} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={styles.cameraControls}>
            <button style={styles.cameraCaptureBtn} onClick={handleCapturePhoto}>{t('report.capture_btn')}</button>
            <button style={styles.cameraCancelBtn} onClick={handleCameraCancel}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {/* Photo full-screen viewer overlay */}
      {viewingPhoto && (
        <div
          style={styles.viewerOverlay}
          onClick={() => setViewingPhoto(null)}
        >
          <button
            style={styles.viewerClose}
            onClick={(e) => { e.stopPropagation(); setViewingPhoto(null); }}
          >
            ×
          </button>
          <img
            src={viewingPhotoUrl ?? ""}
            alt="Full size photo"
            style={styles.viewerImage}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Duplicate submission warning modal (submit-time) */}
      {showDupeWarning && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>{t('report.dupe_title')}</h3>
            <p style={styles.modalBody}>
              {t('report.dupe_body')}
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button style={{ ...styles.secondaryButton, flex: 1 }} onClick={() => setShowDupeWarning(false)}>
                {t('common.go_back')}
              </button>
              <button style={{ ...styles.primaryButton, flex: 1 }} onClick={() => void doSubmit(submissionSubmittedAt)}>
                {t('report.dupe_submit_anyway')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: "100dvh",
    background: "#F6F3F2",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    position: "sticky" as const,
    top: 0,
    zIndex: 50,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    height: 56,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    flexShrink: 0,
    boxSizing: "border-box" as const,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 22,
    cursor: "pointer",
    minWidth: 44,
    minHeight: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    color: "#1B1C1C",
    fontSize: 17,
    fontWeight: 600,
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap" as const,
  },
  content: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  step: {
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  stepTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: "#1A2B4A",
  },
  guidelineList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  guidelineItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
  },
  dropZone: {
    borderRadius: 10,
    padding: "28px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "border-color 0.15s, background 0.15s",
    minHeight: 110,
  },
  addAnotherBtn: {
    padding: "8px 16px",
    border: "1px solid #0468B1",
    borderRadius: 8,
    color: "#0468B1",
    background: "transparent",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  locationPanel: {
    padding: "16px 16px 20px",
    background: "#fff",
    borderRadius: "16px 16px 0 0",
    boxShadow: "0 -8px 32px rgba(0,0,0,0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    overflowY: "auto",
    maxHeight: 400,
    flexShrink: 0,
  },
  selectionCard: {
    background: "#F6F3F2",
    borderRadius: 12,
    padding: "12px 16px",
  },
  selectionCardTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#717782",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    marginBottom: 4,
  },
  selectionCardName: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1B1C1C",
    marginTop: 2,
    lineHeight: 1.3,
  },
  selectionCardMeta: {
    fontSize: 12,
    color: "#717782",
    marginTop: 2,
  },
  selectionCardCoords: {
    fontSize: 11,
    color: "#717782",
    marginTop: 6,
    fontVariantNumeric: "tabular-nums",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  // B3/B11 — Desktop floating confirmation card
  confirmCardDesktop: {
    position: "absolute" as const,
    bottom: 80,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
    padding: 20,
    minWidth: 280,
  },
  // B3/B12 — Mobile bottom sheet
  bottomSheet: {
    position: "fixed" as const,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    background: "#fff",
    borderRadius: "16px 16px 0 0",
    padding: "20px 20px 32px",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.15)",
  },
  bottomSheetHandle: {
    width: 40,
    height: 4,
    background: "#E2E8F0",
    borderRadius: 2,
    margin: "0 auto 16px",
  },
  confirmBuildingName: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 4,
  },
  confirmBuildingType: {
    fontSize: 13,
    color: "#717782",
    textTransform: "capitalize" as const,
    marginBottom: 2,
  },
  confirmBuildingCoords: {
    fontSize: 12,
    color: "#717782",
    fontVariantNumeric: "tabular-nums",
  },
  confirmCancelBtn: {
    flex: 1,
    padding: "10px 20px",
    border: "1px solid #E2E8F0",
    borderRadius: 8,
    background: "#fff",
    color: "#717782",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  confirmConfirmBtn: {
    flex: 1,
    padding: "10px 20px",
    border: "none",
    borderRadius: 8,
    background: "#0468B1",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  // B10 — Inline duplicate warning
  inlineDupeWarning: {
    background: "#FFF8E1",
    border: "1px solid #FFD54F",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 13,
    color: "#795548",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    justifyContent: "space-between",
  },
  inlineDupeDismiss: {
    background: "none",
    border: "none",
    color: "#795548",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
    flexShrink: 0,
  },
  // B5 — Field label
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#717782",
    letterSpacing: "0.06em",
    display: "block",
    marginBottom: 4,
  },
  // B7 — Location note textarea (underline style)
  noteTextarea: {
    width: "100%",
    padding: "10px 0",
    borderRadius: 0,
    border: "none",
    borderBottom: "2px solid #0468B1",
    fontSize: 16, // H1: must be ≥16px to prevent iOS Safari auto-zoom on focus
    outline: "none",
    background: "transparent",
    boxSizing: "border-box" as const,
    resize: "none" as const,
    fontFamily: "inherit",
    lineHeight: 1.5,
  },
  gpsButton: {
    padding: "10px 16px",
    background: "transparent",
    color: "#0468B1",
    border: "1.5px solid #0468B1",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    fontFamily: "inherit",
  },
  manualToggle: {
    background: "none",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    cursor: "pointer",
    textAlign: "left" as const,
    padding: 0,
    textDecoration: "underline",
  },
  zoomHint: {
    position: "absolute",
    bottom: 12,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(26,43,74,0.82)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 500,
    padding: "6px 14px",
    borderRadius: 20,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 10,
  },
  optionBtn: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "16px",
    borderRadius: 10,
    border: "1.5px solid",
    cursor: "pointer",
    background: "#fff",
    textAlign: "left",
    transition: "all 0.15s",
  },
  optionIcon: {
    fontSize: 28,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "#1A2B4A",
    textAlign: "left" as const,
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    fontSize: 16, // H1: must be ≥16px to prevent iOS Safari auto-zoom on focus
    outline: "none",
    background: "#fff",
    boxSizing: "border-box" as const,
  },
  photoHint: {
    fontSize: 14,
    color: "#666",
  },
  photoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
  },
  photoThumb: {
    position: "relative",
    aspectRatio: "1",
    borderRadius: 8,
    overflow: "visible",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: 8,
    display: "block",
  },
  thumbPopover: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
    display: "flex",
    flexDirection: "column" as const,
    zIndex: 100,
    overflow: "hidden",
    minWidth: 100,
  },
  thumbAction: {
    padding: "10px 16px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid #f0f0f0",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left" as const,
    color: "#1A2B4A",
  },
  navButtons: {
    display: "flex",
    gap: 12,
    marginTop: 8,
  },
  primaryButton: {
    flex: 1,
    height: 48,
    background: "linear-gradient(135deg, #0468B1, #00508A)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "inherit",
    boxShadow: "0 4px 12px rgba(4,104,177,0.25)",
  },
  secondaryButton: {
    height: 48,
    padding: "0 20px",
    background: "transparent",
    color: "#0468B1",
    border: "none",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  reviewCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "4px 0",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  reviewRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  reviewLabel: {
    fontSize: 14,
    color: "#666",
  },
  reviewValue: {
    fontSize: 14,
    fontWeight: 500,
    color: "#1A2B4A",
    maxWidth: "60%",
    textAlign: "right",
  },
  reviewDataCard: {
    background: "#F6F3F2",
    borderRadius: 12,
    padding: "12px 16px",
  },
  reviewDataLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "#717782",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    margin: "0 0 4px",
  },
  reviewDataValue: {
    fontSize: 15,
    fontWeight: 700,
    color: "#1B1C1C",
    lineHeight: 1.4,
    margin: 0,
  },
  offlineNotice: {
    background: "#fff3e0",
    border: "1px solid #ffcc02",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    color: "#e65100",
  },
  successContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "48px 24px 40px",
    textAlign: "center",
    minHeight: "100dvh",
    background: "#fcf9f8",
  },
  successTitle: {
    fontSize: 36,
    fontWeight: 700,
    color: "#1B1C1C",
    lineHeight: 1.2,
    marginBottom: 12,
  },
  successText: {
    fontSize: 16,
    color: "#717782",
    lineHeight: 1.6,
    marginBottom: 32,
    paddingLeft: 8,
    paddingRight: 8,
  },
  error: {
    color: "#d32f2f",
    fontSize: 14,
    textAlign: "center",
  },
  questionProgress: {
    fontSize: 10,
    fontWeight: 700,
    color: "#0468B1",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    marginBottom: 8,
  },
  radioOption: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px 18px",
    minHeight: 52,
    borderRadius: 12,
    border: "2px solid transparent",
    marginBottom: 8,
    cursor: "pointer",
    transition: "border 0.12s, background 0.12s",
    boxSizing: "border-box" as const,
  },
  questionTitle: {
    fontSize: 24,
    fontWeight: 700,
    color: "#1B1C1C",
    lineHeight: 1.3,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    flexShrink: 0,
    boxSizing: "border-box" as const,
    transition: "border 0.12s",
  },
  radioLabel: {
    fontSize: "0.9rem",
    color: "#1A2B4A",
    lineHeight: 1.4,
    textAlign: "left" as const,
  },
  categoryHeading: {
    fontSize: "0.7rem",
    fontWeight: 700,
    color: "#717782",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    marginTop: 12,
    marginBottom: 6,
  },
  navButtonsSticky: {
    display: "flex",
    gap: 12,
    marginTop: 16,
    position: "sticky" as const,
    bottom: 0,
    background: "#F6F3F2",
    padding: "12px 0",
    zIndex: 5,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    minHeight: 52,
    borderRadius: 12,
    border: "2px solid transparent",
    marginBottom: 8,
    cursor: "pointer",
    transition: "border 0.12s, background 0.12s",
    boxSizing: "border-box" as const,
  },
  checkbox: {
    width: 22,
    height: 22,
    border: "2px solid #C1C7D2",
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxSelected: {
    border: "2px solid #0468B1",
    background: "#0468B1",
  },
  checkmark: {
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
  },
  checkRowText: {
    fontSize: 15,
    color: "#1A2B4A",
    textAlign: "left" as const,
  },
  charCounter: {
    fontSize: 12,
    color: "#999",
    textAlign: "right" as const,
  },
  centeredMessage: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    gap: 20,
    textAlign: "center",
    minHeight: "100dvh",
  },
  centeredError: {
    fontSize: 16,
    color: "#d32f2f",
    textAlign: "center",
  },
  confirmCheckCircle: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    background: "linear-gradient(145deg, #27AE60, #1E8449)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginBottom: 24,
    boxShadow: "0 8px 32px rgba(39,174,96,0.28)",
  },
  confirmRef: {
    fontSize: 14,
    color: "#666",
    fontVariantNumeric: "tabular-nums",
    background: "#f4f6f9",
    padding: "8px 20px",
    borderRadius: 20,
    letterSpacing: "0.05em",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "0 20px",
  },
  modalBox: {
    background: "#fff",
    borderRadius: 14,
    padding: "28px 24px",
    maxWidth: 380,
    width: "100%",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 12,
  },
  modalBody: {
    fontSize: 15,
    color: "#444",
    lineHeight: 1.55,
    marginBottom: 4,
  },
  reviewSection: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 28,
  },
  reviewSectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  reviewSectionTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1B1C1C",
  },
  editLink: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  reviewPhotoThumb: {
    width: 80,
    height: 80,
    objectFit: "cover" as const,
    borderRadius: 8,
    flexShrink: 0,
  },
  reviewPhotoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 8,
    background: "#f0f4f8",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 32,
    flexShrink: 0,
  },
  permNote: {
    fontSize: 13,
    color: "#717782",
    margin: 0,
    lineHeight: 1.5,
  },
  denialBox: {
    background: "#FFF8F0",
    border: "1px solid #F6AD55",
    borderRadius: 8,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  denialMsg: {
    fontSize: 14,
    color: "#C05621",
    margin: 0,
    lineHeight: 1.5,
  },
  denialHint: {
    fontSize: 13,
    color: "#A0AEC0",
    margin: 0,
    lineHeight: 1.5,
  },
  cameraBtn: {
    padding: "14px 16px",
    background: "#1A2B4A",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
  },
  uploadBtn: {
    padding: "14px 16px",
    background: "#fff",
    color: "#1A2B4A",
    border: "1.5px solid #e0e0e0",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
  },
  cameraOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "#000",
    zIndex: 2000,
    display: "flex",
    flexDirection: "column" as const,
  },
  cameraVideo: {
    flex: 1,
    width: "100%",
    objectFit: "cover" as const,
  },
  cameraControls: {
    padding: "16px 20px 32px",
    display: "flex",
    gap: 12,
    background: "rgba(0,0,0,0.8)",
  },
  cameraCaptureBtn: {
    flex: 1,
    padding: "16px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 17,
    fontWeight: 700,
    cursor: "pointer",
  },
  cameraCancelBtn: {
    padding: "16px 20px",
    background: "transparent",
    color: "#fff",
    border: "1.5px solid rgba(255,255,255,0.4)",
    borderRadius: 10,
    fontSize: 15,
    cursor: "pointer",
  },
  viewerOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.92)",
    zIndex: 3000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerClose: {
    position: "absolute" as const,
    top: 16,
    right: 16,
    background: "rgba(255,255,255,0.15)",
    border: "none",
    color: "#fff",
    fontSize: 28,
    width: 44,
    height: 44,
    borderRadius: "50%",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  viewerImage: {
    maxWidth: "90vw",
    maxHeight: "90vh",
    objectFit: "contain" as const,
    borderRadius: 8,
  },
  photoSlotActive: {
    aspectRatio: "1",
    borderRadius: 12,
    border: "2px dashed #0468B1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(4,104,177,0.05)",
    cursor: "pointer",
  },
  photoSlotFaded: {
    aspectRatio: "1",
    borderRadius: 12,
    border: "2px dashed #C1C7D2",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#F6F3F2",
  },
  thumbRemoveBtn: {
    position: "absolute" as const,
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "#BA1A1A",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    zIndex: 1,
  },
  photoActionBtn: {
    width: "100%",
    height: 48,
    border: "2px solid #0468B1",
    borderRadius: 12,
    background: "transparent",
    color: "#0468B1",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontFamily: "inherit",
  },
};
