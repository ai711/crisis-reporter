import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import maplibregl, { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { UserMinus, AlertTriangle } from "lucide-react";
import Layout from "../components/Layout";
import Header from "../components/Header";
import PropertySummaryPanel from "../components/PropertySummaryPanel";
import { useAuthStore } from "../stores/authStore";
import {
  getProjectDetail,
  getProjectImportStatus,
  getProjectReports,
  getProjectProperties,
  getProjectStats,
  getProjectUsers,
  addProjectUser,
  removeProjectUser,
  updateProjectUserAccess,
} from "../services/api";
import api from "../services/api";
import type { ProjectDetail, ProjectUser, MapPin, FlagStatus } from "../types";
import {
  formatDateTime,
  formatDamageLevel,
  formatProjectStatus,
  formatDateRange,
  isEndDatePassed,
  PROJECT_STATUS_COLOURS,
} from "../utils/formatters";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";
const BLUE = "#0468B1";

const DAMAGE_COLORS: Record<string, string> = {
  minimal: "#4caf50",
  partial: "#ff9800",
  complete: "#f44336",
};

const FLAG_COLORS: Record<string, string> = {
  grey: "#9e9e9e",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
  discarded: "#616161",
};

const PIE_COLORS: Record<string, string> = {
  "Completely Destroyed": "#F44336",
  "Partially Damaged": "#FF9800",
  "Minimal or No Damage": "#4CAF50",
};

// ── Local types ───────────────────────────────────────────────────────────────

interface ProjectReportItem {
  report_id: string;
  serial_number?: number | null;
  created_at: string;
  country: string | null;
  damage_level: string;
  infrastructure_types: string[];
  crisis_type: string | null;
  flag_status: FlagStatus;
}

interface ProjectReportsResponse {
  items: ProjectReportItem[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

interface ProjectPropertyItem {
  property_id: string;
  display_name: string;
  country: string | null;
  current_damage_level: string | null;
  confirmed_status: string | null;
  has_conflict_warning: boolean;
  total_reports: number;
  most_recent_report_at: string | null;
}

interface ProjectPropertiesResponse {
  items: ProjectPropertyItem[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

interface ProjectStatsSummary {
  total_reports: number;
  completely_damaged: number;
  partially_damaged: number;
  minimal_damage: number;
}

interface TimePoint {
  date: string;
  count: number;
}

interface InfraPoint {
  infrastructure_type: string;
  count: number;
}

interface CrisisTypePoint {
  crisis_type: string;
  count: number;
}

interface ProjectStatsResponse {
  summary: ProjectStatsSummary;
  time_series: TimePoint[];
  damage_distribution: {
    completely_damaged: number;
    partially_damaged: number;
    minimal_damage: number;
  };
  infrastructure_breakdown: InfraPoint[];
  crisis_type_breakdown: CrisisTypePoint[];
}

interface ImportStatusResponse {
  import_status: string;
  import_progress: number;
  import_total: number;
}

interface DashboardUserSearchItem {
  id: string;
  full_name: string;
  email: string;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Spinner({ size = 32, full = false }: { size?: number; full?: boolean }) {
  const el = (
    <div
      style={{
        width: size,
        height: size,
        border: "3px solid #e2e8f0",
        borderTop: `3px solid ${BLUE}`,
        borderRadius: "50%",
        animation: "pd-spin 0.8s linear infinite",
      }}
    />
  );
  if (full) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        {el}
      </div>
    );
  }
  return <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>{el}</div>;
}

function SectionCard({
  title,
  badge,
  children,
  action,
}: {
  title?: string;
  badge?: number | string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div style={ss.card}>
      {title && (
        <div style={ss.cardHeader}>
          <div style={ss.cardHeaderLeft}>
            <span style={ss.cardTitle}>{title}</span>
            {badge !== undefined && <span style={ss.countBadge}>{badge}</span>}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function FlagPill({ status }: { status: string }) {
  const color = FLAG_COLORS[status] ?? "#999";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        background: color + "20",
        color,
        border: `1px solid ${color}50`,
      }}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function DamagePill({ level }: { level: string | null }) {
  if (!level) return <span style={{ color: "#ccc" }}>—</span>;
  const label = formatDamageLevel(level);
  const key = level.includes("_")
    ? level === "completely_destroyed"
      ? "complete"
      : level === "partially_damaged"
      ? "partial"
      : "minimal"
    : level;
  const color = DAMAGE_COLORS[key] ?? "#888";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        background: color + "20",
        color,
        border: `1px solid ${color}50`,
      }}
    >
      {label}
    </span>
  );
}

const renderPieLabel = ({ value, percent }: { value: number; percent?: number }) => {
  const pct = percent ?? 0;
  return `${value} (${(pct * 100).toFixed(0)}%)`;
};

// ── Main component ────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { serialId } = useParams<{ serialId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  // ── Project detail ─────────────────────────────────────────────────────
  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
  } = useQuery<ProjectDetail>({
    queryKey: ["project-detail", serialId],
    queryFn: async () => {
      const res = await getProjectDetail(serialId!);
      return res.data;
    },
    enabled: !!serialId,
    retry: 1,
  });

  // ── Import status polling ──────────────────────────────────────────────
  const { data: importStatus } = useQuery<ImportStatusResponse>({
    queryKey: ["project-import-status", serialId],
    queryFn: async () => {
      const res = await getProjectImportStatus(serialId!);
      return res.data;
    },
    enabled: !!serialId,
    refetchInterval: (query) => {
      const status = query.state.data?.import_status;
      if (status === "complete" || status === "failed") return false;
      return 3000;
    },
  });

  const effectiveImportStatus =
    importStatus?.import_status ?? project?.import_status ?? "complete";

  // ── Map refs & state ───────────────────────────────────────────────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const setSelectedPinRef = useRef<((p: MapPin | null) => void) | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selectedPin, setSelectedPin] = useState<MapPin | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connected" | "disconnected">("disconnected");
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [, setTick] = useState(0);

  setSelectedPinRef.current = setSelectedPin;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const { data: pinsData } = useQuery({
    queryKey: ["project-map-pins", serialId],
    queryFn: async () => {
      const res = await api.get("/api/dashboard/map/pins", {
        params: { project_serial_id: serialId },
      });
      setLiveStatus("connected");
      setLastUpdated(new Date());
      return res.data as { pins: MapPin[]; total: number };
    },
    enabled: !!serialId && effectiveImportStatus === "complete",
    refetchInterval: 20000,
  });

  // Map initialisation
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

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
      m.addSource("project-pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
        clusterProperties: {
          any_destroyed: ["+", ["case", ["==", ["get", "damage_level"], "complete"], 1, 0]],
          any_partial: ["+", ["case", ["==", ["get", "damage_level"], "partial"], 1, 0]],
        },
      });

      m.addLayer({
        id: "proj-clusters",
        type: "circle",
        source: "project-pins",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "case",
            [">", ["get", "any_destroyed"], 0], "#f44336",
            [">", ["get", "any_partial"], 0], "#ff9800",
            "#4caf50",
          ],
          "circle-radius": ["step", ["get", "point_count"], 20, 10, 30, 50, 40],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.92,
        },
      });

      m.addLayer({
        id: "proj-cluster-count",
        type: "symbol",
        source: "project-pins",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 13,
        },
        paint: { "text-color": "#fff" },
      });

      m.addLayer({
        id: "proj-unclustered-pin",
        type: "circle",
        source: "project-pins",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "match", ["get", "damage_level"],
            "complete", "#f44336",
            "partial", "#ff9800",
            "#4caf50",
          ],
          "circle-radius": 12,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        },
      });

      m.addLayer({
        id: "proj-unclustered-count",
        type: "symbol",
        source: "project-pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["to-string", ["get", "report_count"]],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 10,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fff" },
      });

      m.on("click", "proj-clusters", async (e) => {
        const features = m.queryRenderedFeatures(e.point, { layers: ["proj-clusters"] });
        if (!features.length) return;
        const clusterId = features[0].properties?.cluster_id as number;
        const source = m.getSource("project-pins") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const coords = (features[0].geometry as GeoJSON.Point).coordinates as [number, number];
        m.easeTo({ center: coords, zoom });
      });

      m.on("click", "proj-unclustered-pin", (e) => {
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

      m.on("click", (e) => {
        const hit = m.queryRenderedFeatures(e.point, {
          layers: ["proj-clusters", "proj-unclustered-pin"],
        });
        if (!hit.length) setSelectedPinRef.current?.(null);
      });

      m.on("mouseenter", "proj-clusters", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "proj-clusters", () => { m.getCanvas().style.cursor = ""; });
      m.on("mouseenter", "proj-unclustered-pin", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "proj-unclustered-pin", () => { m.getCanvas().style.cursor = ""; });

      setMapReady(true);
    });

    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Fly to project centre when project data loads
  useEffect(() => {
    if (!mapRef.current || !mapReady || !project) return;
    if (project.map_center_lat && project.map_center_lng) {
      mapRef.current.flyTo({
        center: [project.map_center_lng, project.map_center_lat],
        zoom: 10,
        duration: 1200,
      });
    }
  }, [project, mapReady]);

  // Update GeoJSON source when pins load
  useEffect(() => {
    if (!mapRef.current || !mapReady || !pinsData?.pins) return;
    const source = mapRef.current.getSource("project-pins") as GeoJSONSource | undefined;
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

  // ── Reports section ────────────────────────────────────────────────────
  const [reportFlagFilter, setReportFlagFilter] = useState<FlagStatus[]>([]);
  const [reportSearch, setReportSearch] = useState("");
  const [reportItems, setReportItems] = useState<ProjectReportItem[]>([]);
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [reportHasMore, setReportHasMore] = useState(false);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);

  const fetchReports = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!serialId) return;
      if (append) setReportsLoadingMore(true);
      else setReportsLoading(true);
      try {
        const params: Record<string, string | number> = { limit: 50 };
        if (cursor) params.cursor = cursor;
        if (reportFlagFilter.length > 0) params.flag_status = reportFlagFilter.join(",");
        if (reportSearch.trim()) params.report_id = reportSearch.trim();
        const res = await getProjectReports(serialId, params);
        const d = res.data as ProjectReportsResponse;
        setReportTotal(d.total);
        setReportHasMore(d.has_more);
        setReportCursor(d.cursor);
        setReportItems((prev) => (append ? [...prev, ...d.items] : d.items));
      } catch {
        if (!append) setReportItems([]);
      } finally {
        if (append) setReportsLoadingMore(false);
        else setReportsLoading(false);
      }
    },
    [serialId, reportFlagFilter, reportSearch]
  );

  useEffect(() => {
    fetchReports(null, false);
  }, [fetchReports]);

  // ── Properties section ─────────────────────────────────────────────────
  const [propItems, setPropItems] = useState<ProjectPropertyItem[]>([]);
  const [propCursor, setPropCursor] = useState<string | null>(null);
  const [propHasMore, setPropHasMore] = useState(false);
  const [propTotal, setPropTotal] = useState(0);
  const [propsLoading, setPropsLoading] = useState(true);
  const [propsLoadingMore, setPropsLoadingMore] = useState(false);

  const fetchProperties = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!serialId) return;
      if (append) setPropsLoadingMore(true);
      else setPropsLoading(true);
      try {
        const params: Record<string, string | number> = { limit: 50 };
        if (cursor) params.cursor = cursor;
        const res = await getProjectProperties(serialId, params);
        const d = res.data as ProjectPropertiesResponse;
        setPropTotal(d.total);
        setPropHasMore(d.has_more);
        setPropCursor(d.cursor);
        setPropItems((prev) => (append ? [...prev, ...d.items] : d.items));
      } catch {
        if (!append) setPropItems([]);
      } finally {
        if (append) setPropsLoadingMore(false);
        else setPropsLoading(false);
      }
    },
    [serialId]
  );

  useEffect(() => {
    fetchProperties(null, false);
  }, [fetchProperties]);

  // ── Tab state ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"overview" | "reports" | "properties">("overview");

  // ── Statistics section ─────────────────────────────────────────────────
  const [statsGranularity, setStatsGranularity] = useState<"daily" | "weekly">("daily");

  const { data: statsData, isLoading: statsLoading } = useQuery<ProjectStatsResponse>({
    queryKey: ["project-stats", serialId, statsGranularity],
    queryFn: async () => {
      const res = await getProjectStats(serialId!, { granularity: statsGranularity });
      return res.data as ProjectStatsResponse;
    },
    enabled: !!serialId,
  });

  // ── Users section ──────────────────────────────────────────────────────
  const { data: usersResp, refetch: refetchUsers } = useQuery({
    queryKey: ["project-users", serialId],
    queryFn: async () => {
      const res = await getProjectUsers(serialId!);
      return res.data;
    },
    enabled: !!serialId,
  });

  const projectUsers: ProjectUser[] = Array.isArray(usersResp)
    ? (usersResp as ProjectUser[])
    : ((usersResp as { value?: ProjectUser[] } | null)?.value ?? []);

  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserSearch, setAddUserSearch] = useState("");
  const [addUserSelected, setAddUserSelected] = useState<DashboardUserSearchItem | null>(null);
  const [addUserAccessLevel, setAddUserAccessLevel] = useState<"view_only" | "view_and_edit">("view_only");
  const [addUserLoading, setAddUserLoading] = useState(false);

  const { data: userSearchResults = [] } = useQuery<DashboardUserSearchItem[]>({
    queryKey: ["dashboard-user-search", addUserSearch],
    queryFn: async () => {
      const res = await api.get("/api/dashboard/users", { params: { search: addUserSearch } });
      return (Array.isArray(res.data) ? res.data : (res.data?.items ?? [])) as DashboardUserSearchItem[];
    },
    enabled: addUserSearch.length >= 2,
  });

  const handleAddUser = async () => {
    if (!addUserSelected || !serialId) return;
    setAddUserLoading(true);
    try {
      await addProjectUser(serialId, addUserSelected.id, addUserAccessLevel);
      setAddUserOpen(false);
      setAddUserSearch("");
      setAddUserSelected(null);
      refetchUsers();
    } finally {
      setAddUserLoading(false);
    }
  };

  const handleRemoveUser = async (userId: string) => {
    if (!serialId) return;
    try {
      await removeProjectUser(serialId, userId);
      refetchUsers();
    } catch { /* silent */ }
  };

  const handleChangeAccess = async (userId: string, newLevel: string) => {
    if (!serialId) return;
    try {
      await updateProjectUserAccess(serialId, userId, newLevel);
      refetchUsers();
    } catch { /* silent */ }
  };

  // ── Render guards ──────────────────────────────────────────────────────
  if (projectLoading) {
    return (
      <>
        <style>{`@keyframes pd-spin { to { transform: rotate(360deg); } }`}</style>
        <Layout>
          <Spinner size={40} full />
        </Layout>
      </>
    );
  }

  if (projectError || !project) {
    return (
      <Layout>
        <Header title="Project Not Found" />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
          <div style={ss.errorCard}>
            <div style={ss.errorTitle}>Project not found.</div>
            <button style={ss.backBtn} onClick={() => navigate("/projects")}>
              Back to Projects
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  const truncatedName = project.name.length > 40 ? project.name.slice(0, 40) + "…" : project.name;
  const headerTitle = `${project.serial_id} — ${truncatedName}`;
  const statusColors = PROJECT_STATUS_COLOURS[project.status] ?? { bg: "#f5f5f5", text: "#666" };
  const secondsSince = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);

  const pieData = statsData
    ? [
        { level: "Completely Destroyed", count: statsData.summary.completely_damaged },
        { level: "Partially Damaged", count: statsData.summary.partially_damaged },
        { level: "Minimal or No Damage", count: statsData.summary.minimal_damage },
      ].filter((d) => d.count > 0)
    : [];

  return (
    <>
      <style>{`
        @keyframes pd-spin { to { transform: rotate(360deg); } }
        @keyframes pd-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .pd-tab-btn:hover { background: #f0f4f8 !important; }
        .pd-tab-btn-active:hover { background: transparent !important; }
      `}</style>
      <Layout>
        <Header title={headerTitle} />

        {/* ── Tab bar ── */}
        <div style={ss.tabBar}>
          {(
            [
              { key: "overview", label: "Overview" },
              { key: "reports", label: reportTotal > 0 ? `Reports (${reportTotal})` : "Reports" },
              { key: "properties", label: propTotal > 0 ? `Properties (${propTotal})` : "Properties" },
            ] as { key: "overview" | "reports" | "properties"; label: string }[]
          ).map((tab) => (
            <button
              key={tab.key}
              className={activeTab === tab.key ? "pd-tab-btn pd-tab-btn-active" : "pd-tab-btn"}
              style={activeTab === tab.key ? { ...ss.tabBtn, ...ss.tabBtnActive } : ss.tabBtn}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={ss.page}>

          {/* ── TAB 1: Overview ── */}
          {activeTab === "overview" && (
            <>
              {/* ── SECTION 1: Project Header ── */}
              <SectionCard>
                <div style={ss.headerGrid}>
                  {/* Left */}
                  <div style={ss.headerLeft}>
                    <div style={ss.serialId}>{project.serial_id}</div>
                    <div style={ss.projectName}>{project.name}</div>
                    <div>
                      <span style={{ ...ss.statusPill, background: statusColors.bg, color: statusColors.text }}>
                        {formatProjectStatus(project.status)}
                      </span>
                    </div>
                    <div style={ss.countriesRow}>
                      {(project.countries ?? []).slice(0, 5).map((c) => (
                        <span key={c} style={ss.countryChip}>{c}</span>
                      ))}
                      {(project.countries ?? []).length > 5 && (
                        <span style={ss.countryChip}>+{project.countries.length - 5} more</span>
                      )}
                    </div>
                    <div style={ss.dateRange}>
                      {formatDateRange(project.start_date, project.end_date)}
                      {isEndDatePassed(project.end_date) && (
                        <span style={ss.pastDateBadge}>Past end date</span>
                      )}
                    </div>
                    {project.description && (
                      <div style={ss.description}>{project.description}</div>
                    )}
                  </div>

                  {/* Right */}
                  <div style={ss.headerRight}>
                    <div style={ss.metaBlock}>
                      <span style={ss.metaLabel}>Created by</span>
                      <span
                        style={ss.metaLink}
                        onClick={() =>
                          project.created_by_user_id &&
                          window.open("/users/" + project.created_by_user_id, "_blank")
                        }
                      >
                        {project.created_by_name ?? "—"}
                      </span>
                    </div>
                    <div style={ss.metaBlock}>
                      <span style={ss.metaLabel}>Date created</span>
                      <span style={ss.metaValue}>{formatDateTime(project.created_at)}</span>
                    </div>

                    {effectiveImportStatus !== "complete" && (
                      <div style={ss.importStatus}>
                        {effectiveImportStatus === "running" && (
                          <>
                            <span style={{ ...ss.importDot, background: "#ff9800", animation: "pd-pulse 1.5s infinite" }} />
                            <span style={ss.importText}>
                              Importing reports — {importStatus?.import_progress ?? 0} of {importStatus?.import_total ?? 0} complete
                            </span>
                          </>
                        )}
                        {effectiveImportStatus === "pending" && (
                          <>
                            <span style={{ ...ss.importDot, background: "#9e9e9e" }} />
                            <span style={ss.importText}>Import pending</span>
                          </>
                        )}
                        {effectiveImportStatus === "failed" && (
                          <>
                            <span style={{ ...ss.importDot, background: "#f44336" }} />
                            <span style={{ ...ss.importText, color: "#f44336" }}>
                              Import failed — contact administrator
                            </span>
                          </>
                        )}
                      </div>
                    )}

                    <button
                      style={ss.exportBtn}
                      onClick={() =>
                        navigate("/export", {
                          state: { prefill: { project_id: project.id, report_type: "project_summary" } },
                        })
                      }
                    >
                      Export this project →
                    </button>
                  </div>
                </div>
              </SectionCard>

              {/* ── SECTION 2: Project Map ── */}
              <SectionCard title="Project Map">
                <div style={{ position: "relative", height: 420, borderRadius: 6, overflow: "hidden" }}>
                  <div
                    ref={mapContainer}
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "#dde8f0",
                    }}
                  />

                  {effectiveImportStatus !== "complete" && (
                    <div style={ss.mapOverlay}>
                      Map will populate once report import is complete.
                    </div>
                  )}

                  <div
                    style={{
                      ...ss.liveIndicator,
                      background: liveStatus === "connected"
                        ? "rgba(255,255,255,0.97)"
                        : "rgba(255,248,240,0.97)",
                    }}
                  >
                    <div style={{ ...ss.liveDot, background: liveStatus === "connected" ? "#4caf50" : "#ff9800" }} />
                    <span style={ss.liveText}>
                      {liveStatus === "connected"
                        ? `LIVE — LAST UPDATED ${secondsSince}s ago`
                        : "LOADING MAP DATA"}
                    </span>
                  </div>

                  <div style={ss.legend}>
                    <div style={ss.legendTitle}>Damage Level</div>
                    {(["complete", "partial", "minimal"] as const).map((lvl) => (
                      <div key={lvl} style={ss.legendItem}>
                        <div style={{ ...ss.legendDot, background: DAMAGE_COLORS[lvl] }} />
                        <span style={ss.legendLabel}>
                          {lvl === "complete" ? "Completely Destroyed" : lvl === "partial" ? "Partially Damaged" : "Minimal or No Damage"}
                        </span>
                      </div>
                    ))}
                    <div style={ss.legendNote}>Number on pin = report count</div>
                  </div>

                  {selectedPin && (
                    <PropertySummaryPanel pin={selectedPin} onClose={() => setSelectedPin(null)} />
                  )}
                </div>
              </SectionCard>

              {/* ── SECTION 5: Statistics ── */}
              <SectionCard title="Statistics">
                <div style={ss.statsNote}>
                  Showing confirmed reports only — Grey and Red flagged reports are excluded from all statistics.
                </div>

                {statsLoading ? (
                  <Spinner />
                ) : !statsData ? (
                  <div style={ss.emptyState}>No statistics available.</div>
                ) : (
                  <>
                    {/* Summary numbers */}
                    <div style={ss.summaryRow}>
                      {[
                        { label: "Total Reports", value: statsData.summary.total_reports, color: BLUE },
                        { label: "Completely Destroyed", value: statsData.summary.completely_damaged, color: "#F44336" },
                        { label: "Partially Damaged", value: statsData.summary.partially_damaged, color: "#FF9800" },
                        { label: "Minimal or No Damage", value: statsData.summary.minimal_damage, color: "#4CAF50" },
                      ].map((s) => (
                        <div key={s.label} style={ss.summaryCard}>
                          <div style={{ ...ss.summaryNum, color: s.color }}>{s.value.toLocaleString()}</div>
                          <div style={ss.summaryLbl}>{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Reports Over Time */}
                    <div style={ss.chartBox}>
                      <div style={ss.chartHeader}>
                        <span style={ss.chartTitle}>Reports Over Time</span>
                        <div style={ss.toggleGroup}>
                          {(["daily", "weekly"] as const).map((g) => (
                            <button
                              key={g}
                              style={{ ...ss.toggleBtn, ...(statsGranularity === g ? ss.toggleActive : {}) }}
                              onClick={() => setStatsGranularity(g)}
                            >
                              {g.charAt(0).toUpperCase() + g.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                      {statsData.time_series.length === 0 ? (
                        <div style={ss.emptyState}>No data.</div>
                      ) : (
                        <ResponsiveContainer width="100%" height={240}>
                          <BarChart data={statsData.time_series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#718096" }} tickLine={false} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 11, fill: "#718096" }} tickLine={false} axisLine={false} allowDecimals={false} />
                            <Tooltip contentStyle={{ fontSize: 13, borderRadius: 8 }} />
                            <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} name="Reports" />
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>

                    {/* Damage pie + Infrastructure */}
                    <div style={ss.twoCol}>
                      <div style={ss.chartBox}>
                        <div style={ss.chartTitle}>Damage Level Distribution</div>
                        {pieData.length === 0 ? (
                          <div style={ss.emptyState}>No data.</div>
                        ) : (
                          <ResponsiveContainer width="100%" height={240}>
                            <PieChart>
                              <Pie data={pieData} dataKey="count" nameKey="level" cx="50%" cy="50%" outerRadius={85} label={renderPieLabel} labelLine>
                                {pieData.map((entry) => (
                                  <Cell key={entry.level} fill={PIE_COLORS[entry.level] ?? "#94a3b8"} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ fontSize: 13, borderRadius: 8 }} />
                              <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        )}
                      </div>

                      <div style={ss.chartBox}>
                        <div style={ss.chartTitle}>Reports by Infrastructure Type</div>
                        {(statsData.infrastructure_breakdown ?? []).length === 0 ? (
                          <div style={ss.emptyState}>No data.</div>
                        ) : (
                          <ResponsiveContainer width="100%" height={Math.max(240, statsData.infrastructure_breakdown.length * 36)}>
                            <BarChart data={statsData.infrastructure_breakdown} layout="vertical" margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" horizontal={false} />
                              <XAxis type="number" tick={{ fontSize: 11, fill: "#718096" }} tickLine={false} axisLine={false} allowDecimals={false} />
                              <YAxis type="category" dataKey="infrastructure_type" tick={{ fontSize: 11, fill: "#4a5568" }} tickLine={false} width={180} />
                              <Tooltip contentStyle={{ fontSize: 13, borderRadius: 8 }} />
                              <Bar dataKey="count" fill={BLUE} radius={[0, 3, 3, 0]} name="Reports" />
                            </BarChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>

                    {/* Crisis type */}
                    <div style={ss.chartBox}>
                      <div style={ss.chartTitle}>Reports by Crisis Type</div>
                      {(statsData.crisis_type_breakdown ?? []).length === 0 ? (
                        <div style={ss.emptyState}>No data.</div>
                      ) : (
                        <ResponsiveContainer width="100%" height={Math.max(200, statsData.crisis_type_breakdown.length * 36)}>
                          <BarChart data={statsData.crisis_type_breakdown} layout="vertical" margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" horizontal={false} />
                            <XAxis type="number" tick={{ fontSize: 11, fill: "#718096" }} tickLine={false} axisLine={false} allowDecimals={false} />
                            <YAxis type="category" dataKey="crisis_type" tick={{ fontSize: 12, fill: "#4a5568" }} tickLine={false} width={150} />
                            <Tooltip contentStyle={{ fontSize: 13, borderRadius: 8 }} />
                            <Bar dataKey="count" fill={BLUE} radius={[0, 3, 3, 0]} name="Reports" />
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </>
                )}
              </SectionCard>

              {/* ── SECTION 6: Project Users ── */}
              <SectionCard
                title="Project Users"
                action={
                  isAdmin ? (
                    <button style={ss.addUserBtn} onClick={() => setAddUserOpen((o) => !o)}>
                      + Add User
                    </button>
                  ) : undefined
                }
              >
                {addUserOpen && isAdmin && (
                  <div style={ss.addUserForm}>
                    <div style={{ position: "relative" }}>
                      <input
                        style={ss.addUserInput}
                        placeholder="Search for a user…"
                        value={addUserSearch}
                        onChange={(e) => { setAddUserSearch(e.target.value); setAddUserSelected(null); }}
                      />
                      {userSearchResults.length > 0 && !addUserSelected && addUserSearch.length >= 2 && (
                        <div style={ss.searchDropdown}>
                          {userSearchResults.map((u) => (
                            <button
                              key={u.id}
                              style={ss.searchDropdownItem}
                              onClick={() => { setAddUserSelected(u); setAddUserSearch(u.full_name); }}
                            >
                              <strong>{u.full_name}</strong> — {u.email}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <select
                      style={ss.accessSelect}
                      value={addUserAccessLevel}
                      onChange={(e) => setAddUserAccessLevel(e.target.value as "view_only" | "view_and_edit")}
                    >
                      <option value="view_only">View only</option>
                      <option value="view_and_edit">View and Edit</option>
                    </select>
                    <button
                      style={{ ...ss.addUserSubmit, opacity: addUserSelected && !addUserLoading ? 1 : 0.5 }}
                      onClick={handleAddUser}
                      disabled={!addUserSelected || addUserLoading}
                    >
                      {addUserLoading ? "Adding…" : "Add"}
                    </button>
                    <button
                      style={ss.cancelBtn}
                      onClick={() => { setAddUserOpen(false); setAddUserSearch(""); setAddUserSelected(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <div style={ss.tableWrap}>
                  <table style={ss.table}>
                    <thead>
                      <tr style={ss.thead}>
                        {["Full Name", "Email", "Role", "Access Level", "Assigned", "Creator",
                          ...(isAdmin ? ["Actions"] : [])].map((h) => (
                          <th key={h} style={ss.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {projectUsers.map((u) => (
                        <tr key={u.dashboard_user_id} style={ss.tr}>
                          <td style={ss.td}>
                            <span style={ss.idLink} onClick={() => window.open("/users/" + u.dashboard_user_id, "_blank")}>
                              {u.full_name}
                            </span>
                          </td>
                          <td style={ss.td}>{u.email}</td>
                          <td style={ss.td}>{u.role.charAt(0).toUpperCase() + u.role.slice(1)}</td>
                          <td style={ss.td}>{u.access_level === "view_only" ? "View only" : "View and Edit"}</td>
                          <td style={ss.td}>{formatDateTime(u.assigned_at)}</td>
                          <td style={ss.td}>
                            {u.is_creator && <span style={ss.creatorBadge}>Assigned as Creator</span>}
                          </td>
                          {isAdmin && (
                            <td style={ss.td}>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <select
                                  style={ss.accessSelectSmall}
                                  value={u.access_level}
                                  disabled={u.is_creator}
                                  onChange={(e) => handleChangeAccess(u.dashboard_user_id, e.target.value)}
                                >
                                  <option value="view_only">View only</option>
                                  <option value="view_and_edit">View and Edit</option>
                                </select>
                                <button
                                  style={{ ...ss.removeBtn, opacity: u.is_creator ? 0.4 : 1, cursor: u.is_creator ? "not-allowed" : "pointer" }}
                                  onClick={() => !u.is_creator && handleRemoveUser(u.dashboard_user_id)}
                                  disabled={u.is_creator}
                                  title={u.is_creator ? "Project creator cannot be removed" : "Remove user"}
                                >
                                  <UserMinus size={14} />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                      {projectUsers.length === 0 && (
                        <tr>
                          <td colSpan={isAdmin ? 7 : 6} style={ss.emptyState}>No users found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </SectionCard>

              {/* ── SECTION 7: Export shortcut ── */}
              <div style={ss.exportCard}>
                <div>
                  <div style={ss.exportCardTitle}>Export data for this project</div>
                  <div style={ss.exportCardSub}>Generates a structured export file scoped to this project's reports.</div>
                </div>
                <button
                  style={ss.exportCardBtn}
                  onClick={() =>
                    navigate("/export", {
                      state: { prefill: { project_id: project.id, report_type: "project_summary" } },
                    })
                  }
                >
                  Go to Export →
                </button>
              </div>
            </>
          )}

          {/* ── TAB 2: Reports ── */}
          {activeTab === "reports" && (
            <SectionCard title="Reports" badge={reportTotal}>
              <div style={ss.filterBar}>
                <div style={ss.flagFilterRow}>
                  {(["grey", "green", "orange", "red"] as FlagStatus[]).map((flag) => (
                    <label key={flag} style={ss.flagCheckLabel}>
                      <input
                        type="checkbox"
                        checked={reportFlagFilter.includes(flag)}
                        onChange={() =>
                          setReportFlagFilter((prev) =>
                            prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag]
                          )
                        }
                        style={{ accentColor: BLUE, marginRight: 5 }}
                      />
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: FLAG_COLORS[flag], display: "inline-block", marginRight: 4, flexShrink: 0 }} />
                      {flag.charAt(0).toUpperCase() + flag.slice(1)}
                    </label>
                  ))}
                </div>
                <input
                  style={ss.searchInput}
                  placeholder="Search by Report ID…"
                  value={reportSearch}
                  onChange={(e) => setReportSearch(e.target.value)}
                />
              </div>

              {reportsLoading ? (
                <Spinner />
              ) : reportItems.length === 0 ? (
                <div style={ss.emptyState}>No reports linked to this project yet.</div>
              ) : (
                <>
                  <div style={ss.tableWrap}>
                    <table style={ss.table}>
                      <thead>
                        <tr style={ss.thead}>
                          {["Report ID", "Date / Time", "Country", "Damage Level", "Infrastructure", "Crisis Type", "Flag Status"].map(
                            (h) => <th key={h} style={ss.th}>{h}</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {reportItems.map((row) => (
                          <tr key={row.report_id} style={ss.tr}>
                            <td style={ss.td}>
                              <span style={ss.idLink} onClick={() => window.open("/reports/" + row.report_id, "_blank")}>
                                {row.serial_number != null ? `#${row.serial_number}` : row.report_id.slice(0, 8).toUpperCase()}
                              </span>
                            </td>
                            <td style={ss.td}>{formatDateTime(row.created_at)}</td>
                            <td style={ss.td}>{row.country ?? "—"}</td>
                            <td style={ss.td}><DamagePill level={row.damage_level} /></td>
                            <td style={ss.td}>{(row.infrastructure_types ?? []).join(", ") || "—"}</td>
                            <td style={ss.td}>{row.crisis_type ?? "—"}</td>
                            <td style={ss.td}><FlagPill status={row.flag_status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {reportHasMore && (
                    <div style={ss.loadMoreRow}>
                      <button style={ss.loadMoreBtn} onClick={() => fetchReports(reportCursor, true)} disabled={reportsLoadingMore}>
                        {reportsLoadingMore ? "Loading…" : "Load More"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </SectionCard>
          )}

          {/* ── TAB 3: Properties ── */}
          {activeTab === "properties" && (
            <SectionCard title="Properties" badge={propTotal}>
              {propsLoading ? (
                <Spinner />
              ) : propItems.length === 0 ? (
                <div style={ss.emptyState}>No properties linked to this project yet.</div>
              ) : (
                <>
                  <div style={ss.tableWrap}>
                    <table style={ss.table}>
                      <thead>
                        <tr style={ss.thead}>
                          {["Property ID", "Property Name", "Country", "Current Damage", "Confirmed Status", "Conflict", "Total Reports", "Most Recent Report"].map(
                            (h) => <th key={h} style={ss.th}>{h}</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {propItems.map((row) => (
                          <tr key={row.property_id} style={ss.tr}>
                            <td style={ss.td}>
                              <span
                                style={ss.idLink}
                                onClick={() => window.open("/locations/" + row.property_id + "?project_id=" + serialId, "_blank")}
                              >
                                {row.property_id.slice(0, 8)}…
                              </span>
                            </td>
                            <td style={ss.td}>{row.display_name}</td>
                            <td style={ss.td}>{row.country ?? "—"}</td>
                            <td style={ss.td}><DamagePill level={row.current_damage_level} /></td>
                            <td style={ss.td}>
                              {row.confirmed_status
                                ? <span style={ss.confirmedPill}><span className="material-symbols-outlined" style={{ fontSize: 12, verticalAlign: "middle", marginRight: 3, fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>lock</span>{formatDamageLevel(row.confirmed_status)}</span>
                                : null}
                            </td>
                            <td style={ss.td}>
                              {row.has_conflict_warning && <AlertTriangle size={16} color="#e65100" />}
                            </td>
                            <td style={{ ...ss.td, textAlign: "center" }}>{row.total_reports}</td>
                            <td style={ss.td}>{formatDateTime(row.most_recent_report_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {propHasMore && (
                    <div style={ss.loadMoreRow}>
                      <button style={ss.loadMoreBtn} onClick={() => fetchProperties(propCursor, true)} disabled={propsLoadingMore}>
                        {propsLoadingMore ? "Loading…" : "Load More"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </SectionCard>
          )}

        </div>
      </Layout>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ss: Record<string, React.CSSProperties> = {
  tabBar: {
    display: "flex",
    gap: 0,
    borderBottom: "2px solid #e0e8f0",
    background: "#fff",
    padding: "0 32px",
    position: "sticky",
    top: 64,
    zIndex: 49,
  },
  tabBtn: {
    padding: "14px 22px",
    fontSize: 14,
    fontWeight: 600,
    color: "#718096",
    background: "transparent",
    border: "none",
    borderBottom: "3px solid transparent",
    marginBottom: -2,
    cursor: "pointer",
    transition: "color 0.15s, border-color 0.15s",
    whiteSpace: "nowrap" as const,
  },
  tabBtnActive: {
    color: BLUE,
    borderBottomColor: BLUE,
    background: "transparent",
  },
  page: {
    padding: "24px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    background: "#f4f6f9",
    minHeight: "100%",
  },
  errorCard: {
    background: "#fff",
    border: "1px solid #e0e8f0",
    borderRadius: 12,
    padding: "40px 48px",
    textAlign: "center",
    boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
  },
  errorTitle: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", marginBottom: 16 },
  backBtn: {
    padding: "9px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  card: {
    background: "#fff",
    border: "1px solid #e0e8f0",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  cardHeaderLeft: { display: "flex", alignItems: "center", gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: "#1A2B4A" },
  countBadge: {
    background: "#EBF5FB",
    color: BLUE,
    fontSize: 12,
    fontWeight: 700,
    padding: "2px 9px",
    borderRadius: 12,
  },
  headerGrid: { display: "grid", gridTemplateColumns: "1fr 280px", gap: 32 },
  headerLeft: { display: "flex", flexDirection: "column", gap: 10 },
  headerRight: { display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" },
  serialId: { fontSize: 28, fontWeight: 800, fontFamily: "monospace", color: BLUE, lineHeight: 1 },
  projectName: { fontSize: 20, fontWeight: 700, color: "#1A2B4A", lineHeight: 1.3 },
  statusPill: { display: "inline-block", padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600 },
  countriesRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  countryChip: {
    background: "#f4f6f9",
    color: "#666",
    fontSize: 12,
    padding: "2px 9px",
    borderRadius: 12,
    border: "1px solid #e0e8f0",
  },
  dateRange: { fontSize: 13, color: "#555", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  pastDateBadge: {
    background: "#FFF3E0",
    color: "#E65100",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 10,
    border: "1px solid #FFCC80",
  },
  description: { fontSize: 13, color: "#718096", lineHeight: 1.6 },
  metaBlock: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  metaLabel: { fontSize: 11, fontWeight: 600, color: "#9aa5b4", textTransform: "uppercase", letterSpacing: 0.4 },
  metaValue: { fontSize: 13, color: "#1A2B4A" },
  metaLink: { fontSize: 13, color: BLUE, cursor: "pointer", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2 },
  importStatus: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    background: "#fafafa",
    border: "1px solid #e0e8f0",
    borderRadius: 8,
    padding: "8px 12px",
  },
  importDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  importText: { fontSize: 12, color: "#555" },
  exportBtn: {
    padding: "9px 16px",
    background: "transparent",
    border: `1.5px solid ${BLUE}`,
    borderRadius: 8,
    color: BLUE,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "auto",
  },
  mapOverlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(255,255,255,0.82)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    color: "#718096",
    fontStyle: "italic",
    zIndex: 15,
    borderRadius: 4,
  },
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
  liveDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  liveText: { fontSize: 11, fontWeight: 600, color: "#444", letterSpacing: 0.2, whiteSpace: "nowrap" },
  legend: {
    position: "absolute",
    bottom: 20,
    left: 14,
    background: "rgba(255,255,255,0.97)",
    borderRadius: 10,
    padding: "10px 14px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.14)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 10,
    border: "1px solid rgba(0,0,0,0.07)",
    pointerEvents: "none",
  },
  legendTitle: { fontSize: 11, fontWeight: 700, color: "#9aa5b4", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 2 },
  legendItem: { display: "flex", alignItems: "center", gap: 8 },
  legendDot: { width: 11, height: 11, borderRadius: "50%", flexShrink: 0, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.12)" },
  legendLabel: { fontSize: 11, color: "#1A2B4A", fontWeight: 500 },
  legendNote: { fontSize: 10, color: "#9aa5b4", fontStyle: "italic", marginTop: 3 },
  filterBar: { display: "flex", alignItems: "center", gap: 16, marginBottom: 14, flexWrap: "wrap" },
  flagFilterRow: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  flagCheckLabel: { display: "flex", alignItems: "center", fontSize: 13, color: "#1A2B4A", cursor: "pointer" },
  searchInput: {
    padding: "7px 12px",
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    fontSize: 13,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
    minWidth: 200,
  },
  tableWrap: { overflowX: "auto", border: "1px solid #e8eef4", borderRadius: 8, background: "#fff" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  thead: { background: "#f8fafc" },
  th: {
    padding: "10px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e0e8f0",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "10px 14px", color: "#1A2B4A", verticalAlign: "middle" },
  idLink: { color: BLUE, fontWeight: 600, fontFamily: "monospace", fontSize: 12, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 },
  confirmedPill: { fontSize: 12, color: "#555", fontWeight: 500 },
  emptyState: { padding: "32px 0", textAlign: "center", color: "#9aa5b4", fontSize: 14 },
  loadMoreRow: { display: "flex", justifyContent: "center", padding: "14px 0 4px" },
  loadMoreBtn: {
    padding: "8px 24px",
    background: "#f4f6f9",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: "#1A2B4A",
    cursor: "pointer",
  },
  statsNote: {
    fontSize: 12,
    color: "#718096",
    background: "#f7fafc",
    borderRadius: 6,
    padding: "8px 12px",
    borderLeft: `3px solid ${BLUE}`,
    marginBottom: 16,
  },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 },
  summaryCard: { background: "#f8fafc", border: "1px solid #e8eef4", borderRadius: 10, padding: "14px 16px", textAlign: "center" },
  summaryNum: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  summaryLbl: { fontSize: 11, color: "#718096", marginTop: 4, fontWeight: 500 },
  chartBox: {
    background: "#f8fafc",
    border: "1px solid #e8eef4",
    borderRadius: 10,
    padding: "16px 18px",
    marginBottom: 16,
  },
  chartHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  chartTitle: { fontSize: 14, fontWeight: 700, color: "#1A2B4A", marginBottom: 12, display: "block" },
  toggleGroup: { display: "flex", borderRadius: 6, border: "1.5px solid #e2e8f0", overflow: "hidden" },
  toggleBtn: { padding: "5px 12px", fontSize: 12, fontWeight: 600, background: "#fff", border: "none", cursor: "pointer", color: "#718096" },
  toggleActive: { background: BLUE, color: "#fff" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
  addUserBtn: { padding: "7px 14px", background: BLUE, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  addUserForm: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    marginBottom: 16,
    padding: "14px 16px",
    background: "#f8fafc",
    border: "1px solid #e0e8f0",
    borderRadius: 8,
    flexWrap: "wrap",
    position: "relative",
  },
  addUserInput: { padding: "8px 12px", border: "1.5px solid #d0dce8", borderRadius: 7, fontSize: 13, color: "#1A2B4A", outline: "none", minWidth: 240 },
  searchDropdown: {
    position: "absolute",
    top: "calc(100% + 2px)",
    left: 0,
    width: 340,
    background: "#fff",
    border: "1px solid #e0e8f0",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
    zIndex: 50,
    overflow: "hidden",
  },
  searchDropdownItem: {
    display: "block",
    width: "100%",
    padding: "10px 14px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #f0f4f8",
    textAlign: "left",
    fontSize: 13,
    color: "#1A2B4A",
    cursor: "pointer",
  },
  accessSelect: { padding: "8px 12px", border: "1.5px solid #d0dce8", borderRadius: 7, fontSize: 13, color: "#1A2B4A", background: "#fff", cursor: "pointer" },
  accessSelectSmall: { padding: "5px 8px", border: "1px solid #d0dce8", borderRadius: 6, fontSize: 12, color: "#1A2B4A", background: "#fff", cursor: "pointer" },
  addUserSubmit: { padding: "8px 16px", background: BLUE, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  cancelBtn: { padding: "8px 14px", background: "transparent", border: "1px solid #d0dce8", borderRadius: 7, fontSize: 13, color: "#666", cursor: "pointer" },
  creatorBadge: {
    background: "#FFF3E0",
    color: "#E65100",
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 9px",
    borderRadius: 12,
    border: "1px solid #FFCC80",
  },
  removeBtn: {
    background: "none",
    border: "1px solid #e0e8f0",
    borderRadius: 6,
    padding: "4px 7px",
    display: "flex",
    alignItems: "center",
    color: "#c62828",
    flexShrink: 0,
  },
  exportCard: {
    background: "#fff",
    border: "1px solid #e0e8f0",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  exportCardTitle: { fontSize: 15, fontWeight: 700, color: "#1A2B4A", marginBottom: 4 },
  exportCardSub: { fontSize: 13, color: "#718096" },
  exportCardBtn: {
    padding: "10px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    flexShrink: 0,
  },
};
