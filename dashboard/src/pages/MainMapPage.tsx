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
  const activeFilterCount = flagParam ? 1 : 0;

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
    queryKey: ["map-pins", activeCrisisId, flagParam],
    queryFn: async () => {
      if (!activeCrisisId) return { pins: [], total: 0 };
      const params: Record<string, string> = { crisis_id: activeCrisisId };
      if (flagParam) params.flag_status = flagParam;
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
          <div style={{ ...styles.statItem, borderLeft: "3px solid #4caf50" }}>
            <span style={{ ...styles.statNumber, color: "#4caf50" }}>
              {stats.green_count}
            </span>
            <span style={styles.statLabel}>Verified</span>
          </div>
          {/* Fix 11: label changed from "Flagged" to "Needs Attention" */}
          <div style={{ ...styles.statItem, borderLeft: "3px solid #ff9800" }}>
            <span style={{ ...styles.statNumber, color: "#ff9800" }}>
              {stats.orange_count}
            </span>
            <span style={styles.statLabel}>Needs Attention</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #f44336" }}>
            <span style={{ ...styles.statNumber, color: "#f44336" }}>
              {stats.red_count}
            </span>
            <span style={styles.statLabel}>Review</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #9e9e9e" }}>
            <span style={{ ...styles.statNumber, color: "#9e9e9e" }}>
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
                ? "rgba(255,255,255,0.97)"
                : "rgba(255,248,240,0.97)",
          }}
        >
          <div
            style={{
              ...styles.liveDot,
              background:
                liveStatus === "connected" ? "#4caf50" : "#ff9800",
              boxShadow:
                liveStatus === "connected"
                  ? "0 0 0 3px rgba(76,175,80,0.25)"
                  : "0 0 0 3px rgba(255,152,0,0.25)",
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

              {/* ── Disabled filters — backend support pending ── */}
              {[
                "Damage Level",
                "Crisis Type",
                "Date Range",
                "Country",
                "Show Recovered Properties",
              ].map((name) => (
                <div key={name} style={styles.filterGroup}>
                  <div style={styles.filterGroupLabel}>{name}</div>
                  <div
                    style={styles.filterDisabled}
                    title="Available after backend update"
                  >
                    Available after backend update
                  </div>
                </div>
              ))}
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
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
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
    color: "#1A2B4A",
    lineHeight: 1,
  },
  statLabel: {
    fontSize: 11,
    color: "#666",
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
    boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
    border: "1px solid rgba(0,0,0,0.07)",
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
    color: "#444",
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
    background: "#fff",
    border: "1.5px solid #e0e0e0",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "#1A2B4A",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    whiteSpace: "nowrap",
  },
  filterBadge: {
    background: "#0468B1",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 10,
    marginLeft: 2,
  },
  filterPanel: {
    marginTop: 6,
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    boxShadow: "0 4px 20px rgba(0,0,0,0.13)",
    padding: "14px 16px",
    width: 260,
  },
  filterPanelTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#9aa5b4",
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
    color: "#1A2B4A",
    marginBottom: 6,
  },
  filterCheckLabel: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    color: "#1A2B4A",
    cursor: "pointer",
    marginBottom: 5,
    userSelect: "none",
  },
  filterCheck: {
    accentColor: "#0468B1",
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
    color: "#b0bec5",
    fontStyle: "italic",
    padding: "4px 8px",
    background: "#f8fafc",
    borderRadius: 6,
    border: "1px dashed #e0e0e0",
    cursor: "not-allowed",
  },
  // Legend — bottom-left of canvas
  legend: {
    position: "absolute",
    bottom: 32,
    left: 14,
    background: "rgba(255,255,255,0.97)",
    borderRadius: 10,
    padding: "12px 16px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.14)",
    display: "flex",
    flexDirection: "column",
    gap: 7,
    zIndex: 10,
    border: "1px solid rgba(0,0,0,0.07)",
    pointerEvents: "none",
  },
  legendTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: "#9aa5b4",
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
    border: "2px solid #fff",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
  },
  legendLabel: {
    fontSize: 12,
    color: "#1A2B4A",
    fontWeight: 500,
  },
  legendNote: {
    fontSize: 11,
    color: "#9aa5b4",
    fontStyle: "italic",
    marginTop: 5,
    lineHeight: 1.4,
  },
};

// Suppress unused import warning — DAMAGE_LABELS used in legend via inline array
void DAMAGE_LABELS;
