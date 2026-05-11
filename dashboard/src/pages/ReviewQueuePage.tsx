import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import { useSSE } from "../hooks/useSSE";
import api from "../services/api";
import type { SSEEvent } from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const PAGE_SIZE = 20;

const DAMAGE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  complete: { bg: "#FFF5F5", color: "#C53030", label: "Completely Damaged" },
  partial:  { bg: "#FFF8F0", color: "#C05621", label: "Partially Damaged" },
  minimal:  { bg: "#F0FFF4", color: "#276749", label: "Minimal / No Damage" },
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface QueueReport {
  id: string;
  damage_level: string;
  infrastructure_type: string;
  flag_status: string;
  submitted_at: string;
  reporter_id: string | null;
  photo_count: number;
  first_photo_url?: string | null;
  gps_latitude?: number | null;
  gps_longitude?: number | null;
  location_address?: string | null;
}

interface QueueResponse {
  items: QueueReport[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

function locationLabel(r: QueueReport): string {
  if (r.location_address) return r.location_address;
  if (r.gps_latitude != null && r.gps_longitude != null)
    return `${r.gps_latitude.toFixed(4)}, ${r.gps_longitude.toFixed(4)}`;
  return "No location recorded";
}

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: "3px solid #e2e8f0",
        borderTop: `3px solid ${BLUE}`,
        borderRadius: "50%",
        animation: "rv-spin 0.8s linear infinite",
      }}
    />
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ReviewQueuePage() {
  const navigate = useNavigate();
  const { activeCrisisId } = useAuthStore();

  const [items, setItems] = useState<QueueReport[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actioningIds, setActioningIds] = useState<Set<string>>(new Set());

  const initialFetchDone = useRef(false);

  const fetchPage = useCallback(
    async (pageCursor?: string) => {
      const params: Record<string, string> = {
        flag_status: "red",
        limit: String(PAGE_SIZE),
      };
      if (activeCrisisId) params.crisis_id = activeCrisisId;
      if (pageCursor) params.cursor = pageCursor;

      const res = await api.get<QueueResponse>("/api/dashboard/reports", { params });
      return res.data;
    },
    [activeCrisisId]
  );

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage()
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setTotal(data.total);
        setCursor(data.cursor);
        setHasMore(data.has_more);
        initialFetchDone.current = true;
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [fetchPage]);

  // Load more
  async function handleLoadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(cursor);
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      setHasMore(data.has_more);
    } catch {
      //
    } finally {
      setLoadingMore(false);
    }
  }

  // SSE — re-fetch first page on review_queue_updated events
  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.type === "review_queue_updated" || event.type === "flag_changed") {
        fetchPage().then((data) => {
          setItems((prev) => {
            const existingIds = new Set(prev.map((r) => r.id));
            const newItems = data.items.filter((r) => !existingIds.has(r.id));
            return [...newItems, ...prev];
          });
          setTotal(data.total);
        }).catch(() => {});
      }
    },
    [fetchPage]
  );

  useSSE({ crisisId: activeCrisisId, onEvent: handleSSE });

  // Actions
  async function act(reportId: string, flag: string) {
    setActioningIds((prev) => new Set([...prev, reportId]));
    setItems((prev) => prev.filter((r) => r.id !== reportId));
    setTotal((t) => Math.max(0, t - 1));
    try {
      await api.patch(`/api/dashboard/reports/${reportId}/flag`, { flag_status: flag });
    } catch {
      //
    } finally {
      setActioningIds((prev) => {
        const next = new Set(prev);
        next.delete(reportId);
        return next;
      });
    }
  }

  return (
    <div style={s.page}>
      <style>{`@keyframes rv-spin { to { transform: rotate(360deg); } }`}</style>

      <Header
        title="Review Queue"
        subtitle={loading ? "Loading…" : `${total} report${total !== 1 ? "s" : ""} requiring review`}
      />

      <div style={s.content}>
        {/* Count badge + note */}
        <div style={s.topRow}>
          <div style={s.countBadge}>
            <span style={s.countDot} />
            {total} flagged
          </div>
          <p style={s.note}>
            These reports have been flagged and require human review before approval.
          </p>
        </div>

        {/* Table */}
        {loading ? (
          <div style={s.centred}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>✅</div>
            <p style={s.emptyText}>No reports pending review</p>
          </div>
        ) : (
          <>
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Photo</th>
                    <th style={s.th}>Location</th>
                    <th style={s.th}>Infrastructure</th>
                    <th style={s.th}>Damage Level</th>
                    <th style={s.th}>Submitted</th>
                    <th style={s.th}>Reporter</th>
                    <th style={s.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((report) => {
                    const dmg = DAMAGE_STYLE[report.damage_level] ?? {
                      bg: "#f7fafc",
                      color: "#4a5568",
                      label: report.damage_level,
                    };
                    const busy = actioningIds.has(report.id);
                    return (
                      <tr key={report.id} style={s.tr}>
                        {/* Thumbnail */}
                        <td style={s.td}>
                          {report.first_photo_url ? (
                            <img
                              src={report.first_photo_url}
                              alt=""
                              style={s.thumb}
                            />
                          ) : (
                            <div style={s.thumbPlaceholder}>
                              <span style={{ fontSize: 22 }}>📷</span>
                              {report.photo_count > 0 && (
                                <span style={s.photoCount}>{report.photo_count}</span>
                              )}
                            </div>
                          )}
                        </td>
                        {/* Location */}
                        <td style={{ ...s.td, maxWidth: 190 }}>
                          <span style={s.locationText}>{locationLabel(report)}</span>
                        </td>
                        {/* Infrastructure */}
                        <td style={s.td}>
                          <span style={s.infraText}>{report.infrastructure_type || "—"}</span>
                        </td>
                        {/* Damage */}
                        <td style={s.td}>
                          <span
                            style={{
                              ...s.damageBadge,
                              background: dmg.bg,
                              color: dmg.color,
                            }}
                          >
                            {dmg.label}
                          </span>
                        </td>
                        {/* Submitted */}
                        <td style={s.td}>
                          <span style={s.timeText}>{timeAgo(report.submitted_at)}</span>
                        </td>
                        {/* Reporter */}
                        <td style={s.td}>
                          <span style={s.reporterText}>
                            {report.reporter_id
                              ? report.reporter_id.slice(0, 8) + "…"
                              : "Anonymous"}
                          </span>
                        </td>
                        {/* Actions */}
                        <td style={s.td}>
                          <div style={s.actionRow}>
                            <button
                              style={{
                                ...s.approveBtn,
                                opacity: busy ? 0.5 : 1,
                                cursor: busy ? "not-allowed" : "pointer",
                              }}
                              disabled={busy}
                              onClick={() => act(report.id, "green")}
                            >
                              Approve
                            </button>
                            <button
                              style={{
                                ...s.discardBtn,
                                opacity: busy ? 0.5 : 1,
                                cursor: busy ? "not-allowed" : "pointer",
                              }}
                              disabled={busy}
                              onClick={() => act(report.id, "discarded")}
                            >
                              Discard
                            </button>
                            <button
                              style={s.viewBtn}
                              onClick={() => navigate(`/reports/${report.id}`)}
                            >
                              View Report →
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div style={s.loadMoreRow}>
                <button
                  style={{
                    ...s.loadMoreBtn,
                    opacity: loadingMore ? 0.6 : 1,
                    cursor: loadingMore ? "default" : "pointer",
                  }}
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load More"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: { display: "flex", flexDirection: "column", height: "100vh", background: "#f4f6f9" },
  content: { flex: 1, padding: "20px 28px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 },
  topRow: { display: "flex", alignItems: "center", gap: 16 },
  countBadge: {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "#FFF5F5", color: "#C53030", border: "1px solid #FC8181",
    borderRadius: 20, padding: "5px 14px", fontSize: 13, fontWeight: 700, flexShrink: 0,
  },
  countDot: {
    width: 8, height: 8, borderRadius: "50%", background: "#E53E3E", display: "inline-block",
  },
  note: {
    fontSize: 13, color: "#718096", margin: 0,
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
    padding: "8px 14px", flex: 1,
  },
  centred: { display: "flex", justifyContent: "center", paddingTop: 80 },
  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 80, gap: 12 },
  emptyIcon: { fontSize: 56 },
  emptyText: { fontSize: 16, color: "#718096", margin: 0 },
  tableWrap: { background: "#fff", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "11px 14px", textAlign: "left", fontSize: 11, fontWeight: 700,
    color: "#718096", textTransform: "uppercase", letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "12px 14px", fontSize: 13, color: "#2d3748", verticalAlign: "middle" },
  thumb: { width: 60, height: 60, objectFit: "cover", borderRadius: 6, display: "block" },
  thumbPlaceholder: {
    width: 60, height: 60, borderRadius: 6, background: "#f7fafc",
    border: "1px solid #e2e8f0", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 2,
  },
  photoCount: { fontSize: 10, color: "#a0aec0", fontWeight: 600 },
  locationText: { fontSize: 12, color: "#4a5568", display: "block", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  infraText: { fontSize: 13, color: "#2d3748" },
  damageBadge: { padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  timeText: { fontSize: 12, color: "#718096" },
  reporterText: { fontSize: 12, color: "#718096", fontFamily: "monospace" },
  actionRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  approveBtn: {
    padding: "6px 12px", fontSize: 12, fontWeight: 700, border: "none",
    borderRadius: 6, background: "#38A169", color: "#fff",
  },
  discardBtn: {
    padding: "6px 12px", fontSize: 12, fontWeight: 700, border: "none",
    borderRadius: 6, background: "#E53E3E", color: "#fff",
  },
  viewBtn: {
    padding: "6px 12px", fontSize: 12, fontWeight: 600,
    background: "#EBF5FB", color: BLUE, border: `1px solid #bee3f8`,
    borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" as const,
  },
  loadMoreRow: { display: "flex", justifyContent: "center", paddingTop: 8 },
  loadMoreBtn: {
    padding: "10px 28px", background: "#fff", border: `1.5px solid ${BLUE}`,
    color: BLUE, borderRadius: 8, fontSize: 14, fontWeight: 600,
  },
};
