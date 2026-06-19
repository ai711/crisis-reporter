import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Home } from "lucide-react";
import Header from "../components/Header";
import PageSpinner from "../components/PageSpinner";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { getProperties, getDashboardProjects, getPropertyStats } from "../services/api";
import { formatDamageLevel, formatDateTime, countryCodeToName } from "../utils/formatters";
import { usePageTitle } from "../hooks/usePageTitle";
import type { Property, PropertiesListResponse, PropertyStats, ProjectListRow, ProjectsListResponse } from "../types";

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

function ColumnsIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="18" rx="1" />
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

// ── Column definitions ────────────────────────────────────────────────────────

interface ColDef {
  id: string;
  label: string;
  sortField?: SortField;
  alwaysVisible?: boolean;
  defaultHidden?: boolean;
  tooltip?: string;
}

const COLUMN_DEFS: ColDef[] = [
  { id: "property_id",           label: "Property ID",         sortField: "property_id",          alwaysVisible: true },
  { id: "display_name",          label: "Property Name",       sortField: "display_name",   tooltip: "Override name → building name from reporter/OSM → GPS coords fallback when no name is available" },
  { id: "address",               label: "Address / GPS",       sortField: "address",        tooltip: "Free-text address from the most recent report, or GPS coordinates if no address was provided" },
  { id: "country",               label: "Country",             sortField: "country" },
  { id: "current_damage_level",  label: "Current Damage",      sortField: "current_damage_level" },
  { id: "confirmed_status",      label: "Confirmed Status",    sortField: "confirmed_status" },
  { id: "has_conflict_warning",  label: "Conflict",            sortField: "has_conflict_warning" },
  { id: "total_reports",         label: "Reports",             sortField: "total_reports" },
  { id: "total_reporters",       label: "Reporters",           sortField: "total_reporters",       defaultHidden: true },
  { id: "most_recent_report_at", label: "Most Recent Report",  sortField: "most_recent_report_at" },
  { id: "property_status",       label: "Status",              sortField: "property_status" },
];

const DEFAULT_VISIBLE = new Set(
  COLUMN_DEFS.filter((c) => !c.defaultHidden).map((c) => c.id)
);

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
  usePageTitle("Locations");
  const [search, setSearch] = useState("");
  const [showUnreviewed, setShowUnreviewed] = useState(false);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortField>("most_recent_report_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(100);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [visibleCols, setVisibleCols] = useState<Set<string>>(DEFAULT_VISIBLE);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);

  const { data: projectsData } = useQuery<ProjectsListResponse>({
    queryKey: ["locations-filter-projects"],
    queryFn: async () => {
      const res = await getDashboardProjects({ status: "active,closed", limit: 200 });
      return res.data as ProjectsListResponse;
    },
    staleTime: 1000 * 60 * 5,
  });
  const projectOptions: ProjectListRow[] = projectsData?.items ?? [];

  // Summary stats (global, unfiltered)
  const { data: statsData } = useQuery<PropertyStats>({
    queryKey: ["property-stats"],
    queryFn: async () => {
      const res = await getPropertyStats();
      return res.data as PropertyStats;
    },
    staleTime: 1000 * 60 * 2,
  });

  // Close columns panel on outside click
  useEffect(() => {
    if (!colsOpen) return;
    const handler = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) {
        setColsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colsOpen]);

  // Build query params — param names must match backend list_properties() signature
  const buildParams = (): Record<string, string | number | boolean> => {
    const p: Record<string, string | number | boolean> = { limit: pageSize };
    if (cursor) p.cursor = cursor;
    if (search.trim()) p.search = search.trim();
    if (showUnreviewed) p.show_unreviewed = true;
    if (filters.conflict_only) p.conflict_warning = true;
    if (filters.confirmed_status_filter === "confirmed") p.confirmed_status = "set";
    if (filters.confirmed_status_filter === "unconfirmed") p.confirmed_status = "unset";
    if (!filters.property_status.active && filters.property_status.recovered) p.property_status = "recovered";
    if (filters.property_status.active && !filters.property_status.recovered) p.property_status = "active";
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

  const total: number = data?.total ?? 0;
  const hasMore: boolean = data?.has_more ?? false;
  const nextCursor: string | null = data?.cursor ?? null;

  // Client-side sort — backend ignores sort_by/sort_dir; we sort the fetched page here.
  // items is derived inside the memo so ?? [] doesn't create a new array ref on every
  // render and destabilise the dependency array.
  const sortedItems = useMemo(() => {
    const items: Property[] = data?.items ?? [];
    if (items.length === 0) return items;
    return [...items].sort((a, b) => {
      const av = a[sortBy as keyof Property];
      const bv = b[sortBy as keyof Property];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortBy, sortDir]);

  // Sort handler — client-side sort within the loaded page; resets to page 1 so the
  // user sorts from the beginning of the dataset, not mid-cursor.
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

  const clearFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
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
        {/* ── Summary stat blocks ── */}
        {statsData && (
          <div style={styles.statRow}>
            {[
              { label: "Total Properties", value: statsData.total, color: "var(--c-primary-container)", bg: "rgba(4,104,177,0.07)" },
              { label: "Confirmed",         value: statsData.confirmed,    color: "var(--c-flag-green)",  bg: "rgba(34,197,94,0.08)" },
              { label: "With Conflict",     value: statsData.with_conflict, color: "var(--c-flag-orange)", bg: "rgba(245,166,35,0.08)" },
              { label: "Recovered",         value: statsData.recovered,    color: "var(--c-text-muted)",  bg: "var(--c-surface-low)" },
            ].map(({ label, value, color, bg }) => (
              <div key={label} style={{ ...styles.statCard, background: bg }}>
                <span style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value.toLocaleString()}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-text-muted)", marginTop: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{label}</span>
              </div>
            ))}
          </div>
        )}

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

        {/* ── Toolbar: search + columns ── */}
        <div style={styles.toolbar}>
          <div style={styles.searchWrap}>
            <span style={styles.searchIcon}><SearchIcon /></span>
            <input
              style={styles.searchInput}
              type="text"
              placeholder="Search by name, address, or Property ID…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetPagination(); }}
            />
          </div>

          {activeFilterCount > 0 && (
            <button style={styles.clearAllBtn} onClick={clearFilters}>
              Clear All ({activeFilterCount})
            </button>
          )}

          {/* Columns visibility toggle */}
          <div style={{ position: "relative" }} ref={colsRef}>
            <button
              style={{
                ...styles.filterBtn,
                background: visibleCols.size < COLUMN_DEFS.length ? "rgba(4,104,177,0.08)" : "var(--c-surface-low)",
                border: visibleCols.size < COLUMN_DEFS.length ? "1.5px solid var(--c-primary-container)" : "1.5px solid var(--c-border)",
                color: visibleCols.size < COLUMN_DEFS.length ? "var(--c-primary-container)" : "var(--c-text-secondary)",
              }}
              onClick={() => setColsOpen((o) => !o)}
            >
              <ColumnsIcon />
              <span style={{ marginLeft: 6 }}>Columns</span>
              {visibleCols.size < COLUMN_DEFS.length && (
                <span style={styles.filterBadge}>{COLUMN_DEFS.length - visibleCols.size} hidden</span>
              )}
            </button>
            {colsOpen && (
              <div style={{ ...styles.filterPanel, width: 220, padding: "16px" }} onClick={(e) => e.stopPropagation()}>
                <div style={styles.filterTitle}>Visible Columns</div>
                {COLUMN_DEFS.map((col) => (
                  <label key={col.id} style={{ ...styles.filterCheckLabel, opacity: col.alwaysVisible ? 0.5 : 1 }}>
                    <input
                      type="checkbox"
                      checked={visibleCols.has(col.id)}
                      disabled={!!col.alwaysVisible}
                      onChange={(e) => {
                        setVisibleCols((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(col.id);
                          else next.delete(col.id);
                          return next;
                        });
                      }}
                      style={{ marginRight: 8 }}
                    />
                    {col.label}
                  </label>
                ))}
                <div style={{ ...styles.filterActions, marginTop: 12 }}>
                  <button style={styles.filterClearBtn} onClick={() => setVisibleCols(DEFAULT_VISIBLE)}>
                    Reset
                  </button>
                  <button style={styles.filterApplyBtn} onClick={() => setColsOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Inline filter bar ── */}
        <div style={styles.filterBar}>
          {/* Conflict warning toggle chip */}
          <button
            style={{
              ...styles.conflictChip,
              background: filters.conflict_only ? "rgba(245,166,35,0.15)" : "var(--c-surface-low)",
              borderColor: filters.conflict_only ? "rgba(245,166,35,0.6)" : "var(--c-border)",
              color: filters.conflict_only ? "#92400e" : "var(--c-text-secondary)",
            }}
            onClick={() => { setFilters((f) => ({ ...f, conflict_only: !f.conflict_only })); resetPagination(); }}
            title="Show only properties with conflicting assessments (≥25% minority)"
          >
            <AlertTriangleIcon size={12} />
            <span>Conflict</span>
          </button>

          <span style={styles.filterDivider} />

          {/* Confirmed status */}
          <select
            style={styles.inlineSelect}
            value={filters.confirmed_status_filter}
            onChange={(e) => { setFilters((f) => ({ ...f, confirmed_status_filter: e.target.value as Filters["confirmed_status_filter"] })); resetPagination(); }}
            title="Filter by confirmed status"
          >
            <option value="all">All Confirmed</option>
            <option value="confirmed">Confirmed Only</option>
            <option value="unconfirmed">Not Confirmed</option>
          </select>

          {/* Damage level */}
          <select
            style={styles.inlineSelect}
            value={filters.damage_level[0] ?? ""}
            onChange={(e) => { setFilters((f) => ({ ...f, damage_level: e.target.value ? [e.target.value] : [] })); resetPagination(); }}
            title="Filter by damage level"
          >
            <option value="">Any Damage</option>
            {DAMAGE_LEVEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Property status */}
          <select
            style={styles.inlineSelect}
            value={
              filters.property_status.active && filters.property_status.recovered ? "both"
              : filters.property_status.active ? "active"
              : "recovered"
            }
            onChange={(e) => {
              const v = e.target.value;
              setFilters((f) => ({
                ...f,
                property_status: { active: v !== "recovered", recovered: v !== "active" },
              }));
              resetPagination();
            }}
            title="Filter by property status"
          >
            <option value="both">All Status</option>
            <option value="active">Active Only</option>
            <option value="recovered">Recovered Only</option>
          </select>

          <span style={styles.filterDivider} />

          {/* Country */}
          <input
            style={styles.inlineTextInput}
            type="text"
            placeholder="Country…"
            value={filters.country}
            onChange={(e) => { setFilters((f) => ({ ...f, country: e.target.value })); resetPagination(); }}
            title="Filter by country"
          />

          {/* Project */}
          {projectOptions.length > 0 && (
            <select
              style={styles.inlineSelect}
              value={filters.project_serial_id}
              onChange={(e) => { setFilters((f) => ({ ...f, project_serial_id: e.target.value })); resetPagination(); }}
              title="Filter by project"
            >
              <option value="">All Projects</option>
              {projectOptions.map((proj) => (
                <option key={proj.serial_id} value={proj.serial_id}>{proj.name} ({proj.serial_id})</option>
              ))}
            </select>
          )}

          <span style={styles.filterDivider} />

          {/* Date range */}
          <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", whiteSpace: "nowrap" as const, flexShrink: 0 }}>From</span>
          <input
            style={styles.inlineDateInput}
            type="date"
            value={filters.date_from}
            onChange={(e) => { setFilters((f) => ({ ...f, date_from: e.target.value })); resetPagination(); }}
            title="Most recent report from date"
          />
          <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", flexShrink: 0 }}>To</span>
          <input
            style={styles.inlineDateInput}
            type="date"
            value={filters.date_to}
            onChange={(e) => { setFilters((f) => ({ ...f, date_to: e.target.value })); resetPagination(); }}
            title="Most recent report to date"
          />
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
            <ErrorState message="Failed to load properties. Check your connection and try again." />
          )}

          {isLoading && (
            <PageSpinner />
          )}

          {!isLoading && !isError && sortedItems.length === 0 && (
            <EmptyState
              icon={<Home size={28} color="var(--c-text-subtle)" />}
              title="No properties yet"
              message="Properties appear here once green or orange reports are received."
            />
          )}

          {!isLoading && !isError && sortedItems.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr style={styles.thead}>
                  {COLUMN_DEFS.filter((c) => visibleCols.has(c.id)).map((col) => (
                    <th
                      key={col.id}
                      style={{
                        ...styles.th,
                        ...(col.id === "has_conflict_warning" ? { textAlign: "center" as const } : {}),
                      }}
                      onClick={() => col.sortField && handleSort(col.sortField)}
                      title={col.tooltip}
                    >
                      {col.label} {col.sortField && sortIndicator(col.sortField)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((prop) => {
                  const isUnreviewed = showUnreviewed && !prop.confirmed_status;
                  const isHovered = hoveredRow === prop.property_id;
                  const dmgColor = prop.current_damage_level
                    ? DAMAGE_COLORS[prop.current_damage_level] ?? "var(--c-text-muted)"
                    : null;
                  const confirmedColor = prop.confirmed_status
                    ? DAMAGE_COLORS[prop.confirmed_status] ?? "var(--c-text-muted)"
                    : null;

                  const renderCell = (colId: string) => {
                    switch (colId) {
                      case "property_id":
                        return (
                          <td key={colId} style={styles.td}>
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
                        );
                      case "display_name":
                        return <td key={colId} style={styles.td}>{prop.display_name}</td>;
                      case "address":
                        return (
                          <td key={colId} style={styles.td}>
                            {prop.address
                              ? prop.address
                              : prop.latitude != null && prop.longitude != null
                                ? `${prop.latitude.toFixed(5)}, ${prop.longitude.toFixed(5)}`
                                : <span style={styles.muted}>No coordinates</span>}
                          </td>
                        );
                      case "country":
                        return <td key={colId} style={styles.td}>{countryCodeToName(prop.country)}</td>;
                      case "current_damage_level":
                        return (
                          <td key={colId} style={styles.td}>
                            {prop.current_damage_level && dmgColor ? (
                              <span style={{ ...styles.pill, background: dmgColor }}>
                                {formatDamageLevel(prop.current_damage_level)}
                              </span>
                            ) : <span style={styles.muted}>—</span>}
                          </td>
                        );
                      case "confirmed_status":
                        return (
                          <td key={colId} style={styles.td}>
                            {prop.confirmed_status && confirmedColor ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                <span style={{ ...styles.pill, background: confirmedColor }}>
                                  {!prop.auto_confirmed && <LockIcon />}
                                  {formatDamageLevel(prop.confirmed_status)}
                                </span>
                                {prop.auto_confirmed && (
                                  <span style={styles.autoBadge} title="Set automatically based on majority of reports">Auto</span>
                                )}
                              </span>
                            ) : null}
                          </td>
                        );
                      case "has_conflict_warning":
                        return (
                          <td key={colId} style={{ ...styles.td, textAlign: "center" as const }}>
                            {prop.has_conflict_warning && (
                              <span style={styles.conflictIcon} title="Conflicting assessments from reporters">
                                <AlertTriangleIcon size={18} />
                              </span>
                            )}
                          </td>
                        );
                      case "total_reports":
                        return <td key={colId} style={{ ...styles.td, textAlign: "center" }}>{prop.total_reports}</td>;
                      case "total_reporters":
                        return <td key={colId} style={{ ...styles.td, textAlign: "center" }}>{prop.total_reporters}</td>;
                      case "most_recent_report_at":
                        return (
                          <td key={colId} style={styles.td}>
                            {prop.most_recent_report_at
                              ? formatDateTime(prop.most_recent_report_at)
                              : <span style={styles.muted}>—</span>}
                          </td>
                        );
                      case "property_status":
                        return (
                          <td key={colId} style={styles.td}>
                            <span style={{
                              fontWeight: 600,
                              fontSize: "var(--text-sm)",
                              color: prop.property_status === "Active" ? "var(--c-flag-green)" : "var(--c-text-muted)",
                            }}>
                              {prop.property_status}
                            </span>
                          </td>
                        );
                      default:
                        return <td key={colId} style={styles.td}>—</td>;
                    }
                  };

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
                      {COLUMN_DEFS.filter((c) => visibleCols.has(c.id)).map((col) => renderCell(col.id))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination ── */}
        {!isLoading && sortedItems.length > 0 && (
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
  statRow: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start",
    padding: "14px 18px",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--c-border-ghost)",
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
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap" as const,
    border: "1px solid var(--c-border-ghost)",
  },
  filterBar: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    padding: "10px 16px",
    boxShadow: "var(--shadow-sm)",
    marginBottom: 14,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap" as const,
    border: "1px solid var(--c-border-ghost)",
  },
  conflictChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    border: "1.5px solid",
    transition: "all 0.15s",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  filterDivider: {
    width: 1,
    height: 20,
    background: "var(--c-border)",
    flexShrink: 0,
    alignSelf: "center",
  },
  inlineSelect: {
    padding: "6px 10px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    cursor: "pointer",
    outline: "none",
    flexShrink: 0,
  },
  inlineTextInput: {
    padding: "6px 10px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    width: 110,
    flexShrink: 0,
  },
  inlineDateInput: {
    padding: "6px 8px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    flexShrink: 0,
  },
  clearAllBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "8px 14px",
    background: "rgba(4,104,177,0.08)",
    border: "1.5px solid var(--c-primary-container)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--c-primary-container)",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  searchWrap: {
    flex: 1,
    position: "relative" as const,
    minWidth: 200,
    maxWidth: 340,
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
  autoBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    background: "var(--c-surface-low)",
    border: "1px solid var(--c-border)",
    borderRadius: 4,
    padding: "2px 5px",
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    flexShrink: 0,
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
};
