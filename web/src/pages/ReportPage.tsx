import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { addToQueue } from "../utils/offlineQueue";
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reporterId, countryCode, languageCode } = useAuthStore();

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

  // Location state
  const [gpsLatitude, setGpsLatitude] = useState<number | null>(null);
  const [gpsLongitude, setGpsLongitude] = useState<number | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<number | null>(null);
  const [selectedBuildingTags, setSelectedBuildingTags] = useState<{ name: string; building: string }>({ name: "", building: "" });
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");
  const [locationBuildingName, setLocationBuildingName] = useState("");
  const [manualExpanded, setManualExpanded] = useState(false);
  const [gpsCapturing, setGpsCapturing] = useState(false);
  const [locationMapZoom, setLocationMapZoom] = useState(2);

  // UI state
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
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

  // Map initialisation — runs whenever location step becomes active
  useEffect(() => {
    if (step !== "location" || !mapContainerRef.current || mapRef.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAPTILER_KEY ? MAP_STYLE : OSM_STYLE,
      center: [0, 20],
      zoom: 2,
    });
    mapRef.current = mapInstance;

    mapInstance.addControl(new maplibregl.NavigationControl(), "top-right");

    mapInstance.on("load", () => {
      // Center on device GPS or world view
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => mapInstance.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15 }),
          () => {},
          { timeout: 8000 }
        );
      }

      // Sources
      mapInstance.addSource("buildings", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });
      mapInstance.addSource("selected-building", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });

      // Building layers — default style
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

      // Selected building highlight layer
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

      // Building click — select & compute centroid
      mapInstance.on("click", "buildings-fill", (e) => {
        if (!e.features?.length) return;
        const f = e.features[0];
        const props = f.properties as { osm_id: number; name: string; building: string };
        const geom = f.geometry as { type: "Polygon"; coordinates: number[][][] };

        const [centLng, centLat] = computeCentroid(geom.coordinates[0]);

        setSelectedBuildingId(props.osm_id);
        setSelectedBuildingTags({ name: props.name || "", building: props.building || "yes" });
        setGpsLatitude(centLat);
        setGpsLongitude(centLng);

        (mapInstance.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: props, geometry: geom }],
        } as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
      });

      mapInstance.on("mouseenter", "buildings-fill", () => {
        mapInstance.getCanvas().style.cursor = "pointer";
      });
      mapInstance.on("mouseleave", "buildings-fill", () => {
        mapInstance.getCanvas().style.cursor = "";
      });

      // moveend — debounced building fetch + zoom state
      mapInstance.on("moveend", () => {
        const zoom = mapInstance.getZoom();
        setLocationMapZoom(zoom);
        if (zoom >= 14) {
          if (debounceTimer.current) clearTimeout(debounceTimer.current);
          debounceTimer.current = setTimeout(() => fetchBuildingsForMap(mapInstance), 1000);
        }
      });

      // Initial fetch if already zoomed in
      const initialZoom = mapInstance.getZoom();
      setLocationMapZoom(initialZoom);
      if (initialZoom >= 14) fetchBuildingsForMap(mapInstance);
    });

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      mapInstance.remove();
      mapRef.current = null;
    };
  }, [step]);

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

  const checkDuplicate = (): boolean => {
    if (!gpsLatitude || !gpsLongitude || !crisisId) return false;
    try {
      const raw = localStorage.getItem("cr_submitted_locations");
      if (!raw) return false;
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number }> = JSON.parse(raw);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return locs.some(
        (l) =>
          l.crisis_id === crisisId &&
          Math.abs(l.lat - gpsLatitude) < 0.001 &&
          Math.abs(l.lng - gpsLongitude) < 0.001 &&
          l.timestamp > cutoff
      );
    } catch {
      return false;
    }
  };

  const saveSubmittedLocation = () => {
    if (!gpsLatitude || !gpsLongitude || !crisisId) return;
    try {
      const raw = localStorage.getItem("cr_submitted_locations");
      const locs: Array<{ lat: number; lng: number; crisis_id: string; timestamp: number }> =
        raw ? JSON.parse(raw) : [];
      locs.push({ lat: gpsLatitude, lng: gpsLongitude, crisis_id: crisisId, timestamp: Date.now() });
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
    setGpsLatitude(null);
    setGpsLongitude(null);
    setSelectedBuildingId(null);
    setSelectedBuildingTags({ name: "", building: "" });
    setLocationAddress("");
    setLocationLandmark("");
    setLocationBuildingName("");
    setManualExpanded(false);
    setSubmitted(false);
    setWasQueued(false);
    setSubmittedReportId(null);
    setError("");
    setStep("photos");
  };

  const handleGpsCapture = () => {
    if (!navigator.geolocation) return;
    setGpsCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setGpsLatitude(lat);
        setGpsLongitude(lng);
        setSelectedBuildingId(null);
        setSelectedBuildingTags({ name: "", building: "" });
        // Clear any building highlight
        (mapRef.current?.getSource("selected-building") as maplibregl.GeoJSONSource | undefined)
          ?.setData(EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0]);
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 16 });
        setGpsCapturing(false);
      },
      () => setGpsCapturing(false),
      { timeout: 10000 }
    );
  };

  const isLocationValid = (): boolean =>
    (gpsLatitude !== null && gpsLongitude !== null) ||
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

  const handlePhotoAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - photos.length;
    setPhotos((prev) => [...prev, ...files.slice(0, remaining)]);
  };

  const handlePhotoRemove = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const buildLocationAddress = (): string | null => {
    if (selectedBuildingId) {
      const parts = [selectedBuildingTags.name, selectedBuildingTags.building !== "yes" ? selectedBuildingTags.building : ""].filter(Boolean);
      return parts.length > 0 ? parts.join(" — ") : null;
    }
    return locationAddress || null;
  };

  const doSubmit = async () => {
    setShowDupeWarning(false);
    setSubmitting(true);
    setError("");

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
      submitted_at: new Date().toISOString(),
      location: {
        gps_latitude: gpsLatitude,
        gps_longitude: gpsLongitude,
        gps_accuracy_meters: null,
        gps_available: gpsLatitude !== null,
        location_address: buildLocationAddress(),
        location_landmark: locationLandmark || null,
        location_building_name: locationBuildingName || null,
      },
      reporter_id: reporterId || undefined,
      language_code: languageCode,
      question_package_version: questionPackage?.version ?? null,
      was_queued: false,
    };

    if (!navigator.onLine) {
      const queuedPhotos: QueuedPhoto[] = photos.map((file, index) => ({
        blob: file,
        filename: file.name,
        content_type: file.type,
        display_order: index,
      }));
      await addToQueue({ ...reportPayload, was_queued: true }, queuedPhotos);
      saveSubmittedLocation();
      setWasQueued(true);
      setSubmittedReportId(null);
      setSubmitted(true);
      setSubmitting(false);
      return;
    }

    try {
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      for (let i = 0; i < photos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", photos[i]);
        await api.post("/api/photos", formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }

      saveSubmittedLocation();
      setSubmittedReportId(reportId as string);
      setWasQueued(false);
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
              : "Thank you for helping UNDP map crisis damage. Your report has been received and will be reviewed shortly."}
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

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("report.title")}</h1>
        <span style={styles.stepIndicator}>
          {step === "photos" ? "1/4" : step === "location" ? "2/4" : step === "damage" ? "3/4" : "4/4"}
        </span>
      </div>

      {/* Progress bar */}
      <div style={styles.progressBar}>
        <div style={{
          ...styles.progressFill,
          width: step === "photos" ? "25%" : step === "location" ? "50%" : step === "damage" ? "75%" : "100%",
        }} />
      </div>

      {/* Content — location step needs overflow:hidden so map can flex */}
      <div style={{ ...styles.content, overflow: step === "location" ? "hidden" : "auto" }}>

        {/* Step 1 — Photos */}
        {step === "photos" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>{t("report.photos")} *</h2>
            <p style={styles.photoHint}>Add up to 3 photos of the damage. At least 1 is required.</p>

            <div style={styles.photoGrid}>
              {photos.map((photo, index) => (
                <div key={index} style={styles.photoThumb}>
                  <img src={URL.createObjectURL(photo)} style={styles.thumbImg} alt={`Photo ${index + 1}`} />
                  <button style={styles.removePhotoBtn} onClick={() => handlePhotoRemove(index)}>✕</button>
                </div>
              ))}
              {photos.length < 3 && (
                <button style={styles.addPhotoBtn} onClick={() => fileInputRef.current?.click()}>
                  <span style={{ fontSize: 32 }}>📷</span>
                  <span style={{ fontSize: 13 }}>{t("report.addPhoto")}</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              multiple
              style={{ display: "none" }}
              onChange={handlePhotoAdd}
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

        {/* Step 2 — Location (map-based) */}
        {step === "location" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Map area */}
            <div style={{ flex: 1, position: "relative", minHeight: 260 }}>
              <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />

              {/* Zoom hint overlay */}
              {locationMapZoom < 14 && (
                <div style={styles.zoomHint}>Zoom in to see and select buildings</div>
              )}
            </div>

            {/* Bottom panel — scrollable */}
            <div style={styles.locationPanel}>
              <h2 style={{ ...styles.stepTitle, marginBottom: 4 }}>{t("report.location")}</h2>

              {/* Selected building / GPS info card */}
              {gpsLatitude !== null && gpsLongitude !== null && (
                <div style={styles.selectionCard}>
                  <div style={styles.selectionCardTitle}>
                    {selectedBuildingId ? "Building Selected" : "GPS Location Captured"}
                  </div>
                  <div style={styles.selectionCardName}>
                    {selectedBuildingId
                      ? (selectedBuildingTags.name || "Unnamed building")
                      : `${gpsLatitude.toFixed(6)}, ${gpsLongitude.toFixed(6)}`}
                  </div>
                  {selectedBuildingId && selectedBuildingTags.building && selectedBuildingTags.building !== "yes" && (
                    <div style={styles.selectionCardMeta}>Type: {selectedBuildingTags.building}</div>
                  )}
                  {selectedBuildingId && (
                    <div style={styles.selectionCardCoords}>
                      {gpsLatitude.toFixed(6)}, {gpsLongitude.toFixed(6)}
                    </div>
                  )}
                </div>
              )}

              {/* GPS capture button */}
              <button
                style={styles.gpsButton}
                onClick={handleGpsCapture}
                disabled={gpsCapturing}
              >
                📍 {gpsCapturing ? "Getting location…" : "Use My GPS Location"}
              </button>

              {/* Manual entry toggle */}
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
                    onChange={(e) => setLocationAddress(e.target.value)}
                  />
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Landmark (e.g. Near central market)"
                    value={locationLandmark}
                    onChange={(e) => setLocationLandmark(e.target.value)}
                  />
                  <input
                    style={styles.input}
                    type="text"
                    placeholder="Building Name"
                    value={locationBuildingName}
                    onChange={(e) => setLocationBuildingName(e.target.value)}
                  />
                </div>
              )}

              <div style={styles.navButtons}>
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

            {/* Q1 — Damage level */}
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

            {/* Q2 — Infrastructure type */}
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
                    <div style={{
                      ...styles.checkbox,
                      ...(infrastructureTypes.includes(value) ? styles.checkboxSelected : {}),
                    }}>
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

            {/* Q3 — Infrastructure name */}
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

            {/* Q4 — Disaster type */}
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

            {/* Q5 — Debris blocking */}
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

            {/* Q6 — Electricity condition */}
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

            {/* Q7 — Health services */}
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

            {/* Q8 — Pressing needs (multi-select) */}
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
                    <div style={{
                      ...styles.checkbox,
                      ...(pressingNeeds.includes(value) ? styles.checkboxSelected : {}),
                    }}>
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

            <div style={styles.reviewCard}>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Damage Level</span>
                <span style={styles.reviewValue}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Infrastructure</span>
                <span style={styles.reviewValue}>
                  {infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v).join(", ")}
                </span>
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
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Photos</span>
                <span style={styles.reviewValue}>{photos.length} photo(s)</span>
              </div>
              {gpsLatitude !== null && (
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Location</span>
                  <span style={styles.reviewValue}>
                    {selectedBuildingId
                      ? (selectedBuildingTags.name || "Building selected")
                      : `GPS ${gpsLatitude.toFixed(4)}, ${gpsLongitude!.toFixed(4)}`}
                  </span>
                </div>
              )}
              {!gpsLatitude && locationAddress && (
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Address</span>
                  <span style={styles.reviewValue}>{locationAddress}</span>
                </div>
              )}
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
                style={{ ...styles.primaryButton, opacity: submitting ? 0.7 : 1, flex: 1 }}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? t("report.submitting") : t("report.submit")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Duplicate submission warning modal */}
      {showDupeWarning && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>Report already submitted for this location</h3>
            <p style={styles.modalBody}>
              It looks like you may have already submitted a report for this building. Submitting again could create a duplicate. Are you sure you want to continue?
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button
                style={{ ...styles.secondaryButton, flex: 1 }}
                onClick={() => setShowDupeWarning(false)}
              >
                Cancel
              </button>
              <button
                style={{ ...styles.primaryButton, flex: 1 }}
                onClick={doSubmit}
              >
                Submit Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  stepIndicator: {
    color: "#A0B4CC",
    fontSize: 14,
  },
  progressBar: {
    height: 4,
    background: "#e0e0e0",
    flexShrink: 0,
  },
  progressFill: {
    height: "100%",
    background: "#0468B1",
    transition: "width 0.3s ease",
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
  locationPanel: {
    padding: "14px 16px 20px",
    background: "#fff",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    overflowY: "auto",
    maxHeight: 340,
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
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: "#666",
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
    overflow: "hidden",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  removePhotoBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    border: "none",
    borderRadius: "50%",
    width: 24,
    height: 24,
    cursor: "pointer",
    fontSize: 12,
  },
  addPhotoBtn: {
    aspectRatio: "1",
    borderRadius: 8,
    border: "2px dashed #ccc",
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    color: "#666",
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
  successIcon: {
    fontSize: 72,
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
};
