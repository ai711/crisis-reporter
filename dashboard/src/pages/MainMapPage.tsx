import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import { useSSE } from "../hooks/useSSE";
import api from "../services/api";
import type { MapPin, DashboardStats, Crisis, SSEEvent } from "../types";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
const DAMAGE_COLORS = {
  minimal: "#4caf50",
  partial: "#ff9800",
  complete: "#f44336",
};

export default function MainMapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const queryClient = useQueryClient();
  const { activeCrisisId, setActiveCrisis } = useAuthStore();
  const [liveStatus, setLiveStatus] = useState<"connected" | "disconnected">("disconnected");
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  // Load crises
  const { data: crises } = useQuery<Crisis[]>({
    queryKey: ["crises"],
    queryFn: async () => {
      const response = await api.get("/api/crises");
      return response.data;
    },
  });

  // Auto-select first crisis
  useEffect(() => {
    if (crises && crises.length > 0 && !activeCrisisId) {
      setActiveCrisis(crises[0].id, crises[0].name);
    }
  }, [crises, activeCrisisId, setActiveCrisis]);

  // Load map pins
  const { data: pinsData } = useQuery({
    queryKey: ["map-pins", activeCrisisId],
    queryFn: async () => {
      if (!activeCrisisId) return { pins: [], total: 0 };
      const response = await api.get("/api/dashboard/map/pins", {
        params: { crisis_id: activeCrisisId },
      });
      return response.data;
    },
    enabled: !!activeCrisisId,
    refetchInterval: liveStatus === "disconnected" ? 20000 : false,
  });

  // Load stats
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats", activeCrisisId],
    queryFn: async () => {
      if (!activeCrisisId) return null;
      const response = await api.get("/api/dashboard/map/stats", {
        params: { crisis_id: activeCrisisId },
      });
      return response.data;
    },
    enabled: !!activeCrisisId,
    refetchInterval: liveStatus === "disconnected" ? 20000 : false,
  });

  // SSE real-time updates
  const handleSSEEvent = useCallback((event: SSEEvent) => {
    if (event.type === "connected") {
      setLiveStatus("connected");
      setLastUpdated(new Date());
    } else if (event.type === "heartbeat") {
      setLastUpdated(new Date());
    } else if (event.type === "report_confirmed" || event.type === "flag_changed") {
      queryClient.invalidateQueries({ queryKey: ["map-pins", activeCrisisId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats", activeCrisisId] });
      setLastUpdated(new Date());
    } else if (event.type === "error") {
      setLiveStatus("disconnected");
    }
  }, [activeCrisisId, queryClient]);

  useSSE({
    crisisId: activeCrisisId,
    onEvent: handleSSEEvent,
    enabled: !!activeCrisisId,
  });

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
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

    map.current.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map pins
  useEffect(() => {
    if (!map.current || !pinsData?.pins) return;

    // Remove existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Add new markers
    pinsData.pins.forEach((pin: MapPin) => {
      const el = document.createElement("div");
      el.style.cssText = `
        width: 32px;
        height: 32px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        background: ${DAMAGE_COLORS[pin.damage_level] || "#666"};
        border: 3px solid #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      if (pin.report_count > 1) {
        const badge = document.createElement("div");
        badge.style.cssText = `
          position: absolute;
          top: -8px;
          right: -8px;
          background: #1A2B4A;
          color: #fff;
          border-radius: 50%;
          width: 18px;
          height: 18px;
          font-size: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          transform: rotate(45deg);
        `;
        badge.textContent = String(pin.report_count);
        el.style.position = "relative";
        el.appendChild(badge);
      }

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([pin.longitude, pin.latitude])
        .setPopup(
          new maplibregl.Popup({ offset: 25 }).setHTML(`
            <div style="padding: 8px; font-family: sans-serif;">
              <div style="font-weight: 700; text-transform: capitalize; color: #1A2B4A;">
                ${pin.damage_level} damage
              </div>
              <div style="font-size: 13px; color: #666; margin-top: 4px;">
                ${pin.report_count} report(s)
              </div>
              <div style="font-size: 12px; color: #999; margin-top: 2px;">
                ${pin.latitude.toFixed(4)}, ${pin.longitude.toFixed(4)}
              </div>
            </div>
          `)
        )
        .addTo(map.current!);

      markersRef.current.push(marker);
    });

    // Fit map to pins if any exist
    if (pinsData.pins.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      pinsData.pins.forEach((pin: MapPin) => {
        bounds.extend([pin.longitude, pin.latitude]);
      });
      map.current.fitBounds(bounds, { padding: 80, maxZoom: 14 });
    }
  }, [pinsData]);

  const secondsSinceUpdate = Math.floor(
    (new Date().getTime() - lastUpdated.getTime()) / 1000
  );

  return (
    <div style={styles.container}>
      <Header
        title="Crisis Map"
        subtitle={`${pinsData?.total || 0} locations reported`}
      />

      {/* Stats bar */}
      {stats && (
        <div style={styles.statsBar}>
          <div style={styles.statItem}>
            <span style={styles.statNumber}>{stats.total_reports}</span>
            <span style={styles.statLabel}>Total</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #4caf50" }}>
            <span style={{ ...styles.statNumber, color: "#4caf50" }}>{stats.green_count}</span>
            <span style={styles.statLabel}>Verified</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #ff9800" }}>
            <span style={{ ...styles.statNumber, color: "#ff9800" }}>{stats.orange_count}</span>
            <span style={styles.statLabel}>Flagged</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #f44336" }}>
            <span style={{ ...styles.statNumber, color: "#f44336" }}>{stats.red_count}</span>
            <span style={styles.statLabel}>Review</span>
          </div>
          <div style={{ ...styles.statItem, borderLeft: "3px solid #9e9e9e" }}>
            <span style={{ ...styles.statNumber, color: "#9e9e9e" }}>{stats.grey_count}</span>
            <span style={styles.statLabel}>Processing</span>
          </div>

          {/* Live indicator */}
          <div style={styles.liveIndicator}>
            <div style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: liveStatus === "connected" ? "#4caf50" : "#ff9800",
              marginRight: 8,
            }} />
            <span style={styles.liveText}>
              {liveStatus === "connected"
                ? `LIVE — LAST UPDATED ${secondsSinceUpdate}s ago`
                : "CONNECTION LOST — MAP DATA MAY BE OUTDATED"}
            </span>
          </div>
        </div>
      )}

      {/* Map */}
      <div style={styles.mapWrapper}>
        <div ref={mapContainer} style={styles.map} />

        {/* Legend */}
        <div style={styles.legend}>
          <div style={styles.legendTitle}>Damage Level</div>
          {Object.entries(DAMAGE_COLORS).map(([level, color]) => (
            <div key={level} style={styles.legendItem}>
              <div style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: color,
              }} />
              <span style={styles.legendLabel}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </span>
            </div>
          ))}
        </div>

        {/* Crisis selector */}
        {crises && crises.length > 1 && (
          <div style={styles.crisisSelector}>
            <select
              style={styles.crisisSelect}
              value={activeCrisisId || ""}
              onChange={(e) => {
                const crisis = crises.find((c) => c.id === e.target.value);
                if (crisis) setActiveCrisis(crisis.id, crisis.name);
              }}
            >
              {crises.map((crisis) => (
                <option key={crisis.id} value={crisis.id}>
                  {crisis.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

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
  liveIndicator: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    background: "#f4f6f9",
    padding: "6px 14px",
    borderRadius: 20,
  },
  liveText: {
    fontSize: 12,
    color: "#444",
    fontWeight: 500,
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
  legend: {
    position: "absolute",
    bottom: 32,
    left: 16,
    background: "#fff",
    borderRadius: 8,
    padding: "12px 16px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    zIndex: 10,
  },
  legendTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  legendLabel: {
    fontSize: 13,
    color: "#1A2B4A",
  },
  crisisSelector: {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 10,
  },
  crisisSelect: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    background: "#fff",
    fontSize: 14,
    fontWeight: 500,
    color: "#1A2B4A",
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    cursor: "pointer",
  },
};