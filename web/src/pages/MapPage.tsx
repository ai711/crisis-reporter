import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import SideMenu from "../components/SideMenu";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
const MAP_STYLE = `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`;

// Fallback tile style when no Maptiler key is configured
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

// Capital coordinates for the 20 most common crisis-affected countries
const COUNTRY_CAPITALS: Record<string, [number, number]> = {
  SY: [36.2921, 33.5102],  // Damascus, Syria
  UA: [30.5238, 50.4501],  // Kyiv, Ukraine
  TR: [32.8597, 39.9334],  // Ankara, Turkey
  MA: [-6.8498, 33.9716],  // Rabat, Morocco
  LY: [13.1800, 32.9042],  // Tripoli, Libya
  AF: [69.1720, 34.5281],  // Kabul, Afghanistan
  PK: [73.0479, 33.6844],  // Islamabad, Pakistan
  BD: [90.4125, 23.8103],  // Dhaka, Bangladesh
  PH: [120.9842, 14.5995], // Manila, Philippines
  HT: [-72.3388, 18.5944], // Port-au-Prince, Haiti
  NP: [85.3240, 27.7172],  // Kathmandu, Nepal
  ET: [38.7369, 9.0320],   // Addis Ababa, Ethiopia
  SO: [45.3418, 2.0469],   // Mogadishu, Somalia
  SD: [32.5599, 15.5007],  // Khartoum, Sudan
  YE: [44.2065, 15.3694],  // Sanaa, Yemen
  MM: [96.1951, 19.7633],  // Naypyidaw, Myanmar
  IQ: [44.3661, 33.3152],  // Baghdad, Iraq
  NG: [7.4898, 9.0579],    // Abuja, Nigeria
  KE: [36.8219, -1.2921],  // Nairobi, Kenya
  CO: [-74.0721, 4.7110],  // Bogotá, Colombia
};

const DAMAGE_LABELS: Record<string, string> = {
  complete: "Completely Damaged",
  partial: "Partially Damaged",
  minimal: "Minimal / No Damage",
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
  report_id: string;
  damage_level: string;
  created_at: string;
  location?: {
    gps_latitude?: number | null;
    gps_longitude?: number | null;
  };
}

interface ReportsListResponse {
  reports: ReportMapItem[];
  total_count: number;
}

// ── GeoJSON builders ──────────────────────────────────────────────────────────

function buildingsGeoJSON(data: OverpassResponse): Parameters<maplibregl.GeoJSONSource["setData"]>[0] {
  const nodes = new Map<number, [number, number]>();

  for (const el of data.elements) {
    if (el.type === "node") {
      nodes.set(el.id, [el.lon, el.lat]);
    }
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

    // Close the ring
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }

    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    });
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
    const lat = r.location?.gps_latitude;
    const lng = r.location?.gps_longitude;
    if (!lat || !lng) continue;

    features.push({
      type: "Feature",
      properties: {
        report_id: r.report_id,
        damage_level: r.damage_level,
        created_at: r.created_at,
      },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }

  return { type: "FeatureCollection", features } as Parameters<maplibregl.GeoJSONSource["setData"]>[0];
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function centerOnGPS(
  mapInstance: maplibregl.Map,
  countryCode: string | null
) {
  const fallback = () => {
    const capital = countryCode ? COUNTRY_CAPITALS[countryCode] : null;
    if (capital) {
      mapInstance.flyTo({ center: capital, zoom: 10 });
    } else {
      mapInstance.flyTo({ center: [0, 0], zoom: 2 });
    }
  };

  if (!navigator.geolocation) {
    fallback();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      mapInstance.flyTo({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: 15,
      });
    },
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
  } catch {
    // Network error — silently ignore, buildings are non-critical
  }
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconHamburger() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

// ── Footer icons ──────────────────────────────────────────────────────────────

function IconHome({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconMapPin({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconList({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const navigate = useNavigate();
  const { countryCode } = useAuthStore();

  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popup = useRef<maplibregl.Popup | null>(null);
  // Capture countryCode at mount time so the effect has no reactive dep
  const countryCodeAtMount = useRef(countryCode);

  const [showZoomHint, setShowZoomHint] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: MAPTILER_KEY ? MAP_STYLE : OSM_STYLE,
      center: [0, 20],
      zoom: 2,
    });
    map.current = mapInstance;

    popup.current = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "220px",
    });

    mapInstance.addControl(new maplibregl.NavigationControl(), "top-right");

    mapInstance.on("load", async () => {
      // ── GPS / country centering ────────────────────────────────────────────
      centerOnGPS(mapInstance, countryCodeAtMount.current);

      // ── Add sources ────────────────────────────────────────────────────────
      mapInstance.addSource("buildings", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });

      mapInstance.addSource("reports", {
        type: "geojson",
        data: EMPTY_FC as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
      });

      // ── Building layers ────────────────────────────────────────────────────
      mapInstance.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        paint: {
          "fill-color": "#CBD5E0",
          "fill-opacity": 0.5,
        },
      });

      mapInstance.addLayer({
        id: "buildings-outline",
        type: "line",
        source: "buildings",
        paint: {
          "line-color": "#718096",
          "line-width": 0.6,
        },
      });

      // ── Report circles ─────────────────────────────────────────────────────
      mapInstance.addLayer({
        id: "reports-circles",
        type: "circle",
        source: "reports",
        paint: {
          "circle-radius": 9,
          "circle-color": [
            "match",
            ["get", "damage_level"],
            "complete", "#E53E3E",
            "partial",  "#F57C00",
            "minimal",  "#38A169",
            "#9CA3AF",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      // ── Pin popup on click ─────────────────────────────────────────────────
      mapInstance.on("click", "reports-circles", (e) => {
        if (!e.features?.length) return;
        const f = e.features[0];
        const props = f.properties as { damage_level: string; created_at: string };
        const geom = f.geometry as { type: "Point"; coordinates: [number, number] };

        const label = DAMAGE_LABELS[props.damage_level] ?? props.damage_level;
        const dateStr = props.created_at
          ? new Date(props.created_at).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "Unknown date";

        popup.current
          ?.setLngLat(geom.coordinates)
          .setHTML(
            `<div style="font:13px/1.6 system-ui,sans-serif;padding:2px 0">` +
            `<strong style="color:#1A2B4A">${label}</strong><br/>` +
            `<span style="color:#718096">${dateStr}</span>` +
            `</div>`
          )
          .addTo(mapInstance);
      });

      mapInstance.on("mouseenter", "reports-circles", () => {
        mapInstance.getCanvas().style.cursor = "pointer";
      });
      mapInstance.on("mouseleave", "reports-circles", () => {
        mapInstance.getCanvas().style.cursor = "";
      });

      // ── moveend: buildings + zoom hint ─────────────────────────────────────
      mapInstance.on("moveend", () => {
        const zoom = mapInstance.getZoom();
        setShowZoomHint(zoom < 14);

        if (zoom >= 14) {
          if (debounceTimer.current) clearTimeout(debounceTimer.current);
          debounceTimer.current = setTimeout(() => {
            fetchBuildings(mapInstance);
          }, 1000);
        }
      });

      // ── Initial state ──────────────────────────────────────────────────────
      const initialZoom = mapInstance.getZoom();
      setShowZoomHint(initialZoom < 14);
      if (initialZoom >= 14) {
        fetchBuildings(mapInstance);
      }

      // ── Fetch reports via active crisis ────────────────────────────────────
      try {
        const crisisRes = await api.get("/api/crises/active");
        const list = Array.isArray(crisisRes.data)
          ? crisisRes.data
          : (crisisRes.data?.items ?? []);

        if (list.length > 0) {
          const crisisId: string = list[0].id;
          const reportsRes = await api.get<ReportsListResponse>("/api/reports", {
            params: { crisis_id: crisisId, limit: 200 },
          });
          const source = mapInstance.getSource("reports") as maplibregl.GeoJSONSource | undefined;
          source?.setData(reportsGeoJSON(reportsRes.data.reports));
        }
      } catch {
        // Reports are non-critical — map still usable without them
      }
    });

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      popup.current?.remove();
      mapInstance.remove();
      map.current = null;
    };
  }, []); // intentionally empty — map initialises once

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* Header */}
      <header style={s.header}>
        <button
          style={s.hamburgerBtn}
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
        >
          <IconHamburger />
        </button>
        <span style={s.headerTitle}>Crisis Map</span>
        {/* spacer to keep title visually centred */}
        <div style={{ width: 30 }} />
      </header>

      {/* Map + zoom hint overlay */}
      <div style={s.mapWrapper}>
        <div ref={mapContainer} style={s.map} />

        {showZoomHint && (
          <div style={s.zoomHint}>Zoom in to see buildings</div>
        )}
      </div>

      {/* Footer navigation */}
      <nav style={s.footer}>
        <button style={s.navBtn} onClick={() => navigate("/")}>
          <IconHome active={false} />
          <span style={s.navLabel}>Home</span>
        </button>
        <button style={s.navBtn} onClick={() => navigate("/map")}>
          <IconMapPin active={true} />
          <span style={{ ...s.navLabel, color: "#0468B1", fontWeight: 600 }}>
            Map
          </span>
        </button>
        <button style={s.navBtn} onClick={() => navigate("/my-reports")}>
          <IconList active={false} />
          <span style={s.navLabel}>My Reports</span>
        </button>
      </nav>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    margin: "0 auto",
    background: "#fff",
  },
  header: {
    background: "#0468B1",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
  },
  hamburgerBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    width: 30,
  },
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
  footer: {
    background: "#fff",
    borderTop: "1px solid #E2E8F0",
    display: "flex",
    justifyContent: "space-around",
    padding: "8px 0 12px",
    flexShrink: 0,
  },
  navBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "6px 20px",
    flex: 1,
  },
  navLabel: {
    fontSize: 11,
    color: "#9CA3AF",
    fontWeight: 500,
  },
};
