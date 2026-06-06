import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Search, ChevronDown, X, ChevronLeft, ChevronRight, Eye, Download } from "lucide-react";
import Header from "../components/Header";
import api from "../services/api";
import type { ReportListItem, FlagStatus, ReportListResponse } from "../types";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";

// ── Constants ─────────────────────────────────────────────────────────────────

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#717782",
  green: "#005a2c",
  orange: "#f97316",
  red: "#ba1a1a",
  discarded: "#616161",
};

const DAMAGE_PILL: Record<string, { bg: string; color: string; label: string }> = {
  completely_destroyed: { bg: "rgba(186,26,26,0.1)", color: "#ba1a1a", label: "Destroyed" },
  partially_damaged:    { bg: "#ffedd5", color: "#ea580c", label: "Partial" },
  minimal_or_no_damage: { bg: "#c7d7ff", color: "#4d5d7f", label: "Minimal" },
};

const PAGE_SIZE_OPTIONS = [100, 200, 300, 400, 500];

const DAMAGE_LEVEL_OPTIONS = [
  { label: "Completely Destroyed", value: "completely_destroyed" },
  { label: "Partially Damaged",    value: "partially_damaged" },
  { label: "Minimal or No Damage", value: "minimal_or_no_damage" },
];

const INFRASTRUCTURE_TYPE_OPTIONS = [
  "Residential Infrastructure",
  "Commercial Infrastructure",
  "Government Building",
  "Utility Infrastructure",
  "Transport and Communication Infrastructure",
  "Community Infrastructure",
  "Public Spaces and Recreation Infrastructure",
  "Other",
];

const CRISIS_TYPE_OPTIONS = [
  "Earthquake", "Flood", "Tsunami", "Hurricane or Cyclone",
  "Wildfire", "Explosion", "Chemical Incident", "Conflict", "Civil Unrest",
];

// ── Filter state ──────────────────────────────────────────────────────────────

interface FilterState {
  search: string;
  flagStatuses: FlagStatus[];
  dateFrom: string;
  dateTo: string;
  country: string;
  damageLevels: string[];
  infrastructureTypes: string[];
  crisisTypes: string[];
}

const EMPTY_FILTERS: FilterState = {
  search: "",
  flagStatuses: [],
  dateFrom: "",
  dateTo: "",
  country: "",
  damageLevels: [],
  infrastructureTypes: [],
  crisisTypes: [],
};

function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.search) n++;
  if (f.flagStatuses.length > 0) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.country) n++;
  if (f.damageLevels.length > 0) n++;
  if (f.infrastructureTypes.length > 0) n++;
  if (f.crisisTypes.length > 0) n++;
  return n;
}

// ── Status icon (filled SVG matching Material Symbols style) ──────────────────

function StatusIcon({ status }: { status: FlagStatus }) {
  const sz = 20;
  switch (status) {
    case "green":
      return (
        <svg width={sz} height={sz} viewBox="0 0 24 24" fill="#005a2c">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5-5-5 1.41-1.41L10 13.67l7.59-7.59L19 7.5l-9 9z"/>
        </svg>
      );
    case "orange":
      return (
        <svg width={sz} height={sz} viewBox="0 0 24 24" fill="#f97316">
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
        </svg>
      );
    case "red":
      return (
        <svg width={sz} height={sz} viewBox="0 0 24 24" fill="#ba1a1a">
          <path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/>
        </svg>
      );
    case "grey":
      return (
        <svg width={sz} height={sz} viewBox="0 0 24 24" fill="#717782">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
        </svg>
      );
    default:
      return (
        <svg width={sz} height={sz} viewBox="0 0 24 24" fill="#616161">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/>
        </svg>
      );
  }
}

// ── Pagination range helper ───────────────────────────────────────────────────

function buildPageRange(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "...", total];
  if (current >= total - 3) return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "...", current - 1, current, current + 1, "...", total];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const navigate = useNavigate();

  // Filters
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [activeFilterChip, setActiveFilterChip] = useState<string | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  // ref to avoid stale closures in the outside-click effect
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // Row selection
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  // Pagination
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorStack = useRef<string[]>([]);

  // Close chip dropdowns when clicking outside the filter bar
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (filterBarRef.current && !filterBarRef.current.contains(e.target as Node)) {
        setActiveFilterChip(null);
        setPendingFilters(filtersRef.current);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  // Build query params from current applied filters + pagination state
  const queryParams = useCallback((): Record<string, string> => {
    const p: Record<string, string> = { limit: String(pageSize) };
    if (filters.search) p.q = filters.search;
    // Send comma-separated list when multiple statuses selected.
    // When none selected, send nothing — backend excludes discarded by default.
    if (filters.flagStatuses.length > 0) p.flag_status = filters.flagStatuses.join(",");
    if (filters.dateFrom) p.date_from = filters.dateFrom;
    if (filters.dateTo) p.date_to = filters.dateTo;
    if (filters.country) p.country = filters.country;
    if (filters.damageLevels.length > 0) p.damage_level = filters.damageLevels.join(",");
    if (filters.infrastructureTypes.length > 0) p.infrastructure_type = filters.infrastructureTypes.join(",");
    if (filters.crisisTypes.length > 0) p.crisis_type = filters.crisisTypes.join(",");
    if (cursor) p.cursor = cursor;
    return p;
  }, [filters, pageSize, cursor]);

  const { data, isLoading } = useQuery<ReportListResponse>({
    queryKey: ["reports", filters, pageSize, cursor],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/reports", { params: queryParams() });
      return response.data;
    },
  });

  // Fetch status-level counts for the stat cards (no pagination, just counts per flag)
  const { data: statsData } = useQuery<{ counts: Record<string, number>; total: number }>({
    queryKey: ["reports-stats", filters],
    queryFn: async () => {
      const baseParams: Record<string, string> = { limit: "1" };
      if (filters.search) baseParams.q = filters.search;
      if (filters.country) baseParams.country = filters.country;
      if (filters.dateFrom) baseParams.date_from = filters.dateFrom;
      if (filters.dateTo) baseParams.date_to = filters.dateTo;
      if (filters.damageLevels.length > 0) baseParams.damage_level = filters.damageLevels.join(",");
      if (filters.infrastructureTypes.length > 0) baseParams.infrastructure_type = filters.infrastructureTypes.join(",");
      if (filters.crisisTypes.length > 0) baseParams.crisis_type = filters.crisisTypes.join(",");

      const statuses = ["green", "orange", "red", "grey", "discarded"];
      const results = await Promise.all(
        statuses.map(async (s) => {
          const res = await api.get<ReportListResponse>("/api/dashboard/reports", {
            params: { ...baseParams, flag_status: s },
          });
          return [s, res.data.total] as [string, number];
        })
      );
      const counts: Record<string, number> = Object.fromEntries(results);
      return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
    staleTime: 1000 * 30,
  });

  // ── Pagination handlers ────────────────────────────────────────────────────

  function handleNextPage() {
    if (!data?.has_more || !data.cursor) return;
    cursorStack.current.push(cursor ?? "");
    setCursor(data.cursor);
    setPage((p) => p + 1);
  }

  function handlePrevPage() {
    if (page <= 1) return;
    const prev = cursorStack.current.pop() ?? null;
    setCursor(prev);
    setPage((p) => p - 1);
  }

  function handlePageSizeChange(newSize: number) {
    cursorStack.current = [];
    setCursor(null);
    setPage(1);
    setPageSize(newSize);
  }

  function resetPagination() {
    cursorStack.current = [];
    setCursor(null);
    setPage(1);
  }

  // ── Filter chip handlers ───────────────────────────────────────────────────

  function openChip(id: string) {
    if (activeFilterChip === id) {
      setActiveFilterChip(null);
      setPendingFilters(filtersRef.current); // discard unsaved pending changes
    } else {
      setPendingFilters(filtersRef.current); // start fresh from current applied state
      setActiveFilterChip(id);
    }
  }

  function applyFilters() {
    setFilters(pendingFilters);
    resetPagination();
    setActiveFilterChip(null);
  }

  function clearAllFilters() {
    setFilters(EMPTY_FILTERS);
    setPendingFilters(EMPTY_FILTERS);
    resetPagination();
    setActiveFilterChip(null);
  }

  function toggleFlagStatus(flag: FlagStatus) {
    setPendingFilters((prev) => {
      const has = prev.flagStatuses.includes(flag);
      return {
        ...prev,
        flagStatuses: has ? prev.flagStatuses.filter((f) => f !== flag) : [...prev.flagStatuses, flag],
      };
    });
  }

  function toggleDamageLevel(value: string) {
    setPendingFilters((prev) => {
      const has = prev.damageLevels.includes(value);
      return { ...prev, damageLevels: has ? prev.damageLevels.filter((v) => v !== value) : [...prev.damageLevels, value] };
    });
  }

  function toggleInfrastructureType(value: string) {
    setPendingFilters((prev) => {
      const has = prev.infrastructureTypes.includes(value);
      return { ...prev, infrastructureTypes: has ? prev.infrastructureTypes.filter((v) => v !== value) : [...prev.infrastructureTypes, value] };
    });
  }

  function toggleCrisisType(value: string) {
    setPendingFilters((prev) => {
      const has = prev.crisisTypes.includes(value);
      return { ...prev, crisisTypes: has ? prev.crisisTypes.filter((v) => v !== value) : [...prev.crisisTypes, value] };
    });
  }

  // ── Row interaction ────────────────────────────────────────────────────────

  function openReport(id: string) {
    window.open(`/reports/${id}`, "_blank");
  }

  function toggleRow(id: string) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllRows() {
    const ids = (data?.items ?? []).map((r) => r.id);
    if (selectedRows.size === ids.length && ids.length > 0) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(ids));
    }
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  const activeCount = countActiveFilters(filters);
  const items = data?.items ?? [];
  const startRecord = data ? (page - 1) * pageSize + 1 : 0;
  const endRecord = data ? (page - 1) * pageSize + items.length : 0;
  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;
  const allSelected = items.length > 0 && selectedRows.size === items.length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      <Header
        title="Reports"
        subtitle={data ? `${data.total.toLocaleString()} total reports` : ""}
      />

      <div style={styles.content}>

        {/* ── Top action row ───────────────────────────────────────────── */}
        <div style={styles.topActionRow}>
          <div style={styles.topActionLeft}>
            <button style={styles.exportBtn} onClick={() => navigate("/export")}>
              <Download size={15} />
              Export
            </button>
            <select
              style={styles.pageSizeSelect}
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} per page</option>
              ))}
            </select>
          </div>
          <span style={styles.totalMeta}>
            {data
              ? `Showing ${startRecord.toLocaleString()}–${endRecord.toLocaleString()} of ${data.total.toLocaleString()} reports`
              : ""}
          </span>
        </div>

        {/* ── Filter bar card ──────────────────────────────────────────── */}
        <div ref={filterBarRef} style={styles.filterCard}>
          <div style={styles.filterRow}>

            {/* Search */}
            <div style={styles.searchWrapper}>
              <Search size={18} color="#717782" style={{ flexShrink: 0 }} />
              <input
                type="text"
                style={styles.searchInput}
                placeholder="Search report ID, reporter..."
                value={pendingFilters.search}
                onChange={(e) => setPendingFilters((p) => ({ ...p, search: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }}
              />
            </div>

            {/* Chip filters */}
            <div style={styles.chipsGroup}>

              {/* Flag Status */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...(filters.flagStatuses.length > 0 ? styles.chipActive : {}) }}
                  onClick={() => openChip("flag")}
                >
                  {filters.flagStatuses.length > 0 && (
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#005a2c", display: "inline-block" }} />
                  )}
                  Flag Status
                  {filters.flagStatuses.length > 0 && (
                    <span style={styles.chipBadge}>{filters.flagStatuses.length}</span>
                  )}
                  <ChevronDown size={12} />
                </button>
                {activeFilterChip === "flag" && (
                  <div style={styles.chipDropdown}>
                    <div style={styles.dropdownTitle}>Flag Status</div>
                    {(["grey", "green", "orange", "red", "discarded"] as FlagStatus[]).map((flag) => (
                      <label key={flag} style={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={pendingFilters.flagStatuses.includes(flag)}
                          onChange={() => toggleFlagStatus(flag)}
                        />
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: FLAG_COLORS[flag], display: "inline-block", flexShrink: 0 }} />
                        {flag.charAt(0).toUpperCase() + flag.slice(1)}
                      </label>
                    ))}
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Damage Level */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...(filters.damageLevels.length > 0 ? styles.chipActive : {}) }}
                  onClick={() => openChip("damage")}
                >
                  Damage Level
                  {filters.damageLevels.length > 0 && (
                    <span style={styles.chipBadge}>{filters.damageLevels.length}</span>
                  )}
                  <ChevronDown size={12} />
                </button>
                {activeFilterChip === "damage" && (
                  <div style={styles.chipDropdown}>
                    <div style={styles.dropdownTitle}>Damage Level</div>
                    {DAMAGE_LEVEL_OPTIONS.map(({ label, value }) => (
                      <label key={value} style={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={pendingFilters.damageLevels.includes(value)}
                          onChange={() => toggleDamageLevel(value)}
                        />
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: DAMAGE_PILL[value]?.color ?? "#9ca3af", display: "inline-block", flexShrink: 0 }} />
                        {label}
                      </label>
                    ))}
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Infrastructure */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...(filters.infrastructureTypes.length > 0 ? styles.chipActive : {}) }}
                  onClick={() => openChip("infra")}
                >
                  Infrastructure
                  {filters.infrastructureTypes.length > 0 && (
                    <span style={styles.chipBadge}>{filters.infrastructureTypes.length}</span>
                  )}
                  <ChevronDown size={12} />
                </button>
                {activeFilterChip === "infra" && (
                  <div style={{ ...styles.chipDropdown, minWidth: 284 }}>
                    <div style={styles.dropdownTitle}>Infrastructure Type</div>
                    {INFRASTRUCTURE_TYPE_OPTIONS.map((type) => (
                      <label key={type} style={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={pendingFilters.infrastructureTypes.includes(type)}
                          onChange={() => toggleInfrastructureType(type)}
                        />
                        {type}
                      </label>
                    ))}
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Crisis Type */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...(filters.crisisTypes.length > 0 ? styles.chipActive : {}) }}
                  onClick={() => openChip("crisis")}
                >
                  Crisis Type
                  {filters.crisisTypes.length > 0 && (
                    <span style={styles.chipBadge}>{filters.crisisTypes.length}</span>
                  )}
                  <ChevronDown size={12} />
                </button>
                {activeFilterChip === "crisis" && (
                  <div style={styles.chipDropdown}>
                    <div style={styles.dropdownTitle}>Crisis Type</div>
                    {CRISIS_TYPE_OPTIONS.map((type) => (
                      <label key={type} style={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={pendingFilters.crisisTypes.includes(type)}
                          onChange={() => toggleCrisisType(type)}
                        />
                        {type}
                      </label>
                    ))}
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Date Range */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...((filters.dateFrom || filters.dateTo) ? styles.chipActive : {}) }}
                  onClick={() => openChip("date")}
                >
                  Date Range
                  {(filters.dateFrom || filters.dateTo) && <span style={styles.chipBadge}>✓</span>}
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </button>
                {activeFilterChip === "date" && (
                  <div style={{ ...styles.chipDropdown, minWidth: 260 }}>
                    <div style={styles.dropdownTitle}>Date Range</div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={styles.dateLabel}>From</div>
                      <input
                        type="date"
                        style={styles.dateInput}
                        value={pendingFilters.dateFrom}
                        onChange={(e) => setPendingFilters((p) => ({ ...p, dateFrom: e.target.value }))}
                      />
                    </div>
                    <div style={{ marginBottom: 2 }}>
                      <div style={styles.dateLabel}>To</div>
                      <input
                        type="date"
                        style={styles.dateInput}
                        value={pendingFilters.dateTo}
                        onChange={(e) => setPendingFilters((p) => ({ ...p, dateTo: e.target.value }))}
                      />
                    </div>
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Country */}
              <div style={{ position: "relative" }}>
                <button
                  style={{ ...styles.chip, ...(filters.country ? styles.chipActive : {}) }}
                  onClick={() => openChip("country")}
                >
                  Country
                  {filters.country && <span style={styles.chipBadge}>✓</span>}
                  <ChevronDown size={12} />
                </button>
                {activeFilterChip === "country" && (
                  <div style={{ ...styles.chipDropdown, minWidth: 220 }}>
                    <div style={styles.dropdownTitle}>Country</div>
                    <input
                      type="text"
                      style={styles.dateInput}
                      placeholder="e.g. TR, SY, PK"
                      value={pendingFilters.country}
                      onChange={(e) => setPendingFilters((p) => ({ ...p, country: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") applyFilters(); }}
                    />
                    <div style={styles.dropdownFooter}>
                      <button style={styles.applyBtn} onClick={applyFilters}>Apply</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Clear all */}
              {activeCount > 0 && (
                <button style={styles.clearChip} onClick={clearAllFilters}>
                  <X size={11} />
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Summary stat cards ───────────────────────────────────────── */}
        <div style={styles.statsGrid}>
          <div style={{ ...styles.statCard, borderLeft: "4px solid #00508a" }}>
            <p style={styles.statLabel}>Total Reports</p>
            <span style={styles.statValue}>{statsData ? statsData.total.toLocaleString() : (data ? data.total.toLocaleString() : "—")}</span>
            <p style={styles.statSub}>All statuses</p>
          </div>
          <div style={{ ...styles.statCard, borderLeft: "4px solid #005a2c" }}>
            <p style={styles.statLabel}>Green Flagged</p>
            <span style={{ ...styles.statValue, color: "#005a2c" }}>
              {statsData ? statsData.counts.green.toLocaleString() : "—"}
            </span>
            <p style={styles.statSub}>Verified &amp; safe</p>
          </div>
          <div style={{ ...styles.statCard, borderLeft: "4px solid #f97316" }}>
            <p style={styles.statLabel}>Orange Flagged</p>
            <span style={{ ...styles.statValue, color: "#f97316" }}>
              {statsData ? statsData.counts.orange.toLocaleString() : "—"}
            </span>
            <p style={styles.statSub}>Manually approved</p>
          </div>
          <div style={{ ...styles.statCard, borderLeft: "4px solid #ba1a1a", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <p style={styles.statLabel}>Red Flagged</p>
              <span style={{ ...styles.statValue, color: "#ba1a1a" }}>
                {statsData ? statsData.counts.red.toLocaleString() : "—"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
              <span style={styles.statSub}>Pending review</span>
              <a href="/review-queue" style={styles.reviewNowLink}>Review Now</a>
            </div>
          </div>
        </div>

        {/* ── Table + pagination ───────────────────────────────────────── */}
        {isLoading ? (
          <div style={styles.loading}>Loading reports…</div>
        ) : (
          <div style={styles.tableCard}>
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr style={styles.theadRow}>
                    <th style={{ ...styles.th, width: 48, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAllRows}
                        style={{ cursor: "pointer" }}
                      />
                    </th>
                    <th style={styles.th}>Report ID</th>
                    <th style={styles.th}>Date &amp; Time</th>
                    <th style={styles.th}>Country</th>
                    <th style={styles.th}>Damage Level</th>
                    <th style={styles.th}>Infrastructure Type</th>
                    <th style={styles.th}>Crisis Type</th>
                    <th style={{ ...styles.th, textAlign: "center" }}>Status</th>
                    <th style={styles.th}>Reporter ID</th>
                    <th style={{ ...styles.th, width: 48 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((report: ReportListItem) => {
                    const flagColor = FLAG_COLORS[report.flag_status];
                    const isSelected = selectedRows.has(report.id);
                    const dmg = DAMAGE_PILL[report.damage_level];
                    return (
                      <tr
                        key={report.id}
                        style={{
                          ...styles.tableRow,
                          borderLeft: `4px solid ${flagColor}`,
                          background: isSelected ? "rgba(0,80,138,0.04)" : undefined,
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLElement).style.background = "#f0f6ff";
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.background = isSelected
                            ? "rgba(0,80,138,0.04)"
                            : "";
                        }}
                        onClick={() => openReport(report.id)}
                      >
                        {/* Checkbox */}
                        <td
                          style={{ ...styles.td, textAlign: "center" }}
                          onClick={(e) => { e.stopPropagation(); toggleRow(report.id); }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(report.id)}
                            style={{ cursor: "pointer" }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>

                        {/* Report ID */}
                        <td style={styles.td}>
                          <span style={styles.idLink} title={report.id}>
                            {report.serial_number != null
                              ? `#${report.serial_number}`
                              : report.id.slice(0, 8).toUpperCase()}
                          </span>
                        </td>

                        {/* Date / Time */}
                        <td style={styles.td}>
                          <span style={styles.dateCell}>{formatDateTime(report.submitted_at)}</span>
                        </td>

                        {/* Country */}
                        <td style={styles.td}>
                          <span style={styles.countryCell}>{report.country ?? "—"}</span>
                        </td>

                        {/* Damage Level */}
                        <td style={styles.td}>
                          {dmg ? (
                            <span style={{
                              background: dmg.bg,
                              color: dmg.color,
                              padding: "2px 10px",
                              borderRadius: 20,
                              fontSize: 10,
                              fontWeight: 700,
                              whiteSpace: "nowrap",
                            }}>
                              {dmg.label}
                            </span>
                          ) : (
                            <span style={{ color: "#717782", fontSize: 12 }}>
                              {formatDamageLevel(report.damage_level)}
                            </span>
                          )}
                        </td>

                        {/* Infrastructure Type */}
                        <td style={{ ...styles.td, fontSize: 12, color: "#414751" }}>
                          {report.infrastructure_type}
                        </td>

                        {/* Crisis Type */}
                        <td style={{ ...styles.td, fontSize: 12, color: "#414751" }}>
                          {report.disaster_type ?? "—"}
                        </td>

                        {/* Status icon */}
                        <td style={{ ...styles.td, textAlign: "center" }}>
                          <StatusIcon status={report.flag_status} />
                        </td>

                        {/* Reporter ID */}
                        <td
                          style={styles.td}
                          onClick={(e) => {
                            if (report.reporter_id) {
                              e.stopPropagation();
                              window.open(`/reporters/${report.reporter_id}`, "_blank");
                            }
                          }}
                        >
                          {report.reporter_id ? (
                            <span style={styles.reporterLink}>
                              {report.reporter_display_id != null
                                ? `#${report.reporter_display_id}`
                                : report.reporter_id.slice(0, 8).toUpperCase()}
                            </span>
                          ) : (
                            <span style={{ fontSize: 13, color: "#9ca3af" }}>—</span>
                          )}
                        </td>

                        {/* View action */}
                        <td
                          style={{ ...styles.td, textAlign: "center" }}
                          onClick={(e) => { e.stopPropagation(); openReport(report.id); }}
                        >
                          <span style={styles.eyeBtn}>
                            <Eye size={16} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={10} style={styles.emptyCell}>No reports found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination inside the table card */}
            <div style={styles.paginationBar}>
              <span style={styles.paginationMeta}>
                {data
                  ? `Showing ${startRecord.toLocaleString()} to ${endRecord.toLocaleString()} of ${data.total.toLocaleString()} results`
                  : ""}
              </span>
              <div style={styles.pageButtons}>
                <button
                  style={{
                    ...styles.pageNavBtn,
                    opacity: page <= 1 ? 0.4 : 1,
                    cursor: page <= 1 ? "not-allowed" : "pointer",
                  }}
                  disabled={page <= 1}
                  onClick={handlePrevPage}
                >
                  <ChevronLeft size={18} />
                </button>

                {totalPages > 0 && buildPageRange(page, totalPages).map((p, i) =>
                  p === "..." ? (
                    <span key={`ellipsis-${i}`} style={styles.pageEllipsis}>…</span>
                  ) : (
                    <button
                      key={p}
                      style={{
                        ...styles.pageNumBtn,
                        ...(p === page ? styles.pageNumBtnActive : {}),
                      }}
                      onClick={() => {
                        if (p === page) return;
                        if ((p as number) === page + 1) handleNextPage();
                        else if ((p as number) === page - 1) handlePrevPage();
                      }}
                    >
                      {p}
                    </button>
                  )
                )}

                <button
                  style={{
                    ...styles.pageNavBtn,
                    opacity: !data?.has_more ? 0.4 : 1,
                    cursor: !data?.has_more ? "not-allowed" : "pointer",
                  }}
                  disabled={!data?.has_more}
                  onClick={handleNextPage}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: {
    flex: 1,
    padding: "24px 32px",
    overflow: "auto",
    background: "#f4f6f9",
  },

  // Top action row
  topActionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  topActionLeft: { display: "flex", alignItems: "center", gap: 12 },
  exportBtn: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 18px",
    background: "#00508a",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    boxShadow: "0 2px 8px rgba(0,80,138,0.18)",
    transition: "opacity 0.1s",
  },
  pageSizeSelect: {
    padding: "7px 12px",
    background: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    color: "#191c1e",
    cursor: "pointer",
    boxShadow: "0 1px 4px rgba(8,27,57,0.06)",
    outline: "none",
  },
  totalMeta: { fontSize: 13, fontWeight: 500, color: "#717782" },

  // Filter bar card
  filterCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "16px 20px",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
    marginBottom: 20,
  },
  filterRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  searchWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#f2f4f7",
    borderRadius: 8,
    padding: "8px 14px",
    flexGrow: 1,
    maxWidth: 380,
    minWidth: 180,
  },
  searchInput: {
    border: "none",
    outline: "none",
    background: "transparent",
    fontSize: 13,
    color: "#191c1e",
    width: "100%",
  },
  chipsGroup: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 13px",
    background: "#e6e8eb",
    border: "none",
    borderRadius: 9999,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: "#191c1e",
    whiteSpace: "nowrap",
    transition: "background 0.12s",
  },
  chipActive: {
    background: "#d2e4ff",
    color: "#00508a",
  },
  chipBadge: {
    background: "#00508a",
    color: "#fff",
    borderRadius: 20,
    padding: "1px 5px",
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1.6,
  },
  clearChip: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
    color: "#00508a",
    padding: "6px 8px",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },

  // Chip dropdowns
  chipDropdown: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 8px 32px rgba(8,27,57,0.14), 0 2px 8px rgba(8,27,57,0.06)",
    zIndex: 200,
    padding: "14px 16px",
    minWidth: 210,
  },
  dropdownTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#717782",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#191c1e",
    marginBottom: 8,
    cursor: "pointer",
  },
  dropdownFooter: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1px solid #f0f4f8",
  },
  applyBtn: {
    width: "100%",
    padding: "7px",
    background: "#00508a",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },
  dateLabel: {
    fontSize: 10,
    color: "#717782",
    fontWeight: 700,
    marginBottom: 5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  dateInput: {
    width: "100%",
    padding: "7px 10px",
    border: "1px solid #e6e8eb",
    borderRadius: 7,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
    color: "#191c1e",
  },

  // Stat cards
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 20,
    marginBottom: 20,
  },
  statCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  statLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "#717782",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 6,
    marginTop: 0,
  },
  statValue: {
    fontSize: 28,
    fontWeight: 800,
    color: "#191c1e",
    lineHeight: 1.1,
  },
  statSub: {
    fontSize: 10,
    color: "#717782",
    marginTop: 4,
    marginBottom: 0,
  },
  reviewNowLink: {
    fontSize: 10,
    fontWeight: 700,
    color: "#ba1a1a",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    whiteSpace: "nowrap",
  },

  // Table
  emptyState: {
    padding: "56px 20px",
    textAlign: "center",
    color: "#717782",
    fontSize: 14,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  loading: {
    padding: 56,
    textAlign: "center",
    color: "#717782",
    fontSize: 14,
  },
  tableCard: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  theadRow: {
    background: "#f2f4f7",
    borderBottom: "1px solid rgba(193,199,210,0.25)",
  },
  th: {
    padding: "14px 16px",
    textAlign: "left",
    fontSize: 10,
    fontWeight: 800,
    color: "#717782",
    textTransform: "uppercase",
    letterSpacing: 0.9,
    whiteSpace: "nowrap",
  },
  tableRow: {
    borderBottom: "1px solid #f2f4f7",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  td: {
    padding: "12px 16px",
    fontSize: 13,
    color: "#191c1e",
    verticalAlign: "middle",
  },
  emptyCell: {
    padding: 48,
    textAlign: "center",
    color: "#717782",
    fontSize: 14,
  },

  // Cell styles
  idLink: {
    color: "#00508a",
    fontWeight: 700,
    fontFamily: "monospace",
    fontSize: 12,
    cursor: "pointer",
  },
  dateCell: { color: "#717782", whiteSpace: "nowrap", fontSize: 12 },
  countryCell: { fontWeight: 600, fontSize: 13 },
  reporterLink: {
    color: "#717782",
    fontFamily: "monospace",
    fontSize: 12,
    cursor: "pointer",
  },
  anonymousCell: { color: "#9ca3af", fontSize: 12, fontStyle: "italic" },
  eyeBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 5,
    borderRadius: 6,
    color: "#717782",
    cursor: "pointer",
    transition: "background 0.1s",
  },

  // Pagination bar inside table card
  paginationBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    borderTop: "1px solid rgba(193,199,210,0.15)",
    background: "#fff",
  },
  paginationMeta: { fontSize: 12, fontWeight: 500, color: "#717782" },
  pageButtons: { display: "flex", alignItems: "center", gap: 2 },
  pageNavBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    background: "none",
    border: "none",
    borderRadius: 4,
    color: "#717782",
    transition: "background 0.1s",
  },
  pageNumBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    background: "none",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: "#191c1e",
    transition: "background 0.1s",
  },
  pageNumBtnActive: {
    background: "#00508a",
    color: "#fff",
    cursor: "default",
    borderRadius: 4,
  },
  pageEllipsis: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    fontSize: 12,
    color: "#717782",
  },
};
