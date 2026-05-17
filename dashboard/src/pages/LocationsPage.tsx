import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Header from "../components/Header";
import { getProperties } from "../services/api";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";
import type { Property, PropertiesListResponse } from "../types";

// ── Damage colours ────────────────────────────────────────────────────────────

const DAMAGE_COLORS: Record<string, string> = {
  completely_destroyed: "#f44336",
  partially_damaged: "#ff9800",
  minimal_or_no_damage: "#4caf50",
};

// ── Inline SVG icons ──────────────────────────────────────────────────────────

function AlertTriangleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ marginRight: 4, flexShrink: 0 }} aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type SortField =
  | "property_id" | "display_name" | "address" | "country"
  | "current_damage_level" | "confirmed_status" | "has_conflict_warning"
  | "total_reports" | "total_reporters" | "most_recent_report_at" | "property_status";

type SortDir = "asc" | "desc";

interface Filters {
  conflict_only: boolean;
  confirmed_status_filter: "all" | "confirmed" | "unconfirmed";
  property_status: { active: boolean; recovered: boolean };
  country: string;
  date_from: string;
  date_to: string;
}

const DEFAULT_FILTERS: Filters = {
  conflict_only: false,
  confirmed_status_filter: "all",
  property_status: { active: true, recovered: true },
  country: "",
  date_from: "",
  date_to: "",
};

const PAGE_SIZES = [100, 200, 300, 400, 500];

// ── Component ─────────────────────────────────────────────────────────────────

export default function LocationsPage() {
  const [search, setSearch] = useState("");
  const [showUnreviewed, setShowUnreviewed] = useState(false);
  const [sortBy, setSortBy] = useState<SortField>("most_recent_report_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(100);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [pendingFilters, setPendingFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const filterRef = useRef<HTMLDivElement>(null);

  // Close filter panel on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterOpen]);

  // Build query params
  const buildParams = (): Record<string, string | number | boolean> => {
    const p: Record<string, string | number | boolean> = {
      limit: pageSize,
      sort_by: sortBy,
      sort_dir: sortDir,
    };
    if (cursor) p.cursor = cursor;
    if (search.trim()) p.search = search.trim();
    if (showUnreviewed) p.show_unreviewed = true;
    if (filters.conflict_only) p.conflict_only = true;
    if (filters.confirmed_status_filter === "confirmed") p.confirmed_only = true;
    if (filters.confirmed_status_filter === "unconfirmed") p.unconfirmed_only = true;
    if (!filters.property_status.active && filters.property_status.recovered) p.status = "Recovered";
    if (filters.property_status.active && !filters.property_status.recovered) p.status = "Active";
    if (filters.country.trim()) p.country = filters.country.trim();
    if (filters.date_from) p.date_from = filters.date_from;
    if (filters.date_to) p.date_to = filters.date_to;
    return p;
  };

  const { data, isLoading, isError } = useQuery<PropertiesListResponse>({
    queryKey: ["properties", buildParams()],
    queryFn: async () => {
      const res = await getProperties(buildParams());
      return res.data;
    },
  });

  const items: Property[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const hasMore: boolean = data?.has_more ?? false;
  const nextCursor: string | null = data?.cursor ?? null;

  // Sort handler
  const handleSort = (field: SortField) => {
    if (field === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
    resetPagination();
  };

  const resetPagination = () => {
    setCursor(null);
    setCursorStack([null]);
    setPageIndex(0);
  };

  const handleNext = () => {
    if (!hasMore || !nextCursor) return;
    const newStack = [...cursorStack, nextCursor];
    setCursorStack(newStack);
    setCursor(nextCursor);
    setPageIndex((i) => i + 1);
  };

  const handlePrev = () => {
    if (pageIndex === 0) return;
    const newStack = cursorStack.slice(0, -1);
    setCursorStack(newStack);
    setCursor(newStack[newStack.length - 1] ?? null);
    setPageIndex((i) => i - 1);
  };

  // Filter active badge count
  const activeFilterCount =
    (filters.conflict_only ? 1 : 0) +
    (filters.confirmed_status_filter !== "all" ? 1 : 0) +
    (!filters.property_status.active || !filters.property_status.recovered ? 1 : 0) +
    (filters.country.trim() ? 1 : 0) +
    (filters.date_from || filters.date_to ? 1 : 0);

  const applyFilters = () => {
    setFilters({ ...pendingFilters });
    setFilterOpen(false);
    resetPagination();
  };

  const clearFilters = () => {
    setPendingFilters({ ...DEFAULT_FILTERS });
    setFilters({ ...DEFAULT_FILTERS });
    setFilterOpen(false);
    resetPagination();
  };

  // Sort indicator
  const sortIndicator = (field: SortField) => {
    if (sortBy !== field) return <span style={styles.sortNeutral}>↕</span>;
    return <span style={styles.sortActive}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const pageStart = pageIndex * pageSize + 1;
  const pageEnd = Math.min((pageIndex + 1) * pageSize, total);

  return (
    <div style={styles.page}>
      <Header title="Location Page" subtitle="Building and area-level location data" />

      <div style={styles.body}>
        {/* ── Toolbar ── */}
        <div style={styles.toolbar}>
          <input
            style={styles.searchInput}
            type="text"
            placeholder="Search by property name, address, or Property ID"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPagination(); }}
          />

          <div style={{ position: "relative" }} ref={filterRef}>
            <button
              style={{
                ...styles.filterBtn,
                background: activeFilterCount > 0 ? "#e8f0fb" : "#f4f6f9",
                border: activeFilterCount > 0 ? "1.5px solid #0468B1" : "1.5px solid #e0e0e0",
                color: activeFilterCount > 0 ? "#0468B1" : "#444",
              }}
              onClick={() => {
                setPendingFilters({ ...filters });
                setFilterOpen((o) => !o);
              }}
            >
              <FilterIcon />
              <span style={{ marginLeft: 6 }}>Filters</span>
              {activeFilterCount > 0 && (
                <span style={styles.filterBadge}>{activeFilterCount}</span>
              )}
            </button>

            {filterOpen && (
              <div style={styles.filterPanel}>
                <div style={styles.filterTitle}>Filter Properties</div>

                {/* Conflict warning */}
                <div style={styles.filterSection}>
                  <label style={styles.filterCheckLabel}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.conflict_only}
                      onChange={(e) =>
                        setPendingFilters((f) => ({ ...f, conflict_only: e.target.checked }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    <span style={{ color: "#e65100", fontWeight: 500 }}>
                      Properties with conflicting assessments
                    </span>
                  </label>
                </div>

                {/* Confirmed status */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Confirmed Status</div>
                  {(["all", "confirmed", "unconfirmed"] as const).map((opt) => (
                    <label key={opt} style={styles.filterRadioLabel}>
                      <input
                        type="radio"
                        name="confirmed_status_filter"
                        value={opt}
                        checked={pendingFilters.confirmed_status_filter === opt}
                        onChange={() =>
                          setPendingFilters((f) => ({ ...f, confirmed_status_filter: opt }))
                        }
                        style={{ marginRight: 8 }}
                      />
                      {opt === "all" ? "All" : opt === "confirmed" ? "Confirmed only" : "Not yet confirmed"}
                    </label>
                  ))}
                </div>

                {/* Property status */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Property Status</div>
                  <label style={styles.filterCheckLabel}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.property_status.active}
                      onChange={(e) =>
                        setPendingFilters((f) => ({
                          ...f,
                          property_status: { ...f.property_status, active: e.target.checked },
                        }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    Active
                  </label>
                  <label style={styles.filterCheckLabel}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.property_status.recovered}
                      onChange={(e) =>
                        setPendingFilters((f) => ({
                          ...f,
                          property_status: { ...f.property_status, recovered: e.target.checked },
                        }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    Recovered
                  </label>
                </div>

                {/* Country */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Country</div>
                  <input
                    style={styles.filterInput}
                    type="text"
                    placeholder="e.g. Ukraine"
                    value={pendingFilters.country}
                    onChange={(e) =>
                      setPendingFilters((f) => ({ ...f, country: e.target.value }))
                    }
                  />
                </div>

                {/* Date range */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Most Recent Report — Date Range</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      style={{ ...styles.filterInput, flex: 1 }}
                      type="date"
                      value={pendingFilters.date_from}
                      onChange={(e) =>
                        setPendingFilters((f) => ({ ...f, date_from: e.target.value }))
                      }
                    />
                    <input
                      style={{ ...styles.filterInput, flex: 1 }}
                      type="date"
                      value={pendingFilters.date_to}
                      onChange={(e) =>
                        setPendingFilters((f) => ({ ...f, date_to: e.target.value }))
                      }
                    />
                  </div>
                </div>

                {/* Disabled filters */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>
                    Damage Level Filter{" "}
                    <span style={styles.disabledBadge} title="Available after backend update">
                      Coming soon
                    </span>
                  </div>
                  <input
                    style={{ ...styles.filterInput, opacity: 0.4, cursor: "not-allowed" }}
                    disabled
                    placeholder="All damage levels"
                  />
                </div>

                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>
                    Project Filter{" "}
                    <span style={styles.disabledBadge} title="Available after backend update">
                      Coming soon
                    </span>
                  </div>
                  <input
                    style={{ ...styles.filterInput, opacity: 0.4, cursor: "not-allowed" }}
                    disabled
                    placeholder="All projects"
                  />
                </div>

                <div style={styles.filterActions}>
                  <button style={styles.filterClearBtn} onClick={clearFilters}>
                    Clear all
                  </button>
                  <button style={styles.filterApplyBtn} onClick={applyFilters}>
                    Apply Filters
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Show unreviewed toggle ── */}
        <div style={styles.toggleRow}>
          <label style={styles.toggleLabel}>
            <div
              style={{
                ...styles.toggle,
                background: showUnreviewed ? "#0468B1" : "#ccc",
              }}
              onClick={() => { setShowUnreviewed((v) => !v); resetPagination(); }}
              role="switch"
              aria-checked={showUnreviewed}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { setShowUnreviewed((v) => !v); resetPagination(); } }}
            >
              <div
                style={{
                  ...styles.toggleThumb,
                  transform: showUnreviewed ? "translateX(20px)" : "translateX(2px)",
                }}
              />
            </div>
            <span style={{ marginLeft: 10, fontSize: 13, color: "#444" }}>
              Show unreviewed properties
            </span>
          </label>

          {/* Page size */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <span style={styles.pageSizeLabel}>Rows:</span>
            <select
              style={styles.pageSizeSelect}
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); resetPagination(); }}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Table ── */}
        <div style={styles.tableWrap}>
          {isError && (
            <div style={styles.errorMsg}>
              Failed to load properties. Check your connection and try again.
            </div>
          )}

          {isLoading && (
            <div style={styles.loadingMsg}>Loading properties…</div>
          )}

          {!isLoading && !isError && items.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>🏚</div>
              <div style={styles.emptyText}>
                No properties have been reported yet. Properties appear here once reports pass automatic checks.
              </div>
            </div>
          )}

          {!isLoading && !isError && items.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  {(
                    [
                      ["property_id", "Property ID"],
                      ["display_name", "Property Name"],
                      ["address", "Address / GPS"],
                      ["country", "Country"],
                      ["current_damage_level", "Current Damage"],
                      ["confirmed_status", "Confirmed Status"],
                      ["has_conflict_warning", "Conflict"],
                      ["total_reports", "Reports"],
                      ["total_reporters", "Reporters"],
                      ["most_recent_report_at", "Most Recent Report"],
                      ["property_status", "Status"],
                    ] as [SortField, string][]
                  ).map(([field, label]) => (
                    <th
                      key={field}
                      style={styles.th}
                      onClick={() => handleSort(field)}
                    >
                      {label} {sortIndicator(field)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((prop) => {
                  const isUnreviewed = showUnreviewed && !prop.confirmed_status;
                  const dmgColor = prop.current_damage_level
                    ? DAMAGE_COLORS[prop.current_damage_level] ?? "#888"
                    : null;
                  const confirmedColor = prop.confirmed_status
                    ? DAMAGE_COLORS[prop.confirmed_status] ?? "#888"
                    : null;

                  return (
                    <tr
                      key={prop.property_id}
                      style={{
                        ...styles.tr,
                        background: isUnreviewed ? "#FFF8E1" : "#fff",
                      }}
                    >
                      {/* Property ID */}
                      <td style={styles.td}>
                        <span
                          style={styles.idLink}
                          onClick={() => window.open("/locations/" + prop.property_id, "_blank")}
                          role="link"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") window.open("/locations/" + prop.property_id, "_blank");
                          }}
                        >
                          {prop.property_id.slice(0, 8)}…
                        </span>
                      </td>

                      {/* Property Name */}
                      <td style={styles.td}>{prop.display_name}</td>

                      {/* Address / GPS */}
                      <td style={styles.td}>
                        {prop.address
                          ? prop.address
                          : `${prop.latitude.toFixed(5)}, ${prop.longitude.toFixed(5)}`}
                      </td>

                      {/* Country */}
                      <td style={styles.td}>{prop.country ?? "—"}</td>

                      {/* Current Damage Level */}
                      <td style={styles.td}>
                        {prop.current_damage_level && dmgColor ? (
                          <span style={{ ...styles.pill, background: dmgColor }}>
                            {formatDamageLevel(prop.current_damage_level)}
                          </span>
                        ) : (
                          <span style={styles.muted}>—</span>
                        )}
                      </td>

                      {/* Confirmed Status */}
                      <td style={styles.td}>
                        {prop.confirmed_status && confirmedColor ? (
                          <span style={{ ...styles.pill, background: confirmedColor }}>
                            <LockIcon />
                            {formatDamageLevel(prop.confirmed_status)}
                          </span>
                        ) : null}
                      </td>

                      {/* Conflict Warning */}
                      <td style={styles.td}>
                        {prop.has_conflict_warning && (
                          <span
                            style={styles.conflictIcon}
                            title="Conflicting assessments from reporters"
                          >
                            <AlertTriangleIcon size={18} />
                          </span>
                        )}
                      </td>

                      {/* Total Reports */}
                      <td style={{ ...styles.td, textAlign: "center" }}>{prop.total_reports}</td>

                      {/* Total Reporters */}
                      <td style={{ ...styles.td, textAlign: "center" }}>{prop.total_reporters}</td>

                      {/* Most Recent Report */}
                      <td style={styles.td}>
                        {prop.most_recent_report_at
                          ? formatDateTime(prop.most_recent_report_at)
                          : <span style={styles.muted}>—</span>}
                      </td>

                      {/* Property Status */}
                      <td style={styles.td}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: prop.property_status === "Active" ? "#2e7d32" : "#9aa5b4",
                          }}
                        >
                          {prop.property_status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination ── */}
        {!isLoading && items.length > 0 && (
          <div style={styles.pagination}>
            <span style={styles.paginationInfo}>
              {total > 0
                ? `${pageStart}–${pageEnd} of ${total.toLocaleString()} properties`
                : "No properties"}
            </span>
            <button
              style={{
                ...styles.pageBtn,
                opacity: pageIndex === 0 ? 0.4 : 1,
                cursor: pageIndex === 0 ? "not-allowed" : "pointer",
              }}
              onClick={handlePrev}
              disabled={pageIndex === 0}
            >
              ← Previous
            </button>
            <button
              style={{
                ...styles.pageBtn,
                opacity: !hasMore ? 0.4 : 1,
                cursor: !hasMore ? "not-allowed" : "pointer",
              }}
              onClick={handleNext}
              disabled={!hasMore}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    overflow: "hidden",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 32px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  searchInput: {
    flex: 1,
    padding: "9px 14px",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
  },
  filterBtn: {
    display: "flex",
    alignItems: "center",
    padding: "9px 16px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    gap: 0,
    whiteSpace: "nowrap",
  },
  filterBadge: {
    marginLeft: 8,
    background: "#0468B1",
    color: "#fff",
    borderRadius: 10,
    padding: "1px 7px",
    fontSize: 11,
    fontWeight: 700,
  },
  filterPanel: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    width: 360,
    background: "#fff",
    border: "1px solid #e0e8f0",
    borderRadius: 12,
    boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
    zIndex: 50,
    padding: "20px 20px 16px",
  },
  filterTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 16,
  },
  filterSection: {
    marginBottom: 16,
  },
  filterLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#9aa5b4",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  filterCheckLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "#1A2B4A",
    marginBottom: 6,
    cursor: "pointer",
  },
  filterRadioLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "#1A2B4A",
    marginBottom: 6,
    cursor: "pointer",
  },
  filterInput: {
    width: "100%",
    padding: "8px 12px",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    color: "#1A2B4A",
    outline: "none",
    boxSizing: "border-box",
  },
  disabledBadge: {
    background: "#f0f4f8",
    color: "#9aa5b4",
    borderRadius: 6,
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
  },
  filterActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 8,
    borderTop: "1px solid #f0f4f8",
  },
  filterClearBtn: {
    padding: "8px 16px",
    background: "#f4f6f9",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    color: "#444",
    cursor: "pointer",
    fontWeight: 500,
  },
  filterApplyBtn: {
    padding: "8px 18px",
    background: "#0468B1",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    cursor: "pointer",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: 14,
    gap: 8,
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
  },
  toggle: {
    width: 40,
    height: 22,
    borderRadius: 11,
    position: "relative",
    cursor: "pointer",
    transition: "background 0.2s",
    flexShrink: 0,
  },
  toggleThumb: {
    position: "absolute",
    top: 2,
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
    transition: "transform 0.2s",
  },
  pageSizeLabel: {
    fontSize: 12,
    color: "#9aa5b4",
  },
  pageSizeSelect: {
    padding: "5px 8px",
    border: "1px solid #d0dce8",
    borderRadius: 6,
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    cursor: "pointer",
  },
  tableWrap: {
    flex: 1,
    overflowX: "auto",
    border: "1px solid #e8eef4",
    borderRadius: 10,
    background: "#fff",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  thead: {
    background: "#f8fafc",
  },
  th: {
    padding: "11px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#9aa5b4",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e8eef4",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  tr: {
    borderBottom: "1px solid #f0f4f8",
    transition: "background 0.1s",
  },
  td: {
    padding: "10px 14px",
    color: "#1A2B4A",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 10px",
    borderRadius: 12,
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
  },
  idLink: {
    color: "#0468B1",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
  },
  muted: {
    color: "#ccc",
  },
  conflictIcon: {
    color: "#e65100",
    display: "inline-flex",
    alignItems: "center",
  },
  sortNeutral: {
    color: "#ccc",
    marginLeft: 4,
    fontSize: 10,
  },
  sortActive: {
    color: "#0468B1",
    marginLeft: 4,
    fontSize: 10,
  },
  pagination: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 0 0",
    justifyContent: "flex-end",
  },
  paginationInfo: {
    fontSize: 13,
    color: "#9aa5b4",
    marginRight: "auto",
  },
  pageBtn: {
    padding: "8px 18px",
    background: "#fff",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: "#1A2B4A",
  },
  loadingMsg: {
    padding: 60,
    textAlign: "center",
    color: "#9aa5b4",
    fontSize: 14,
  },
  errorMsg: {
    padding: 40,
    textAlign: "center",
    color: "#c62828",
    fontSize: 14,
  },
  emptyState: {
    padding: 80,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    fontSize: 14,
    color: "#9aa5b4",
    maxWidth: 440,
    lineHeight: 1.6,
  },
};
