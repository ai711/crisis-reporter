import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

interface ReporterReport {
  id: string;
  damage_level: "minimal" | "partial" | "complete";
  submitted_at: string;
  location: {
    location_address: string | null;
    gps_latitude: number | null;
    gps_longitude: number | null;
  } | null;
  photo_count: number;
  first_photo_url: string | null;
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

function formatLocation(report: ReporterReport): string {
  if (report.location?.location_address) return report.location.location_address;
  if (report.location?.gps_latitude != null && report.location?.gps_longitude != null) {
    return `${report.location.gps_latitude.toFixed(4)}, ${report.location.gps_longitude.toFixed(4)}`;
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

const PAGE_SIZE = 20;

export default function MyReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reporterId } = useAuthStore();

  const [reports, setReports] = useState<ReporterReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const fetchReports = useCallback(async (cursor?: string) => {
    if (!reporterId) {
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
        reporter_id: reporterId,
        limit: String(PAGE_SIZE),
      };
      if (cursor) params.cursor = cursor;

      const res = await api.get<ReportsResponse>("/api/reports", { params });
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

  return (
    <div style={styles.container}>
      <style>{`@keyframes cr-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("home.myReports")}</h1>
      </div>

      <div style={styles.content}>
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
            <p style={styles.emptyText}>No reports submitted yet</p>
          </div>
        ) : (
          <div style={styles.list}>
            {reports.map((report) => {
              const color = DAMAGE_COLOR[report.damage_level] ?? "#999";
              return (
                <div key={report.id} style={styles.card}>
                  {report.first_photo_url ? (
                    <img
                      src={report.first_photo_url}
                      alt="Report photo"
                      style={styles.thumbnail}
                    />
                  ) : (
                    <div style={styles.thumbnailPlaceholder}>
                      <span style={{ fontSize: 28 }}>📷</span>
                    </div>
                  )}
                  <div style={styles.cardBody}>
                    <span style={{
                      ...styles.damageBadge,
                      background: color + "22",
                      color,
                    }}>
                      {DAMAGE_LABEL[report.damage_level] ?? report.damage_level}
                    </span>
                    <p style={styles.cardDate}>{formatDate(report.submitted_at)}</p>
                    <p style={styles.cardLocation}>📍 {formatLocation(report)}</p>
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
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
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
  card: {
    background: "#fff",
    borderRadius: 12,
    display: "flex",
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
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
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
  },
  cardDate: { fontSize: 13, color: "#888", margin: 0 },
  cardLocation: { fontSize: 13, color: "#1A2B4A", margin: 0 },
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
};
