import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import maplibregl, { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Header from "../components/Header";
import PropertySummaryPanel from "../components/PropertySummaryPanel";
import { useAuthStore } from "../stores/authStore";
import { useSSE } from "../hooks/useSSE";
import api from "../services/api";
import type { MapPin, DashboardStats, Crisis, SSEEvent } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";

const DAMAGE_COLORS: Record<string, string> = {
  minimal: "#4caf50",
  partial: "#ff9800",
  complete: "#f44336",
};

const DAMAGE_LABELS: Record<string, string> = {
  minimal: "Minimal or No Damage",
  partial: "Partially Damaged",
  complete: "Completely Destroyed",
};

// ── Funnel icon (inline SVG — filter button) ──────────────────────────────────

function FunnelIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MainMapPage() {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Stable ref to setSelectedPin so map click handlers (defined once) always
  // call the current setter without stale closure issues.
  const setSelectedPinRef = useRef<((p: MapPin | null) => void) | null>(null);
  // Track which crisis we most recently flew to — prevents repeated flyTo.
  const lastFlyToCrisisRef = useRef<string | null>(null);

  // ── Store ─────────────────────────────────────────────────────────────────
  const queryClient = useQueryClient();
  const { activeCrisisId, setActiveCrisis } = useAuthStore();

  // ── State ─────────────────────────────────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<"connected" | "disconnected">(
    "disconnected"
  );
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  // Tick increments every second to keep the "X seconds ago" display live.
  const [, setTick] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [selectedPin, setSelectedPin] = useState<MapPin | null>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [flagFilters, setFlagFilters] = useState({
    green: true,
    orange: true,
  });
  const [damageLevel, setDamageLevel] = useState<string[]>([]);
  const [crisisType, setCrisisType] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [country, setCountry] = useState("");
  const [showRecovered, setShowRecovered] = useState(false);

  // Keep setter ref current every render.
  setSelectedPinRef.current = setSelectedPin;

  // ── Seconds ticker ────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Filter helpers ────────────────────────────────────────────────────────
  const activeFlags = (
    [flagFilters.green && "green", flagFilters.orange && "orange"] as (
      | string
      | false
    )[]
  ).filter(Boolean) as string[];

  // Pass a single flag_status param only when filtering to one flag;
  // omit it (use backend default green+orange) when both are active.
  const flagParam = activeFlags.length === 1 ? activeFlags[0] : undefined;
  const activeFilterCount = [
    flagParam ? 1 : 0,
    damageLevel.length > 0 ? 1 : 0,
    crisisType.length > 0 ? 1 : 0,
    (dateFrom || dateTo) ? 1 : 0,
    country.trim() ? 1 : 0,
    showRecovered ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const handleFlagFilter = (flag: "green" | "orange") => {
    setFlagFilters((prev) => {
      const next = { ...prev, [flag]: !prev[flag] };
      // Never allow both to be false.
      if (!next.green && !next.orange) return prev;
      return next;
    });
  };

  // ── Data queries ──────────────────────────────────────────────────────────
  const { data: crises } = useQuery<Crisis[]>({
    queryKey: ["crises"],
    queryFn: async () => {
      const res = await api.get<Crisis[]>("/api/crises");
      return res.data;
    },
  });

  const { data: pinsData } = useQuery({
    queryKey: [
      "map-pins",
      activeCrisisId,
      flagParam,
      damageLevel.join(","),
      crisisType.join(","),
      dateFrom,
      dateTo,
      country,
      showRecovered,
    ],
    queryFn: async () => {
      if (!activeCrisisId) return { pins: [], total: 0 };
      const params: Record<string, string> = { crisis_id: activeCrisisId };
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
    enabled: !!activeCrisisId,
    refetchInterval: liveStatus === "disconnected" ? 20000 : false,
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats", activeCrisisId],
    queryFn: async () => {
      if (!activeCrisisId) return null;
      const res = await api.get("/api/dashboard/map/stats", {
        params: { crisis_id: activeCrisisId },
      });
      return res.data;
    },
    enabled: !!activeCrisisId,
    refetchInterval: liveStatus === "disconnected" ? 20000 : false,
  });

  // ── Auto-select first crisis ───────────────────────────────────────────────
  useEffect(() => {
    if (crises && crises.length > 0 && !activeCrisisId) {
      setActiveCrisis(crises[0].id, crises[0].name);
    }
  }, [crises, activeCrisisId, setActiveCrisis]);

  // Stable ref so SSE handler always sees the current selectedPin without stale closure.
  const selectedPinRef = useRef<MapPin | null>(null);
  selectedPinRef.current = selectedPin;

  // ── SSE real-time updates ─────────────────────────────────────────────────
  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (event.type === "connected") {
        setLiveStatus("connected");
        setLastUpdated(new Date());
      } else if (event.type === "heartbeat") {
        setLastUpdated(new Date());
      } else if (
        event.type === "report_confirmed" ||
        event.type === "flag_changed"
      ) {
        queryClient.invalidateQueries({
          queryKey: ["map-pins", activeCrisisId],
        });
        queryClient.invalidateQueries({
          queryKey: ["dashboard-stats", activeCrisisId],
        });
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
    [activeCrisisId, queryClient]
  );

  useSSE({
    crisisId: activeCrisisId,
    onEvent: handleSSEEvent,
    enabled: !!activeCrisisId,
  });

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

    m.addControl(new maplibregl.NavigationControl(), "top-right");

    m.on("load", () => {
      // ── GeoJSON source with cluster support ──────────────────────────────
      m.addSource("pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
        clusterProperties: {
          // Accumulate counts of each damage level across cluster members.
          // Used to drive cluster colour (most severe wins).
          any_destroyed: [
            "+",
            ["case", ["==", ["get", "damage_level"], "complete"], 1, 0],
          ],
          any_partial: [
            "+",
            ["case", ["==", ["get", "damage_level"], "partial"], 1, 0],
          ],
        },
      });

      // ── Cluster circle layer ──────────────────────────────────────────────
      m.addLayer({
        id: "clusters",
        type: "circle",
        source: "pins",
        filter: ["has", "point_count"],
        paint: {
          // Colour: red if any Completely Destroyed, orange if any Partially
          // Damaged, green if all Minimal or No Damage.
          "circle-color": [
            "case",
            [">", ["get", "any_destroyed"], 0],
            "#f44336",
            [">", ["get", "any_partial"], 0],
            "#ff9800",
            "#4caf50",
          ],
          // Radius scales with the number of properties in the cluster.
          "circle-radius": [
            "step",
            ["get", "point_count"],
            20,
            10,
            30,
            50,
            40,
          ],
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
        paint: {
          "text-color": "#fff",
        },
      });

      // ── Individual (unclustered) pin circle ───────────────────────────────
      m.addLayer({
        id: "unclustered-pin",
        type: "circle",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "match",
            ["get", "damage_level"],
            "complete",
            "#f44336",
            "partial",
            "#ff9800",
            "#4caf50",
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
        paint: {
          "text-color": "#fff",
        },
      });

      // ── Click: cluster → zoom in ──────────────────────────────────────────
      m.on("click", "clusters", async (e) => {
        const features = m.queryRenderedFeatures(e.point, {
          layers: ["clusters"],
        });
        if (!features.length) return;
        const clusterId = features[0].properties?.cluster_id as number;
        const source = m.getSource("pins") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coords = (features[0].geometry as GeoJSON.Point)
          .coordinates as [number, number];
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
        if (!hit.length) {
          setSelectedPinRef.current?.(null);
        }
      });

      // ── Cursor feedback ───────────────────────────────────────────────────
      m.on("mouseenter", "clusters", () => {
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "clusters", () => {
        m.getCanvas().style.cursor = "";
      });
      m.on("mouseenter", "unclustered-pin", () => {
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "unclustered-pin", () => {
        m.getCanvas().style.cursor = "";
      });

      setMapReady(true);
    });

    map.current = m;

    return () => {
      m.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  // ── Fly to active crisis centre (Fix 1) ───────────────────────────────────
  // Runs when crises data loads or active crisis changes. Only flies once per
  // crisis ID to avoid fighting with the user's manual panning.
  useEffect(() => {
    if (!map.current || !crises || !activeCrisisId) return;
    if (lastFlyToCrisisRef.current === activeCrisisId) return;
    const crisis = crises.find((c) => c.id === activeCrisisId);
    if (crisis?.map_center_lat && crisis?.map_center_lng) {
      map.current.flyTo({
        center: [crisis.map_center_lng, crisis.map_center_lat],
        zoom: 10,
        duration: 1500,
      });
      lastFlyToCrisisRef.current = activeCrisisId;
    }
  }, [crises, activeCrisisId]);

  // ── Update GeoJSON source when pins data changes ──────────────────────────
  useEffect(() => {
    if (!map.current || !mapReady || !pinsData?.pins) return;
    const source = map.current.getSource("pins") as GeoJSONSource | undefined;
    if (!source) return;

    const features: GeoJSON.Feature[] = pinsData.pins.map((pin: MapPin) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [pin.longitude, pin.latitude],
      },
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

  return (
    <div style={styles.container}>
      <Header
        title="Crisis Map"
        subtitle={`${pinsData?.total ?? 0} location${(pinsData?.total ?? 0) !== 1 ? "s" : ""} reported`}
      />

      {/* ── Stats bar ── */}
      {stats && (
        <div style={styles.statsBar}>
          <div style={styles.statItem}>
            <span style={styles.statNumber}>{stats.total_reports}</span>
            <span style={styles.statLabel}>Total</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid var(--c-flag-green)" }}>
            <span style={{ ...styles.statNumber, color: "var(--c-flag-green)" }}>
              {stats.green_count}
            </span>
            <span style={styles.statLabel}>Verified</span>
          </div>
          {/* Fix 11: label changed from "Flagged" to "Needs Attention" */}
          <div style={{ ...styles.statItem, borderLeft: "3px solid var(--c-flag-orange)" }}>
            <span style={{ ...styles.statNumber, color: "var(--c-flag-orange)" }}>
              {stats.orange_count}
            </span>
            <span style={styles.statLabel}>Needs Attention</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid var(--c-flag-red)" }}>
            <span style={{ ...styles.statNumber, color: "var(--c-flag-red)" }}>
              {stats.red_count}
            </span>
            <span style={styles.statLabel}>Review</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid var(--c-flag-grey)" }}>
            <span style={{ ...styles.statNumber, color: "var(--c-flag-grey)" }}>
              {stats.grey_count}
            </span>
            <span style={styles.statLabel}>Processing</span>
          </div>
        </div>
      )}

      {/* ── Map canvas area ── */}
      <div style={styles.mapWrapper}>
        <div ref={mapContainer} style={styles.map} />

        {/* Fix 2: Live indicator — always on canvas, outside stats conditional */}
        <div
          style={{
            ...styles.liveIndicator,
            background:
              liveStatus === "connected"
                ? "var(--c-surface-lowest)"
                : "rgba(255,248,240,0.97)",
          }}
        >
          <div
            style={{
              ...styles.liveDot,
              background:
                liveStatus === "connected" ? "var(--c-flag-green)" : "var(--c-flag-orange)",
              boxShadow:
                liveStatus === "connected"
                  ? "0 0 0 3px rgba(56,161,105,0.25)"
                  : "0 0 0 3px rgba(242,153,74,0.25)",
            }}
          />
          <span style={styles.liveText}>
            {liveStatus === "connected"
              ? `LIVE — LAST UPDATED ${secondsSince}s ago`
              : "CONNECTION LOST — MAP DATA MAY BE OUTDATED"}
          </span>
        </div>

        {/* Fix 9: Filter button + panel */}
        <div style={styles.filterArea}>
          <button
            style={styles.filterBtn}
            onClick={() => setFilterPanelOpen((o) => !o)}
            aria-expanded={filterPanelOpen}
          >
            <FunnelIcon />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span style={styles.filterBadge}>
                {activeFilterCount} active
              </span>
            )}
          </button>

          {filterPanelOpen && (
            <div style={styles.filterPanel}>
              <div style={styles.filterPanelTitle}>Filter map pins</div>

              {/* ── Flag status (active — backend supported) ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Flag Status</div>
                <label style={styles.filterCheckLabel}>
                  <input
                    type="checkbox"
                    checked={flagFilters.green}
                    onChange={() => handleFlagFilter("green")}
                    style={styles.filterCheck}
                  />
                  <span
                    style={{
                      ...styles.filterFlagDot,
                      background: "#4caf50",
                    }}
                  />
                  Green (Verified)
                </label>
                <label style={styles.filterCheckLabel}>
                  <input
                    type="checkbox"
                    checked={flagFilters.orange}
                    onChange={() => handleFlagFilter("orange")}
                    style={styles.filterCheck}
                  />
                  <span
                    style={{
                      ...styles.filterFlagDot,
                      background: "#ff9800",
                    }}
                  />
                  Orange (Needs Attention)
                </label>
              </div>

              {/* ── Damage Level ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Damage Level</div>
                {[
                  { value: "complete", label: "Completely Destroyed" },
                  { value: "partial", label: "Partially Damaged" },
                  { value: "minimal", label: "Minimal or No Damage" },
                ].map(({ value, label }) => (
                  <label key={value} style={styles.filterCheckLabel}>
                    <input
                      type="checkbox"
                      checked={damageLevel.includes(value)}
                      onChange={() =>
                        setDamageLevel((prev) =>
                          prev.includes(value)
                            ? prev.filter((v) => v !== value)
                            : [...prev, value]
                        )
                      }
                      style={styles.filterCheck}
                    />
                    <span
                      style={{
                        ...styles.filterFlagDot,
                        background: DAMAGE_COLORS[value],
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>

              {/* ── Crisis Type ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Crisis Type</div>
                {[
                  "earthquake",
                  "flood",
                  "cyclone",
                  "wildfire",
                  "landslide",
                  "tsunami",
                  "conflict",
                  "drought",
                  "other",
                ].map((type) => (
                  <label key={type} style={styles.filterCheckLabel}>
                    <input
                      type="checkbox"
                      checked={crisisType.includes(type)}
                      onChange={() =>
                        setCrisisType((prev) =>
                          prev.includes(type)
                            ? prev.filter((t) => t !== type)
                            : [...prev, type]
                        )
                      }
                      style={styles.filterCheck}
                    />
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </label>
                ))}
              </div>

              {/* ── Date Range ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Date Range</div>
                <div style={styles.filterDateRow}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.filterDateLabel}>From</div>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      style={styles.filterInput}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={styles.filterDateLabel}>To</div>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      style={styles.filterInput}
                    />
                  </div>
                </div>
              </div>

              {/* ── Country ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Country</div>
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="e.g. TR, UA"
                  style={styles.filterInput}
                />
              </div>

              {/* ── Show Recovered Properties ── */}
              <div style={styles.filterGroup}>
                <div style={styles.filterGroupLabel}>Recovered Properties</div>
                <label style={{ ...styles.filterCheckLabel, alignItems: "flex-start", gap: 10 }}>
                  <div
                    style={{
                      ...styles.filterToggle,
                      background: showRecovered ? "var(--c-primary-container)" : "var(--c-surface-high)",
                      marginTop: 2,
                      flexShrink: 0,
                    }}
                    onClick={() => setShowRecovered((v) => !v)}
                    role="switch"
                    aria-checked={showRecovered}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter")
                        setShowRecovered((v) => !v);
                    }}
                  >
                    <div
                      style={{
                        ...styles.filterToggleThumb,
                        transform: showRecovered
                          ? "translateX(18px)"
                          : "translateX(2px)",
                      }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, color: "var(--c-text-primary)" }}>
                      Show recovered properties
                    </div>
                    <div style={{ fontSize: 11, color: "var(--c-text-muted)", marginTop: 2 }}>
                      Recovered properties are hidden by default.
                    </div>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Fix 3: Legend with full damage level labels + count badge note */}
        <div style={styles.legend}>
          <div style={styles.legendTitle}>Damage Level</div>
          {(
            [
              ["complete", "Completely Destroyed"],
              ["partial", "Partially Damaged"],
              ["minimal", "Minimal or No Damage"],
            ] as [string, string][]
          ).map(([level, label]) => (
            <div key={level} style={styles.legendItem}>
              <div
                style={{
                  ...styles.legendDot,
                  background: DAMAGE_COLORS[level],
                }}
              />
              <span style={styles.legendLabel}>{label}</span>
            </div>
          ))}
          <div style={styles.legendNote}>
            Number on pin = report count for that property
          </div>
        </div>

        {/* Fix 7: Property summary panel — slides in from right */}
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
    borderBottom: "1px solid var(--c-border)",
    padding: "12px 32px",
    display: "flex",
    alignItems: "center",
    gap: 32,
    flexShrink: 0,
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
  mapWrapper: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  map: {
    width: "100%",
    height: "100%",
  },
  // Live indicator — always on the canvas, top-right below nav controls
  liveIndicator: {
    position: "absolute",
    top: 52,
    right: 12,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "6px 13px",
    borderRadius: 20,
    boxShadow: "var(--shadow-sm)",
    border: "1px solid var(--c-border)",
    pointerEvents: "none",
  },
  liveDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background 0.3s, box-shadow 0.3s",
  },
  liveText: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--c-text-secondary)",
    letterSpacing: 0.2,
    whiteSpace: "nowrap",
  },
  // Filter button — top-left of canvas
  filterArea: {
    position: "absolute",
    top: 14,
    left: 14,
    zIndex: 10,
  },
  filterBtn: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 14px",
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-surface-high)",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-text-primary)",
    cursor: "pointer",
    boxShadow: "var(--shadow-sm)",
    whiteSpace: "nowrap",
  },
  filterBadge: {
    background: "var(--c-primary-container)",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 10,
    marginLeft: 2,
  },
  filterPanel: {
    marginTop: 6,
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderRadius: 10,
    boxShadow: "var(--shadow-float)",
    padding: "14px 16px",
    width: 300,
    maxHeight: "calc(100vh - 180px)",
    overflowY: "auto",
  },
  filterPanelTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--c-text-subtle)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  filterGroup: {
    marginBottom: 14,
  },
  filterGroupLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--c-text-primary)",
    marginBottom: 6,
  },
  filterCheckLabel: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    color: "var(--c-text-primary)",
    cursor: "pointer",
    marginBottom: 5,
    userSelect: "none",
  },
  filterCheck: {
    accentColor: "var(--c-primary-container)",
    width: 14,
    height: 14,
    flexShrink: 0,
  },
  filterFlagDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  filterDisabled: {
    fontSize: 12,
    color: "var(--c-text-subtle)",
    fontStyle: "italic",
    padding: "4px 8px",
    background: "var(--c-surface-lowest)",
    borderRadius: 6,
    border: "1px dashed var(--c-surface-high)",
    cursor: "not-allowed",
  },
  filterInput: {
    width: "100%",
    padding: "6px 8px",
    border: "1.5px solid var(--c-surface-high)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
    boxSizing: "border-box" as const,
  },
  filterDateRow: {
    display: "flex",
    gap: 8,
  },
  filterDateLabel: {
    fontSize: 10,
    color: "var(--c-text-subtle)",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
    marginBottom: 3,
  },
  filterToggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    position: "relative" as const,
    cursor: "pointer",
    transition: "background 0.2s",
  },
  filterToggleThumb: {
    position: "absolute" as const,
    top: 2,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
    transition: "transform 0.2s",
  },
  // Legend — bottom-left of canvas
  legend: {
    position: "absolute",
    bottom: 32,
    left: 14,
    background: "var(--c-surface-lowest)",
    borderRadius: 10,
    padding: "12px 16px",
    boxShadow: "var(--shadow-card)",
    display: "flex",
    flexDirection: "column",
    gap: 7,
    zIndex: 10,
    border: "1px solid var(--c-border)",
    pointerEvents: "none",
  },
  legendTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-subtle)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 9,
  },
  legendDot: {
    width: 13,
    height: 13,
    borderRadius: "50%",
    flexShrink: 0,
    border: "2px solid var(--c-surface-lowest)",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
  },
  legendLabel: {
    fontSize: 12,
    color: "var(--c-text-primary)",
    fontWeight: 500,
  },
  legendNote: {
    fontSize: 11,
    color: "var(--c-text-subtle)",
    fontStyle: "italic",
    marginTop: 5,
    lineHeight: 1.4,
  },
};

// Suppress unused import warning — DAMAGE_LABELS used in legend via inline array
void DAMAGE_LABELS;
