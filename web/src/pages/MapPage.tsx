import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ─────────────────────────────────────────────────────────────────

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

const COUNTRY_CAPITALS: Record<string, [number, number]> = {
  SY: [36.2921, 33.5102],
  UA: [30.5238, 50.4501],
  TR: [32.8597, 39.9334],
  MA: [-6.8498, 33.9716],
  LY: [13.1800, 32.9042],
  AF: [69.1720, 34.5281],
  PK: [73.0479, 33.6844],
  BD: [90.4125, 23.8103],
  PH: [120.9842, 14.5995],
  HT: [-72.3388, 18.5944],
  NP: [85.3240, 27.7172],
  ET: [38.7369, 9.0320],
  SO: [45.3418, 2.0469],
  SD: [32.5599, 15.5007],
  YE: [44.2065, 15.3694],
  MM: [96.1951, 19.7633],
  IQ: [44.3661, 33.3152],
  NG: [7.4898, 9.0579],
  KE: [36.8219, -1.2921],
  CO: [-74.0721, 4.7110],
};

const DAMAGE_LABELS: Record<string, string> = {
  complete: "Completely Damaged",
  partial: "Partially Damaged",
  minimal: "Minimal / No Damage",
};

const DAMAGE_COLORS: Record<string, string> = {
  complete: "#E53E3E",
  partial: "#F57C00",
  minimal: "#38A169",
};

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as never[] };

// ── Types ─────────────────────────────────────────────────────────────────────

interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

interface OverpassOther {
  type: "relation" | "area";
  id: number;
  tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay | OverpassOther;

interface OverpassResponse {
  elements: OverpassElement[];
}

interface ReportMapItem {
  id: string;
  damage_level: string;
  created_at: string;
  gps_latitude: number;
  gps_longitude: number;
}

interface ReportsListResponse {
  reports: ReportMapItem[];
  total_count: number;
}

/**
 * Fields available on pin click from the current /api/reports response.
 * NOTE: building_name, address, and report_count are expected future backend
 * fields (to be added to ReportMapItem and the GeoJSON properties when the
 * backend includes them in the reports list endpoint).
 */
interface PinDetail {
  report_id: string;
  damage_level: string;
  created_at: string;
  coordinates: [number, number];
}

// ── GeoJSON builders ──────────────────────────────────────────────────────────

function buildingsGeoJSON(data: OverpassResponse): Parameters<maplibregl.GeoJSONSource["setData"]>[0] {
  const nodes = new Map<number, [number, number]>();
  for (const el of data.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  const features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: "Polygon"; coordinates: Array<Array<[number, number]>> };
  }> = [];

  for (const el of data.elements) {
    if (el.type !== "way" || !el.tags?.building) continue;
    const ring: Array<[number, number]> = [];
    for (const nodeId of el.nodes) {
      const coord = nodes.get(nodeId);
      if (coord) ring.push(coord);
    }
    if (ring.length < 3) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
  }

  return { type: "FeatureCollection", features } as Parameters<maplibregl.GeoJSONSource["setData"]>[0];
}

function reportsGeoJSON(reports: ReportMapItem[]): Parameters<maplibregl.GeoJSONSource["setData"]>[0] {
  const features: Array<{
    type: "Feature";
    properties: Record<string, string>;
    geometry: { type: "Point"; coordinates: [number, number] };
  }> = [];

  for (const r of reports) {
    const lat = r.gps_latitude;
    const lng = r.gps_longitude;
    if (!lat || !lng) continue;
    features.push({
      type: "Feature",
      properties: { report_id: r.id, damage_level: r.damage_level, created_at: r.created_at },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }

  return { type: "FeatureCollection", features } as Parameters<maplibregl.GeoJSONSource["setData"]>[0];
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function centerOnGPS(mapInstance: maplibregl.Map, countryCode: string | null) {
  const fallback = () => {
    const capital = countryCode ? COUNTRY_CAPITALS[countryCode] : null;
    if (capital) mapInstance.flyTo({ center: capital, zoom: 10 });
    else mapInstance.flyTo({ center: [0, 0], zoom: 2 });
  };

  if (!navigator.geolocation) { fallback(); return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => mapInstance.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15 }),
    fallback,
    { timeout: 8000 }
  );
}

async function fetchBuildings(mapInstance: maplibregl.Map): Promise<void> {
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
    const source = mapInstance.getSource("buildings") as maplibregl.GeoJSONSource | undefined;
    source?.setData(buildingsGeoJSON(data));
  } catch { /* silent — buildings non-critical */ }
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconGPS() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#717782" strokeWidth={2} strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const { t } = useTranslation();
  const { countryCode } = useAuthStore();

  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countryCodeAtMount = useRef(countryCode);

  const [showZoomHint, setShowZoomHint] = useState(false);
  const [selectedPin, setSelectedPin] = useState<PinDetail | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);

  // D30: Offline detection
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Responsive breakpoint for panel layout (D33/D34)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // D30–31: Listen for online/offline events
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      window.location.reload(); // Re-initialise map fresh when connection restores
    };
    const handleOffline = () => {
      setIsOnline(false);
      // Clean up map instance so MapLibre doesn't operate on a detached container
      if (map.current) {
        try { map.current.remove(); } catch { /* ignore */ }
        map.current = null;
      }
      setSelectedPin(null);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Map initialisation — runs once on mount, only when online
  useEffect(() => {
    if (!isOnline) return;
    if (!mapContainer.current || map.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: MAPTILER_KEY ? MAP_STYLE : OSM_STYLE,
      center: [0, 20],
      zoom: 2,
    });
    map.current = mapInstance;

    mapInstance.addControl(new maplibregl.NavigationControl(), "top-right");

    mapInstance.on("load", async () => {
      centerOnGPS(mapInstance, countryCodeAtMount.current);

      mapInstance.addSource("buildings", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });
      mapInstance.addSource("reports", {
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
        id: "reports-circles",
        type: "circle",
        source: "reports",
        paint: {
          "circle-radius": 9,
          "circle-color": [
            "match", ["get", "damage_level"],
            "complete", "#E53E3E",
            "partial",  "#F57C00",
            "minimal",  "#38A169",
            "#9CA3AF",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      // D33/D34: Pin click opens custom panel (replaces MapLibre popup)
      mapInstance.on("click", "reports-circles", (e) => {
        if (!e.features?.length) return;
        const f = e.features[0];
        const props = f.properties as { report_id: string; damage_level: string; created_at: string };
        const geom = f.geometry as { type: "Point"; coordinates: [number, number] };
        setSelectedPin({
          report_id: props.report_id,
          damage_level: props.damage_level,
          created_at: props.created_at,
          coordinates: geom.coordinates,
        });
      });

      // Close panel when clicking empty map area
      mapInstance.on("click", (e) => {
        const features = mapInstance.queryRenderedFeatures(e.point, { layers: ["reports-circles"] });
        if (!features.length) setSelectedPin(null);
      });

      mapInstance.on("mouseenter", "reports-circles", () => {
        mapInstance.getCanvas().style.cursor = "pointer";
      });
      mapInstance.on("mouseleave", "reports-circles", () => {
        mapInstance.getCanvas().style.cursor = "";
      });

      mapInstance.on("moveend", () => {
        const zoom = mapInstance.getZoom();
        setShowZoomHint(zoom < 14);
        if (zoom >= 14) {
          if (debounceTimer.current) clearTimeout(debounceTimer.current);
          debounceTimer.current = setTimeout(() => fetchBuildings(mapInstance), 1000);
        }
      });

      const initialZoom = mapInstance.getZoom();
      setShowZoomHint(initialZoom < 14);
      if (initialZoom >= 14) fetchBuildings(mapInstance);

      setReportsLoading(true);
      try {
        const crisisRes = await api.get("/api/crises/active");
        const list = Array.isArray(crisisRes.data)
          ? crisisRes.data
          : (crisisRes.data?.items ?? []);
        if (list.length > 0) {
          const crisisId: string = (list[0] as { id: string }).id;
          const reportsRes = await api.get<ReportsListResponse>("/api/reports/map", {
            params: { crisis_id: crisisId, limit: 200 },
          });
          const source = mapInstance.getSource("reports") as maplibregl.GeoJSONSource | undefined;
          source?.setData(reportsGeoJSON(reportsRes.data.reports));
        }
      } catch { /* reports non-critical */ } finally {
        setReportsLoading(false);
      }
    });

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      mapInstance.remove();
      map.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Map initialises once on mount

  // D35: GPS recentre handler
  const handleGpsRecentre = () => {
    if (map.current) centerOnGPS(map.current, countryCode);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* D30–31: Offline state — suppress map entirely */}
      {!isOnline ? (
        <div style={s.offlineContainer}>
          <p style={s.offlineText}>
            {t('map.offline_message')}
          </p>
          <button style={s.retryBtn} onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <div style={s.mapWrapper}>
          <div ref={mapContainer} style={s.map} />

          {/* Reports loading chip — shown while crisis + reports fetch runs */}
          {reportsLoading && (
            <div style={s.reportsLoadingChip}>
              <style>{`@keyframes cr-map-spin { to { transform: rotate(360deg); } }`}</style>
              <div style={s.miniSpinner} />
              <span style={s.reportsLoadingText}>{t('map.loading_reports', 'Loading reports…')}</span>
            </div>
          )}

          {showZoomHint && (
            <div style={s.zoomHint}>{t('map.zoom_hint')}</div>
          )}

          {/* D35: GPS recentre button — bottom-right, always visible when map is loaded */}
          <button
            style={s.gpsBtn}
            onClick={handleGpsRecentre}
            aria-label="Recentre map on my location"
          >
            <IconGPS />
          </button>
        </div>
      )}

      {/* D33/D34: Pin detail panel — right panel on desktop, bottom sheet on mobile */}
      {selectedPin && (
        <>
          {/* Invisible overlay to close panel when clicking outside */}
          <div
            style={s.panelOverlay}
            onClick={() => setSelectedPin(null)}
          />
          <div style={isMobile ? s.bottomSheet : s.rightPanel}>
            <div style={s.panelHeader}>
              <span style={s.panelTitle}>
                {t(`map.damage_${selectedPin.damage_level}`, { defaultValue: DAMAGE_LABELS[selectedPin.damage_level] ?? selectedPin.damage_level })}
              </span>
              <button style={s.panelCloseBtn} onClick={() => setSelectedPin(null)} aria-label="Close">
                <IconClose />
              </button>
            </div>

            {/* Damage level badge */}
            <div style={s.panelBody}>
              <span
                style={{
                  ...s.damagePill,
                  background: DAMAGE_COLORS[selectedPin.damage_level] ?? "#9CA3AF",
                }}
              >
                {t(`map.damage_${selectedPin.damage_level}`, { defaultValue: DAMAGE_LABELS[selectedPin.damage_level] ?? selectedPin.damage_level })}
              </span>

              {/* GPS coordinates */}
              <p style={s.panelCoords}>
                {selectedPin.coordinates[1].toFixed(5)}, {selectedPin.coordinates[0].toFixed(5)}
              </p>

              {/* Last report time */}
              <p style={s.panelMeta}>
                {t('map.pin_reported')}{" "}
                {new Date(selectedPin.created_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>

              {/* Report ID (small reference) */}
              <p style={s.panelId}>{t('map.pin_id')}{selectedPin.report_id}</p>
            </div>
          </div>
        </>
      )}

    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#fff",
    position: "relative",
  },
  // D30–31: Offline state
  offlineContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 24px",
    gap: 20,
  },
  offlineText: {
    fontSize: "1rem",
    color: "#1A2B4A",
    textAlign: "center",
    lineHeight: 1.6,
    margin: 0,
    maxWidth: 320,
  },
  retryBtn: {
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 24px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Map container
  mapWrapper: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  map: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  reportsLoadingChip: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(255,255,255,0.96)",
    borderRadius: 20,
    padding: "7px 14px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    zIndex: 10,
    whiteSpace: "nowrap",
  },
  miniSpinner: {
    width: 14,
    height: 14,
    border: "2px solid #e0e0e0",
    borderTop: "2px solid #0468B1",
    borderRadius: "50%",
    flexShrink: 0,
    animation: "cr-map-spin 0.8s linear infinite",
  },
  reportsLoadingText: {
    fontSize: 12,
    fontWeight: 600,
    color: "#1A2B4A",
  },
  zoomHint: {
    position: "absolute",
    bottom: 140,
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
  // D35: GPS recentre button — sits above fixed bottom nav (~80px)
  gpsBtn: {
    position: "absolute",
    bottom: 88,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "#0468B1",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 8px rgba(4,104,177,0.35)",
    zIndex: 10,
  },
  // D33/D34: Panel overlay and panels
  panelOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 200,
    background: "transparent",
  },
  // Desktop: right side panel
  rightPanel: {
    position: "fixed",
    top: 56,
    right: 0,
    bottom: 0,
    width: 360,
    background: "#fff",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
    zIndex: 201,
    display: "flex",
    flexDirection: "column",
    animation: "slideInRight 0.25s ease",
  },
  // Mobile: bottom sheet
  bottomSheet: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "60vh",
    background: "#fff",
    borderRadius: "20px 20px 0 0",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.12)",
    zIndex: 201,
    display: "flex",
    flexDirection: "column",
    animation: "slideUp 0.25s ease",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px 12px",
    borderBottom: "1px solid #E2E8F0",
    flexShrink: 0,
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  panelCloseBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  panelBody: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  damagePill: {
    display: "inline-block",
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    padding: "4px 12px",
    borderRadius: 20,
    alignSelf: "flex-start",
  },
  panelCoords: {
    fontSize: 13,
    color: "#717782",
    margin: 0,
    fontFamily: "monospace",
  },
  panelMeta: {
    fontSize: 13,
    color: "#4A5568",
    margin: 0,
  },
  panelId: {
    fontSize: 11,
    color: "#a0aec0",
    margin: 0,
    fontFamily: "monospace",
  },
};
