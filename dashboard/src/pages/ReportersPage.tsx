import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, X } from "lucide-react";
import Header from "../components/Header";
import { usePageTitle } from "../hooks/usePageTitle";
import PageSpinner from "../components/PageSpinner";
import EmptyState from "../components/EmptyState";
import { getReporters } from "../services/api";
import type { ReporterListRow, ReportersListResponse } from "../types";
import {
  formatDateTime,
  formatProfileType,
  formatProfileStatus,
} from "../utils/formatters";

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Platform label ────────────────────────────────────────────────────────────

function platformCell(row: ReporterListRow): string {
  const base = row.platform_label || row.platform;
  if (!base) return "—";
  if (row.app_version) return `${base} — v${row.app_version}`;
  if (row.browser_version) return `${base} — ${row.browser_version}`;
  return base;
}

// ── Filter state ──────────────────────────────────────────────────────────────

interface FilterState {
  profileType: string;
  profileStatus: string;
  platform: string;
  country: string;
  dateFrom: string;
  dateTo: string;
  reportCountMin: string;
  reportCountMax: string;
}

const EMPTY_FILTERS: FilterState = {
  profileType: "",
  profileStatus: "",
  platform: "",
  country: "",
  dateFrom: "",
  dateTo: "",
  reportCountMin: "",
  reportCountMax: "",
};

function countActiveFilters(f: FilterState): number {
  return [
    f.profileType, f.profileStatus, f.platform, f.country,
    f.dateFrom, f.dateTo, f.reportCountMin, f.reportCountMax,
  ].filter(Boolean).length;
}

// ── StatusPill ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "active" ? "chip chip-green" :
    status === "flagged" ? "chip chip-amber" :
    status === "blocked" ? "chip chip-red" :
    "chip chip-grey";
  return <span className={cls}>{formatProfileStatus(status)}</span>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportersPage() {
  usePageTitle("Reporters");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 400);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const [allItems, setAllItems] = useState<ReporterListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const PAGE_SIZE = 100;

  const queryParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (debouncedSearch) queryParams.search = debouncedSearch;
  if (filters.profileType) queryParams.profile_type = filters.profileType;
  if (filters.profileStatus) queryParams.profile_status = filters.profileStatus;
  if (filters.platform) queryParams.platform = filters.platform;
  if (filters.country) queryParams.country = filters.country;
  if (filters.dateFrom) queryParams.date_from = filters.dateFrom;
  if (filters.dateTo) queryParams.date_to = filters.dateTo;
  if (filters.reportCountMin) queryParams.report_count_min = Number(filters.reportCountMin);
  if (filters.reportCountMax) queryParams.report_count_max = Number(filters.reportCountMax);

  const { data, isLoading } = useQuery({
    queryKey: ["reporters", queryParams],
    queryFn: async () => {
      const res = await getReporters(queryParams);
      return res.data as ReportersListResponse;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getReporters({ ...queryParams, cursor: nextCursor });
      const d = res.data as ReportersListResponse;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore]);

  const activeFilterCount = countActiveFilters(filters);

  function clearAll() {
    setSearch("");
    setFilters(EMPTY_FILTERS);
  }

  function openProfile(reporterId: string) {
    window.open("/reporters/" + reporterId, "_blank");
  }

  const hasAnyClear = search.length > 0 || activeFilterCount > 0;

  return (
    <div style={s.container}>
      <Header
        title="Reporter Profiles"
        subtitle={`${total} total reporters`}
      />

      <div style={s.content}>
        {/* Toolbar row: search + clear all */}
        <div style={s.toolbar}>
          <div style={s.searchWrap}>
            <input
              style={s.searchInput}
              placeholder="Search by Reporter ID, device ID, name, email, or IP"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button style={s.searchClear} onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            )}
          </div>

          {hasAnyClear && (
            <button style={s.clearAllBtn} onClick={clearAll}>
              Clear All{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
            </button>
          )}
        </div>

        {/* Inline filter bar */}
        <div style={s.filterBar}>
          <select
            style={s.inlineSelect}
            value={filters.profileStatus}
            onChange={(e) => setFilters({ ...filters, profileStatus: e.target.value })}
          >
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="flagged">Flagged</option>
            <option value="blocked">Blocked</option>
          </select>

          <div style={s.filterDivider} />

          <select
            style={s.inlineSelect}
            value={filters.profileType}
            onChange={(e) => setFilters({ ...filters, profileType: e.target.value })}
          >
            <option value="">All Types</option>
            <option value="anonymous_no_reports">Anon — No Reports</option>
            <option value="anonymous_with_reports">Anon — With Reports</option>
            <option value="named_profile">Named Profile</option>
          </select>

          <div style={s.filterDivider} />

          <select
            style={s.inlineSelect}
            value={filters.platform}
            onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
          >
            <option value="">All Platforms</option>
            <option value="Native App iOS">iOS App</option>
            <option value="Native App Android">Android App</option>
            <option value="PWA iOS">PWA iOS</option>
            <option value="PWA Android">PWA Android</option>
            <option value="Plain Web">Plain Web</option>
          </select>

          <div style={s.filterDivider} />

          <input
            style={s.inlineTextInput}
            placeholder="Country"
            value={filters.country}
            onChange={(e) => setFilters({ ...filters, country: e.target.value })}
          />

          <div style={s.filterDivider} />

          <input
            type="date"
            style={s.inlineDateInput}
            title="From date"
            value={filters.dateFrom}
            onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
          />
          <span style={{ color: "var(--c-text-subtle)", fontSize: "var(--text-xs)" }}>–</span>
          <input
            type="date"
            style={s.inlineDateInput}
            title="To date"
            value={filters.dateTo}
            onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
          />

          <div style={s.filterDivider} />

          <input
            type="number"
            style={s.inlineNumberInput}
            placeholder="Min reports"
            value={filters.reportCountMin}
            onChange={(e) => setFilters({ ...filters, reportCountMin: e.target.value })}
            min={0}
          />
          <input
            type="number"
            style={s.inlineNumberInput}
            placeholder="Max reports"
            value={filters.reportCountMax}
            onChange={(e) => setFilters({ ...filters, reportCountMax: e.target.value })}
            min={0}
          />
        </div>

        {/* Table */}
        <div className="card" style={{ overflow: "hidden" }}>
          {isLoading ? (
            <PageSpinner />
          ) : allItems.length === 0 ? (
            <EmptyState
              icon={<Users size={28} color="var(--c-text-subtle)" />}
              title="No reporter profiles found"
              message="Reporter profiles appear here once submissions are received."
            />
          ) : (
            <>
              <div style={s.countRow}>
                Showing {allItems.length} of {total} reporters
              </div>
              <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Reporter ID</th>
                    <th style={s.th}>Profile Type</th>
                    <th style={s.th}>Created</th>
                    <th style={s.th}>Country</th>
                    <th style={s.th}>IP Address</th>
                    <th style={s.th}>Platform</th>
                    <th style={{ ...s.th, textAlign: "center" as const }}>Reports</th>
                    <th style={s.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {allItems.map((row) => {
                    const isHovered = hoveredRow === row.reporter_id;
                    return (
                      <tr
                        key={row.reporter_id}
                        style={{
                          ...s.tr,
                          background: isHovered
                            ? "rgba(4,104,177,0.04)"
                            : "var(--c-surface-lowest)",
                        }}
                        onMouseEnter={() => setHoveredRow(row.reporter_id)}
                        onMouseLeave={() => setHoveredRow(null)}
                        onClick={() => openProfile(row.reporter_id)}
                      >
                        <td style={s.td}>
                          <button
                            style={s.linkBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              openProfile(row.reporter_id);
                            }}
                            title={row.uuid || String(row.reporter_id)}
                          >
                            #{row.reporter_id}
                          </button>
                        </td>
                        <td style={s.td}>{formatProfileType(row.profile_type)}</td>
                        <td style={s.td}>{formatDateTime(row.created_at)}</td>
                        <td style={s.td}>{row.country || "—"}</td>
                        <td style={{ ...s.td, fontFamily: "monospace", fontSize: 12 }}>
                          {row.ip_address || "—"}
                        </td>
                        <td style={s.td}>{platformCell(row)}</td>
                        <td style={{ ...s.td, textAlign: "center" as const, fontVariantNumeric: "tabular-nums" }}>
                          {row.total_reports > 0 ? (
                            <span style={{
                              display: "inline-block",
                              background: row.total_reports > 10
                                ? "rgba(4,104,177,0.10)"
                                : "var(--c-surface-low)",
                              color: row.total_reports > 10
                                ? "var(--c-primary-container)"
                                : "var(--c-text-secondary)",
                              borderRadius: "var(--radius-pill)",
                              padding: "2px 10px",
                              fontSize: "var(--text-xs)",
                              fontWeight: 700,
                              minWidth: 28,
                            }}>
                              {row.total_reports}
                            </span>
                          ) : (
                            <span style={{ color: "var(--c-text-subtle)", fontSize: "var(--text-xs)" }}>0</span>
                          )}
                        </td>
                        <td style={s.td}>
                          <StatusPill status={row.profile_status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>

              {/* Pagination bar */}
              <div style={s.paginationRow}>
                <span style={s.paginationInfo}>
                  Showing <strong>{allItems.length.toLocaleString()}</strong> of <strong>{total.toLocaleString()}</strong> reporters
                </span>
                {hasMore && (
                  <button
                    style={{
                      ...s.loadMoreBtn,
                      opacity: loadingMore ? 0.6 : 1,
                      cursor: loadingMore ? "default" : "pointer",
                    }}
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading…" : `Load next page — ${(total - allItems.length).toLocaleString()} remaining`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", overflow: "auto" },

  toolbar: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 8,
  },
  searchWrap: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    minWidth: 200,
    maxWidth: 380,
    flex: "0 1 380px",
  },
  searchInput: {
    width: "100%",
    padding: "9px 36px 9px 14px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
    boxSizing: "border-box" as const,
  },
  searchClear: {
    position: "absolute",
    right: 10,
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--c-text-muted)",
    display: "flex",
    alignItems: "center",
    padding: 2,
  },
  clearAllBtn: {
    padding: "8px 14px",
    background: "none",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--c-text-secondary)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },

  filterBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    alignItems: "center",
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-lg)",
    padding: "10px 14px",
    marginBottom: 16,
  },
  filterDivider: {
    width: 1,
    height: 20,
    background: "var(--c-border-ghost)",
    flexShrink: 0,
  },
  inlineSelect: {
    border: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-sm)",
    padding: "5px 8px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-secondary)",
    background: "var(--c-surface-low)",
    cursor: "pointer",
    outline: "none",
  },
  inlineTextInput: {
    border: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-sm)",
    padding: "5px 8px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-secondary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 90,
  },
  inlineDateInput: {
    border: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-sm)",
    padding: "5px 8px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-secondary)",
    background: "var(--c-surface-low)",
    outline: "none",
  },
  inlineNumberInput: {
    border: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-sm)",
    padding: "5px 8px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-secondary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 100,
  },

  countRow: {
    padding: "10px 16px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    borderBottom: "1px solid var(--c-border-ghost)",
  },

  table: { width: "100%", borderCollapse: "collapse" as const },
  thead: { background: "var(--c-surface-low)" },
  th: {
    padding: "10px 14px",
    textAlign: "left" as const,
    fontSize: "var(--text-xs)",
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    borderBottom: "1px solid var(--c-border-ghost)",
    whiteSpace: "nowrap" as const,
  },
  tr: {
    borderBottom: "1px solid var(--c-border-ghost)",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  td: { padding: "9px 14px", fontSize: "var(--text-sm)", color: "var(--c-text-primary)", verticalAlign: "middle" as const },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
    fontFamily: "monospace",
  },

  paginationRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderTop: "1px solid var(--c-border-ghost)",
  },
  paginationInfo: { fontSize: "var(--text-xs)", color: "var(--c-text-muted)" },
  loadMoreBtn: {
    padding: "8px 20px",
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-primary-container)",
    borderRadius: "var(--radius-md)",
    color: "var(--c-primary-container)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
  },
};
