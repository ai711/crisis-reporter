import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

interface ReporterReport {
  id: string;
  damage_level: "minimal" | "partial" | "complete";
  submitted_at: string;
  gps_latitude?: number | null;
  gps_longitude?: number | null;
  location_address?: string | null;
  location_landmark?: string | null;
  building_name?: string | null;
  photo_count: number;
  first_photo_url: string | null;
  status?: string;
  flag_status?: string;
  disaster_type?: string;
  infrastructure_name?: string;
}

interface SessionReport {
  id: string;
  damage_level: string;
  infrastructure_types: string[];
  location_address: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  submitted_at: string;
}

interface ReportsResponse {
  items: ReporterReport[];
  next_cursor: string | null;
}

const DAMAGE_COLOR: Record<string, string> = {
  complete: "#e53935",
  partial: "#f57c00",
  minimal: "#388e3c",
};

const DAMAGE_LABEL: Record<string, string> = {
  complete: "Completely Damaged",
  partial: "Partially Damaged",
  minimal: "Minimal / No Damage",
};

function convertSessionReport(s: SessionReport): ReporterReport {
  return {
    id: s.id,
    damage_level: s.damage_level as ReporterReport["damage_level"],
    submitted_at: s.submitted_at,
    gps_latitude: s.gps_latitude,
    gps_longitude: s.gps_longitude,
    location_address: s.location_address,
    photo_count: 0,
    first_photo_url: null,
    status: "submitted",
  };
}

function formatLocation(report: ReporterReport): string {
  if (report.location_address) return report.location_address;
  if (report.gps_latitude != null && report.gps_longitude != null) {
    return `${report.gps_latitude.toFixed(4)}, ${report.gps_longitude.toFixed(4)}`;
  }
  return "Location not recorded";
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return width;
}

const PAGE_SIZE = 20;

export default function MyReportsPage() {
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();
  const navigate = useNavigate();
  const width = useWindowWidth();
  const isDesktop = width > 768;

  const [reports, setReports] = useState<ReporterReport[]>([]);
  const [loading, setLoading] = useState(!!reporterId);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isSessionMode, setIsSessionMode] = useState(false);
  const [selectedReport, setSelectedReport] = useState<ReporterReport | null>(null);

  const fetchReports = useCallback(async (cursor?: string) => {
    if (!reporterId) {
      const raw = sessionStorage.getItem("cr_session_reports");
      if (raw) {
        try {
          const parsed: SessionReport[] = JSON.parse(raw);
          setReports([...parsed].reverse().map(convertSessionReport));
          setIsSessionMode(true);
        } catch { /* ignore malformed data */ }
      }
      setLoading(false);
      return;
    }

    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError(null);
    }

    try {
      const params: Record<string, string> = {
        limit: String(PAGE_SIZE),
      };
      if (cursor) params.cursor = cursor;

      const res = await api.get<ReportsResponse>("/api/reports/my", { params });
      const data = res.data;

      if (cursor) {
        setReports((prev) => [...prev, ...data.items]);
      } else {
        setReports(data.items);
      }
      setNextCursor(data.next_cursor);
    } catch {
      setError("Failed to load reports. Please try again.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [reporterId]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const emptyMessage = !reporterId
    ? "Submit your first report to get started."
    : "No reports submitted yet";

  const statusText = (report: ReporterReport) =>
    report.status === "submitted" ? "✓ Submitted" : (report.status ?? "Submitted");

  const renderDetailFields = (report: ReporterReport) => (
    <div style={styles.detailFields}>
      <p style={styles.detailField}><strong>Location:</strong> {formatLocation(report)}</p>
      <p style={styles.detailField}><strong>Damage Level:</strong> {DAMAGE_LABEL[report.damage_level] ?? report.damage_level}</p>
      {report.disaster_type && <p style={styles.detailField}><strong>Disaster Type:</strong> {report.disaster_type}</p>}
      <p style={styles.detailField}><strong>Date:</strong> {formatDateTime(report.submitted_at)}</p>
      <p style={styles.detailField}><strong>Status:</strong> {statusText(report)}</p>
      {report.infrastructure_name && <p style={styles.detailField}><strong>Infrastructure:</strong> {report.infrastructure_name}</p>}
      {report.building_name && <p style={styles.detailField}><strong>Building:</strong> {report.building_name}</p>}
    </div>
  );

  // A6: Mobile full-screen detail view
  if (!isDesktop && selectedReport) {
    return (
      <div style={styles.container}>
        <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>
        <div style={styles.header}>
          <h1 style={styles.title}>{t("home.myReports")}</h1>
        </div>
        <div style={{ flex: 1, padding: "0 16px 32px" }}>
          <button onClick={() => setSelectedReport(null)} style={styles.backBtn}>
            ← Back to My Reports
          </button>
          <h3 style={styles.detailTitle}>Report Details</h3>
          {renderDetailFields(selectedReport)}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={styles.header}>
        <h1 style={styles.title}>{t("home.myReports")}</h1>
      </div>

      <div style={styles.content}>
        {/* A3: Login prompt for anonymous reporters — always shown when not logged in */}
        {!reporterId && (
          <div style={styles.loginPrompt}>
            <p style={styles.loginPromptText}>
              Log in to see all your reports across sessions and devices.
            </p>
            <div style={styles.loginPromptBtns}>
              <button onClick={() => navigate("/login")} style={styles.loginBtn}>
                Log In
              </button>
              <button onClick={() => navigate("/login?mode=register")} style={styles.registerBtn}>
                Create Account
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div style={styles.centred}>
            <div style={styles.spinner} />
            <p style={styles.loadingText}>Loading your reports...</p>
          </div>
        ) : error ? (
          <div style={styles.centred}>
            <p style={styles.errorText}>{error}</p>
            <button style={styles.retryBtn} onClick={() => fetchReports()}>
              Try Again
            </button>
          </div>
        ) : reports.length === 0 ? (
          <div style={styles.centred}>
            <span style={styles.emptyIcon}>📋</span>
            <p style={styles.emptyText}>{emptyMessage}</p>
          </div>
        ) : (
          <div style={styles.list}>
            {isSessionMode && (
              <p style={styles.sessionNote}>
                Showing reports from this session. Log in to see your full history.
              </p>
            )}

            {/* A5: Desktop column headers */}
            {isDesktop && (
              <div style={styles.columnHeaders}>
                <span>Location</span>
                <span>Damage Level</span>
                <span>Date</span>
                <span>Status</span>
              </div>
            )}

            {reports.map((report) => {
              const color = DAMAGE_COLOR[report.damage_level] ?? "#999";
              const label = DAMAGE_LABEL[report.damage_level] ?? report.damage_level;
              const st = statusText(report);

              if (isDesktop) {
                return (
                  <div
                    key={report.id}
                    style={styles.desktopRow}
                    onClick={() => setSelectedReport(report)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#F7FAFC"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#fff"; }}
                  >
                    <span style={styles.desktopCell}>{formatLocation(report)}</span>
                    <span>
                      <span style={{ ...styles.damageBadge, background: color + "22", color }}>
                        {label}
                      </span>
                    </span>
                    <span style={styles.desktopCell}>{formatDate(report.submitted_at)}</span>
                    <span style={{ ...styles.desktopCell, color: "#388e3c" }}>{st}</span>
                  </div>
                );
              }

              return (
                <div
                  key={report.id}
                  style={styles.card}
                  onClick={() => setSelectedReport(report)}
                >
                  {report.first_photo_url ? (
                    <img src={report.first_photo_url} alt="Report photo" style={styles.thumbnail} />
                  ) : (
                    <div style={styles.thumbnailPlaceholder}>
                      <span style={{ fontSize: 28 }}>📷</span>
                    </div>
                  )}
                  <div style={styles.cardBody}>
                    <span style={{ ...styles.damageBadge, background: color + "22", color }}>
                      {label}
                    </span>
                    <p style={styles.cardDate}>{formatDate(report.submitted_at)}</p>
                    <p style={styles.cardLocation}>📍 {formatLocation(report)}</p>
                    <span style={styles.cardStatus}>{st}</span>
                  </div>
                </div>
              );
            })}

            {nextCursor && (
              <button
                style={{
                  ...styles.loadMoreBtn,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={() => fetchReports(nextCursor)}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* A5: Desktop right-side detail panel */}
      {isDesktop && selectedReport && (
        <div style={styles.detailPanel}>
          <button onClick={() => setSelectedReport(null)} style={styles.detailClose}>×</button>
          <h3 style={styles.detailTitle}>Report Details</h3>
          {renderDetailFields(selectedReport)}
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
  },
  title: { color: "#fff", fontSize: 18, fontWeight: 700, margin: 0 },
  content: {
    flex: 1,
    padding: 16,
    maxWidth: 600,
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box",
  },
  loginPrompt: {
    background: "#F0F4FF",
    border: "1px solid #D0E4FF",
    borderRadius: 12,
    padding: "16px 20px",
    marginBottom: 20,
    textAlign: "center",
  },
  loginPromptText: {
    color: "#1A2B4A",
    fontSize: "0.9rem",
    margin: "0 0 12px",
  },
  loginPromptBtns: {
    display: "flex",
    gap: 8,
    justifyContent: "center",
    flexWrap: "wrap",
  },
  loginBtn: {
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 14,
  },
  registerBtn: {
    background: "transparent",
    color: "#0468B1",
    border: "1px solid #0468B1",
    borderRadius: 8,
    padding: "10px 20px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
  },
  centred: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
    gap: 16,
    textAlign: "center",
  },
  spinner: {
    width: 36,
    height: 36,
    border: "3px solid #e0e0e0",
    borderTop: "3px solid #0468B1",
    borderRadius: "50%",
    animation: "cr-spin 0.8s linear infinite",
  },
  loadingText: { fontSize: 15, color: "#666", margin: 0 },
  errorText: { fontSize: 16, color: "#d32f2f", margin: 0 },
  retryBtn: {
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 24px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  emptyIcon: { fontSize: 64 },
  emptyText: { fontSize: 16, color: "#666", margin: 0 },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingTop: 8,
  },
  sessionNote: {
    fontSize: 13,
    color: "#718096",
    textAlign: "center",
    margin: "0 0 4px",
    padding: "10px 14px",
    background: "#EDF2F7",
    borderRadius: 8,
  },
  columnHeaders: {
    display: "grid",
    gridTemplateColumns: "2fr 1fr 1fr 1fr",
    padding: "8px 16px",
    borderBottom: "1px solid #E2E8F0",
    color: "#717782",
    fontSize: "0.75rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  desktopRow: {
    display: "grid",
    gridTemplateColumns: "2fr 1fr 1fr 1fr",
    padding: "12px 16px",
    background: "#fff",
    borderRadius: 8,
    cursor: "pointer",
    alignItems: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
    transition: "background 0.15s",
  },
  desktopCell: {
    fontSize: 13,
    color: "#1A2B4A",
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    display: "flex",
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    cursor: "pointer",
  },
  thumbnail: {
    width: 88,
    height: 88,
    objectFit: "cover",
    flexShrink: 0,
  },
  thumbnailPlaceholder: {
    width: 88,
    height: 88,
    background: "#f0f2f5",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardBody: {
    flex: 1,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    justifyContent: "center",
  },
  damageBadge: {
    alignSelf: "flex-start",
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
  },
  cardDate: { fontSize: 13, color: "#888", margin: 0 },
  cardLocation: { fontSize: 13, color: "#1A2B4A", margin: 0 },
  cardStatus: { fontSize: 12, color: "#717782" },
  loadMoreBtn: {
    marginTop: 4,
    background: "#fff",
    border: "1.5px solid #0468B1",
    borderRadius: 8,
    padding: "13px",
    fontSize: 15,
    fontWeight: 600,
    color: "#0468B1",
    width: "100%",
  },
  detailPanel: {
    position: "fixed",
    top: 64,
    right: 0,
    width: 380,
    height: "calc(100dvh - 64px)",
    background: "#fff",
    borderLeft: "1px solid #E2E8F0",
    overflowY: "auto",
    padding: 24,
    zIndex: 20,
    boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
  },
  detailClose: {
    position: "absolute",
    top: 16,
    right: 16,
    background: "none",
    border: "none",
    fontSize: 20,
    cursor: "pointer",
    color: "#717782",
    lineHeight: 1,
  },
  detailTitle: {
    color: "#1A2B4A",
    margin: "0 0 16px",
    fontSize: 17,
    fontWeight: 700,
  },
  detailFields: {
    fontSize: "0.9rem",
    color: "#1A2B4A",
    lineHeight: 1.6,
  },
  detailField: {
    margin: "0 0 10px",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "none",
    border: "none",
    color: "#0468B1",
    fontSize: "0.9rem",
    cursor: "pointer",
    padding: "16px 0",
    fontWeight: 600,
  },
};
