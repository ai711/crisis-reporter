import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// B2 — Geocoding search bar (styles are embedded in the Lit web component — no CSS import needed)
// Requires VITE_MAPTILER_KEY to be set in .env for search to function
import { GeocodingControl } from "@maptiler/geocoding-control/maplibregl";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { addToQueue } from "../utils/offlineQueue";
import { validatePhoto } from "../utils/photoValidation";
import { compressPhoto } from "../utils/photoCompression";
import { extractExif } from "../utils/exifExtraction";
import SubmissionStepper, { type StepperStep } from "../components/SubmissionStepper";
import type { DamageLevel, QueuedPhoto } from "../types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
const MAP_STYLE = `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`;

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
    (navigator.maxTouchPoints > 1 && /MacIntel/.test(navigator.platform))
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

// ── Question package types ─────────────────────────────────────────────────────

interface ApiOption { option_text: string; option_value: string; }
interface ApiQuestion { question_text: string; order_index: number; options: ApiOption[]; }
interface ActivePackage { version: string; questions: ApiQuestion[]; }

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
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    });
    if (!res.ok) return;
    const data: OverpassResponse = await res.json();
    (mapInstance.getSource("buildings") as maplibregl.GeoJSONSource | undefined)?.setData(
      buildingsGeoJSON(data)
    );
  } catch { /* silent — buildings are non-critical */ }
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
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(null);
  const [showDupeWarning, setShowDupeWarning] = useState(false);
  const [error, setError] = useState("");
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);
  const [questionPackage, setQuestionPackage] = useState<ActivePackage | null>(null);

  // Refs
  const isSubmittedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gpsMarkerRef = useRef<maplibregl.Marker | null>(null); // B9
  const pinMarkerRef = useRef<maplibregl.Marker | null>(null); // B6

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
          fetch(
            `https://api.maptiler.com/geocoding/${encodeURIComponent(cc)}.json?key=${MAPTILER_KEY}&types=country`,
            { signal: AbortSignal.timeout(5000) }
          )
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { features?: Array<{ bbox?: number[]; center?: [number, number] }> } | null) => {
              const feature = data?.features?.[0];
              if (!feature) return;
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
            .catch(() => { /* silent — map stays at world view */ });
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
          debounceTimer.current = setTimeout(() => fetchBuildingsForMap(mapInstance), 1000);
        }
      });

      const initialZoom = mapInstance.getZoom();
      setLocationMapZoom(initialZoom);
      if (initialZoom >= 14) fetchBuildingsForMap(mapInstance);
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

  // beforeunload fires on browser back, tab close, URL change, and external link clicks.
  // It does NOT fire on React router navigate() calls — those are client-side.
  // The App.tsx route guard handles in-app navigation guards separately if needed.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isSubmittedRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // Required for Chrome — triggers the browser's generic prompt
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

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

  // ── Duplicate / submit helpers ────────────────────────────────────────────────

  // G5 — Use centroid/pin/GPS in order of priority for duplicate checks
  const checkDuplicate = (): boolean => {
    const lat = buildingCentroidLat ?? pinDropCoords?.lat ?? gpsLatitude;
    const lng = buildingCentroidLng ?? pinDropCoords?.lng ?? gpsLongitude;
    if (!lat || !lng || !crisisId) return false;
    try {
      const raw = localStorage.getItem("cr_submitted_locations");
      if (!raw) return false;
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number }> =
        JSON.parse(raw);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return locs.some(
        (l) =>
          l.crisis_id === crisisId &&
          Math.abs(l.lat - lat) < 0.001 &&
          Math.abs(l.lng - lng) < 0.001 &&
          l.timestamp > cutoff
      );
    } catch {
      return false;
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
      localStorage.setItem("cr_submitted_locations", JSON.stringify(locs));
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
    setStep("photos");
  };

  // G5 — Valid if any usable coordinate or text field is filled
  const isLocationValid = (): boolean =>
    (gpsLatitude !== null && gpsLongitude !== null) ||
    buildingCentroidLat !== null ||
    pinDropCoords !== null ||
    locationAddress.trim().length > 0 ||
    locationLandmark.trim().length > 0 ||
    locationBuildingName.trim().length > 0;

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

  const doSubmit = async () => {
    setShowDupeWarning(false);
    setError("");

    // Phase 1 — compress photos and extract EXIF (both run before the network call)
    setPreparingPhotos(true);
    let compressedPhotos: File[];
    let photoMetadata: Array<{ compressed: boolean; original_size_kb: number; compressed_size_kb: number }>;
    let exifResults: Array<Record<string, unknown>>;
    try {
      const compressionResults = await Promise.all(photos.map(compressPhoto));
      compressedPhotos = compressionResults.map((r) => r.file);
      photoMetadata = compressionResults.map((r) => ({
        compressed: r.compressed,
        original_size_kb: r.original_size_kb,
        compressed_size_kb: r.compressed_size_kb,
      }));
      exifResults = await Promise.all(photos.map(extractExif)) as Array<Record<string, unknown>>;
    } finally {
      setPreparingPhotos(false);
    }

    // Phase 2 — transmit
    setSubmitting(true);

    const submissionSubmittedAt = new Date().toISOString();

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
      platform: "web" as const,
      submission_started_at: submissionStartTime,
      submission_submitted_at: submissionSubmittedAt,
      photo_metadata: JSON.stringify(photoMetadata),
      photo_exif_data: JSON.stringify(exifResults),
      location: {
        // G5 — Actual device GPS (never overwritten by building centroid)
        gps_latitude: gpsLatitude,
        gps_longitude: gpsLongitude,
        gps_accuracy_meters: gpsAccuracy,
        // C5 — explicit flags: gps_available set in success callback, gps_denied in denial callback
        gps_available: gpsAvailable,
        gps_denied: gpsDenied,
        // G5 — Building footprint centroid (separate from device GPS)
        building_centroid_lat: buildingCentroidLat,
        building_centroid_lng: buildingCentroidLng,
        building_id: selectedBuildingId,
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
      reporter_id: reporterId || undefined,
      language_code: languageCode,
      question_package_version: questionPackage?.version ?? null,
      was_queued: false,
      browser_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen_resolution: `${window.screen.width}x${window.screen.height}`,
      viewport_dimensions: `${window.innerWidth}x${window.innerHeight}`,
    };

    if (!navigator.onLine) {
      const queuedPhotos: QueuedPhoto[] = compressedPhotos.map((file, index) => ({
        blob: file,
        filename: file.name,
        content_type: file.type,
        display_order: index,
      }));
      await addToQueue({ ...reportPayload, was_queued: true }, queuedPhotos);
      saveSubmittedLocation();
      setWasQueued(true);
      setSubmittedReportId(null);
      isSubmittedRef.current = true;
      setSubmitted(true);
      setSubmitting(false);
      return;
    }

    try {
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      for (let i = 0; i < compressedPhotos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", compressedPhotos[i]);
        await api.post("/api/photos", formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }

      saveSubmittedLocation();

      try {
        const summary = {
          id: reportId as string,
          damage_level: damageLevel,
          infrastructure_types: infrastructureTypes,
          location_address: buildLocationAddress(),
          gps_latitude: gpsLatitude,
          gps_longitude: gpsLongitude,
          submitted_at: submissionSubmittedAt,
        };
        const existing: unknown[] = JSON.parse(
          sessionStorage.getItem("cr_session_reports") || "[]"
        );
        existing.push(summary);
        sessionStorage.setItem("cr_session_reports", JSON.stringify(existing));
      } catch { /* non-critical */ }

      setSubmittedReportId(reportId as string);
      setWasQueued(false);
      isSubmittedRef.current = true;
      setSubmitted(true);
    } catch {
      setError(t("report.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!damageLevel || infrastructureTypes.length === 0 || !infrastructureName.trim() || !disasterType || !debrisBlocking || !electricityCondition || !healthServicesCondition || pressingNeeds.length === 0 || photos.length === 0) {
      setError("Please complete all required fields");
      return;
    }
    if (checkDuplicate()) {
      setShowDupeWarning(true);
      return;
    }
    await doSubmit();
  };

  // ── Success screen ────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div style={styles.container}>
        <div style={styles.successContainer}>
          <div style={styles.confirmCheckCircle}>
            <span style={{ fontSize: 44, lineHeight: 1 }}>✓</span>
          </div>
          <h2 style={styles.successTitle}>
            {wasQueued ? "Report Saved" : "Report Submitted"}
          </h2>
          <p style={styles.successText}>
            {wasQueued
              ? "Your report has been saved and will be sent automatically when you reconnect to the internet."
              : "Thank you for helping UNDP map crisis damage. Your report has been received and is now part of the crisis map."}
          </p>
          <p style={styles.confirmRef}>
            {wasQueued
              ? "Your report is queued"
              : `Report ref: ${(submittedReportId ?? "").slice(0, 8).toUpperCase()}`}
          </p>
          <button style={styles.primaryButton} onClick={resetForm}>
            Submit Another Report
          </button>
          <button
            style={{ ...styles.secondaryButton, border: "none", color: "#666", fontSize: 15 }}
            onClick={() => navigate("/")}
          >
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  if (crisisLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.centeredMessage}>
          <div style={{ fontSize: 16, color: "#666" }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (crisisError || !crisisId) {
    return (
      <div style={styles.container}>
        <div style={styles.centeredMessage}>
          <p style={styles.centeredError}>No active crisis found. Please try again later.</p>
          <button style={styles.secondaryButton} onClick={() => navigate(-1)}>Go Back</button>
        </div>
      </div>
    );
  }

  // ── Guidelines state ──────────────────────────────────────────────────────────
  const guidelinesPass = photos.length > 0;
  const GUIDELINES = [
    t("photo_guidelines.guideline_1"),
    t("photo_guidelines.guideline_2"),
    t("photo_guidelines.guideline_3"),
    t("photo_guidelines.guideline_4"),
  ];

  // ── Photo step sub-components ─────────────────────────────────────────────────

  const renderPhotoThumbnails = () => (
    <div style={styles.photoGrid}>
      {photos.map((photo, index) => (
        <div
          key={index}
          style={{ ...styles.photoThumb, cursor: "pointer" }}
          onClick={() => setSelectedPhotoIndex(selectedPhotoIndex === index ? null : index)}
        >
          <img src={URL.createObjectURL(photo)} style={styles.thumbImg} alt={`Photo ${index + 1}`} />
          {selectedPhotoIndex === index && (
            <div style={styles.thumbPopover} onClick={(e) => e.stopPropagation()}>
              <button
                style={styles.thumbAction}
                onClick={() => {
                  setViewingPhoto(photo);
                  setSelectedPhotoIndex(null);
                }}
              >
                View
              </button>
              <button
                style={styles.thumbAction}
                onClick={() => {
                  setReplaceIndex(index);
                  setSelectedPhotoIndex(null);
                  replaceInputRef.current?.click();
                }}
              >
                Replace
              </button>
              <button
                style={{ ...styles.thumbAction, color: "#E53E3E" }}
                onClick={() => handlePhotoRemove(index)}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const renderAddAnotherButton = () => {
    if (isMobile) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          {!cameraDenied && (
            <button
              style={styles.addAnotherBtn}
              onClick={() => void handleTakePhoto()}
            >
              + Take Another Photo
            </button>
          )}
          <button style={styles.addAnotherBtn} onClick={() => fileInputRef.current?.click()}>
            + Upload Another Photo
          </button>
        </div>
      );
    }
    return (
      <button style={styles.addAnotherBtn} onClick={() => fileInputRef.current?.click()}>
        + Add another photo
      </button>
    );
  };

  const renderDesktopDropZone = () => (
    <div
      style={{
        ...styles.dropZone,
        border: isDragging ? "2px dashed #0468B1" : "2px dashed #E2E8F0",
        background: isDragging ? "#F0F4FF" : "transparent",
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging ? (
        <span style={{ color: "#0468B1", fontWeight: 600, fontSize: 15 }}>Drop your photo here</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, color: "#717782" }}>Drag a photo here, or</span>
          <button style={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
            📁 Upload a Photo
          </button>
        </div>
      )}
    </div>
  );

  const renderMobileButtons = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!cameraDenied && (
        <p style={styles.permNote}>
          Crisis Reporter needs camera access to take a photo of the damage.
        </p>
      )}
      {cameraDenied && (
        <div style={styles.denialBox}>
          <p style={styles.denialMsg}>
            Camera access is not available. You can enable it in your browser settings, or upload a photo from your device instead.
          </p>
          <p style={styles.denialHint}>
            To enable camera access, open your browser settings and allow camera access for this site.
          </p>
        </div>
      )}
      {!cameraDenied && (
        <button style={styles.cameraBtn} onClick={() => void handleTakePhoto()}>
          📷 Take a Photo
        </button>
      )}
      <button style={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
        📁 Upload a Photo
      </button>
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("report.title")}</h1>
      </div>

      {/* 5-step labeled stepper */}
      <SubmissionStepper currentStep={getStepperStep(step, submitting)} />

      {/* Content */}
      <div style={{ ...styles.content, overflow: step === "location" ? "hidden" : "auto" }}>

        {/* Step 1 — Photos */}
        {step === "photos" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>{t("report.photos")} *</h2>

            <ul style={styles.guidelineList}>
              {GUIDELINES.map((text, i) => (
                <li key={i} style={styles.guidelineItem}>
                  <span style={{ color: guidelinesPass ? "#38A169" : "#CBD5E0", fontSize: 14, flexShrink: 0 }}>
                    {guidelinesPass ? "✓" : "●"}
                  </span>
                  <span style={{ color: "#717782", fontSize: "0.8rem" }}>{text}</span>
                </li>
              ))}
            </ul>

            {photos.length > 0 && renderPhotoThumbnails()}

            {photos.length === 0 && (
              isMobile ? renderMobileButtons() : renderDesktopDropZone()
            )}
            {photos.length > 0 && photos.length < 3 && renderAddAnotherButton()}
            {photos.length === 3 && (
              <p style={{ fontSize: 13, color: "#717782", margin: 0 }}>Maximum 3 photos added.</p>
            )}

            {dropExtraMessage && (
              <p style={{ fontSize: 13, color: "#717782", margin: 0 }}>{dropExtraMessage}</p>
            )}

            {photoError && (
              <p style={{ fontSize: "0.85rem", color: "#E53E3E", margin: 0 }}>{photoError}</p>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/bmp,image/tiff"
              multiple
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
            <input
              ref={replaceInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/bmp,image/tiff"
              style={{ display: "none" }}
              onChange={handleReplaceInputChange}
            />

            <button
              style={{ ...styles.primaryButton, opacity: photos.length > 0 ? 1 : 0.5 }}
              disabled={photos.length === 0}
              onClick={() => setStep("location")}
            >
              Next →
            </button>
          </div>
        )}

        {/* Step 2 — Location */}
        {step === "location" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>

            {/* D2/E1 — Amber banner: offline on arrival OR mid-session drop */}
            {locationOffline && (
              <div style={{
                background: "#FEF3C7",
                border: "1px solid #F5A623",
                borderRadius: 8,
                padding: "12px 16px",
                margin: "8px 12px 0",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexShrink: 0,
              }}>
                <span style={{ color: "#F5A623", fontSize: 20 }}>⚠</span>
                <span style={{ color: "#92400E", fontSize: "0.875rem", fontWeight: 500 }}>
                  {t("location.offline_banner")}
                </span>
              </div>
            )}

            {/* D1 — Map area: suppressed when offline on arrival; kept when mid-session drop */}
            {(!locationOffline || connectionLostMidSession) && (
            <div style={{ flex: 1, position: "relative", minHeight: 260 }}>
              <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />
              {locationMapZoom < 14 && (
                <div style={styles.zoomHint}>Zoom in to see and select buildings</div>
              )}

              {/* B3/B11 — Desktop: floating confirmation card */}
              {pendingBuilding && !isMobile && (
                <div style={styles.confirmCardDesktop}>
                  <div style={styles.confirmBuildingName}>
                    {pendingBuilding.name || "Unnamed Building"}
                  </div>
                  <div style={styles.confirmBuildingType}>
                    {pendingBuilding.type !== "yes"
                      ? pendingBuilding.type.replace(/_/g, " ")
                      : "Building"}
                  </div>
                  <div style={styles.confirmBuildingCoords}>
                    {Math.abs(pendingBuilding.lat).toFixed(4)}°{pendingBuilding.lat >= 0 ? "N" : "S"},{" "}
                    {Math.abs(pendingBuilding.lng).toFixed(4)}°{pendingBuilding.lng >= 0 ? "E" : "W"}
                  </div>
                  <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid #E2E8F0" }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={styles.confirmCancelBtn} onClick={handleBuildingCancel}>Cancel</button>
                    <button style={styles.confirmConfirmBtn} onClick={handleBuildingConfirm}>Confirm</button>
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
                  {pendingBuilding.name || "Unnamed Building"}
                </div>
                <div style={styles.confirmBuildingType}>
                  {pendingBuilding.type !== "yes"
                    ? pendingBuilding.type.replace(/_/g, " ")
                    : "Building"}
                </div>
                <div style={styles.confirmBuildingCoords}>
                  {Math.abs(pendingBuilding.lat).toFixed(4)}°{pendingBuilding.lat >= 0 ? "N" : "S"},{" "}
                  {Math.abs(pendingBuilding.lng).toFixed(4)}°{pendingBuilding.lng >= 0 ? "E" : "W"}
                </div>
                <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid #E2E8F0" }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={styles.confirmCancelBtn} onClick={handleBuildingCancel}>Cancel</button>
                  <button style={styles.confirmConfirmBtn} onClick={handleBuildingConfirm}>Confirm</button>
                </div>
              </div>
            )}

            {/* Bottom panel */}
            <div style={styles.locationPanel}>
              <h2 style={{ ...styles.stepTitle, marginBottom: 4 }}>{t("report.location")}</h2>

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

              {/* D4 — GPS captured while offline */}
              {locationOffline && gpsLatitude !== null && (
                <p style={{ color: "#065F46", fontSize: "0.8rem", margin: "0 0 4px" }}>
                  {t("location.offline_gps_captured")}
                </p>
              )}

              {/* E3 — No internet and no GPS */}
              {locationOffline && gpsLatitude === null && (
                <p style={{ color: "#717782", fontSize: "0.8rem", margin: "0 0 4px" }}>
                  {t("location.offline_no_gps")}
                </p>
              )}

              {/* Selection state card */}
              {selectedBuildingId && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>Building Selected</div>
                  <div style={styles.selectionCardName}>
                    {selectedBuildingName || "Unnamed building"}
                  </div>
                  {selectedBuildingType && selectedBuildingType !== "yes" && (
                    <div style={styles.selectionCardMeta}>
                      Type: {selectedBuildingType.replace(/_/g, " ")}
                    </div>
                  )}
                  {buildingCentroidLat !== null && buildingCentroidLng !== null && (
                    <div style={styles.selectionCardCoords}>
                      {buildingCentroidLat.toFixed(6)}, {buildingCentroidLng.toFixed(6)}
                    </div>
                  )}
                </div>
              )}
              {!selectedBuildingId && pinDropCoords && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>Pin Dropped</div>
                  <div style={styles.selectionCardCoords}>
                    {pinDropCoords.lat.toFixed(6)}, {pinDropCoords.lng.toFixed(6)}
                  </div>
                </div>
              )}
              {!selectedBuildingId && !pinDropCoords && gpsLatitude !== null && gpsLongitude !== null && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>GPS Location Captured</div>
                  <div style={styles.selectionCardCoords}>
                    {gpsLatitude.toFixed(6)}, {gpsLongitude.toFixed(6)}
                  </div>
                </div>
              )}

              {/* B10 — Inline duplicate warning (dismissible, non-blocking) */}
              {showDuplicateInlineWarning && (
                <div style={styles.inlineDupeWarning}>
                  <span>
                    A report for this location may already exist from this device. You can still
                    submit if this is a different incident.
                  </span>
                  <button
                    style={styles.inlineDupeDismiss}
                    onClick={() => setShowDuplicateInlineWarning(false)}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* B5 — Editable building name (after building confirmed or pin dropped) */}
              {(selectedBuildingId || pinDropCoords) && (
                <div>
                  <label style={styles.fieldLabel}>BUILDING NAME</label>
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Building name (optional)"
                    value={selectedBuildingName}
                    onChange={(e) => setSelectedBuildingName(e.target.value)}
                  />
                </div>
              )}

              {/* B7/B8 — Optional location note (after building confirmed or pin dropped) */}
              {(selectedBuildingId || pinDropCoords) && (
                <div>
                  <label style={styles.fieldLabel}>
                    ADD A LOCATION NOTE (OPTIONAL){" "}
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
                    placeholder="e.g. Blue gate on the left, next to the pharmacy"
                    value={locationNote}
                    onChange={(e) => setLocationNote(e.target.value)}
                  />
                </div>
              )}

              {/* Online, GPS not yet captured, not denied — asking for permission */}
              {!locationOffline && gpsLatitude === null && !gpsDenied && (
                <p style={styles.permNote}>
                  Crisis Reporter needs your location to help identify the building you are reporting.
                </p>
              )}

              {/* C4 — Online but GPS denied: quiet inline note instead of full denial box */}
              {!locationOffline && gpsDenied && (
                <p style={{ color: "#717782", fontSize: "0.8rem", margin: "8px 0", padding: "0 4px" }}>
                  {t("location.gps_unavailable_inline")}
                </p>
              )}

              {!gpsDenied && (
                <button
                  style={styles.gpsButton}
                  onClick={() => void triggerGeolocation()}
                  disabled={gpsCapturing}
                >
                  📍 {gpsCapturing ? "Getting location…" : "Use My GPS Location"}
                </button>
              )}

              <button
                style={styles.manualToggle}
                onClick={() => setManualExpanded(!manualExpanded)}
              >
                {manualExpanded ? "Hide manual entry ▲" : "Enter location manually instead ▼"}
              </button>

              {manualExpanded && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Address"
                    value={locationAddress}
                    onChange={(e) => {
                      setLocationAddress(e.target.value);
                      if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                    }}
                  />
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Landmark (e.g. Near central market)"
                    value={locationLandmark}
                    onChange={(e) => {
                      setLocationLandmark(e.target.value);
                      if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                    }}
                  />
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Building Name"
                    value={locationBuildingName}
                    onChange={(e) => {
                      setLocationBuildingName(e.target.value);
                      if (!selectedBuildingId && !pinDropCoords) setLocationEntryMethod("manual_text");
                    }}
                  />
                </div>
              )}

              {/* H4 — Sticky on desktop so Next is always visible regardless of panel content height */}
              <div style={{
                display: "flex",
                gap: 12,
                marginTop: 8,
                ...(window.innerWidth > 768 ? {
                  position: "sticky" as const,
                  bottom: 0,
                  background: "#FFFFFF",
                  padding: "12px 0",
                  borderTop: "1px solid #E2E8F0",
                  zIndex: 5,
                } : {}),
              }}>
                <button style={styles.secondaryButton} onClick={() => setStep("photos")}>← Back</button>
                <button
                  style={{ ...styles.primaryButton, opacity: isLocationValid() ? 1 : 0.5 }}
                  disabled={!isLocationValid()}
                  onClick={() => setStep("damage")}
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3 — Damage Assessment */}
        {step === "damage" && (
          <div style={styles.step}>
            <div style={styles.questionProgress}>Question {damageQuestion} of 8</div>

            {damageQuestion === 1 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(1, "How bad is the damage? *")}</h2>
                {qOptions(1, [
                  { value: "minimal", label: "Minimal / No damage" },
                  { value: "partial", label: "Partially damaged" },
                  { value: "complete", label: "Completely damaged" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: damageLevel === value ? "#0468B1" : "#e0e0e0",
                      background: damageLevel === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDamageLevel(value as DamageLevel)}
                  >
                    <span style={styles.optionIcon}>
                      {value === "minimal" ? "🟢" : value === "partial" ? "🟠" : "🔴"}
                    </span>
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {damageQuestion === 2 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(2, "What type of infrastructure is this? *")}</h2>
                <p style={styles.photoHint}>Select all that apply.</p>
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
                  <div key={value} style={styles.checkRow} onClick={() => toggleInfraType(value)}>
                    <div style={{ ...styles.checkbox, ...(infrastructureTypes.includes(value) ? styles.checkboxSelected : {}) }}>
                      {infrastructureTypes.includes(value) && <span style={styles.checkmark}>✓</span>}
                    </div>
                    <span style={styles.checkRowText}>{label}</span>
                  </div>
                ))}
                {infrastructureTypes.includes("other") && (
                  <input
                    style={{ ...styles.input, marginTop: 8 }}
                    type="text"
                    maxLength={100}
                    placeholder="Please specify (max 100 characters)"
                    value={infrastructureOther}
                    onChange={(e) => setInfrastructureOther(e.target.value)}
                  />
                )}
              </>
            )}

            {damageQuestion === 3 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(3, "What is the name of this infrastructure? *")}</h2>
                <input
                  style={styles.input}
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Main Street Bridge"
                  value={infrastructureName}
                  onChange={(e) => setInfrastructureName(e.target.value)}
                />
                <div style={styles.charCounter}>{infrastructureName.length} / 200</div>
              </>
            )}

            {damageQuestion === 4 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(4, "What type of disaster caused this damage? *")}</h2>
                {qOptions(4, [
                  { value: "earthquake", label: "Earthquake" },
                  { value: "flood", label: "Flood" },
                  { value: "cyclone", label: "Cyclone / Typhoon / Hurricane" },
                  { value: "landslide", label: "Landslide" },
                  { value: "fire", label: "Fire" },
                  { value: "conflict", label: "Conflict / War" },
                  { value: "other", label: "Other" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: disasterType === value ? "#0468B1" : "#e0e0e0",
                      background: disasterType === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDisasterType(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {damageQuestion === 5 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(5, "Is there debris blocking access? *")}</h2>
                {qOptions(5, [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                  { value: "partially", label: "Partially" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: debrisBlocking === value ? "#0468B1" : "#e0e0e0",
                      background: debrisBlocking === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDebrisBlocking(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {damageQuestion === 6 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(6, "What is the current condition of electricity infrastructure in your community following the crisis? *")}</h2>
                {qOptions(6, [
                  { value: "no_damage", label: "No damage observed" },
                  { value: "minor", label: "Minor damage — service disruptions but quickly repairable" },
                  { value: "moderate", label: "Moderate damage — partial outages requiring repairs" },
                  { value: "severe", label: "Severe damage — major infrastructure damaged, prolonged outages" },
                  { value: "destroyed", label: "Completely destroyed — no electricity infrastructure functioning" },
                  { value: "unknown", label: "Unknown / cannot be assessed" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: electricityCondition === value ? "#0468B1" : "#e0e0e0",
                      background: electricityCondition === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setElectricityCondition(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {damageQuestion === 7 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(7, "How would you rate the overall functioning of health services in your community since the event? *")}</h2>
                {qOptions(7, [
                  { value: "fully_functional", label: "Fully functional" },
                  { value: "partially_functional", label: "Partially functional" },
                  { value: "largely_disrupted", label: "Largely disrupted" },
                  { value: "not_functioning", label: "Not functioning at all" },
                  { value: "unknown", label: "Unknown" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: healthServicesCondition === value ? "#0468B1" : "#e0e0e0",
                      background: healthServicesCondition === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setHealthServicesCondition(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {damageQuestion === 8 && (
              <>
                <h2 style={styles.stepTitle}>{qTitle(8, "What are the most pressing needs in your community right now? *")}</h2>
                <p style={styles.photoHint}>Select all that apply. At least one required.</p>
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
                  <div key={value} style={styles.checkRow} onClick={() => togglePressingNeed(value)}>
                    <div style={{ ...styles.checkbox, ...(pressingNeeds.includes(value) ? styles.checkboxSelected : {}) }}>
                      {pressingNeeds.includes(value) && <span style={styles.checkmark}>✓</span>}
                    </div>
                    <span style={styles.checkRowText}>{label}</span>
                  </div>
                ))}
                {pressingNeeds.includes("other") && (
                  <div>
                    <input
                      style={{ ...styles.input, marginTop: 8 }}
                      type="text"
                      maxLength={100}
                      placeholder="Please specify (max 100 characters)"
                      value={pressingNeedsOther}
                      onChange={(e) => setPressingNeedsOther(e.target.value)}
                    />
                    <div style={styles.charCounter}>{pressingNeedsOther.length} / 100</div>
                  </div>
                )}
              </>
            )}

            <div style={styles.navButtons}>
              <button style={styles.secondaryButton} onClick={handleDamageBack}>← Back</button>
              <button
                style={{ ...styles.primaryButton, opacity: isDamageQuestionAnswered() ? 1 : 0.5 }}
                disabled={!isDamageQuestionAnswered()}
                onClick={handleDamageNext}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — Review and Submit */}
        {step === "review" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>Review Your Report</h2>

            <div style={styles.reviewSection}>
              <div style={styles.reviewSectionHeader}>
                <span style={styles.reviewSectionTitle}>Photo</span>
                <button style={styles.editLink} onClick={() => setStep("photos")}>Edit</button>
              </div>
              <div style={styles.reviewCard}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                  {photos.length > 0 ? (
                    <img
                      src={URL.createObjectURL(photos[0])}
                      alt="Photo preview"
                      style={styles.reviewPhotoThumb}
                    />
                  ) : (
                    <div style={styles.reviewPhotoPlaceholder}>📷</div>
                  )}
                  <span style={{ fontSize: 14, color: "#666" }}>
                    {photos.length} photo{photos.length !== 1 ? "s" : ""} added
                  </span>
                </div>
              </div>
            </div>

            <div style={styles.reviewSection}>
              <div style={styles.reviewSectionHeader}>
                <span style={styles.reviewSectionTitle}>Location</span>
                <button style={styles.editLink} onClick={() => setStep("location")}>Edit</button>
              </div>
              <div style={styles.reviewCard}>
                {selectedBuildingId ? (
                  <div style={styles.reviewRow}>
                    <span style={styles.reviewLabel}>Building</span>
                    <span style={styles.reviewValue}>{selectedBuildingName || "Building selected"}</span>
                  </div>
                ) : pinDropCoords ? (
                  <div style={styles.reviewRow}>
                    <span style={styles.reviewLabel}>Pin Location</span>
                    <span style={styles.reviewValue}>
                      {pinDropCoords.lat.toFixed(4)}, {pinDropCoords.lng.toFixed(4)}
                    </span>
                  </div>
                ) : gpsLatitude !== null ? (
                  <div style={styles.reviewRow}>
                    <span style={styles.reviewLabel}>GPS</span>
                    <span style={styles.reviewValue}>
                      {gpsLatitude.toFixed(4)}, {gpsLongitude!.toFixed(4)}
                    </span>
                  </div>
                ) : locationAddress ? (
                  <div style={styles.reviewRow}>
                    <span style={styles.reviewLabel}>Address</span>
                    <span style={styles.reviewValue}>{locationAddress}</span>
                  </div>
                ) : (
                  <div style={styles.reviewRow}>
                    <span style={styles.reviewLabel}>Location</span>
                    <span style={styles.reviewValue}>Not specified</span>
                  </div>
                )}
              </div>
            </div>

            <div style={styles.reviewSection}>
              <div style={styles.reviewSectionHeader}>
                <span style={styles.reviewSectionTitle}>Questions</span>
                <button style={styles.editLink} onClick={() => { setDamageQuestion(1); setStep("damage"); }}>Edit</button>
              </div>
              <div style={styles.reviewCard}>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Damage Level</span>
                  <span style={styles.reviewValue}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Infrastructure</span>
                  <span style={styles.reviewValue}>{infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v).join(", ")}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Infrastructure Name</span>
                  <span style={styles.reviewValue}>{infrastructureName}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Disaster Type</span>
                  <span style={styles.reviewValue}>{DISASTER_LABELS[disasterType] ?? disasterType}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Debris Blocking</span>
                  <span style={styles.reviewValue}>{DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Electricity</span>
                  <span style={styles.reviewValue}>{ELECTRICITY_LABELS[electricityCondition] ?? electricityCondition}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Health Services</span>
                  <span style={styles.reviewValue}>{HEALTH_LABELS[healthServicesCondition] ?? healthServicesCondition}</span>
                </div>
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Pressing Needs</span>
                  <span style={styles.reviewValue}>
                    {pressingNeeds.map((v) => PRESSING_NEEDS_LABELS[v] ?? v).join(", ")}
                    {pressingNeeds.includes("other") && pressingNeedsOther ? ` (${pressingNeedsOther})` : ""}
                  </span>
                </div>
              </div>
            </div>

            {!navigator.onLine && (
              <div style={styles.offlineNotice}>
                📵 You are offline. This report will be saved and submitted when you reconnect.
              </div>
            )}

            {error && <p style={styles.error}>{error}</p>}

            <div style={styles.navButtons}>
              <button style={styles.secondaryButton} onClick={() => { setDamageQuestion(8); setStep("damage"); }}>
                ← Back
              </button>
              <button
                style={{ ...styles.primaryButton, opacity: (preparingPhotos || submitting) ? 0.7 : 1, flex: 1 }}
                onClick={handleSubmit}
                disabled={preparingPhotos || submitting}
              >
                {preparingPhotos ? "Preparing photos…" : submitting ? t("report.submitting") : t("report.submit")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Camera preview overlay */}
      {cameraActive && (
        <div style={styles.cameraOverlay}>
          <video ref={videoRef} autoPlay playsInline muted style={styles.cameraVideo} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={styles.cameraControls}>
            <button style={styles.cameraCaptureBtn} onClick={handleCapturePhoto}>Capture</button>
            <button style={styles.cameraCancelBtn} onClick={handleCameraCancel}>Cancel</button>
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
            src={URL.createObjectURL(viewingPhoto)}
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
            <h3 style={styles.modalTitle}>Report already submitted for this location</h3>
            <p style={styles.modalBody}>
              It looks like you may have already submitted a report for this building. Submitting again could create a duplicate. Are you sure you want to continue?
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button style={{ ...styles.secondaryButton, flex: 1 }} onClick={() => setShowDupeWarning(false)}>
                Cancel
              </button>
              <button style={{ ...styles.primaryButton, flex: 1 }} onClick={doSubmit}>
                Submit Anyway
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
    minHeight: "100vh",
    background: "#f4f6f9",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    background: "#1A2B4A",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    gap: 16,
    flexShrink: 0,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
    flex: 1,
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
    padding: "14px 16px 20px",
    background: "#fff",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    overflowY: "auto",
    maxHeight: 380,
    flexShrink: 0,
  },
  selectionCard: {
    background: "#E8F4FD",
    border: "1.5px solid #0468B1",
    borderRadius: 8,
    padding: "10px 14px",
  },
  selectionCardTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#0468B1",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  selectionCardName: {
    fontSize: 15,
    fontWeight: 600,
    color: "#1A2B4A",
    marginTop: 2,
  },
  selectionCardMeta: {
    fontSize: 12,
    color: "#718096",
    marginTop: 2,
  },
  selectionCardCoords: {
    fontSize: 11,
    color: "#718096",
    marginTop: 4,
    fontVariantNumeric: "tabular-nums",
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
  // B7 — Location note textarea
  noteTextarea: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #E2E8F0",
    fontSize: 15,
    outline: "none",
    background: "#fff",
    boxSizing: "border-box" as const,
    resize: "vertical" as const,
    fontFamily: "inherit",
    lineHeight: 1.5,
  },
  gpsButton: {
    padding: "12px 16px",
    background: "#1A2B4A",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
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
    fontSize: 15,
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
    padding: "16px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    maxHeight: 56,
  },
  secondaryButton: {
    padding: "16px 20px",
    background: "#fff",
    color: "#1A2B4A",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
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
    justifyContent: "center",
    padding: "40px 24px",
    gap: 20,
    textAlign: "center",
    minHeight: "100vh",
  },
  successTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  successText: {
    fontSize: 16,
    color: "#666",
    lineHeight: 1.6,
  },
  error: {
    color: "#d32f2f",
    fontSize: 14,
    textAlign: "center",
  },
  questionProgress: {
    fontSize: 13,
    fontWeight: 600,
    color: "#0468B1",
    textAlign: "center" as const,
    marginBottom: 4,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 4px",
    borderBottom: "1px solid #f0f0f0",
    cursor: "pointer",
  },
  checkbox: {
    width: 22,
    height: 22,
    border: "2px solid #ccc",
    borderRadius: 4,
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
    minHeight: "100vh",
  },
  centeredError: {
    fontSize: 16,
    color: "#d32f2f",
    textAlign: "center",
  },
  confirmCheckCircle: {
    width: 80,
    height: 80,
    borderRadius: "50%",
    background: "#22c55e",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 44,
    flexShrink: 0,
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
    gap: 6,
  },
  reviewSectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reviewSectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "#9CA3AF",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  },
  editLink: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
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
};
