import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Header from "../components/Header";
import { getProperties, getDashboardProjects } from "../services/api";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";
import type { Property, PropertiesListResponse, ProjectListRow, ProjectsListResponse } from "../types";

// ── Damage colours ────────────────────────────────────────────────────────────

const DAMAGE_COLORS: Record<string, string> = {
  completely_destroyed: "var(--c-flag-red)",
  partially_damaged: "var(--c-flag-orange)",
  minimal_or_no_damage: "var(--c-flag-green)",
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
  damage_level: string[];
  project_serial_id: string;
}

const DEFAULT_FILTERS: Filters = {
  conflict_only: false,
  confirmed_status_filter: "all",
  property_status: { active: true, recovered: true },
  country: "",
  date_from: "",
  date_to: "",
  damage_level: [],
  project_serial_id: "",
};

const DAMAGE_LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: "completely_destroyed", label: "Completely Destroyed" },
  { value: "partially_damaged",    label: "Partially Damaged" },
  { value: "minimal_or_no_damage", label: "Minimal or No Damage" },
];

const PAGE_SIZES = [100, 200, 300, 400, 500];

// ── Component ─────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export default function LocationsPage() {
  const [search, setSearch] = useState("");
  const [showUnreviewed, setShowUnreviewed] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortField>("most_recent_report_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(100);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [pendingFilters, setPendingFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [fetchProjects, setFetchProjects] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // Fetch projects when filter panel is first opened
  const { data: projectsData } = useQuery<ProjectsListResponse>({
    queryKey: ["locations-filter-projects"],
    queryFn: async () => {
      const res = await getDashboardProjects({ status: "active,closed", limit: 200 });
      return res.data as ProjectsListResponse;
    },
    enabled: fetchProjects,
    staleTime: 1000 * 60 * 5,
  });
  const projectOptions: ProjectListRow[] = projectsData?.items ?? [];

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
    if (filters.damage_level.length > 0) p.damage_level = filters.damage_level.join(",");
    if (filters.project_serial_id) p.project_serial_id = filters.project_serial_id;
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
    (filters.date_from || filters.date_to ? 1 : 0) +
    (filters.damage_level.length > 0 ? 1 : 0) +
    (filters.project_serial_id ? 1 : 0);

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
      <Header title="Location Page" subtitle="Building and area-level damage data" />

      <div style={styles.body}>
        {/* ── Page context strip ── */}
        <div style={styles.contextStrip}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={styles.contextText}>
              Properties with qualifying (green/orange) reports
            </span>
            {activeFilterCount > 0 && (
              <span style={styles.activeFiltersChip}>
                {activeFilterCount} filter{activeFilterCount !== 1 ? "s" : ""} active
              </span>
            )}
          </div>
          <span style={styles.contextCount}>
            {total > 0 ? `${total.toLocaleString()} properties` : ""}
          </span>
        </div>

        {/* ── Toolbar ── */}
        <div style={styles.toolbar}>
          <div style={styles.searchWrap}>
            <span style={styles.searchIcon}><SearchIcon /></span>
            <input
              style={styles.searchInput}
              type="text"
              placeholder="Search by property name, address, or Property ID…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetPagination(); }}
            />
          </div>

          <div style={{ position: "relative" }} ref={filterRef}>
            <button
              style={{
                ...styles.filterBtn,
                background: activeFilterCount > 0 ? "rgba(4,104,177,0.08)" : "var(--c-surface-low)",
                border: activeFilterCount > 0 ? "1.5px solid var(--c-primary-container)" : "1.5px solid var(--c-border)",
                color: activeFilterCount > 0 ? "var(--c-primary-container)" : "var(--c-text-secondary)",
              }}
              onClick={() => {
                setPendingFilters({ ...filters });
                setFetchProjects(true);
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

                {/* Conflict warning — highlighted as primary QA filter */}
                <div style={{
                  ...styles.filterSection,
                  background: pendingFilters.conflict_only
                    ? "rgba(245,166,35,0.10)"
                    : "rgba(245,166,35,0.05)",
                  border: `1.5px solid ${pendingFilters.conflict_only ? "rgba(245,166,35,0.5)" : "rgba(245,166,35,0.2)"}`,
                  borderRadius: "var(--radius-md)",
                  padding: "10px 12px",
                }}>
                  <label style={{ ...styles.filterCheckLabel, marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.conflict_only}
                      onChange={(e) =>
                        setPendingFilters((f) => ({ ...f, conflict_only: e.target.checked }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    <div>
                      <div style={{ color: "#92400e", fontWeight: 700, fontSize: "var(--text-sm)" }}>
                        <AlertTriangleIcon size={13} />
                        {" "}Properties with conflicting assessments
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", marginTop: 3 }}>
                        Show only properties where reporters disagree on damage level (≥25% minority)
                      </div>
                    </div>
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

                {/* Damage level */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Damage Level</div>
                  {DAMAGE_LEVEL_OPTIONS.map((opt) => (
                    <label key={opt.value} style={styles.filterCheckLabel}>
                      <input
                        type="checkbox"
                        checked={pendingFilters.damage_level.includes(opt.value)}
                        onChange={(e) =>
                          setPendingFilters((f) => ({
                            ...f,
                            damage_level: e.target.checked
                              ? [...f.damage_level, opt.value]
                              : f.damage_level.filter((v) => v !== opt.value),
                          }))
                        }
                        style={{ marginRight: 8 }}
                      />
                      <span style={{
                        color: opt.value === "completely_destroyed" ? "var(--c-flag-red)"
                          : opt.value === "partially_damaged" ? "var(--c-flag-orange)"
                          : "var(--c-flag-green)",
                        fontWeight: 500,
                      }}>
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>

                {/* Project */}
                <div style={styles.filterSection}>
                  <div style={styles.filterLabel}>Project</div>
                  <select
                    style={styles.filterInput}
                    value={pendingFilters.project_serial_id}
                    onChange={(e) =>
                      setPendingFilters((f) => ({ ...f, project_serial_id: e.target.value }))
                    }
                  >
                    <option value="">All projects</option>
                    {projectOptions.map((proj) => (
                      <option key={proj.serial_id} value={proj.serial_id}>
                        {proj.name} ({proj.serial_id})
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", marginTop: 6 }}>
                    Filtering by project shows only properties with reports linked to that project.
                  </div>
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
                background: showUnreviewed ? "var(--c-primary-container)" : "var(--c-text-subtle)",
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
            <span style={{ marginLeft: 10, fontSize: "var(--text-sm)", color: "var(--c-text-secondary)" }}>
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
              <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="var(--c-text-subtle)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <div style={styles.emptyText}>
                No properties have been reported yet.
                <br />
                <span style={{ color: "var(--c-text-subtle)", fontStyle: "italic" }}>
                  Properties appear here once green or orange reports are received.
                </span>
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
                  const isHovered = hoveredRow === prop.property_id;
                  const dmgColor = prop.current_damage_level
                    ? DAMAGE_COLORS[prop.current_damage_level] ?? "var(--c-text-muted)"
                    : null;
                  const confirmedColor = prop.confirmed_status
                    ? DAMAGE_COLORS[prop.confirmed_status] ?? "var(--c-text-muted)"
                    : null;

                  return (
                    <tr
                      key={prop.property_id}
                      style={{
                        ...styles.tr,
                        cursor: "pointer",
                        background: isUnreviewed
                          ? (isHovered ? "rgba(245,166,35,0.10)" : "rgba(245,166,35,0.05)")
                          : (isHovered ? "rgba(4,104,177,0.04)" : "var(--c-surface-lowest)"),
                      }}
                      onMouseEnter={() => setHoveredRow(prop.property_id)}
                      onMouseLeave={() => setHoveredRow(null)}
                      onClick={() => window.open("/locations/" + prop.property_id, "_blank")}
                    >
                      {/* Property ID */}
                      <td style={styles.td}>
                        <span
                          style={styles.idLink}
                          onClick={(e) => { e.stopPropagation(); window.open("/locations/" + prop.property_id, "_blank"); }}
                          role="link"
                          tabIndex={0}
                          title={prop.property_id ?? ""}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") window.open("/locations/" + prop.property_id, "_blank");
                          }}
                        >
                          {(prop.property_id ?? "").slice(0, 8)}…
                        </span>
                      </td>

                      {/* Property Name */}
                      <td style={styles.td}>{prop.display_name}</td>

                      {/* Address / GPS */}
                      <td style={styles.td}>
                        {prop.address
                          ? prop.address
                          : prop.latitude != null && prop.longitude != null
                            ? `${prop.latitude.toFixed(5)}, ${prop.longitude.toFixed(5)}`
                            : <span style={styles.muted}>No coordinates</span>}
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
                            fontSize: "var(--text-sm)",
                            color: prop.property_status === "Active" ? "var(--c-flag-green)" : "var(--c-text-muted)",
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
  contextStrip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 4px",
    marginBottom: 12,
  },
  contextText: {
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  contextCount: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-subtle)",
  },
  activeFiltersChip: {
    background: "rgba(4,104,177,0.1)",
    color: "var(--c-primary-container)",
    borderRadius: "var(--radius-pill)",
    padding: "2px 10px",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
  },
  toolbar: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    padding: "12px 16px",
    boxShadow: "var(--shadow-sm)",
    marginBottom: 16,
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap" as const,
    border: "1px solid var(--c-border-ghost)",
  },
  searchWrap: {
    flex: 1,
    position: "relative" as const,
    minWidth: 280,
    display: "flex",
    alignItems: "center",
  },
  searchIcon: {
    position: "absolute" as const,
    left: 10,
    color: "var(--c-text-subtle)",
    display: "flex",
    alignItems: "center",
    pointerEvents: "none" as const,
  },
  searchInput: {
    width: "100%",
    padding: "9px 14px 9px 32px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
  },
  filterBtn: {
    display: "flex",
    alignItems: "center",
    padding: "9px 16px",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    cursor: "pointer",
    gap: 0,
    whiteSpace: "nowrap" as const,
  },
  filterBadge: {
    marginLeft: 8,
    background: "var(--c-primary-container)",
    color: "#fff",
    borderRadius: 10,
    padding: "1px 7px",
    fontSize: "var(--text-xs)",
    fontWeight: 700,
  },
  filterPanel: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    width: 360,
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-float)",
    zIndex: 50,
    padding: "20px 20px 16px",
  },
  filterTitle: {
    fontSize: "var(--text-base)",
    fontWeight: 700,
    color: "var(--c-text-primary)",
    marginBottom: 16,
  },
  filterSection: {
    marginBottom: 16,
  },
  filterLabel: {
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  filterCheckLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    marginBottom: 6,
    cursor: "pointer",
  },
  filterRadioLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    marginBottom: 6,
    cursor: "pointer",
  },
  filterInput: {
    width: "100%",
    padding: "8px 12px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  disabledBadge: {
    background: "var(--c-surface-low)",
    color: "var(--c-text-muted)",
    borderRadius: "var(--radius-sm)",
    padding: "2px 7px",
    fontSize: 10,
    fontWeight: 600,
  },
  filterActions: {
    display: "flex",
    justifyContent: "flex-end" as const,
    gap: 10,
    paddingTop: 8,
    borderTop: "1px solid var(--c-border-ghost)",
  },
  filterClearBtn: {
    padding: "8px 16px",
    background: "var(--c-surface-high)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    cursor: "pointer",
    fontWeight: 500,
  },
  filterApplyBtn: {
    padding: "8px 18px",
    background: "var(--c-primary-container)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
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
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
  },
  pageSizeSelect: {
    padding: "5px 8px",
    border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    cursor: "pointer",
  },
  tableWrap: {
    flex: 1,
    overflowX: "auto",
    borderRadius: "var(--radius-lg)",
    background: "var(--c-surface-lowest)",
    boxShadow: "var(--shadow-card)",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "var(--text-sm)",
  },
  thead: {
    background: "var(--c-surface-low)",
  },
  th: {
    padding: "11px 14px",
    textAlign: "left" as const,
    fontSize: "var(--text-xs)",
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    borderBottom: "1px solid var(--c-border-ghost)",
    cursor: "pointer",
    userSelect: "none" as const,
    whiteSpace: "nowrap" as const,
  },
  tr: {
    borderBottom: "1px solid var(--c-border-ghost)",
    transition: "background 0.1s",
  },
  td: {
    padding: "10px 14px",
    color: "var(--c-text-primary)",
    verticalAlign: "middle" as const,
    whiteSpace: "nowrap" as const,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "3px 10px",
    borderRadius: 12,
    color: "#fff",
    fontSize: "var(--text-xs)",
    fontWeight: 600,
  },
  idLink: {
    color: "var(--c-primary-container)",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "var(--text-xs)",
  },
  muted: {
    color: "var(--c-text-subtle)",
  },
  conflictIcon: {
    color: "var(--c-flag-orange)",
    display: "inline-flex",
    alignItems: "center",
  },
  sortNeutral: {
    color: "var(--c-text-subtle)",
    marginLeft: 4,
    fontSize: 10,
  },
  sortActive: {
    color: "var(--c-primary-container)",
    marginLeft: 4,
    fontSize: 10,
  },
  pagination: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 0 0",
    justifyContent: "flex-end" as const,
  },
  paginationInfo: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-muted)",
    marginRight: "auto",
  },
  pageBtn: {
    padding: "8px 18px",
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    color: "var(--c-text-primary)",
  },
  loadingMsg: {
    padding: 60,
    textAlign: "center" as const,
    color: "var(--c-text-muted)",
    fontSize: "var(--text-sm)",
  },
  errorMsg: {
    padding: 40,
    textAlign: "center" as const,
    color: "var(--c-flag-red)",
    fontSize: "var(--text-sm)",
  },
  emptyState: {
    padding: 80,
    textAlign: "center" as const,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center" as const,
    gap: 16,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-muted)",
    maxWidth: 440,
    lineHeight: 1.6,
  },
};
