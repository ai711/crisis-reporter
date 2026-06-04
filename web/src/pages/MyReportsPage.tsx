import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api, { tokenStorage } from "../services/api";
import {
  getAllQueueItems,
  removeFromQueue,
  resetItemForRetry,
  syncQueue,
} from "../utils/offlineQueue";
import type { QueuedReport } from "../types";

// ── Interfaces ────────────────────────────────────────────────────────────────

interface ReporterReport {
  id: string;
  serial_number?: number | null;
  damage_level: "minimal" | "partial" | "complete";
  submitted_at: string;
  created_at?: string;
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

/** Full report detail — returned by GET /api/reports/{id} */
interface ReportDetailFull {
  id: string;
  serial_number?: number | null;
  damage_level: string;
  submitted_at: string;
  created_at: string;
  gps_latitude?: number | null;
  gps_longitude?: number | null;
  gps_accuracy_meters?: number | null;
  location_address?: string | null;
  location_landmark?: string | null;
  location_building_name?: string | null;
  location_note?: string | null;
  building_name?: string | null;
  building_name_reporter?: string | null;
  building_name_osm?: string | null;
  building_id?: string | null;
  infrastructure_type?: string | null;
  infrastructure_types?: string[] | null;
  infrastructure_other?: string | null;
  infrastructure_name?: string | null;
  disaster_type?: string | null;
  debris_blocking?: string | null;
  electricity_condition?: string | null;
  health_services_condition?: string | null;
  pressing_needs?: string[] | null;
  pressing_needs_other?: string | null;
  description?: string | null;
  flag_status: string;
  photo_urls: string[];
  photo_count: number;
  was_queued: boolean;
}

// Shape saved to localStorage by ReportPage (cr_local_reports)
interface LocalReport {
  id: string;
  damage_level: string;
  gps_latitude: number | null;
  gps_longitude: number | null;
  location_address: string | null;
  submitted_at: string;
  created_at?: string;
}

// Legacy shape saved to sessionStorage (cr_session_reports)
interface SessionReport {
  id: string;
  damage_level?: string;
  lat?: number | null;
  lng?: number | null;
  location_address?: string | null;
  submitted_at: string;
}

interface ReportsResponse {
  items: ReporterReport[];
  next_cursor: string | null;
}

// ── Static colour maps (no text — safe outside component) ─────────────────────

const DAMAGE_COLOR: Record<string, string> = {
  complete: "#e53935",
  partial:  "#f57c00",
  minimal:  "#388e3c",
};

// ── Converter helpers ─────────────────────────────────────────────────────────

function convertLocalReport(r: LocalReport): ReporterReport {
  return {
    id: r.id,
    damage_level: r.damage_level as ReporterReport["damage_level"],
    submitted_at: r.submitted_at,
    created_at: r.created_at,
    gps_latitude: r.gps_latitude,
    gps_longitude: r.gps_longitude,
    location_address: r.location_address,
    photo_count: 0,
    first_photo_url: null,
    status: "submitted",
  };
}

function convertSessionReport(s: SessionReport): ReporterReport {
  return {
    id: s.id,
    damage_level: (s.damage_level ?? "minimal") as ReporterReport["damage_level"],
    submitted_at: s.submitted_at,
    gps_latitude: s.lat ?? null,
    gps_longitude: s.lng ?? null,
    location_address: s.location_address ?? null,
    photo_count: 0,
    first_photo_url: null,
    status: "submitted",
  };
}

function formatLocation(report: ReporterReport, fallback: string): string {
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

/** Format a raw snake_case option value into Title Case for display. */
function fmtVal(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function fmtList(arr: string[] | null | undefined): string | null {
  if (!arr?.length) return null;
  return arr.map((v) => fmtVal(v)!).join(", ");
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
const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

/**
 * Ensure a photo URL is absolute.
 * LocalFileSystemStorage returns relative paths ("/api/uploads/photos/…")
 * which break when the API runs on a different origin than the web app.
 */
function absolutePhotoUrl(url: string): string {
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return url;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MyReportsPage() {
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();
  const navigate = useNavigate();

  // Translation-aware label helpers
  const damageLabel = (level: string) => {
    const map: Record<string, string> = {
      complete: t("my_reports.damage_complete"),
      partial:  t("my_reports.damage_partial"),
      minimal:  t("my_reports.damage_minimal"),
    };
    return map[level] ?? level;
  };

  const width = useWindowWidth();
  const isDesktop = width > 768;

  // ── State ─────────────────────────────────────────────────────────────────

  const [reports, setReports]               = useState<ReporterReport[]>([]);
  const [offlineReports, setOfflineReports] = useState<QueuedReport[]>([]);
  const [loading, setLoading]               = useState(true);
  const [loadingOffline, setLoadingOffline] = useState(true);
  const [loadingMore, setLoadingMore]       = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [nextCursor, setNextCursor]         = useState<string | null>(null);
  const [isLocalMode, setIsLocalMode]       = useState(false);
  const [selectedReport, setSelectedReport] = useState<ReporterReport | null>(null);
  const [loadingDetail, setLoadingDetail]   = useState(false);
  const [fullDetail, setFullDetail]         = useState<ReportDetailFull | null>(null);
  const [deletingId, setDeletingId]         = useState<string | null>(null);
  const [retryingId, setRetryingId]         = useState<string | null>(null);

  // ── Load offline queue ────────────────────────────────────────────────────

  const refreshOfflineReports = useCallback(() => {
    getAllQueueItems()
      .then((items) => {
        items.sort((a, b) => {
          const rank = (i: QueuedReport) =>
            i.status === "syncing" ? 0 : i.retry_count >= 5 ? 2 : 1;
          return rank(a) - rank(b);
        });
        setOfflineReports(items);
      })
      .catch(() => setOfflineReports([]))
      .finally(() => setLoadingOffline(false));
  }, []);

  useEffect(() => { refreshOfflineReports(); }, [refreshOfflineReports]);

  useEffect(() => {
    const onOnline = () => { syncQueue(API_BASE).finally(() => refreshOfflineReports()); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refreshOfflineReports]);

  // ── Load submitted reports ────────────────────────────────────────────────

  const fetchReports = useCallback(async (cursor?: string) => {
    if (!cursor) { setLoading(true); setError(null); }
    else          { setLoadingMore(true); }

    if (!reporterId || !tokenStorage.getAccessToken()) {
      try {
        const raw = localStorage.getItem("cr_local_reports");
        if (raw) {
          const parsed: LocalReport[] = JSON.parse(raw);
          if (parsed.length > 0) {
            setReports([...parsed].reverse().map(convertLocalReport));
            setIsLocalMode(true);
            setLoading(false);
            return;
          }
        }
      } catch { /* ignore */ }

      try {
        const raw = sessionStorage.getItem("cr_session_reports");
        if (raw) {
          const parsed: SessionReport[] = JSON.parse(raw);
          if (parsed.length > 0) {
            setReports([...parsed].reverse().map(convertSessionReport));
            setIsLocalMode(true);
            setLoading(false);
            return;
          }
        }
      } catch { /* ignore */ }

      setLoading(false);
      return;
    }

    try {
      const params: Record<string, string> = { limit: String(PAGE_SIZE) };
      if (cursor) params.cursor = cursor;
      const res = await api.get<ReportsResponse>("/api/reports/my", { params });
      const data = res.data;
      if (cursor) setReports((prev) => [...prev, ...data.items]);
      else        setReports(data.items);
      setNextCursor(data.next_cursor);
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } })?.response?.status;
      if (httpStatus === 401) {
        try {
          const raw = localStorage.getItem("cr_local_reports");
          if (raw) {
            const parsed: LocalReport[] = JSON.parse(raw);
            setReports([...parsed].reverse().map(convertLocalReport));
            setIsLocalMode(true);
          }
        } catch { /* ignore */ }
      } else {
        setError(t("my_reports.load_error"));
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [reporterId, t]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  // ── Detail fetch ──────────────────────────────────────────────────────────

  const handleReportClick = useCallback(async (report: ReporterReport) => {
    setSelectedReport(report);
    setFullDetail(null);
    setLoadingDetail(true);
    try {
      const res = await api.get<ReportDetailFull>(`/api/reports/${report.id}`);
      setFullDetail(res.data);
    } catch {
      /* fall through — detailContent() shows basic fallback */
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const handleDetailClose = useCallback(() => {
    setSelectedReport(null);
    setFullDetail(null);
  }, []);

  // ── Offline queue actions ─────────────────────────────────────────────────

  const handleDelete = async (local_id: string) => {
    setDeletingId(local_id);
    try {
      await removeFromQueue(local_id);
      setOfflineReports((prev) => prev.filter((r) => r.local_id !== local_id));
    } catch { /* ignore */ } finally {
      setDeletingId(null);
    }
  };

  const handleRetry = async (local_id: string) => {
    setRetryingId(local_id);
    try {
      await resetItemForRetry(local_id);
      await syncQueue(API_BASE);
      refreshOfflineReports();
    } catch { /* ignore */ } finally {
      setRetryingId(null);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const statusText = (report: ReporterReport) =>
    report.status === "submitted"
      ? t("my_reports.status_submitted")
      : (report.status ?? t("my_reports.status_submitted"));

  /** Section title row used inside the full detail view. */
  const renderSection = (title: string, children: React.ReactNode) => (
    <div style={styles.detailSection}>
      <div style={styles.detailSectionTitle}>{title}</div>
      {children}
    </div>
  );

  /** One label + value row inside a section. */
  const renderRow = (label: string, value: React.ReactNode) => (
    <div key={label} style={styles.detailRow}>
      <span style={styles.detailRowLabel}>{label}</span>
      <span style={styles.detailRowValue}>{value}</span>
    </div>
  );

  /**
   * Full Q1-Q8 detail panel — shown when GET /api/reports/{id} succeeds.
   * Mirrors the review step of the submission flow exactly.
   */
  const renderFullDetail = (d: ReportDetailFull) => {
    const buildingName =
      d.building_name || d.building_name_reporter || d.building_name_osm || d.location_building_name;

    const hasLocationSection =
      d.building_id || d.infrastructure_types?.length ||
      d.location_address || d.location_landmark ||
      buildingName || d.location_note || d.gps_latitude != null;

    return (
      <div>
        {/* ── Header: serial number ── */}
        {d.serial_number ? (
          <div style={{ marginBottom: 4 }}>
            <span style={styles.serialNumber}>
              {t("my_reports.report_number", { n: d.serial_number })}
            </span>
          </div>
        ) : null}
        <p style={styles.detailTimestamp}>🕐 {formatDateTime(d.submitted_at)}</p>

        {/* ── Photos ── */}
        {d.photo_urls?.length > 0 && renderSection(
          `📷 ${t("report.review_photos")}`,
          <div style={styles.photoStrip}>
            {d.photo_urls.map((url, i) => {
              const absUrl = absolutePhotoUrl(url);
              return (
                <img
                  key={i}
                  src={absUrl}
                  alt={`Photo ${i + 1}`}
                  style={styles.detailPhoto}
                  title={t("my_reports.photos_tap_to_view")}
                  onClick={() => window.open(absUrl, "_blank")}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              );
            }
            ))}
          </div>
        )}

        {/* ── Location ── */}
        {hasLocationSection && renderSection(
          `📍 ${t("report.review_location")}`,
          <div style={styles.detailTable}>
            {d.building_id && renderRow(
              t("report.review_label_building"),
              <span style={styles.codeText}>{d.building_id.substring(0, 20)}</span>
            )}
            {d.infrastructure_types?.length ? renderRow(
              t("report.review_label_type"),
              <div style={styles.chipRow}>
                {d.infrastructure_types.map((v) => (
                  <span key={v} style={styles.chip}>{fmtVal(v)}</span>
                ))}
              </div>
            ) : null}
            {d.location_address && renderRow(t("report.review_label_address"), d.location_address)}
            {d.location_landmark && renderRow(t("report.review_label_landmark"), d.location_landmark)}
            {buildingName && renderRow(t("report.review_label_building_name"), buildingName)}
            {d.location_note && renderRow(t("report.review_label_location_note"), d.location_note)}
            {d.gps_latitude != null && renderRow(
              t("report.review_label_gps"),
              `${d.gps_latitude.toFixed(5)}, ${d.gps_longitude!.toFixed(5)}`
            )}
          </div>
        )}

        {/* ── Damage Assessment (Q1-Q8) ── */}
        {renderSection(
          `📊 ${t("report.review_damage_assessment")}`,
          <div style={styles.detailTable}>
            {renderRow(t("report.review_q1"), damageLabel(d.damage_level))}
            {d.infrastructure_types?.length ? renderRow(
              t("report.review_q2"),
              fmtList(d.infrastructure_types)
            ) : null}
            {d.infrastructure_other && renderRow(t("report.review_label_q2_other"), d.infrastructure_other)}
            {d.infrastructure_name && renderRow(t("report.review_q3"), d.infrastructure_name)}
            {d.disaster_type && renderRow(t("report.review_q4"), fmtVal(d.disaster_type))}
            {d.debris_blocking && renderRow(t("report.review_q5"), fmtVal(d.debris_blocking))}
            {d.electricity_condition && renderRow(t("report.review_q6"), fmtVal(d.electricity_condition))}
            {d.health_services_condition && renderRow(t("report.review_q7"), fmtVal(d.health_services_condition))}
            {d.pressing_needs?.length ? renderRow(
              t("report.review_q8"),
              fmtList(d.pressing_needs)
            ) : null}
            {d.pressing_needs_other && renderRow(t("report.review_label_q8_other"), d.pressing_needs_other)}
          </div>
        )}

        {/* ── Description ── */}
        {d.description && renderSection(
          `📝 ${t("my_reports.description")}`,
          <p style={styles.descriptionText}>{d.description}</p>
        )}
      </div>
    );
  };

  /**
   * Basic fallback shown while the detail is loading or when the API call failed.
   * Uses data already available from the list endpoint.
   */
  const renderBasicDetail = (report: ReporterReport) => {
    return (
      <div style={styles.detailFields}>
        <p style={styles.detailField}>
          <strong>📍 {t("my_reports.label_location")}</strong>{" "}
          {formatLocation(report, t("my_reports.location_not_recorded"))}
        </p>
        <p style={styles.detailField}>
          <strong>⚠ {t("my_reports.label_damage")}</strong>{" "}
          {damageLabel(report.damage_level)}
        </p>
        {report.disaster_type && (
          <p style={styles.detailField}>
            <strong>⚡ {t("my_reports.label_disaster_type")}</strong>{" "}
            {report.disaster_type}
          </p>
        )}
        {(report.infrastructure_name || report.infrastructure_type) && (
          <p style={styles.detailField}>
            <strong>🏗 {t("my_reports.label_infrastructure")}</strong>{" "}
            {report.infrastructure_name || report.infrastructure_type}
          </p>
        )}
        {report.building_name && (
          <p style={styles.detailField}>
            <strong>🏢 {t("my_reports.label_building")}</strong>{" "}
            {report.building_name}
          </p>
        )}
        <p style={styles.detailField}>
          <strong>🕐 {t("my_reports.label_date")}</strong>{" "}
          {formatDateTime(report.submitted_at)}
        </p>
        <p style={styles.detailField}>
          <strong>📊 {t("my_reports.label_status")}</strong>{" "}
          {statusText(report)}
        </p>
        {report.photo_count > 0 && (
          <p style={styles.detailField}>
            <strong>📷 {t("my_reports.label_photos")}</strong>{" "}
            {report.photo_count}
          </p>
        )}
      </div>
    );
  };

  /** Renders the content of the detail panel (loading → full → basic fallback). */
  const detailContent = () => {
    if (loadingDetail) {
      return (
        <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", padding: "40px 0", gap: 12 }}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>{t("my_reports.loading_detail")}</p>
        </div>
      );
    }
    if (fullDetail) return renderFullDetail(fullDetail);
    if (selectedReport) return renderBasicDetail(selectedReport);
    return null;
  };

  const renderOfflineCard = (qr: QueuedReport) => {
    const loc =
      qr.report.location?.location_building_name ||
      qr.report.location?.location_address ||
      (qr.report.location?.gps_latitude != null
        ? `${qr.report.location.gps_latitude.toFixed(4)}, ${(qr.report.location.gps_longitude ?? 0).toFixed(4)}`
        : t("my_reports.location_not_recorded"));

    const dmgColor  = DAMAGE_COLOR[qr.report.damage_level as string] ?? "#999";
    const dmgLbl    = damageLabel(qr.report.damage_level as string);
    const isFailed  = qr.retry_count >= 5;
    const isSyncing = qr.status === "syncing";
    const isDeleting = deletingId === qr.local_id;
    const isRetrying = retryingId === qr.local_id;

    const offlineBadge = isFailed
      ? { bg: "rgba(229,62,62,0.12)", color: "#E53E3E", label: t("my_reports.offline_upload_failed") }
      : isSyncing
        ? { bg: "rgba(66,153,225,0.12)", color: "#3182CE", label: t("my_reports.offline_uploading") }
        : { bg: "rgba(245,166,35,0.12)", color: "#F5A623", label: t("my_reports.offline_label") };

    return (
      <div key={qr.local_id} style={styles.card}>
        <div style={styles.thumbnailPlaceholder}>
          <span style={{ fontSize: 22 }}>{isFailed ? "⚠" : isSyncing ? "⬆" : "⏳"}</span>
        </div>
        <div style={styles.cardBody}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" }}>
            <span style={{ ...styles.damageBadge, background: dmgColor + "22", color: dmgColor }}>{dmgLbl}</span>
            <span style={{ ...styles.flagBadge, background: offlineBadge.bg, color: offlineBadge.color }}>{offlineBadge.label}</span>
          </div>
          <p style={styles.cardDate}>🕐 {formatDateTime(qr.created_at)}</p>
          <p style={styles.cardLocation}>📍 {loc}</p>
          {qr.report.infrastructure_type && (
            <p style={styles.cardMeta}>🏗 {qr.report.infrastructure_type}</p>
          )}
          {isFailed && (
            <p style={styles.cardMeta}>{t("my_reports.failed_attempts", { count: qr.retry_count })}</p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            {isFailed && (
              <button
                style={{ ...styles.actionBtn, background: "#0468B1", color: "#fff" }}
                onClick={() => handleRetry(qr.local_id)}
                disabled={isRetrying || isDeleting}
              >
                {isRetrying ? t("my_reports.action_retrying") : t("my_reports.action_retry")}
              </button>
            )}
            <button
              style={{ ...styles.actionBtn, background: "transparent", color: "#E53E3E", border: "1px solid #E53E3E" }}
              onClick={() => handleDelete(qr.local_id)}
              disabled={isDeleting || isRetrying || isSyncing}
            >
              {isDeleting ? t("my_reports.action_deleting") : t("my_reports.action_delete")}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── Mobile: full-screen detail view ──────────────────────────────────────

  if (!isDesktop && selectedReport) {
    return (
      <div style={styles.container}>
        <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ flex: 1, padding: "0 16px 32px", overflowY: "auto" as const }}>
          <button onClick={handleDetailClose} style={styles.backBtn}>
            {t("my_reports.back")}
          </button>
          <h3 style={styles.detailTitle}>{t("my_reports.detail_title")}</h3>
          {detailContent()}
        </div>
      </div>
    );
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const isLoading    = loading || loadingOffline;
  const hasSubmitted = reports.length > 0;
  const hasOffline   = offlineReports.length > 0;
  const isEmpty      = !isLoading && !hasSubmitted && !hasOffline && !error;

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={styles.content}>

        {/* Login prompt for anonymous reporters */}
        {!reporterId && (
          <div style={styles.loginPrompt}>
            <p style={styles.loginPromptText}>{t("my_reports.login_prompt")}</p>
            <div style={styles.loginPromptBtns}>
              <button onClick={() => navigate("/login")} style={styles.loginBtn}>{t("my_reports.login_btn")}</button>
              <button onClick={() => navigate("/login?mode=register")} style={styles.registerBtn}>{t("my_reports.register_btn")}</button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div style={styles.centred}>
            <div style={styles.spinner} />
            <p style={styles.loadingText}>{t("common.loading")}</p>
          </div>
        ) : error ? (
          <div style={styles.centred}>
            <p style={styles.errorText}>{error}</p>
            <button style={styles.retryBtn} onClick={() => fetchReports()}>
              {t("common.retry")}
            </button>
          </div>
        ) : isEmpty ? (
          <div style={styles.centred}>
            <span style={styles.emptyIcon}>📋</span>
            <p style={styles.emptyText}>
              {!reporterId ? t("my_reports.empty_anonymous") : t("my_reports.empty_title")}
            </p>
          </div>
        ) : (
          <div style={styles.list}>

            {isLocalMode && (
              <p style={styles.sessionNote}>{t("my_reports.session_note")}</p>
            )}

            {/* Offline / pending upload reports */}
            {hasOffline && (
              <>
                <p style={styles.sectionLabel}>
                  {offlineReports.some((r) => r.retry_count >= 5)
                    ? `⚠ ${t("my_reports.upload_issues_label", { count: offlineReports.length })}`
                    : `⏳ ${t("my_reports.pending_upload_label", { count: offlineReports.length })}`}
                </p>
                {offlineReports.map(renderOfflineCard)}
                {hasSubmitted && <p style={styles.sectionLabel}>{t("my_reports.submitted_section")}</p>}
              </>
            )}

            {/* Submitted reports */}
            {hasSubmitted && (
              <>
                {isDesktop && (
                  <div style={styles.columnHeaders}>
                    <span>{t("my_reports.col_location")}</span>
                    <span>{t("my_reports.col_damage")}</span>
                    <span>{t("my_reports.col_date")}</span>
                    <span>{t("my_reports.col_status")}</span>
                  </div>
                )}

                {reports.map((report) => {
                  const color    = DAMAGE_COLOR[report.damage_level] ?? "#999";
                  const lbl      = damageLabel(report.damage_level);
                  const st       = statusText(report);
                  const isActive = selectedReport?.id === report.id;

                  if (isDesktop) {
                    return (
                      <div
                        key={report.id}
                        style={{
                          ...styles.desktopRow,
                          background: isActive ? "#EBF4FF" : "#fff",
                          borderLeft: isActive ? "3px solid #0468B1" : "3px solid transparent",
                        }}
                        onClick={() => handleReportClick(report)}
                        onMouseEnter={(e) => {
                          if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "#F7FAFC";
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "#fff";
                        }}
                      >
                        <span style={styles.desktopCell}>
                          {formatLocation(report, t("my_reports.location_not_recorded"))}
                        </span>
                        <span>
                          <span style={{ ...styles.damageBadge, background: color + "22", color }}>{lbl}</span>
                        </span>
                        <span style={styles.desktopCell}>{formatDateTime(report.submitted_at)}</span>
                        <span style={{ ...styles.desktopCell, color: "#388e3c" }}>{st}</span>
                      </div>
                    );
                  }

                  return (
                    <div key={report.id} style={styles.card} onClick={() => handleReportClick(report)}>
                      {report.first_photo_url ? (
                        <img src={absolutePhotoUrl(report.first_photo_url)} alt="Report photo" style={styles.thumbnail} />
                      ) : (
                        <div style={styles.thumbnailPlaceholder}>
                          <span style={{ fontSize: 28 }}>📷</span>
                        </div>
                      )}
                      <div style={styles.cardBody}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" }}>
                          <span style={{ ...styles.damageBadge, background: color + "22", color }}>{lbl}</span>
                        </div>
                        <p style={styles.cardDate}>🕐 {formatDateTime(report.submitted_at)}</p>
                        <p style={styles.cardLocation}>📍 {formatLocation(report, t("my_reports.location_not_recorded"))}</p>
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
                    style={{ ...styles.loadMoreBtn, opacity: loadingMore ? 0.6 : 1, cursor: loadingMore ? "default" : "pointer" }}
                    onClick={() => fetchReports(nextCursor)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? t("common.loading") : t("my_reports.load_more")}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Desktop right-side detail panel */}
      {isDesktop && selectedReport && (
        <div style={styles.detailPanel}>
          <button onClick={handleDetailClose} style={styles.detailClose}>×</button>
          <h3 style={styles.detailTitle}>{t("my_reports.detail_title")}</h3>
          {detailContent()}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  loginPromptText: { color: "#1A2B4A", fontSize: "0.9rem", margin: "0 0 12px" },
  loginPromptBtns: { display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" },
  loginBtn: {
    background: "#0468B1", color: "#fff", border: "none", borderRadius: 8,
    padding: "10px 20px", fontWeight: 700, cursor: "pointer", fontSize: 14,
  },
  registerBtn: {
    background: "transparent", color: "#0468B1", border: "1px solid #0468B1",
    borderRadius: 8, padding: "10px 20px", fontWeight: 600, cursor: "pointer", fontSize: 14,
  },
  centred: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "50vh", gap: 16, textAlign: "center",
  },
  spinner: {
    width: 36, height: 36, border: "3px solid #e0e0e0",
    borderTop: "3px solid #0468B1", borderRadius: "50%",
    animation: "cr-spin 0.8s linear infinite",
  },
  loadingText: { fontSize: 15, color: "#666", margin: 0 },
  errorText:   { fontSize: 16, color: "#d32f2f", margin: 0 },
  retryBtn: {
    background: "#0468B1", color: "#fff", border: "none", borderRadius: 8,
    padding: "10px 24px", fontSize: 15, fontWeight: 600, cursor: "pointer",
  },
  emptyIcon: { fontSize: 64 },
  emptyText:  { fontSize: 16, color: "#666", margin: 0 },
  list: { display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 },
  sessionNote: {
    fontSize: 13, color: "#718096", textAlign: "center",
    margin: "0 0 4px", padding: "10px 14px", background: "#EDF2F7", borderRadius: 8,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: 700, color: "#717782",
    textTransform: "uppercase", letterSpacing: "0.08em", margin: "8px 0 6px",
  },
  columnHeaders: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr",
    padding: "8px 16px", borderBottom: "1px solid #E2E8F0",
    color: "#717782", fontSize: "0.75rem", fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.05em",
  },
  desktopRow: {
    display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr",
    padding: "12px 16px", background: "#fff", borderRadius: 8,
    cursor: "pointer", alignItems: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.04)", transition: "background 0.15s",
    borderLeft: "3px solid transparent",
  },
  desktopCell: { fontSize: 13, color: "#1A2B4A" },
  card: {
    background: "#fff", borderRadius: 16, display: "flex",
    overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", cursor: "pointer",
  },
  thumbnail: { width: 88, height: 88, objectFit: "cover", flexShrink: 0 },
  thumbnailPlaceholder: {
    width: 88, minHeight: 88, background: "#f0f2f5",
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  cardBody: {
    flex: 1, padding: "12px 14px", display: "flex",
    flexDirection: "column", gap: 4, justifyContent: "center",
  },
  damageBadge: {
    alignSelf: "flex-start", display: "inline-block",
    padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
  },
  flagBadge: {
    alignSelf: "flex-start", display: "inline-block",
    padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 600,
  },
  actionBtn: { padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none" },
  cardDate:     { fontSize: 12, color: "#888", margin: "2px 0 0" },
  cardLocation: { fontSize: 13, color: "#1A2B4A", margin: "2px 0 0" },
  cardMeta:     { fontSize: 12, color: "#717782", margin: "2px 0 0" },
  loadMoreBtn: {
    marginTop: 4, background: "#fff", border: "1.5px solid #0468B1",
    borderRadius: 8, padding: "13px", fontSize: 15, fontWeight: 600,
    color: "#0468B1", width: "100%",
  },

  // ── Detail panel ─────────────────────────────────────────────────────────
  detailPanel: {
    position: "fixed", top: 56, right: 0,
    width: 440, height: "calc(100dvh - 64px)",
    background: "#fff", borderLeft: "1px solid #E2E8F0",
    overflowY: "auto", padding: "24px 20px 40px",
    zIndex: 20, boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
  },
  detailClose: {
    position: "absolute", top: 16, right: 16,
    background: "none", border: "none", fontSize: 20,
    cursor: "pointer", color: "#717782", lineHeight: 1,
  },
  detailTitle: { color: "#1A2B4A", margin: "0 0 16px", fontSize: 17, fontWeight: 700 },

  // Header row inside full detail
  serialNumber: { fontSize: 15, fontWeight: 700, color: "#1A2B4A" },
  detailTimestamp: { fontSize: 12, color: "#9CA3AF", margin: "0 0 16px" },

  // Photos
  photoStrip: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 },
  detailPhoto: {
    width: 80, height: 80, objectFit: "cover", borderRadius: 8,
    cursor: "pointer", flexShrink: 0, border: "1px solid #E2E8F0",
  },

  // Section blocks
  detailSection: { marginBottom: 20 },
  detailSectionTitle: {
    fontSize: 11, fontWeight: 700, color: "#717782",
    textTransform: "uppercase", letterSpacing: "0.08em",
    paddingBottom: 8, borderBottom: "1px solid #E2E8F0",
    marginBottom: 10,
  },
  detailTable: { display: "flex", flexDirection: "column", gap: 8 },
  detailRow: { display: "flex", gap: 8, alignItems: "flex-start" },
  detailRowLabel: { flexShrink: 0, width: 120, fontSize: 12, color: "#9CA3AF", paddingTop: 1 },
  detailRowValue: { flex: 1, fontSize: 13, color: "#1A2B4A", lineHeight: 1.5 },

  // Infrastructure type chips
  chipRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  chip: {
    background: "#EBF4FF", color: "#0468B1", borderRadius: 12,
    padding: "2px 8px", fontSize: 11, fontWeight: 600,
  },
  codeText: { fontFamily: "monospace", fontSize: 11, color: "#555" },
  descriptionText: { color: "#1A2B4A", fontSize: 13, lineHeight: 1.6, margin: 0 },

  // Legacy basic-detail styles (fallback / loading)
  detailFields: { fontSize: "0.9rem", color: "#1A2B4A", lineHeight: 1.6 },
  detailField: { margin: "0 0 10px" },
  backBtn: {
    display: "flex", alignItems: "center", gap: 8,
    background: "none", border: "none", color: "#0468B1",
    fontSize: "0.9rem", cursor: "pointer", padding: "16px 0", fontWeight: 600,
  },
};
