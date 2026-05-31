import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import { CheckCircle, AlertTriangle } from "lucide-react";
import Header from "../components/Header";
import api, { getReviewQueueCounts } from "../services/api";
import type { ReviewQueueCounts } from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

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

const PIE_COLORS: Record<string, string> = {
  "Completely Destroyed": "#F44336",
  "Partially Damaged": "#FF9800",
  "Minimal or No Damage": "#4CAF50",
};

const PIE_LABEL_MAP: Record<string, string> = {
  complete: "Completely Destroyed",
  partial: "Partially Damaged",
  minimal: "Minimal or No Damage",
};

const TOP_COUNTRIES = 10;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ActiveProject {
  serial_id: string;
  name: string;
}

interface Filters {
  country: string[];
  dateFrom: string;
  dateTo: string;
  crisisType: string[];
}

interface CountryOption {
  code: string;
  name: string;
  is_active: boolean;
}

interface AnalyticsSummary {
  total_reports: number;
  total_properties: number;
  completely_damaged: number;
  partially_damaged: number;
  minimal_damage: number;
}

interface TimePoint {
  date: string;
  count: number;
}

interface DistPoint {
  level: string;
  count: number;
}

interface InfraPoint {
  infrastructure_type: string;
  count: number;
}

interface CountryPoint {
  country: string;
  count: number;
}

interface CrisisTypePoint {
  crisis_type: string;
  count: number;
}

interface FlagQualityItem {
  flag_type: string;
  total_raised: number;
  cleared_count: number;
  cleared_percentage: number;
  discard_reason_count: number;
  discard_reason_percentage: number;
  inconclusive_count: number;
  inconclusive_percentage: number;
}

interface FlagQualityResponse {
  total_reviewed: number;
  items: FlagQualityItem[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS: Filters = {
  country: [],
  dateFrom: "",
  dateTo: "",
  crisisType: [],
};

function filtersToParams(f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.country.length > 0) p.country = f.country.join(",");
  if (f.dateFrom) p.date_from = f.dateFrom;
  if (f.dateTo) p.date_to = f.dateTo;
  if (f.crisisType.length > 0) p.crisis_type = f.crisisType.join(",");
  return p;
}

function getDefaultDateRange(granularity: "daily" | "weekly"): { date_from: string; date_to: string } {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const daysBack = granularity === "daily" ? 30 : 84;
  const from = new Date(today);
  from.setDate(from.getDate() - daysBack);
  return { date_from: from.toISOString().split("T")[0], date_to: todayStr };
}

function fmtDayLabel(value: unknown): string {
  const isoDate = value as string;
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtWeekLabel(value: unknown): string {
  const isoDate = value as string;
  const [y, m, d] = isoDate.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 6);
  const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (start.getMonth() === end.getMonth()) {
    return `${startStr}–${end.getDate()}`;
  }
  return `${startStr}–${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function countPct(count: number, pct: number): string {
  return `${count} (${pct.toFixed(0)}%)`;
}

// ── Multi-select dropdown ──────────────────────────────────────────────────────

interface MultiSelectOption {
  id: string;
  name: string;
}

interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (vals: string[]) => void;
  placeholder: string;
}

function MultiSelectDropdown({ label, options, selected, onChange, placeholder }: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const buttonText =
    selected.length === 0
      ? placeholder
      : selected.length === 1
      ? options.find((o) => o.id === selected[0])?.name ?? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={ref} style={s.filterField}>
      <label className="section-label" style={{ marginRight: 4 }}>{label}</label>
      <button
        type="button"
        style={{ ...s.filterSelect, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, textAlign: "left" as const }}>
          {buttonText}
        </span>
        <span style={{ fontSize: 9, color: "var(--c-text-muted)", flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={s.dropdownPanel}>
          {options.map((opt) => (
            <label key={opt.id} style={s.dropdownItem}>
              <input
                type="checkbox"
                checked={selected.includes(opt.id)}
                onChange={() => toggle(opt.id)}
                style={{ marginRight: 8, accentColor: BLUE }}
              />
              {opt.name}
            </label>
          ))}
          {options.length === 0 && (
            <div style={{ padding: "8px 12px", color: "var(--c-text-subtle)", fontSize: 13 }}>Loading…</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small shared components ────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
      <div
        style={{
          width: 32,
          height: 32,
          border: "3px solid var(--c-surface-high)",
          borderTop: `3px solid ${BLUE}`,
          borderRadius: "50%",
          animation: "an-spin 0.8s linear infinite",
        }}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "40px 0", color: "var(--c-text-subtle)", fontSize: 14 }}>
      No data available for the selected filters.
    </div>
  );
}

interface ChartCardProps {
  title: string;
  subtitle?: string;
  loading: boolean;
  empty: boolean;
  children: React.ReactNode;
  fullWidth?: boolean;
  headerRight?: React.ReactNode;
  footnote?: string;
}

function ChartCard({ title, subtitle, loading, empty, children, headerRight, footnote }: ChartCardProps) {
  return (
    <div style={s.chartCard}>
      <div style={{ ...s.chartCardHeader, justifyContent: "space-between", flexDirection: "row", alignItems: "flex-start" }}>
        <div>
          <div style={s.chartTitle}>{title}</div>
          {subtitle && <div style={s.chartSubtitle}>{subtitle}</div>}
        </div>
        {headerRight && <div>{headerRight}</div>}
      </div>
      {loading ? <Spinner /> : empty ? <EmptyState /> : children}
      {footnote && (
        <div style={s.footnote}>{footnote}</div>
      )}
    </div>
  );
}

// ── Pie label renderer ─────────────────────────────────────────────────────────

const renderPieLabel = ({ value, percent }: { value: number; percent?: number }) => {
  const pct = percent ?? 0;
  return `${value} (${(pct * 100).toFixed(0)}%)`;
};

// ── Main component ─────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [granularity, setGranularity] = useState<"daily" | "weekly">("daily");
  const [pending, setPending] = useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);
  const [showAllCountries, setShowAllCountries] = useState(false);

  function applyFilters() {
    setApplied({ ...pending });
  }

  function clearAll() {
    setPending(DEFAULT_FILTERS);
    setApplied(DEFAULT_FILTERS);
  }

  function removeFilterKey(key: keyof Filters) {
    const reset: Filters = {
      ...pending,
      [key]: Array.isArray(pending[key]) ? [] : "",
    };
    setPending(reset);
    setApplied(reset);
  }

  const { data: countriesRaw = [] } = useQuery<CountryOption[]>({
    queryKey: ["analytics-countries"],
    queryFn: () => api.get<CountryOption[]>("/api/countries").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const countryOptions: MultiSelectOption[] = countriesRaw.map((c) => ({
    id: c.code,
    name: c.name,
  }));

  const crisisTypeOptions: MultiSelectOption[] = CRISIS_TYPE_OPTIONS.map((t) => ({
    id: t,
    name: t,
  }));

  const params = filtersToParams(applied);

  // Summary
  const { data: summary, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", applied],
    queryFn: () =>
      api.get<AnalyticsSummary>("/api/analytics/summary", { params }).then((r) => r.data),
  });

  // Reports over time — uses default date window when no date filter active
  const defaultRange = getDefaultDateRange(granularity);
  const timeParams: Record<string, string> = {
    ...params,
    granularity,
    ...(applied.dateFrom || applied.dateTo
      ? {}
      : { date_from: defaultRange.date_from, date_to: defaultRange.date_to }),
  };

  const { data: timeData = [], isLoading: timeLoading } = useQuery<TimePoint[]>({
    queryKey: ["analytics-time", applied, granularity],
    queryFn: () =>
      api.get<TimePoint[]>("/api/analytics/reports-over-time", { params: timeParams }).then((r) => r.data),
  });

  // Damage distribution
  const { data: distRaw = [], isLoading: distLoading } = useQuery<DistPoint[]>({
    queryKey: ["analytics-dist", applied],
    queryFn: () =>
      api.get<DistPoint[]>("/api/analytics/damage-distribution", { params }).then((r) => {
        // Transform the distribution object to array for Recharts
        const d = r.data as unknown as {
          completely_damaged: number;
          partially_damaged: number;
          minimal_damage: number;
        };
        return [
          { level: "complete", count: d.completely_damaged },
          { level: "partial", count: d.partially_damaged },
          { level: "minimal", count: d.minimal_damage },
        ];
      }),
  });

  // Infrastructure breakdown
  const { data: infraData = [], isLoading: infraLoading } = useQuery<InfraPoint[]>({
    queryKey: ["analytics-infra", applied],
    queryFn: () =>
      api.get<InfraPoint[]>("/api/analytics/infrastructure-breakdown", { params }).then((r) => r.data),
  });

  // Country breakdown
  const { data: countryData = [], isLoading: countryLoading } = useQuery<CountryPoint[]>({
    queryKey: ["analytics-country", applied],
    queryFn: () =>
      api.get<CountryPoint[]>("/api/analytics/country-breakdown", { params }).then((r) => r.data),
  });

  // Crisis type breakdown
  const { data: crisisTypeData = [], isLoading: crisisTypeLoading } = useQuery<CrisisTypePoint[]>({
    queryKey: ["analytics-crisis-type", applied],
    queryFn: () =>
      api
        .get<CrisisTypePoint[]>("/api/analytics/crisis-type-breakdown", { params })
        .then((r) => r.data),
  });

  // Review queue counts — always live, never filtered
  const { data: reviewCounts } = useQuery<ReviewQueueCounts>({
    queryKey: ["review-queue-counts"],
    queryFn: async () => {
      const res = await getReviewQueueCounts();
      return res.data as ReviewQueueCounts;
    },
    refetchInterval: 20000,
    staleTime: 0,
  });

  // Active projects — for the project analytics shortcut strip
  const { data: activeProjects = [] } = useQuery<ActiveProject[]>({
    queryKey: ["analytics-active-projects"],
    queryFn: () =>
      api
        .get<ActiveProject[]>("/api/dashboard/projects", { params: { status: "active", limit: 10 } })
        .then((r) => r.data),
    staleTime: 60000,
  });

  // Flag quality
  const { data: flagQuality, isLoading: flagQualityLoading } = useQuery<FlagQualityResponse>({
    queryKey: ["analytics-flag-quality", applied],
    queryFn: () =>
      api
        .get<FlagQualityResponse>("/api/analytics/flag-quality", { params })
        .then((r) => r.data),
  });

  // Normalise pie data
  const distData = distRaw
    .map((d) => ({ ...d, level: PIE_LABEL_MAP[d.level] ?? d.level }))
    .filter((d) => d.count > 0);

  // Active filter tags
  const hasFilters =
    applied.country.length > 0 ||
    applied.dateFrom !== "" ||
    applied.dateTo !== "" ||
    applied.crisisType.length > 0;

  const tags: { key: keyof Filters; label: string }[] = [];
  if (applied.country.length > 0) {
    const names = applied.country
      .map((code) => countryOptions.find((c) => c.id === code)?.name ?? code)
      .join(", ");
    tags.push({ key: "country", label: `Country: ${names}` });
  }
  if (applied.dateFrom) tags.push({ key: "dateFrom", label: `From: ${applied.dateFrom}` });
  if (applied.dateTo) tags.push({ key: "dateTo", label: `To: ${applied.dateTo}` });
  if (applied.crisisType.length > 0) {
    tags.push({ key: "crisisType", label: `Type: ${applied.crisisType.join(", ")}` });
  }

  const scopeLabel = hasFilters ? tags.map((t) => t.label).join(" · ") : "All confirmed reports";

  const countryBarHeight = Math.max(200, countryData.length * 36);
  const infraBarHeight = Math.max(200, infraData.length * 36);
  const crisisBarHeight = Math.max(200, crisisTypeData.length * 36);

  const displayedCountriesCompact = showAllCountries
    ? countryData
    : countryData.slice(0, TOP_COUNTRIES);

  const tab1Count = reviewCounts?.tab1_count ?? 0;
  const tab2Count = reviewCounts?.tab2_count ?? 0;
  const actionAllClear = tab1Count === 0 && tab2Count === 0;

  const flagQualityTotal = flagQuality?.total_reviewed ?? 0;
  const flagQualityItems = flagQuality?.items ?? [];
  const FLAG_QUALITY_THRESHOLD = 50;

  return (
    <div style={s.page}>
      <style>{`@keyframes an-spin { to { transform: rotate(360deg); } }`}</style>

      <Header title="Analytics and Statistics" subtitle="Crisis damage statistics" />

      <div style={s.content}>
        {/* ── Filter bar ── */}
        <div style={s.filterCard}>
          <div style={s.filterRow}>
            <MultiSelectDropdown
              label="Country"
              options={countryOptions}
              selected={pending.country}
              onChange={(vals) => setPending((p) => ({ ...p, country: vals }))}
              placeholder="All countries"
            />

            <div style={s.filterField}>
              <label className="section-label" style={{ marginRight: 4 }}>Start Date</label>
              <input
                type="date"
                style={s.filterInput}
                value={pending.dateFrom}
                onChange={(e) => setPending((p) => ({ ...p, dateFrom: e.target.value }))}
              />
            </div>

            <div style={s.filterField}>
              <label className="section-label" style={{ marginRight: 4 }}>End Date</label>
              <input
                type="date"
                style={s.filterInput}
                value={pending.dateTo}
                onChange={(e) => setPending((p) => ({ ...p, dateTo: e.target.value }))}
              />
            </div>

            <MultiSelectDropdown
              label="Crisis Type"
              options={crisisTypeOptions}
              selected={pending.crisisType}
              onChange={(vals) => setPending((p) => ({ ...p, crisisType: vals }))}
              placeholder="All crisis types"
            />

            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <button style={s.applyBtn} onClick={applyFilters}>
                Apply Filters
              </button>
              {hasFilters && (
                <button style={s.clearBtn} onClick={clearAll}>
                  Clear All
                </button>
              )}
            </div>
          </div>

          {tags.length > 0 && (
            <div style={s.tagRow}>
              {tags.map((tag) => (
                <span key={tag.key} className="chip chip-blue" style={{ marginRight: 6 }}>
                  {tag.label}
                  <button
                    style={s.tagRemove}
                    onClick={() => removeFilterKey(tag.key)}
                    aria-label={`Remove ${tag.label}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div style={s.filterNote}>
            Showing confirmed reports only — Grey and Red flagged reports are excluded from all statistics.
          </div>
        </div>

        {/* ── Summary cards ── */}
        <div style={s.summaryGrid}>
          {[
            { label: "Total Reports", value: summary?.total_reports },
            { label: "Total Properties Reported", value: summary?.total_properties },
            { label: "Completely Destroyed", value: summary?.completely_damaged, accent: "#F44336" },
            { label: "Partially Damaged", value: summary?.partially_damaged, accent: "#FF9800" },
            { label: "Minimal or No Damage", value: summary?.minimal_damage, accent: "#4CAF50" },
          ].map((card) => (
            <div key={card.label} style={s.summaryCard}>
              <div style={{ ...s.summaryAccent, background: card.accent ?? BLUE }} />
              <div style={s.summaryBody}>
                <div style={s.summaryNumber}>
                  {summaryLoading ? "—" : (card.value ?? 0).toLocaleString()}
                </div>
                <div style={s.summaryLabel}>{card.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Project Analytics shortcut strip ── */}
        {activeProjects.length > 0 && (
          <div style={s.projectStripWrap}>
            <div style={s.projectStripLabel}>Project Analytics</div>
            <div style={s.projectStrip}>
              {activeProjects.map((project) => (
                <button
                  key={project.serial_id}
                  onClick={() => navigate("/projects/" + project.serial_id)}
                  style={s.projectCard}
                >
                  <span style={s.projectSerial}>{project.serial_id}</span>
                  <span style={s.projectName}>{project.name}</span>
                  <span style={s.projectArrow}>→</span>
                </button>
              ))}
            </div>
            <div style={s.projectStripNote}>
              Each project page includes analytics scoped to that project's reports.
            </div>
          </div>
        )}

        {/* ── Compact breakdowns ── */}
        <div style={s.twoCol}>
          {/* Crisis type compact */}
          <div style={s.compactCard}>
            <div style={s.compactTitle}>Reports by Crisis Type</div>
            {crisisTypeLoading ? (
              <Spinner />
            ) : crisisTypeData.length === 0 ? (
              <EmptyState />
            ) : (
              <div style={s.compactList}>
                {crisisTypeData.map((row) => (
                  <div key={row.crisis_type} style={s.compactRow}>
                    <span style={s.compactLabel}>{row.crisis_type}</span>
                    <span style={s.compactCount}>{row.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Country compact */}
          <div style={s.compactCard}>
            <div style={s.compactTitle}>Reports by Country</div>
            {countryLoading ? (
              <Spinner />
            ) : countryData.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                <div style={s.compactList}>
                  {displayedCountriesCompact.map((row) => (
                    <div key={row.country} style={s.compactRow}>
                      <span style={s.compactLabel}>{row.country}</span>
                      <span style={s.compactCount}>{row.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
                {countryData.length > TOP_COUNTRIES && (
                  <button
                    style={s.showAllBtn}
                    onClick={() => setShowAllCountries((v) => !v)}
                  >
                    {showAllCountries
                      ? "Show fewer"
                      : `Show all (${countryData.length})`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Action indicator cards ── */}
        <div style={s.twoCol}>
          <button
            style={{ ...s.actionCard, ...(actionAllClear ? s.actionCardClear : s.actionCardAlert) }}
            onClick={() => navigate("/review-queue")}
          >
            {actionAllClear ? (
              <>
                <CheckCircle size={20} color="#38A169" />
                <div style={s.actionBody}>
                  <div style={{ ...s.actionCount, color: "#38A169" }}>0</div>
                  <div style={s.actionLabel}>Red-flagged reports pending review</div>
                  <div style={s.actionSub}>All clear — Review Queue</div>
                </div>
              </>
            ) : (
              <>
                <AlertTriangle size={20} color="#E65100" />
                <div style={s.actionBody}>
                  <div style={{ ...s.actionCount, color: "#E65100" }}>{tab1Count.toLocaleString()}</div>
                  <div style={s.actionLabel}>Red-flagged reports pending review</div>
                  <div style={s.actionSub}>Awaiting human review in Review Queue</div>
                </div>
              </>
            )}
          </button>

          <button
            style={{ ...s.actionCard, ...(actionAllClear ? s.actionCardClear : s.actionCardAlert) }}
            onClick={() => navigate("/review-queue")}
          >
            {actionAllClear ? (
              <>
                <CheckCircle size={20} color="#38A169" />
                <div style={s.actionBody}>
                  <div style={{ ...s.actionCount, color: "#38A169" }}>0</div>
                  <div style={s.actionLabel}>Properties pending review</div>
                  <div style={s.actionSub}>All clear — Review Queue</div>
                </div>
              </>
            ) : (
              <>
                <AlertTriangle size={20} color="#E65100" />
                <div style={s.actionBody}>
                  <div style={{ ...s.actionCount, color: "#E65100" }}>{tab2Count.toLocaleString()}</div>
                  <div style={s.actionLabel}>Properties pending review</div>
                  <div style={s.actionSub}>Conflict warnings or manually flagged</div>
                </div>
              </>
            )}
          </button>
        </div>

        {/* ── Export button ── */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            className="btn btn-secondary"
            style={{ marginTop: 16 }}
            onClick={() =>
              navigate("/export", {
                state: {
                  prefill: {
                    country: applied.country,
                    date_from: applied.dateFrom,
                    date_to: applied.dateTo,
                    crisis_type: applied.crisisType,
                  },
                },
              })
            }
          >
            Export Data →
          </button>
        </div>

        {/* ── Reports Over Time (full width) ── */}
        <div style={s.chartCard}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={s.chartTitle}>Reports Over Time</div>
              <div style={s.chartSubtitle}>{scopeLabel}</div>
            </div>
            <div style={s.toggleGroup}>
              <button
                style={{ ...s.toggleBtn, ...(granularity === "daily" ? s.toggleActive : {}) }}
                onClick={() => setGranularity("daily")}
              >
                Daily
              </button>
              <button
                style={{ ...s.toggleBtn, ...(granularity === "weekly" ? s.toggleActive : {}) }}
                onClick={() => setGranularity("weekly")}
              >
                Weekly
              </button>
            </div>
          </div>
          {timeLoading ? (
            <Spinner />
          ) : timeData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={timeData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e8eb" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={granularity === "weekly" ? fmtWeekLabel : fmtDayLabel}
                  tick={{ fontSize: 11, fill: "#717782" }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#717782" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  labelFormatter={granularity === "weekly" ? fmtWeekLabel : fmtDayLabel}
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e6e8eb", background: "#ffffff" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Damage Distribution + Country ── */}
        <div style={s.twoCol}>
          <ChartCard
            title="Damage Level Distribution"
            subtitle={scopeLabel}
            loading={distLoading}
            empty={distData.length === 0}
          >
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={distData}
                  dataKey="count"
                  nameKey="level"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={renderPieLabel}
                  labelLine
                >
                  {distData.map((entry) => (
                    <Cell
                      key={entry.level}
                      fill={PIE_COLORS[entry.level] ?? "#94a3b8"}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e6e8eb", background: "#ffffff" }}
                />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Reports by Country"
            subtitle={scopeLabel}
            loading={countryLoading}
            empty={countryData.length === 0}
          >
            <ResponsiveContainer width="100%" height={Math.max(260, countryBarHeight)}>
              <BarChart
                data={countryData}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e8eb" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#717782" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="country"
                  tick={{ fontSize: 12, fill: "#414751" }}
                  tickLine={false}
                  width={110}
                />
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e6e8eb", background: "#ffffff" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[0, 3, 3, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* ── Infrastructure + Crisis Type ── */}
        <div style={s.twoCol}>
          <ChartCard
            title="Infrastructure Type Breakdown"
            subtitle={scopeLabel}
            loading={infraLoading}
            empty={infraData.length === 0}
            footnote="A single report may be counted in multiple categories if more than one infrastructure type was selected."
          >
            <ResponsiveContainer width="100%" height={Math.max(260, infraBarHeight)}>
              <BarChart
                data={infraData}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e8eb" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#717782" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="infrastructure_type"
                  tick={{ fontSize: 11, fill: "#414751" }}
                  tickLine={false}
                  width={200}
                />
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e6e8eb", background: "#ffffff" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[0, 3, 3, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Reports by Crisis Type"
            subtitle={scopeLabel}
            loading={crisisTypeLoading}
            empty={crisisTypeData.length === 0}
          >
            <ResponsiveContainer width="100%" height={Math.max(260, crisisBarHeight)}>
              <BarChart
                data={crisisTypeData}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e8eb" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#717782" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="crisis_type"
                  tick={{ fontSize: 12, fill: "#414751" }}
                  tickLine={false}
                  width={150}
                />
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e6e8eb", background: "#ffffff" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[0, 3, 3, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* ── Flag Quality section ── */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="card-header">
            <span style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--c-text-primary)" }}>
              Flag Quality — Automatic Check Performance
            </span>
          </div>

          {flagQualityLoading ? (
            <div style={{ padding: "0 24px 20px" }}><Spinner /></div>
          ) : flagQualityTotal < FLAG_QUALITY_THRESHOLD ? (
            <div style={{ padding: "0 24px 20px" }}>
              <div style={s.flagQualityNote}>
                Insufficient data — flag quality statistics require at least {FLAG_QUALITY_THRESHOLD} reviewed
                reports. Currently: {flagQualityTotal} reviewed.
              </div>
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" as const }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      {["Flag Type", "Total Raised", "Cleared by Reviewer", "Recorded as Discard Reason", "Inconclusive"].map(
                        (col) => (
                          <th key={col}>
                            {col}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {flagQualityItems.map((row) => (
                      <tr key={row.flag_type}>
                        <td>{row.flag_type}</td>
                        <td style={{ textAlign: "right" as const, fontWeight: 600 }}>
                          {row.total_raised}
                        </td>
                        <td style={{ textAlign: "right" as const }}>
                          {countPct(row.cleared_count, row.cleared_percentage)}
                        </td>
                        <td style={{ textAlign: "right" as const }}>
                          {countPct(row.discard_reason_count, row.discard_reason_percentage)}
                        </td>
                        <td style={{ textAlign: "right" as const }}>
                          {countPct(row.inconclusive_count, row.inconclusive_percentage)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={s.flagQualityFootnote}>
                This data reflects reviewer decisions made in the Review Queue. Use it to identify which
                automatic checks are producing reliable signals versus frequent false positives, and adjust
                flag thresholds in Dashboard Settings accordingly.
              </div>
            </>
          )}
        </div>
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
    gap: 24,
  },
  // Filter card
  filterCard: {
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderRadius: "var(--radius-lg)",
    padding: "12px 20px",
    boxShadow: "var(--shadow-sm)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  filterRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 16,
    flexWrap: "wrap",
  },
  filterField: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    minWidth: 150,
    position: "relative",
  },
  filterSelect: {
    padding: "8px 10px",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid var(--c-surface-high)",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    minWidth: 150,
    height: 36,
  },
  filterInput: {
    padding: "8px 10px",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid var(--c-surface-high)",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    height: 36,
  },
  applyBtn: {
    padding: "9px 20px",
    background: "var(--c-primary-container)",
    color: "var(--c-on-primary)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    height: 36,
  },
  clearBtn: {
    padding: "9px 16px",
    background: "transparent",
    color: "var(--c-text-muted)",
    border: "1.5px solid var(--c-surface-high)",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    height: 36,
  },
  dropdownPanel: {
    position: "absolute",
    top: "100%",
    left: 0,
    minWidth: 200,
    maxWidth: 280,
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-surface-high)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
    zIndex: 200,
    maxHeight: 260,
    overflowY: "auto",
    marginTop: 2,
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    cursor: "pointer",
    borderBottom: "1px solid var(--c-surface-low)",
  },
  tagRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  tagRemove: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--c-primary-container)",
    fontSize: 15,
    lineHeight: 1,
    padding: 0,
    display: "flex",
    alignItems: "center",
  },
  filterNote: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    background: "rgba(4,104,177,0.06)",
    borderRadius: "var(--radius-md)",
    padding: "8px 14px",
  },
  // Summary cards
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 16,
    marginBottom: 0,
  },
  summaryCard: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-sm)",
    display: "flex",
    overflow: "hidden",
  },
  summaryAccent: {
    width: 5,
    flexShrink: 0,
  },
  summaryBody: {
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  summaryNumber: {
    fontSize: 30,
    fontWeight: 800,
    color: "var(--c-text-primary)",
    lineHeight: 1,
  },
  summaryLabel: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    fontWeight: 500,
  },
  // Compact breakdowns
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
  },
  compactCard: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-sm)",
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  compactTitle: {
    fontSize: "var(--text-sm)",
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  compactList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  compactRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    borderBottom: "1px solid var(--c-border-ghost)",
    fontSize: 13,
  },
  compactLabel: {
    color: "var(--c-text-secondary)",
  },
  compactCount: {
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  showAllBtn: {
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
    textAlign: "left",
  },
  // Action cards
  actionCard: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    borderRadius: "var(--radius-lg)",
    padding: "16px 20px",
    cursor: "pointer",
    border: "none",
    textAlign: "left",
    width: "100%",
  },
  actionCardAlert: {
    background: "#FFF3E0",
    border: "1.5px solid #FFCC80",
  },
  actionCardClear: {
    background: "#F0FFF4",
    border: "1.5px solid #9AE6B4",
  },
  actionBody: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  actionCount: {
    fontSize: 28,
    fontWeight: 800,
    lineHeight: 1,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-text-primary)",
  },
  actionSub: {
    fontSize: 12,
    color: "var(--c-text-muted)",
  },
  // Project analytics strip
  projectStripWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  projectStripLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-subtle)",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  projectStrip: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  projectCard: {
    padding: "8px 16px",
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxShadow: "var(--shadow-sm)",
  },
  projectSerial: {
    color: "var(--c-primary-container)",
    fontWeight: 600,
    fontFamily: "monospace",
  },
  projectName: {
    color: "var(--c-text-secondary)",
  },
  projectArrow: {
    color: "var(--c-text-subtle)",
    fontSize: 11,
  },
  projectStripNote: {
    fontSize: 12,
    color: "var(--c-text-subtle)",
    fontStyle: "italic",
  },
  // Toggle group
  toggleGroup: {
    display: "flex",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid var(--c-surface-high)",
    overflow: "hidden",
  },
  toggleBtn: {
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    background: "var(--c-surface-low)",
    border: "none",
    cursor: "pointer",
    color: "var(--c-text-muted)",
  },
  toggleActive: {
    background: "var(--c-primary-container)",
    color: "var(--c-on-primary)",
  },
  // Charts
  chartCard: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-sm)",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  chartCardHeader: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  chartTitle: {
    fontSize: "var(--text-base)",
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  chartSubtitle: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
  },
  footnote: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    fontStyle: "italic",
    paddingTop: 4,
  },
  // Flag quality
  flagQualityNote: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-muted)",
    background: "var(--c-surface-low)",
    borderRadius: "var(--radius-md)",
    padding: "14px 16px",
    border: "1px solid var(--c-surface-high)",
  },
  flagQualityFootnote: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    padding: "12px 24px 20px",
    lineHeight: 1.6,
  },
};
