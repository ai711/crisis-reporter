import { useState, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter, X, ChevronLeft, ChevronRight } from "lucide-react";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { ReportListItem, FlagStatus, ReportListResponse } from "../types";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";

// ── Constants ─────────────────────────────────────────────────────────────────

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#9e9e9e",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
  discarded: "#616161",
};

const PAGE_SIZE_OPTIONS = [100, 200, 300, 400, 500];

// ── Constants ─────────────────────────────────────────────────────────────────

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
  "Earthquake",
  "Flood",
  "Tsunami",
  "Hurricane or Cyclone",
  "Wildfire",
  "Explosion",
  "Chemical Incident",
  "Conflict",
  "Civil Unrest",
];

// ── Filter state ──────────────────────────────────────────────────────────────

interface FilterState {
  flagStatuses: FlagStatus[];
  dateFrom: string;
  dateTo: string;
  country: string;
  damageLevels: string[];
  infrastructureTypes: string[];
  crisisTypes: string[];
}

const EMPTY_FILTERS: FilterState = {
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
  if (f.flagStatuses.length > 0) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.country) n++;
  if (f.damageLevels.length > 0) n++;
  if (f.infrastructureTypes.length > 0) n++;
  if (f.crisisTypes.length > 0) n++;
  return n;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { activeCrisisId } = useAuthStore();

  // Filters
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);

  // Pagination state
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorStack = useRef<string[]>([]); // stack of previous cursors

  // Build query params from current filter + pagination state
  const queryParams = useCallback((): Record<string, string> => {
    const p: Record<string, string> = { limit: String(pageSize) };
    if (activeCrisisId) p.crisis_id = activeCrisisId;
    if (filters.flagStatuses.length === 1) p.flag_status = filters.flagStatuses[0];
    if (filters.dateFrom) p.date_from = filters.dateFrom;
    if (filters.dateTo) p.date_to = filters.dateTo;
    if (filters.country) p.country = filters.country;
    if (filters.damageLevels.length > 0) p.damage_level = filters.damageLevels.join(",");
    if (filters.infrastructureTypes.length > 0) p.infrastructure_type = filters.infrastructureTypes.join(",");
    if (filters.crisisTypes.length > 0) p.crisis_type = filters.crisisTypes.join(",");
    if (cursor) p.cursor = cursor;
    return p;
  }, [activeCrisisId, filters, pageSize, cursor]);

  const { data, isLoading } = useQuery<ReportListResponse>({
    queryKey: ["reports", activeCrisisId, filters, pageSize, cursor],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/reports", { params: queryParams() });
      return response.data;
    },
    enabled: !!activeCrisisId,
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

  // ── Filter handlers ────────────────────────────────────────────────────────

  function applyFilters() {
    setFilters(pendingFilters);
    resetPagination();
    setFilterOpen(false);
  }

  function clearAllFilters() {
    setFilters(EMPTY_FILTERS);
    setPendingFilters(EMPTY_FILTERS);
    resetPagination();
    setFilterOpen(false);
  }

  function toggleFlagStatus(flag: FlagStatus) {
    setPendingFilters((prev) => {
      const has = prev.flagStatuses.includes(flag);
      return {
        ...prev,
        flagStatuses: has
          ? prev.flagStatuses.filter((f) => f !== flag)
          : [...prev.flagStatuses, flag],
      };
    });
  }

  function toggleDamageLevel(value: string) {
    setPendingFilters((prev) => {
      const has = prev.damageLevels.includes(value);
      return {
        ...prev,
        damageLevels: has ? prev.damageLevels.filter((v) => v !== value) : [...prev.damageLevels, value],
      };
    });
  }

  function toggleInfrastructureType(value: string) {
    setPendingFilters((prev) => {
      const has = prev.infrastructureTypes.includes(value);
      return {
        ...prev,
        infrastructureTypes: has ? prev.infrastructureTypes.filter((v) => v !== value) : [...prev.infrastructureTypes, value],
      };
    });
  }

  function toggleCrisisType(value: string) {
    setPendingFilters((prev) => {
      const has = prev.crisisTypes.includes(value);
      return {
        ...prev,
        crisisTypes: has ? prev.crisisTypes.filter((v) => v !== value) : [...prev.crisisTypes, value],
      };
    });
  }

  const activeCount = countActiveFilters(filters);

  // ── Open filter panel synced with current applied filters ─────────────────
  function openFilterPanel() {
    setPendingFilters(filters);
    setFilterOpen(true);
  }

  // ── Row click → open detail in new tab ────────────────────────────────────
  function openReport(id: string) {
    window.open(`/reports/${id}`, "_blank");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      <Header
        title="Reports Page"
        subtitle={data ? `${data.total.toLocaleString()} total reports` : ""}
      />

      <div style={styles.content}>

        {/* ── Toolbar ──────────────────────────────────────────────────── */}
        <div style={styles.toolbar}>
          <div style={styles.toolbarLeft}>
            <button style={styles.filterBtn} onClick={openFilterPanel}>
              <Filter size={15} />
              <span>Filters</span>
              {activeCount > 0 && (
                <span style={styles.filterBadge}>{activeCount} active</span>
              )}
            </button>
            {activeCount > 0 && (
              <button style={styles.clearBtn} onClick={clearAllFilters}>
                <X size={13} />
                Clear all filters
              </button>
            )}
          </div>

          {/* Active flag chips */}
          {filters.flagStatuses.map((f) => (
            <span
              key={f}
              style={{
                ...styles.flagChip,
                background: FLAG_COLORS[f] + "20",
                color: FLAG_COLORS[f],
                borderColor: FLAG_COLORS[f] + "60",
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <button
                style={styles.chipRemove}
                onClick={() => {
                  const next = { ...filters, flagStatuses: filters.flagStatuses.filter((x) => x !== f) };
                  setFilters(next);
                  resetPagination();
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>

        {/* ── Filter panel ─────────────────────────────────────────────── */}
        {filterOpen && (
          <>
            <div style={styles.overlay} onClick={() => setFilterOpen(false)} />
            <div style={styles.filterPanel}>
              <div style={styles.filterPanelHeader}>
                <span style={styles.filterPanelTitle}>Filters</span>
                <button style={styles.filterPanelClose} onClick={() => setFilterOpen(false)}>
                  <X size={16} />
                </button>
              </div>

              {/* Flag status */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Flag Status</div>
                {(["grey", "green", "orange", "red", "discarded"] as FlagStatus[]).map((flag) => (
                  <label key={flag} style={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.flagStatuses.includes(flag)}
                      onChange={() => toggleFlagStatus(flag)}
                      style={{ marginRight: 8 }}
                    />
                    <span
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: FLAG_COLORS[flag],
                        marginRight: 6,
                      }}
                    />
                    {flag.charAt(0).toUpperCase() + flag.slice(1)}
                  </label>
                ))}
              </div>

              {/* Date range */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Date Range</div>
                <div style={styles.dateRow}>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={pendingFilters.dateFrom}
                    onChange={(e) =>
                      setPendingFilters((p) => ({ ...p, dateFrom: e.target.value }))
                    }
                    placeholder="From"
                  />
                  <span style={{ color: "#999", fontSize: 12 }}>to</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={pendingFilters.dateTo}
                    onChange={(e) =>
                      setPendingFilters((p) => ({ ...p, dateTo: e.target.value }))
                    }
                    placeholder="To"
                  />
                </div>
              </div>

              {/* Country */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Country</div>
                <input
                  type="text"
                  style={styles.textInput}
                  placeholder="e.g. US, GB, UA"
                  value={pendingFilters.country}
                  onChange={(e) =>
                    setPendingFilters((p) => ({ ...p, country: e.target.value }))
                  }
                />
              </div>

              {/* Damage Level */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Damage Level</div>
                {DAMAGE_LEVEL_OPTIONS.map(({ label, value }) => (
                  <label key={value} style={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.damageLevels.includes(value)}
                      onChange={() => toggleDamageLevel(value)}
                      style={{ marginRight: 8 }}
                    />
                    {label}
                  </label>
                ))}
              </div>

              {/* Infrastructure Type */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Infrastructure Type</div>
                {INFRASTRUCTURE_TYPE_OPTIONS.map((type) => (
                  <label key={type} style={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.infrastructureTypes.includes(type)}
                      onChange={() => toggleInfrastructureType(type)}
                      style={{ marginRight: 8 }}
                    />
                    {type}
                  </label>
                ))}
              </div>

              {/* Crisis Type */}
              <div style={styles.filterSection}>
                <div style={styles.filterSectionLabel}>Crisis Type</div>
                {CRISIS_TYPE_OPTIONS.map((type) => (
                  <label key={type} style={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={pendingFilters.crisisTypes.includes(type)}
                      onChange={() => toggleCrisisType(type)}
                      style={{ marginRight: 8 }}
                    />
                    {type}
                  </label>
                ))}
              </div>

              {/* Project — disabled; handled by header dropdown */}
              <div style={styles.filterSection}>
                <div
                  style={{ ...styles.filterSectionLabel, color: "#bbb" }}
                  title="Use the project dropdown in the header to filter by project."
                >
                  Project
                  <span style={styles.disabledTag}>Use header dropdown</span>
                </div>
              </div>

              <div style={styles.filterActions}>
                <button style={styles.applyBtn} onClick={applyFilters}>
                  Apply Filters
                </button>
                <button style={styles.clearBtnAlt} onClick={clearAllFilters}>
                  Clear All
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Table ────────────────────────────────────────────────────── */}
        {isLoading ? (
          <div style={styles.loading}>Loading reports...</div>
        ) : (
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <th style={styles.th}>Report ID</th>
                  <th style={styles.th}>Date / Time</th>
                  <th style={styles.th}>Country</th>
                  <th style={styles.th}>Damage Level</th>
                  <th style={styles.th}>Infrastructure Type</th>
                  <th style={styles.th}>Crisis Type</th>
                  <th style={styles.th}>Flag Status</th>
                  <th style={styles.th}>Reporter ID</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((report: ReportListItem) => (
                  <tr
                    key={report.id}
                    style={styles.tableRow}
                    onClick={() => openReport(report.id)}
                  >
                    {/* Report ID — clickable */}
                    <td style={styles.td} onClick={(e) => { e.stopPropagation(); openReport(report.id); }}>
                      <span style={styles.idLink} title={report.id}>
                        {report.serial_number != null ? `#${report.serial_number}` : report.id.slice(0, 8).toUpperCase()}
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
                      {formatDamageLevel(report.damage_level)}
                    </td>

                    {/* Infrastructure Type */}
                    <td style={styles.td}>{report.infrastructure_type}</td>

                    {/* Crisis Type */}
                    <td style={styles.td}>{report.disaster_type ?? "—"}</td>

                    {/* Flag Status pill */}
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.flagPill,
                          background: FLAG_COLORS[report.flag_status] + "20",
                          color: FLAG_COLORS[report.flag_status],
                          borderColor: FLAG_COLORS[report.flag_status] + "50",
                        }}
                      >
                        {report.flag_status.charAt(0).toUpperCase() + report.flag_status.slice(1)}
                      </span>
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
                        <span style={styles.anonymousCell}>Anonymous</span>
                      )}
                    </td>
                  </tr>
                ))}
                {(data?.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={8} style={styles.emptyCell}>
                      No reports found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination bar ────────────────────────────────────────────── */}
        <div style={styles.pagination}>
          <div style={styles.pageSizeRow}>
            <span style={styles.pageMeta}>
              {data ? `${data.total.toLocaleString()} total reports` : ""}
            </span>
            <label style={styles.pageSizeLabel}>
              Rows per page:
              <select
                style={styles.pageSizeSelect}
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={styles.pageControls}>
            <button
              style={{
                ...styles.pageBtn,
                opacity: page <= 1 ? 0.4 : 1,
                cursor: page <= 1 ? "not-allowed" : "pointer",
              }}
              disabled={page <= 1}
              onClick={handlePrevPage}
            >
              <ChevronLeft size={16} />
              Previous
            </button>

            <span style={styles.pageIndicator}>Page {page}</span>

            <button
              style={{
                ...styles.pageBtn,
                opacity: !data?.has_more ? 0.4 : 1,
                cursor: !data?.has_more ? "not-allowed" : "pointer",
              }}
              disabled={!data?.has_more}
              onClick={handleNextPage}
            >
              Next
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "20px 28px", overflow: "auto", position: "relative" },

  // Toolbar
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  toolbarLeft: { display: "flex", alignItems: "center", gap: 8 },
  filterBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    background: "#fff",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    color: "#1A2B4A",
  },
  filterBadge: {
    background: "#0468B1",
    color: "#fff",
    borderRadius: 20,
    padding: "1px 7px",
    fontSize: 11,
    fontWeight: 600,
    marginLeft: 2,
  },
  clearBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 12px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    color: "#666",
  },
  flagChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    borderRadius: 20,
    border: "1px solid",
    fontSize: 12,
    fontWeight: 500,
  },
  chipRemove: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    color: "inherit",
    opacity: 0.7,
  },

  // Filter panel
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 199,
  },
  filterPanel: {
    position: "absolute",
    top: 52,
    left: 0,
    width: 320,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
    border: "1px solid #e0e8f0",
    zIndex: 200,
    padding: "16px 20px",
  },
  filterPanelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  filterPanelTitle: { fontSize: 14, fontWeight: 700, color: "#1A2B4A" },
  filterPanelClose: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#666",
    padding: 2,
    display: "flex",
  },
  filterSection: { marginBottom: 16 },
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  disabledTag: {
    fontSize: 10,
    background: "#f0f0f0",
    color: "#999",
    padding: "1px 6px",
    borderRadius: 4,
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "#333",
    marginBottom: 6,
    cursor: "pointer",
  },
  dateRow: { display: "flex", alignItems: "center", gap: 8 },
  dateInput: {
    flex: 1,
    padding: "6px 8px",
    border: "1px solid #d0dce8",
    borderRadius: 6,
    fontSize: 12,
    outline: "none",
  },
  textInput: {
    width: "100%",
    padding: "7px 10px",
    border: "1px solid #d0dce8",
    borderRadius: 6,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  },
  filterActions: {
    display: "flex",
    gap: 8,
    marginTop: 4,
    paddingTop: 14,
    borderTop: "1px solid #f0f0f0",
  },
  applyBtn: {
    flex: 1,
    padding: "8px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  clearBtnAlt: {
    padding: "8px 14px",
    background: "#f4f6f9",
    color: "#333",
    border: "none",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
  },

  // Table
  loading: { padding: 40, textAlign: "center", color: "#666" },
  tableWrapper: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e8eef4",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  tableHeader: { background: "#f4f6f9" },
  th: {
    padding: "11px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e0e8f0",
    whiteSpace: "nowrap",
  },
  tableRow: {
    borderBottom: "1px solid #f0f4f8",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  td: { padding: "12px 14px", fontSize: 13, color: "#1A2B4A" },
  emptyCell: { padding: 40, textAlign: "center", color: "#999", fontSize: 14 },

  // Cell content
  idLink: {
    color: "#0468B1",
    fontWeight: 600,
    fontFamily: "monospace",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  dateCell: { color: "#444", whiteSpace: "nowrap" },
  countryCell: { fontWeight: 500 },
  flagPill: {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid",
  },
  reporterLink: {
    color: "#0468B1",
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  anonymousCell: { color: "#999", fontSize: 12, fontStyle: "italic" },

  // Pagination
  pagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 2px",
    flexWrap: "wrap",
    gap: 12,
  },
  pageSizeRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  pageMeta: { fontSize: 13, color: "#666" },
  pageSizeLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#555",
  },
  pageSizeSelect: {
    padding: "4px 8px",
    border: "1px solid #d0dce8",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    background: "#fff",
  },
  pageControls: { display: "flex", alignItems: "center", gap: 8 },
  pageBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "7px 14px",
    background: "#fff",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: "#1A2B4A",
    transition: "all 0.12s",
  },
  pageIndicator: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A2B4A",
    padding: "0 8px",
  },
};
