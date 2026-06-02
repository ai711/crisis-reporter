import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api, { tokenStorage } from "../services/api";
import { getPendingItems } from "../utils/offlineQueue";
import type { QueuedReport } from "../types";

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
  disaster_type?: string | null;
  infrastructure_name?: string | null;
  infrastructure_type?: string | null;
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

function formatLocation(report: ReporterReport, fallback = "Location not recorded"): string {
  if (report.location_address) return report.location_address;
  if (report.gps_latitude != null && report.gps_longitude != null) {
    return `${report.gps_latitude.toFixed(4)}, ${report.gps_longitude.toFixed(4)}`;
  }
  return fallback;
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

const FLAG_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  green:  { bg: "rgba(56,161,105,0.12)",  color: "#38A169", label: "✓ Verified"  },
  orange: { bg: "rgba(242,153,74,0.12)",  color: "#F2994A", label: "⚠ Review"   },
  red:    { bg: "rgba(229,62,62,0.12)",   color: "#E53E3E", label: "✗ Flagged"  },
  grey:   { bg: "rgba(156,163,175,0.12)", color: "#9CA3AF", label: "◉ Pending"  },
};

export default function MyReportsPage() {
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();
  const navigate = useNavigate();
  const width = useWindowWidth();
  const isDesktop = width > 768;

  const [reports, setReports] = useState<ReporterReport[]>([]);
  const [offlineReports, setOfflineReports] = useState<QueuedReport[]>([]);
  const [loading, setLoading] = useState(!!reporterId);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isSessionMode, setIsSessionMode] = useState(false);
  const [selectedReport, setSelectedReport] = useState<ReporterReport | null>(null);

  const fetchReports = useCallback(async (cursor?: string) => {
    if (!reporterId || !tokenStorage.getAccessToken()) {
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
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        // Token expired and refresh failed — fall back to session reports
        const raw = sessionStorage.getItem("cr_session_reports");
        if (raw) {
          try {
            const parsed: SessionReport[] = JSON.parse(raw);
            setReports([...parsed].reverse().map(convertSessionReport));
            setIsSessionMode(true);
          } catch { /* ignore */ }
        }
      } else {
        setError(t('my_reports.load_error'));
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [reporterId]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Load offline queued reports from IndexedDB
  useEffect(() => {
    getPendingItems()
      .then(setOfflineReports)
      .catch(() => {});
  }, []);

  const emptyMessage = !reporterId
    ? t('my_reports.empty_anonymous')
    : t('my_reports.empty_title');

  const statusText = (report: ReporterReport) =>
    report.status === "submitted" ? "✓ Submitted" : (report.status ?? "Submitted");

  const renderDetailFields = (report: ReporterReport) => {
    const flagInfo = report.flag_status ? FLAG_BADGE[report.flag_status] : null;
    return (
      <div style={styles.detailFields}>
        <p style={styles.detailField}><strong>📍 {t('my_reports.label_location')}</strong> {formatLocation(report, t('my_reports.location_not_recorded'))}</p>
        <p style={styles.detailField}><strong>⚠ {t('my_reports.label_damage')}</strong> {DAMAGE_LABEL[report.damage_level] ?? report.damage_level}</p>
        {report.disaster_type && (
          <p style={styles.detailField}><strong>⚡ {t('my_reports.label_disaster_type')}</strong> {report.disaster_type}</p>
        )}
        {(report.infrastructure_name || report.infrastructure_type) && (
          <p style={styles.detailField}><strong>🏗 Infrastructure</strong> {report.infrastructure_name || report.infrastructure_type}</p>
        )}
        {report.building_name && (
          <p style={styles.detailField}><strong>🏢 Building</strong> {report.building_name}</p>
        )}
        <p style={styles.detailField}><strong>🕐 {t('my_reports.label_date')}</strong> {formatDateTime(report.submitted_at)}</p>
        <p style={styles.detailField}>
          <strong>📊 Review Status</strong>{" "}
          {flagInfo ? (
            <span style={{ ...styles.flagBadge, background: flagInfo.bg, color: flagInfo.color }}>
              {flagInfo.label}
            </span>
          ) : (
            statusText(report)
          )}
        </p>
        {report.photo_count > 0 && (
          <p style={styles.detailField}><strong>📷 Photos</strong> {report.photo_count}</p>
        )}
      </div>
    );
  };

  // A6: Mobile full-screen detail view
  if (!isDesktop && selectedReport) {
    return (
      <div style={styles.container}>
        <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ flex: 1, padding: "0 16px 32px" }}>
          <button onClick={() => setSelectedReport(null)} style={styles.backBtn}>
            {t('my_reports.back')}
          </button>
          <h3 style={styles.detailTitle}>{t('my_reports.detail_title')}</h3>
          {renderDetailFields(selectedReport)}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={styles.content}>
        {/* A3: Login prompt for anonymous reporters — always shown when not logged in */}
        {!reporterId && (
          <div style={styles.loginPrompt}>
            <p style={styles.loginPromptText}>
              {t('my_reports.login_prompt')}
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
            <p style={styles.loadingText}>{t('common.loading')}</p>
          </div>
        ) : error ? (
          <div style={styles.centred}>
            <p style={styles.errorText}>{error}</p>
            <button style={styles.retryBtn} onClick={() => fetchReports()}>
              {t('common.retry')}
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
                {t('my_reports.session_note')}
              </p>
            )}

            {/* Offline queued reports — shown at top */}
            {offlineReports.length > 0 && (
              <>
                <p style={styles.sectionLabel}>⏳ Pending Sync ({offlineReports.length})</p>
                {offlineReports.map((qr) => {
                  const loc =
                    qr.report.location?.location_building_name ||
                    qr.report.location?.location_address ||
                    (qr.report.location?.gps_latitude != null
                      ? `${qr.report.location.gps_latitude.toFixed(4)}, ${(qr.report.location.gps_longitude ?? 0).toFixed(4)}`
                      : t('my_reports.location_not_recorded'));
                  const dmgColor = DAMAGE_COLOR[qr.report.damage_level as string] ?? "#999";
                  const dmgLabel = DAMAGE_LABEL[qr.report.damage_level as string] ?? qr.report.damage_level;
                  return (
                    <div key={qr.local_id} style={styles.card}>
                      <div style={styles.thumbnailPlaceholder}>
                        <span style={{ fontSize: 22 }}>⏳</span>
                      </div>
                      <div style={styles.cardBody}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" }}>
                          <span style={{ ...styles.damageBadge, background: dmgColor + "22", color: dmgColor }}>
                            {dmgLabel}
                          </span>
                          <span style={{ ...styles.flagBadge, background: "rgba(245,166,35,0.12)", color: "#F5A623" }}>
                            Offline
                          </span>
                        </div>
                        <p style={styles.cardDate}>🕐 {formatDateTime(qr.created_at)}</p>
                        <p style={styles.cardLocation}>📍 {loc}</p>
                        {qr.report.infrastructure_type && (
                          <p style={styles.cardMeta}>🏗 {qr.report.infrastructure_type}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {reports.length > 0 && <p style={styles.sectionLabel}>Submitted</p>}
              </>
            )}

            {/* A5: Desktop column headers */}
            {isDesktop && (
              <div style={styles.columnHeaders}>
                <span>{t('my_reports.col_location')}</span>
                <span>{t('my_reports.col_damage')}</span>
                <span>{t('my_reports.col_date')}</span>
                <span>{t('my_reports.col_status')}</span>
              </div>
            )}

            {reports.map((report) => {
              const color = DAMAGE_COLOR[report.damage_level] ?? "#999";
              const label = DAMAGE_LABEL[report.damage_level] ?? report.damage_level;
              const st = statusText(report);
              const flagInfo = report.flag_status ? FLAG_BADGE[report.flag_status] : null;

              if (isDesktop) {
                return (
                  <div
                    key={report.id}
                    style={styles.desktopRow}
                    onClick={() => setSelectedReport(report)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#F7FAFC"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#fff"; }}
                  >
                    <span style={styles.desktopCell}>{formatLocation(report, t('my_reports.location_not_recorded'))}</span>
                    <span>
                      <span style={{ ...styles.damageBadge, background: color + "22", color }}>
                        {label}
                      </span>
                    </span>
                    <span style={styles.desktopCell}>{formatDateTime(report.submitted_at)}</span>
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
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" }}>
                      <span style={{ ...styles.damageBadge, background: color + "22", color }}>
                        {label}
                      </span>
                      {flagInfo && (
                        <span style={{ ...styles.flagBadge, background: flagInfo.bg, color: flagInfo.color }}>
                          {flagInfo.label}
                        </span>
                      )}
                    </div>
                    <p style={styles.cardDate}>🕐 {formatDateTime(report.submitted_at)}</p>
                    <p style={styles.cardLocation}>📍 {formatLocation(report, t('my_reports.location_not_recorded'))}</p>
                    {(report.disaster_type || report.infrastructure_name || report.infrastructure_type) && (
                      <p style={styles.cardMeta}>
                        {report.disaster_type && <span>⚡ {report.disaster_type}</span>}
                        {(report.infrastructure_name || report.infrastructure_type) && (
                          <span>
                            {report.disaster_type ? " · " : ""}
                            🏗 {report.infrastructure_name || report.infrastructure_type}
                          </span>
                        )}
                      </p>
                    )}
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
                {loadingMore ? t('common.loading') : t('my_reports.load_more')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* A5: Desktop right-side detail panel */}
      {isDesktop && selectedReport && (
        <div style={styles.detailPanel}>
          <button onClick={() => setSelectedReport(null)} style={styles.detailClose}>×</button>
          <h3 style={styles.detailTitle}>{t('my_reports.detail_title')}</h3>
          {renderDetailFields(selectedReport)}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    background: "#F6F3F2",
    display: "flex",
    flexDirection: "column",
  },
  content: {
    flex: 1,
    padding: 16,
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
    borderRadius: 16,
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
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#717782",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    margin: "8px 0 6px",
  },
  flagBadge: {
    alignSelf: "flex-start",
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 600,
  },
  cardDate: { fontSize: 12, color: "#888", margin: "2px 0 0" },
  cardLocation: { fontSize: 13, color: "#1A2B4A", margin: "2px 0 0" },
  cardMeta: { fontSize: 12, color: "#717782", margin: "2px 0 0" },
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
    top: 56,
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
