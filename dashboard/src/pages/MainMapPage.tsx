import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import maplibregl, { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Header from "../components/Header";
import PropertySummaryPanel from "../components/PropertySummaryPanel";
import { useSSE } from "../hooks/useSSE";
import api from "../services/api";
import type { MapPin, DashboardStats, SSEEvent } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";

const DAMAGE_COLORS: Record<string, string> = {
  minimal: "#38a169",
  partial: "#f2994a",
  complete: "#e53e3e",
};

// ── SVG icons ─────────────────────────────────────────────────────────────────

function ChevronDown({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function TargetIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MainMapPage() {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Stable ref so map click handlers (defined once) always call current setter.
  const setSelectedPinRef = useRef<((p: MapPin | null) => void) | null>(null);
  // Used to detect outside-clicks for chip dropdown close.
  const pillRef = useRef<HTMLDivElement>(null);

  // ── Store ─────────────────────────────────────────────────────────────────
  const queryClient = useQueryClient();

  // ── State ─────────────────────────────────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<"connected" | "disconnected">("disconnected");
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  // Tick increments every second to keep the "Xs ago" display live.
  const [, setTick] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [selectedPin, setSelectedPin] = useState<MapPin | null>(null);
  // Which chip's dropdown is currently open (null = none).
  const [activeChip, setActiveChip] = useState<string | null>(null);
  // "default" = show green+orange (backend default); or "green"|"orange"|"red" exclusively.
  const [flagMode, setFlagMode] = useState<string>("default");
  const [damageLevel, setDamageLevel] = useState<string[]>([]);
  const [crisisType, setCrisisType] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().split("T")[0]; // e.g. "2026-03-06"
  });
  const [dateTo, setDateTo] = useState("");
  const [country, setCountry] = useState("");
  const [showRecovered, setShowRecovered] = useState(false);

  setSelectedPinRef.current = setSelectedPin;

  // ── Seconds ticker ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Close chip dropdown on outside click ──────────────────────────────────
  useEffect(() => {
    if (!activeChip) return;
    const handler = (e: MouseEvent) => {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) {
        setActiveChip(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [activeChip]);

  // ── Resize map when side panel opens/closes ───────────────────────────────
  useEffect(() => {
    const id = setTimeout(() => map.current?.resize(), 50);
    return () => clearTimeout(id);
  }, [selectedPin]);

  // ── Filter helpers ────────────────────────────────────────────────────────
  // Backend accepts one flag_status value at a time; omitting it defaults to green+orange.
  const flagParam = flagMode === "default" ? undefined : flagMode;

  const toggleChip = (name: string) =>
    setActiveChip((prev) => (prev === name ? null : name));

  // ── Data queries ──────────────────────────────────────────────────────────
  const { data: pinsData } = useQuery({
    queryKey: [
      "map-pins", flagParam,
      damageLevel.join(","), crisisType.join(","),
      dateFrom, dateTo, country, showRecovered,
    ],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (flagParam) params.flag_status = flagParam;
      if (damageLevel.length > 0) params.damage_level = damageLevel.join(",");
      if (crisisType.length > 0) params.crisis_type = crisisType.join(",");
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      if (country.trim()) params.country = country.trim();
      if (showRecovered) params.show_recovered = "true";
      const res = await api.get("/api/dashboard/map/pins", { params });
      return res.data as { pins: MapPin[]; total: number };
    },
    refetchInterval: 20000,
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const res = await api.get("/api/dashboard/map/stats");
      return res.data;
    },
    refetchInterval: 20000,
  });

  // Stable ref so SSE handler always sees the current selectedPin.
  const selectedPinRef = useRef<MapPin | null>(null);
  selectedPinRef.current = selectedPin;

  // ── SSE — not active (no per-crisis channel without a crisis_id). ──────────
  // Map data refreshes on a 20-second polling interval instead.
  // The handler is kept so SSE can be re-enabled trivially if a global channel
  // is added to the backend in the future.
  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (event.type === "connected") {
        setLiveStatus("connected");
        setLastUpdated(new Date());
      } else if (event.type === "heartbeat") {
        setLastUpdated(new Date());
      } else if (event.type === "report_confirmed" || event.type === "flag_changed") {
        queryClient.invalidateQueries({ queryKey: ["map-pins"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
        setLastUpdated(new Date());
      } else if (event.type === "property_updated") {
        queryClient.invalidateQueries({ queryKey: ["map-pins"] });
        const pin = selectedPinRef.current;
        if (pin?.property_id && event.property_id === pin.property_id) {
          queryClient.invalidateQueries({ queryKey: ["property-comments", pin.property_id] });
        }
      } else if (event.type === "property_comment_added") {
        const pin = selectedPinRef.current;
        if (pin?.property_id && event.property_id === pin.property_id) {
          queryClient.invalidateQueries({ queryKey: ["property-comments", pin.property_id] });
        }
      } else if (event.type === "error") {
        setLiveStatus("disconnected");
      }
    },
    [queryClient]
  );

  useSSE({ crisisId: null, onEvent: handleSSEEvent, enabled: false });

  // ── Map initialisation ────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: MAPTILER_KEY
        ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
        : {
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
          },
      center: [0, 20],
      zoom: 2,
    });

    m.addControl(new maplibregl.NavigationControl(), "bottom-left");

    m.on("load", () => {
      // ── GeoJSON source with cluster support ──────────────────────────────
      m.addSource("pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
        clusterProperties: {
          // Accumulate counts of each damage level to drive cluster colour.
          any_destroyed: ["+", ["case", ["==", ["get", "damage_level"], "complete"], 1, 0]],
          any_partial: ["+", ["case", ["==", ["get", "damage_level"], "partial"], 1, 0]],
        },
      });

      // ── Cluster circle layer ──────────────────────────────────────────────
      m.addLayer({
        id: "clusters",
        type: "circle",
        source: "pins",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "case",
            [">", ["get", "any_destroyed"], 0], "#e53e3e",
            [">", ["get", "any_partial"], 0], "#f2994a",
            "#38a169",
          ],
          "circle-radius": ["step", ["get", "point_count"], 20, 10, 30, 50, 40],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.92,
        },
      });

      // ── Cluster count label ───────────────────────────────────────────────
      m.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "pins",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 13,
        },
        paint: { "text-color": "#fff" },
      });

      // ── Individual (unclustered) pin circle ───────────────────────────────
      m.addLayer({
        id: "unclustered-pin",
        type: "circle",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "match", ["get", "damage_level"],
            "complete", "#e53e3e",
            "partial", "#f2994a",
            "#38a169",
          ],
          "circle-radius": 12,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        },
      });

      // ── Report count badge on each pin ────────────────────────────────────
      m.addLayer({
        id: "unclustered-count",
        type: "symbol",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["to-string", ["get", "report_count"]],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 10,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fff" },
      });

      // ── Click: cluster → zoom in ──────────────────────────────────────────
      m.on("click", "clusters", async (e) => {
        const features = m.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        if (!features.length) return;
        const clusterId = features[0].properties?.cluster_id as number;
        const source = m.getSource("pins") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        m.easeTo({ center: coords, zoom });
      });

      // ── Click: individual pin → open property panel ───────────────────────
      m.on("click", "unclustered-pin", (e) => {
        const props = e.features?.[0]?.properties;
        if (!props) return;
        const pin: MapPin = {
          building_id: props.building_id ?? null,
          latitude: Number(props.latitude),
          longitude: Number(props.longitude),
          damage_level: props.damage_level,
          report_count: Number(props.report_count),
          flag_status: props.flag_status,
        };
        setSelectedPinRef.current?.(pin);
      });

      // ── Click: empty canvas → close panel ────────────────────────────────
      m.on("click", (e) => {
        const hit = m.queryRenderedFeatures(e.point, {
          layers: ["clusters", "unclustered-pin"],
        });
        if (!hit.length) setSelectedPinRef.current?.(null);
      });

      // ── Cursor feedback ───────────────────────────────────────────────────
      m.on("mouseenter", "clusters", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "clusters", () => { m.getCanvas().style.cursor = ""; });
      m.on("mouseenter", "unclustered-pin", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "unclustered-pin", () => { m.getCanvas().style.cursor = ""; });

      setMapReady(true);
    });

    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  // ── Update GeoJSON source when pins data changes ──────────────────────────
  useEffect(() => {
    if (!map.current || !mapReady || !pinsData?.pins) return;
    const source = map.current.getSource("pins") as GeoJSONSource | undefined;
    if (!source) return;
    const features: GeoJSON.Feature[] = pinsData.pins.map((pin: MapPin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.longitude, pin.latitude] },
      properties: {
        building_id: pin.building_id,
        latitude: pin.latitude,
        longitude: pin.longitude,
        damage_level: pin.damage_level,
        report_count: pin.report_count,
        flag_status: pin.flag_status,
      },
    }));
    source.setData({ type: "FeatureCollection", features });
  }, [pinsData, mapReady]);

  // ── Computed display values ───────────────────────────────────────────────
  const secondsSince = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);

  // Active-filter booleans for chip highlight state.
  const isDamageActive = damageLevel.length > 0;
  const isCrisisTypeActive = crisisType.length > 0;
  const isDateActive = !!(dateFrom || dateTo);
  const isCountryActive = !!country.trim();
  const isFlagActive = flagMode !== "default";

  // ── Chip style helper ─────────────────────────────────────────────────────
  const chipSty = (name: string, filterActive: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: 9999,
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
    transition: "background 0.15s, color 0.15s",
    background:
      activeChip === name
        ? "#e6e8eb"
        : filterActive
        ? "var(--c-primary)"
        : "transparent",
    color: filterActive && activeChip !== name ? "#fff" : "#191c1e",
  });

  return (
    <div style={styles.container}>
      <style>{`.map-pill-toolbar::-webkit-scrollbar { display: none; }`}</style>
      <Header
        title="Map View"
        subtitle={`${pinsData?.total ?? 0} location${(pinsData?.total ?? 0) !== 1 ? "s" : ""} reported`}
      />

      {/* ── Stats bar ── */}
      {stats && (
        <div style={styles.statsBar}>
          <div style={styles.statItem}>
            <span style={styles.statNumber}>{stats.total_reports}</span>
            <span style={styles.statLabel}>Total Reports</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #38a169" }}>
            <span style={{ ...styles.statNumber, color: "#38a169" }}>{stats.green_count}</span>
            <span style={styles.statLabel}>Verified</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #f2994a" }}>
            <span style={{ ...styles.statNumber, color: "#f2994a" }}>{stats.orange_count}</span>
            <span style={styles.statLabel}>Needs Attention</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #e53e3e" }}>
            <span style={{ ...styles.statNumber, color: "#e53e3e" }}>{stats.red_count}</span>
            <span style={styles.statLabel}>Review</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #9e9e9e" }}>
            <span style={{ ...styles.statNumber, color: "#9e9e9e" }}>{stats.grey_count}</span>
            <span style={styles.statLabel}>Processing</span>
          </div>
        </div>
      )}

      {/* ── Map row: map area + side panel side-by-side ── */}
      <div style={styles.mapRow}>

        {/* ── Map area ── */}
        <div style={styles.mapArea}>
          <div ref={mapContainer} style={styles.map} />

          {/* ── Floating glassmorphism pill toolbar ── */}
          <div ref={pillRef} style={styles.pillToolbar} className="map-pill-toolbar">

            {/* Damage Level chip */}
            <div style={{ position: "relative" }}>
              <button style={chipSty("damage", isDamageActive)} onClick={() => toggleChip("damage")}>
                {isDamageActive ? `Damage (${damageLevel.length})` : "All Damage Levels"}
                <ChevronDown />
              </button>
              {activeChip === "damage" && (
                <div style={styles.chipDropdown}>
                  <div style={styles.chipDropdownTitle}>Damage Level</div>
                  {([ ["complete", "Completely Destroyed"], ["partial", "Partially Damaged"], ["minimal", "Minimal or No Damage"] ] as [string, string][]).map(([v, label]) => (
                    <label key={v} style={styles.chipCheckLabel}>
                      <input
                        type="checkbox"
                        checked={damageLevel.includes(v)}
                        onChange={() =>
                          setDamageLevel((p) =>
                            p.includes(v) ? p.filter((x) => x !== v) : [...p, v]
                          )
                        }
                        style={styles.chipCheck}
                      />
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: DAMAGE_COLORS[v], flexShrink: 0 }} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Crisis Type chip */}
            <div style={{ position: "relative" }}>
              <button style={chipSty("type", isCrisisTypeActive)} onClick={() => toggleChip("type")}>
                {isCrisisTypeActive ? `Type (${crisisType.length})` : "All Crisis Types"}
                <ChevronDown />
              </button>
              {activeChip === "type" && (
                <div style={styles.chipDropdown}>
                  <div style={styles.chipDropdownTitle}>Crisis Type</div>
                  {["earthquake", "flood", "cyclone", "wildfire", "landslide", "tsunami", "conflict", "drought", "other"].map((t) => (
                    <label key={t} style={styles.chipCheckLabel}>
                      <input
                        type="checkbox"
                        checked={crisisType.includes(t)}
                        onChange={() =>
                          setCrisisType((p) =>
                            p.includes(t) ? p.filter((x) => x !== t) : [...p, t]
                          )
                        }
                        style={styles.chipCheck}
                      />
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.pillSep} />

            {/* Date Range chip */}
            <div style={{ position: "relative" }}>
              <button style={chipSty("date", isDateActive)} onClick={() => toggleChip("date")}>
                {isDateActive ? `${dateFrom || "…"} → ${dateTo || "…"}` : "Date Range"}
                <ChevronDown />
              </button>
              {activeChip === "date" && (
                <div style={{ ...styles.chipDropdown, width: 220 }}>
                  <div style={styles.chipDropdownTitle}>Date Range</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                      <div style={styles.chipInputLabel}>From</div>
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={styles.chipInput} />
                    </div>
                    <div>
                      <div style={styles.chipInputLabel}>To</div>
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={styles.chipInput} />
                    </div>
                  </div>
                  {(dateFrom || dateTo) && (
                    <button style={styles.chipClearBtn} onClick={() => { setDateFrom(""); setDateTo(""); }}>
                      Clear dates
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Country chip */}
            <div style={{ position: "relative" }}>
              <button style={chipSty("country", isCountryActive)} onClick={() => toggleChip("country")}>
                {isCountryActive ? country.toUpperCase() : "All Countries"}
                <ChevronDown />
              </button>
              {activeChip === "country" && (
                <div style={{ ...styles.chipDropdown, width: 190 }}>
                  <div style={styles.chipDropdownTitle}>Country Code</div>
                  <input
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="e.g. TR, UA"
                    style={styles.chipInput}
                    autoFocus
                  />
                  {country && (
                    <button style={styles.chipClearBtn} onClick={() => setCountry("")}>Clear</button>
                  )}
                </div>
              )}
            </div>

            {/* Flag Status chip */}
            <div style={{ position: "relative" }}>
              <button style={chipSty("flag", isFlagActive)} onClick={() => toggleChip("flag")}>
                {flagMode === "default" ? "Flag Status" :
                 flagMode === "green" ? "Green only" :
                 flagMode === "orange" ? "Orange only" : "Red only"}
                <ChevronDown />
              </button>
              {activeChip === "flag" && (
                <div style={styles.chipDropdown}>
                  <div style={styles.chipDropdownTitle}>Flag Status</div>
                  {([
                    ["default", "#9e9e9e", "Green + Orange (Default)"],
                    ["green", "#38a169", "Green only — Verified"],
                    ["orange", "#f2994a", "Orange only — Needs Attention"],
                    ["red", "#e53e3e", "Red only — Supervisor View"],
                  ] as [string, string, string][]).map(([mode, color, label]) => (
                    <button
                      key={mode}
                      style={{
                        ...styles.chipDropdownItem,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontWeight: flagMode === mode ? 700 : 400,
                        color: flagMode === mode ? color : "#191c1e",
                      }}
                      onClick={() => { setFlagMode(mode); setActiveChip(null); }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      {label}
                      {flagMode === mode && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.pillSep} />

            {/* Show Recovered toggle chip — no dropdown */}
            <button
              style={{
                ...chipSty("recovered", showRecovered),
                background: showRecovered ? "var(--c-primary)" : "transparent",
                color: showRecovered ? "#fff" : "#191c1e",
              }}
              onClick={() => setShowRecovered((v) => !v)}
            >
              {showRecovered ? "✓ Recovered" : "Show Recovered"}
            </button>

          </div>

          {/* ── Live indicator — glassmorphism pill, top-right ── */}
          <div
            style={{
              ...styles.liveIndicator,
              background: liveStatus === "connected"
                ? "rgba(255,255,255,0.88)"
                : "rgba(255,248,240,0.92)",
            }}
          >
            <div
              style={{
                ...styles.liveDot,
                background: liveStatus === "connected" ? "#38a169" : "#f2994a",
                boxShadow:
                  liveStatus === "connected"
                    ? "0 0 0 3px rgba(56,161,105,0.25)"
                    : "0 0 0 3px rgba(242,153,74,0.25)",
              }}
            />
            <span style={styles.liveText}>
              {liveStatus === "connected"
                ? `LIVE · ${secondsSince}s ago`
                : "OFFLINE · DATA MAY BE OUTDATED"}
            </span>
          </div>

          {/* ── Legend — bottom-left, above zoom controls ── */}
          <div style={styles.legend}>
            <div style={styles.legendTitle}>Damage Level</div>
            {([ ["complete", "Completely Destroyed"], ["partial", "Partially Damaged"], ["minimal", "Minimal or No Damage"] ] as [string, string][]).map(([level, label]) => (
              <div key={level} style={styles.legendItem}>
                <div style={{ ...styles.legendDot, background: DAMAGE_COLORS[level] }} />
                <span style={styles.legendLabel}>{label}</span>
              </div>
            ))}
            {/* Divider */}
            <div style={{ borderTop: "1px solid rgba(0,0,0,0.07)", margin: "4px 0" }} />
            {/* Cluster explanation */}
            <div style={styles.legendItem}>
              <div style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: "rgba(56,161,105,0.85)",
                border: "2px solid #fff",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                fontWeight: 700,
                color: "#fff",
              }}>
                N
              </div>
              <span style={{ ...styles.legendLabel, fontSize: 11 }}>Cluster — zoom in to expand</span>
            </div>
          </div>

          {/* ── FAB — fit all visible pins ── */}
          <button
            style={styles.fab}
            title="Zoom to fit all pins"
            onClick={() => {
              const pins = pinsData?.pins;
              if (!pins?.length || !map.current) return;
              const lngs = pins.map((p: MapPin) => p.longitude);
              const lats = pins.map((p: MapPin) => p.latitude);
              map.current.fitBounds(
                [
                  [Math.min(...lngs), Math.min(...lats)],
                  [Math.max(...lngs), Math.max(...lats)],
                ],
                { padding: 60, duration: 1200, maxZoom: 14 }
              );
            }}
          >
            <TargetIcon size={22} />
          </button>
        </div>

        {/* ── Property summary panel — flex sibling, not absolute overlay ── */}
        {selectedPin && (
          <PropertySummaryPanel
            pin={selectedPin}
            onClose={() => setSelectedPin(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
  },
  statsBar: {
    background: "var(--c-surface-lowest)",
    boxShadow: "0 2px 8px rgba(8,27,57,0.06)",
    padding: "12px 32px",
    display: "flex",
    alignItems: "center",
    gap: 32,
    flexShrink: 0,
    zIndex: 1,
  },
  statItem: {
    display: "flex",
    flexDirection: "column",
    paddingLeft: 12,
  },
  statNumber: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 11,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  // Flex row holding the map area and the side panel.
  mapRow: {
    flex: 1,
    display: "flex",
    flexDirection: "row",
    overflow: "hidden",
  },
  // Map canvas container. No overflow:hidden so chip dropdowns are visible.
  mapArea: {
    flex: 1,
    position: "relative",
  },
  map: {
    width: "100%",
    height: "100%",
  },
  // Floating pill toolbar — glassmorphism, horizontally centered on the map.
  // max-width + overflow-x scroll ensures chips don't disappear off-screen on
  // narrow viewports (e.g. 1024px wide dashboard with sidebar).
  pillToolbar: {
    position: "absolute",
    top: 14,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "5px 8px",
    background: "rgba(255,255,255,0.88)",
    backdropFilter: "blur(12px)",
    borderRadius: 9999,
    boxShadow: "0 4px 20px rgba(8,27,57,0.12)",
    maxWidth: "calc(100% - 28px)",
    overflowX: "auto",
    // Hide scrollbar visually while keeping it functional
    scrollbarWidth: "none" as const,
  },
  pillSep: {
    width: 1,
    height: 20,
    background: "rgba(0,0,0,0.1)",
    margin: "0 4px",
    flexShrink: 0,
  },
  // Chip dropdown panel
  chipDropdown: {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: 0,
    background: "var(--c-surface-lowest)",
    borderRadius: 12,
    boxShadow: "0 8px 24px rgba(8,27,57,0.14)",
    zIndex: 50,
    minWidth: 180,
    padding: "8px 0",
    overflow: "hidden",
  },
  chipDropdownTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#9e9e9e",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    padding: "4px 12px 8px",
  },
  chipDropdownItem: {
    display: "block",
    width: "100%",
    padding: "8px 12px",
    background: "none",
    border: "none",
    textAlign: "left",
    fontSize: 13,
    cursor: "pointer",
  },
  chipCheckLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
    fontSize: 13,
    color: "#191c1e",
    cursor: "pointer",
    userSelect: "none",
  },
  chipCheck: {
    accentColor: "var(--c-primary)",
    width: 14,
    height: 14,
    flexShrink: 0,
  },
  chipInputLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: "#9e9e9e",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 3,
    padding: "0 12px",
  },
  chipInput: {
    width: "100%",
    padding: "6px 12px",
    border: "none",
    borderTop: "1px solid #f2f4f7",
    borderBottom: "1px solid #f2f4f7",
    fontSize: 12,
    color: "#191c1e",
    outline: "none",
    background: "#f2f4f7",
    boxSizing: "border-box" as const,
  },
  chipClearBtn: {
    width: "100%",
    padding: "6px 12px",
    background: "none",
    border: "none",
    color: "#e53e3e",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "left" as const,
    marginTop: 4,
  },
  // Live indicator — glassmorphism pill, top-right of map area
  liveIndicator: {
    position: "absolute",
    top: 14,
    right: 14,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "6px 12px",
    borderRadius: 9999,
    backdropFilter: "blur(12px)",
    boxShadow: "0 2px 8px rgba(8,27,57,0.1)",
    pointerEvents: "none",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background 0.3s, box-shadow 0.3s",
  },
  liveText: {
    fontSize: 10,
    fontWeight: 700,
    color: "#414751",
    letterSpacing: 0.3,
    whiteSpace: "nowrap",
  },
  // Legend — bottom-left, above MapLibre zoom controls (which sit at ~80px)
  legend: {
    position: "absolute",
    bottom: 100,
    left: 14,
    zIndex: 10,
    background: "rgba(255,255,255,0.88)",
    backdropFilter: "blur(12px)",
    borderRadius: 12,
    padding: "12px 14px",
    boxShadow: "0 4px 16px rgba(8,27,57,0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 7,
    pointerEvents: "none",
  },
  legendTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#9e9e9e",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    flexShrink: 0,
    border: "2px solid rgba(255,255,255,0.8)",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.1)",
  },
  legendLabel: {
    fontSize: 12,
    color: "#191c1e",
    fontWeight: 500,
  },
  // FAB — zoom-to-crisis, bottom-right of map area
  fab: {
    position: "absolute",
    bottom: 24,
    right: 16,
    zIndex: 10,
    width: 52,
    height: 52,
    borderRadius: "50%",
    border: "none",
    cursor: "pointer",
    background: "linear-gradient(135deg, var(--c-primary) 0%, var(--c-primary-container) 100%)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 16px rgba(0,80,138,0.35)",
    transition: "opacity 0.15s, transform 0.15s",
  },
};

