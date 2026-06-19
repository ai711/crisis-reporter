import { useState, useEffect, useCallback, useRef } from "react";
import { CheckCircle } from "lucide-react";
import Header from "../components/Header";
import PageSpinner from "../components/PageSpinner";
import EmptyState from "../components/EmptyState";
import { usePageTitle } from "../hooks/usePageTitle";
import { useSSE } from "../hooks/useSSE";
import api from "../services/api";
import type { SSEEvent } from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

const DAMAGE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  complete: { bg: "#FFF5F5", color: "var(--c-flag-red)",    label: "Completely Damaged" },
  partial:  { bg: "#FFF8F0", color: "var(--c-flag-orange)", label: "Partially Damaged" },
  minimal:  { bg: "#F0FFF4", color: "var(--c-flag-green)",  label: "Minimal / No Damage" },
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function ReportQueuePage() {
  usePageTitle("Report Queue");
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
        flag_status: "grey",
        limit: String(PAGE_SIZE),
      };
      if (pageCursor) params.cursor = pageCursor;

      const res = await api.get<QueueResponse>("/api/dashboard/reports", { params });
      return res.data;
    },
    []
  );

  // Initial load
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // SSE — prepend new grey reports as they arrive
  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.type === "report_confirmed") {
        // Refetch first page to capture the new report
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

  useSSE({ crisisId: null, onEvent: handleSSE });

  // Actions
  async function act(reportId: string, flag: string) {
    setActioningIds((prev) => new Set([...prev, reportId]));
    // Optimistic: remove the row immediately
    setItems((prev) => prev.filter((r) => r.id !== reportId));
    setTotal((t) => Math.max(0, t - 1));
    try {
      await api.patch(`/api/reports/${reportId}/flag`, { flag });
    } catch {
      // On error: restore would be complex — just leave it removed and let SSE/next load reconcile
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
      <Header
        title="Report Queue"
        subtitle={loading ? "Loading…" : `${total} pending report${total !== 1 ? "s" : ""}`}
      />

      <div style={s.content}>
        {/* Count badge + note */}
        <div style={s.topRow}>
          <div style={s.countBadge}>
            <span style={s.countDot} />
            {total} pending
          </div>
          <p style={s.note}>
            These reports have been received and are awaiting initial review.
          </p>
        </div>

        {/* Table */}
        {loading ? (
          <PageSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<CheckCircle size={28} color="var(--c-flag-green)" />}
            title="No reports pending review"
            message="Grey reports awaiting initial processing will appear here."
          />
        ) : (
          <>
            <div className="card" style={{ overflow: "hidden" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Photo</th>
                    <th>Location</th>
                    <th>Infrastructure</th>
                    <th>Damage Level</th>
                    <th>Submitted</th>
                    <th>Reporter</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((report) => {
                    const dmg = DAMAGE_STYLE[report.damage_level] ?? {
                      bg: "var(--c-surface-low)",
                      color: "var(--c-text-secondary)",
                      label: report.damage_level,
                    };
                    const busy = actioningIds.has(report.id);
                    return (
                      <tr key={report.id}>
                        {/* Thumbnail */}
                        <td>
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
                        <td style={{ maxWidth: 200 }}>
                          <span style={s.locationText}>{locationLabel(report)}</span>
                        </td>
                        {/* Infrastructure */}
                        <td>
                          <span style={s.infraText}>{report.infrastructure_type || "—"}</span>
                        </td>
                        {/* Damage */}
                        <td>
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
                        <td>
                          <span style={s.timeText}>{timeAgo(report.submitted_at)}</span>
                        </td>
                        {/* Reporter */}
                        <td>
                          <span style={s.reporterText}>
                            {report.reporter_id
                              ? report.reporter_id.slice(0, 8) + "…"
                              : "Anonymous"}
                          </span>
                        </td>
                        {/* Actions */}
                        <td>
                          <div style={s.actionRow}>
                            <button
                              className="btn btn-success"
                              style={{
                                opacity: busy ? 0.5 : 1,
                                cursor: busy ? "not-allowed" : "pointer",
                              }}
                              disabled={busy}
                              onClick={() => act(report.id, "green")}
                            >
                              Approve
                            </button>
                            <button
                              className="btn btn-danger"
                              style={{
                                opacity: busy ? 0.5 : 1,
                                cursor: busy ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                              disabled={busy}
                              onClick={() => act(report.id, "red")}
                            >
                              Flag for Review
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
                  className="btn btn-secondary"
                  style={{
                    padding: "10px 28px",
                    height: "auto",
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
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--c-surface-low)",
  },
  content: {
    flex: 1,
    padding: "24px 32px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  topRow: { display: "flex", alignItems: "center", gap: 16 },
  countBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "rgba(4,104,177,0.08)",
    color: "var(--c-primary-container)",
    border: "1px solid rgba(4,104,177,0.2)",
    borderRadius: 20,
    padding: "5px 14px",
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
  },
  countDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "var(--c-primary-container)",
    animation: "cr-spin 2s linear infinite",
    display: "inline-block",
  },
  note: {
    fontSize: 13,
    color: "var(--c-text-muted)",
    margin: 0,
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    padding: "8px 14px",
    flex: 1,
  },
  thumb: { width: 60, height: 60, objectFit: "cover", borderRadius: 6, display: "block" },
  thumbPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 6,
    background: "var(--c-surface-low)",
    border: "1px solid var(--c-border)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  photoCount: { fontSize: 10, color: "var(--c-text-subtle)", fontWeight: 600 },
  locationText: {
    fontSize: 12,
    color: "var(--c-text-secondary)",
    display: "block",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  infraText: { fontSize: "var(--text-sm)" as string, color: "var(--c-text-primary)" },
  damageBadge: {
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  timeText: { fontSize: 12, color: "var(--c-text-muted)" },
  reporterText: { fontSize: 12, color: "var(--c-text-muted)", fontFamily: "monospace" },
  actionRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  loadMoreRow: { display: "flex", justifyContent: "center", paddingTop: 8 },
};
