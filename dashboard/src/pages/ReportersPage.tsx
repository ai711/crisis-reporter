import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, X, Filter } from "lucide-react";
import Header from "../components/Header";
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
  // Use platform_label (human-readable) if available; fall back to raw platform value
  const base = row.platform_label || row.platform;
  if (!base) return "—";
  if (row.app_version) return `${base} — v${row.app_version}`;
  if (row.browser_version) return `${base} — ${row.browser_version}`;
  return base;
}

// ── Filter panel ──────────────────────────────────────────────────────────────

interface FilterState {
  profileTypes: string[];
  profileStatuses: string[];
  platforms: string[];
  country: string;
  dateFrom: string;
  dateTo: string;
  reportCountMin: string;
  reportCountMax: string;
}

const EMPTY_FILTERS: FilterState = {
  profileTypes: [],
  profileStatuses: [],
  platforms: [],
  country: "",
  dateFrom: "",
  dateTo: "",
  reportCountMin: "",
  reportCountMax: "",
};

function countActiveFilters(f: FilterState): number {
  return (
    f.profileTypes.length +
    f.profileStatuses.length +
    f.platforms.length +
    [f.country, f.dateFrom, f.dateTo, f.reportCountMin, f.reportCountMax].filter(Boolean).length
  );
}

const PROFILE_TYPE_OPTIONS = [
  { value: "anonymous_no_reports", label: "Anonymous — No Reports" },
  { value: "anonymous_with_reports", label: "Anonymous — With Reports" },
  { value: "named_profile", label: "Named Profile" },
];

const PROFILE_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "flagged", label: "Flagged" },
  { value: "blocked", label: "Blocked" },
];

const PLATFORM_OPTIONS = [
  { value: "Native App iOS", label: "Native App iOS" },
  { value: "Native App Android", label: "Native App Android" },
  { value: "PWA iOS", label: "PWA iOS" },
  { value: "PWA Android", label: "PWA Android" },
  { value: "Plain Web", label: "Plain Web" },
];

interface FilterPanelProps {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  onClear: () => void;
  onClose: () => void;
}

function FilterPanel({ filters, onChange, onClear, onClose }: FilterPanelProps) {
  function toggleArr(key: "profileTypes" | "profileStatuses" | "platforms", val: string) {
    const arr = filters[key];
    const next = arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
    onChange({ ...filters, [key]: next });
  }

  return (
    <div style={fp.backdrop} onClick={onClose}>
      <div style={fp.panel} onClick={(e) => e.stopPropagation()}>
        <div style={fp.header}>
          <span style={fp.title}>Filters</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button style={fp.clearBtn} onClick={onClear}>Clear all</button>
            <button style={fp.closeBtn} onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Profile Type</div>
          {PROFILE_TYPE_OPTIONS.map((opt) => (
            <label key={opt.value} style={fp.checkRow}>
              <input
                type="checkbox"
                checked={filters.profileTypes.includes(opt.value)}
                onChange={() => toggleArr("profileTypes", opt.value)}
                style={{ marginRight: 8 }}
              />
              {opt.label}
            </label>
          ))}
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Profile Status</div>
          {PROFILE_STATUS_OPTIONS.map((opt) => (
            <label key={opt.value} style={fp.checkRow}>
              <input
                type="checkbox"
                checked={filters.profileStatuses.includes(opt.value)}
                onChange={() => toggleArr("profileStatuses", opt.value)}
                style={{ marginRight: 8 }}
              />
              {opt.label}
            </label>
          ))}
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Platform</div>
          {PLATFORM_OPTIONS.map((opt) => (
            <label key={opt.value} style={fp.checkRow}>
              <input
                type="checkbox"
                checked={filters.platforms.includes(opt.value)}
                onChange={() => toggleArr("platforms", opt.value)}
                style={{ marginRight: 8 }}
              />
              {opt.label}
            </label>
          ))}
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Country</div>
          <input
            style={fp.textInput}
            placeholder="e.g. UA, SY…"
            value={filters.country}
            onChange={(e) => onChange({ ...filters, country: e.target.value })}
          />
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Date Range</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="date"
              style={{ ...fp.textInput, flex: 1 }}
              value={filters.dateFrom}
              onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
            />
            <span style={{ color: "var(--c-text-subtle)", fontSize: "var(--text-xs)" }}>–</span>
            <input
              type="date"
              style={{ ...fp.textInput, flex: 1 }}
              value={filters.dateTo}
              onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
            />
          </div>
        </div>

        <div style={fp.section}>
          <div style={fp.sectionTitle}>Report Count</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number"
              style={{ ...fp.textInput, flex: 1 }}
              placeholder="More than…"
              value={filters.reportCountMin}
              onChange={(e) => onChange({ ...filters, reportCountMin: e.target.value })}
              min={0}
            />
            <input
              type="number"
              style={{ ...fp.textInput, flex: 1 }}
              placeholder="Fewer than…"
              value={filters.reportCountMax}
              onChange={(e) => onChange({ ...filters, reportCountMax: e.target.value })}
              min={0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const fp: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 500,
  },
  panel: {
    position: "absolute",
    top: 54,
    right: 0,
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-float)",
    padding: "16px 20px 20px",
    width: 340,
    maxHeight: "80vh",
    overflowY: "auto",
    zIndex: 501,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  title: { fontSize: "var(--text-md)", fontWeight: 700, color: "var(--c-text-primary)" },
  clearBtn: {
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  },
  closeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--c-text-muted)",
    padding: 2,
    display: "flex",
    alignItems: "center",
  },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: "var(--text-xs)",
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-secondary)",
    marginBottom: 6,
    cursor: "pointer",
  },
  textInput: {
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    padding: "7px 10px",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  },
};

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
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 400);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const filterBtnRef = useRef<HTMLDivElement>(null);

  const [allItems, setAllItems] = useState<ReporterListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const PAGE_SIZE = 100;

  const queryParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (debouncedSearch) queryParams.search = debouncedSearch;
  if (filters.profileTypes.length > 0) queryParams.profile_type = filters.profileTypes.join(",");
  if (filters.profileStatuses.length > 0) queryParams.profile_status = filters.profileStatuses.join(",");
  if (filters.platforms.length > 0) queryParams.platform = filters.platforms.join(",");
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

  function openProfile(reporterId: string) {
    window.open("/reporters/" + reporterId, "_blank");
  }

  return (
    <div style={s.container}>
      <Header
        title="Reporter Profiles"
        subtitle={`${total} total reporters`}
      />

      <div style={s.content}>
        {/* Search bar */}
        <div style={s.searchRow}>
          <div style={s.searchWrap}>
            <input
              style={s.searchInput}
              placeholder="Search by Reporter ID, device ID, name, email, or IP address"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button style={s.searchClear} onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filters button */}
          <div ref={filterBtnRef} style={{ position: "relative" }}>
            <button
              style={{
                ...s.filterBtn,
                background: showFilters || activeFilterCount > 0 ? "rgba(4,104,177,0.08)" : "var(--c-surface-lowest)",
                borderColor: showFilters || activeFilterCount > 0 ? "var(--c-primary-container)" : "var(--c-border)",
                color: showFilters || activeFilterCount > 0 ? "var(--c-primary-container)" : "var(--c-text-secondary)",
              }}
              onClick={() => setShowFilters((v) => !v)}
            >
              <Filter size={14} style={{ marginRight: 6 }} />
              Filters
              {activeFilterCount > 0 && (
                <span style={s.filterBadge}>{activeFilterCount} active</span>
              )}
            </button>
            {showFilters && (
              <FilterPanel
                filters={filters}
                onChange={setFilters}
                onClear={() => setFilters(EMPTY_FILTERS)}
                onClose={() => setShowFilters(false)}
              />
            )}
          </div>
        </div>

        {/* Table */}
        <div className="card" style={{ overflow: "hidden" }}>
          {isLoading ? (
            <div style={s.loading}>Loading reporter profiles…</div>
          ) : allItems.length === 0 ? (
            <div style={s.emptyState}>
              <Users size={48} color="var(--c-text-subtle)" />
              <p style={s.emptyText}>No reporter profiles found.</p>
            </div>
          ) : (
            <>
              <div style={s.countRow}>
                Showing {allItems.length} of {total} reporters
              </div>
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
                            title={row.reporter_id}
                          >
                            {row.reporter_id.slice(0, 8)}…
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

  searchRow: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    padding: "12px 20px",
    boxShadow: "var(--shadow-sm)",
    marginBottom: 24,
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap" as const,
  },
  searchWrap: {
    flex: 1,
    position: "relative",
    display: "flex",
    alignItems: "center",
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
  filterBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "8px 14px",
    border: "1.5px solid",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  filterBadge: {
    marginLeft: 8,
    background: "var(--c-primary-container)",
    color: "#fff",
    fontSize: "var(--text-xs)",
    fontWeight: 700,
    borderRadius: 10,
    padding: "2px 7px",
  },

  loading: { padding: 40, textAlign: "center" as const, color: "var(--c-text-muted)", fontSize: "var(--text-sm)" },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center" as const,
    padding: "64px 0",
    gap: 16,
  },
  emptyText: { fontSize: "var(--text-sm)", color: "var(--c-text-subtle)", fontStyle: "italic" },
  countRow: {
    padding: "10px 16px",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    borderBottom: "1px solid var(--c-border-ghost)",
  },

  table: { width: "100%", borderCollapse: "collapse" as const },
  thead: { background: "var(--c-surface-low)" },
  th: {
    padding: "11px 14px",
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
  td: { padding: "12px 14px", fontSize: "var(--text-sm)", color: "var(--c-text-primary)", verticalAlign: "middle" as const },
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
