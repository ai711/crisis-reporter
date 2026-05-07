import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
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
import Header from "../components/Header";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

const CRISIS_TYPES = [
  "All",
  "Earthquake",
  "Flood",
  "Tsunami",
  "Hurricane/Cyclone",
  "Wildfire",
  "Explosion",
  "Chemical Incident",
  "Conflict",
  "Civil Unrest",
];

const PIE_COLORS: Record<string, string> = {
  "Completely Damaged": "#E53E3E",
  "Partially Damaged": "#F57C00",
  "Minimal / No Damage": "#38A169",
  complete: "#E53E3E",
  partial: "#F57C00",
  minimal: "#38A169",
};

const PIE_LABEL_MAP: Record<string, string> = {
  complete: "Completely Damaged",
  partial: "Partially Damaged",
  minimal: "Minimal / No Damage",
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface Filters {
  country: string;
  dateFrom: string;
  dateTo: string;
  crisisType: string;
}

interface Country {
  id: string;
  name: string;
}

interface AnalyticsSummary {
  total_reports: number;
  total_properties: number;
  completely_damaged: number;
  partially_damaged: number;
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
  type: string;
  count: number;
}

interface CountryPoint {
  country: string;
  count: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS: Filters = {
  country: "",
  dateFrom: "",
  dateTo: "",
  crisisType: "All",
};

function filtersToParams(f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.country) p.country = f.country;
  if (f.dateFrom) p.date_from = f.dateFrom;
  if (f.dateTo) p.date_to = f.dateTo;
  if (f.crisisType !== "All") p.crisis_type = f.crisisType;
  return p;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Small components ───────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
      <div
        style={{
          width: 32,
          height: 32,
          border: "3px solid #e2e8f0",
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
    <div style={{ textAlign: "center", padding: "40px 0", color: "#a0aec0", fontSize: 14 }}>
      No data available for the selected filters.
    </div>
  );
}

interface ChartCardProps {
  title: string;
  subtitle: string;
  loading: boolean;
  empty: boolean;
  children: React.ReactNode;
}

function ChartCard({ title, subtitle, loading, empty, children }: ChartCardProps) {
  return (
    <div style={s.chartCard}>
      <div style={s.chartCardHeader}>
        <div style={s.chartTitle}>{title}</div>
        <div style={s.chartSubtitle}>{subtitle}</div>
      </div>
      {loading ? <Spinner /> : empty ? <EmptyState /> : children}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const navigate = useNavigate();

  // Pending (in-progress edits) vs applied (used for queries)
  const [pending, setPending] = useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);

  function applyFilters() {
    setApplied({ ...pending });
  }

  function removeTag(key: keyof Filters) {
    const reset = { ...pending, [key]: key === "crisisType" ? "All" : "" };
    setPending(reset);
    setApplied(reset);
  }

  // Countries for dropdown
  const { data: countries = [] } = useQuery<Country[]>({
    queryKey: ["analytics-countries"],
    queryFn: () => api.get<Country[]>("/api/countries").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const params = filtersToParams(applied);

  // Summary
  const { data: summary, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["analytics-summary", applied],
    queryFn: () =>
      api.get<AnalyticsSummary>("/api/analytics/summary", { params }).then((r) => r.data),
  });

  // Reports over time
  const { data: timeData = [], isLoading: timeLoading } = useQuery<TimePoint[]>({
    queryKey: ["analytics-time", applied],
    queryFn: () =>
      api
        .get<TimePoint[]>("/api/analytics/reports-over-time", { params })
        .then((r) => r.data),
  });

  // Damage distribution
  const { data: distRaw = [], isLoading: distLoading } = useQuery<DistPoint[]>({
    queryKey: ["analytics-dist", applied],
    queryFn: () =>
      api
        .get<DistPoint[]>("/api/analytics/damage-distribution", { params })
        .then((r) => r.data),
  });

  // Infrastructure breakdown
  const { data: infraData = [], isLoading: infraLoading } = useQuery<InfraPoint[]>({
    queryKey: ["analytics-infra", applied],
    queryFn: () =>
      api
        .get<InfraPoint[]>("/api/analytics/infrastructure-breakdown", { params })
        .then((r) => r.data),
  });

  // Country breakdown
  const { data: countryData = [], isLoading: countryLoading } = useQuery<CountryPoint[]>({
    queryKey: ["analytics-country", applied],
    queryFn: () =>
      api
        .get<CountryPoint[]>("/api/analytics/country-breakdown", { params })
        .then((r) => r.data),
  });

  // Normalise pie data labels
  const distData = distRaw.map((d) => ({
    ...d,
    level: PIE_LABEL_MAP[d.level] ?? d.level,
  }));

  // Active filter tags
  const tags: { key: keyof Filters; label: string }[] = [];
  if (applied.country) {
    const name = countries.find((c) => c.id === applied.country)?.name ?? applied.country;
    tags.push({ key: "country", label: `Country: ${name}` });
  }
  if (applied.dateFrom) tags.push({ key: "dateFrom", label: `From: ${applied.dateFrom}` });
  if (applied.dateTo) tags.push({ key: "dateTo", label: `To: ${applied.dateTo}` });
  if (applied.crisisType !== "All")
    tags.push({ key: "crisisType", label: `Type: ${applied.crisisType}` });

  const scopeLabel =
    tags.length === 0
      ? "All reports"
      : tags.map((t) => t.label).join(" · ");

  const SUMMARY_CARDS = [
    { label: "Total Reports", value: summary?.total_reports },
    { label: "Total Properties Affected", value: summary?.total_properties },
    { label: "Completely Damaged", value: summary?.completely_damaged },
    { label: "Partially Damaged", value: summary?.partially_damaged },
  ];

  const countryBarHeight = Math.max(240, countryData.length * 36);

  return (
    <div style={s.page}>
      <style>{`@keyframes an-spin { to { transform: rotate(360deg); } }`}</style>

      <Header title="Analytics" subtitle="Crisis damage statistics" />

      <div style={s.content}>
        {/* ── Top bar ── */}
        <div style={s.topBar}>
          <h2 style={s.pageTitle}>Damage Analytics</h2>
          <button style={s.exportBtn} onClick={() => navigate("/export")}>
            Export Data →
          </button>
        </div>

        {/* ── Filter bar ── */}
        <div style={s.filterCard}>
          <div style={s.filterRow}>
            {/* Country */}
            <div style={s.filterField}>
              <label style={s.filterLabel}>Country</label>
              <select
                style={s.filterSelect}
                value={pending.country}
                onChange={(e) => setPending((p) => ({ ...p, country: e.target.value }))}
              >
                <option value="">All countries</option>
                {countries.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Date from */}
            <div style={s.filterField}>
              <label style={s.filterLabel}>Start Date</label>
              <input
                type="date"
                style={s.filterInput}
                value={pending.dateFrom}
                onChange={(e) => setPending((p) => ({ ...p, dateFrom: e.target.value }))}
              />
            </div>

            {/* Date to */}
            <div style={s.filterField}>
              <label style={s.filterLabel}>End Date</label>
              <input
                type="date"
                style={s.filterInput}
                value={pending.dateTo}
                onChange={(e) => setPending((p) => ({ ...p, dateTo: e.target.value }))}
              />
            </div>

            {/* Crisis type */}
            <div style={s.filterField}>
              <label style={s.filterLabel}>Crisis Type</label>
              <select
                style={s.filterSelect}
                value={pending.crisisType}
                onChange={(e) => setPending((p) => ({ ...p, crisisType: e.target.value }))}
              >
                {CRISIS_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <button style={s.applyBtn} onClick={applyFilters}>
              Apply Filters
            </button>
          </div>

          {/* Active filter tags */}
          {tags.length > 0 && (
            <div style={s.tagRow}>
              {tags.map((tag) => (
                <span key={tag.key} style={s.tag}>
                  {tag.label}
                  <button
                    style={s.tagRemove}
                    onClick={() => removeTag(tag.key)}
                    aria-label={`Remove ${tag.label}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Persistent note */}
          <div style={s.filterNote}>
            📋 Showing confirmed reports only — Grey and Red flagged reports are excluded
            from all statistics.
          </div>
        </div>

        {/* ── Summary cards ── */}
        <div style={s.summaryGrid}>
          {SUMMARY_CARDS.map((card) => (
            <div key={card.label} style={s.summaryCard}>
              <div style={s.summaryAccent} />
              <div style={s.summaryBody}>
                <div style={s.summaryNumber}>
                  {summaryLoading ? "—" : (card.value ?? 0).toLocaleString()}
                </div>
                <div style={s.summaryLabel}>{card.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Charts ── */}
        <div style={s.chartsGrid}>
          {/* Chart 1 — Reports Over Time */}
          <ChartCard
            title="Reports Over Time"
            subtitle={scopeLabel}
            loading={timeLoading}
            empty={timeData.length === 0}
          >
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={timeData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDate}
                  tick={{ fontSize: 11, fill: "#718096" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#718096" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  labelFormatter={fmtDate}
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={BLUE}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5 }}
                  name="Reports"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Chart 2 — Damage Level Distribution */}
          <ChartCard
            title="Damage Level Distribution"
            subtitle={scopeLabel}
            loading={distLoading}
            empty={distData.length === 0}
          >
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={distData}
                  dataKey="count"
                  nameKey="level"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={({ name, percent }) =>
                    `${(percent * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                >
                  {distData.map((entry) => (
                    <Cell
                      key={entry.level}
                      fill={PIE_COLORS[entry.level] ?? "#94a3b8"}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <Legend
                  iconSize={10}
                  wrapperStyle={{ fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Chart 3 — Infrastructure Type Breakdown */}
          <ChartCard
            title="Infrastructure Type Breakdown"
            subtitle={scopeLabel}
            loading={infraLoading}
            empty={infraData.length === 0}
          >
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={infraData}
                margin={{ top: 8, right: 16, left: 0, bottom: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" vertical={false} />
                <XAxis
                  dataKey="type"
                  tick={{ fontSize: 11, fill: "#718096" }}
                  tickLine={false}
                  angle={-35}
                  textAnchor="end"
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#718096" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[4, 4, 0, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Chart 4 — Reports by Country (horizontal) */}
          <ChartCard
            title="Reports by Country"
            subtitle={scopeLabel}
            loading={countryLoading}
            empty={countryData.length === 0}
          >
            <ResponsiveContainer width="100%" height={countryBarHeight}>
              <BarChart
                data={countryData}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f4f8" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "#718096" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="country"
                  tick={{ fontSize: 12, fill: "#4a5568" }}
                  tickLine={false}
                  width={110}
                />
                <Tooltip
                  contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <Bar dataKey="count" fill={BLUE} radius={[0, 4, 4, 0]} name="Reports" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
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
    background: "#f4f6f9",
  },
  content: {
    flex: 1,
    padding: "24px 32px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  // Top bar
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pageTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  exportBtn: {
    padding: "9px 18px",
    background: "#EBF5FB",
    color: BLUE,
    border: `1px solid #bee3f8`,
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  // Filter card
  filterCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    padding: "18px 20px",
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
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  filterSelect: {
    padding: "8px 10px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    minWidth: 150,
  },
  filterInput: {
    padding: "8px 10px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
  },
  applyBtn: {
    padding: "9px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    alignSelf: "flex-end",
    whiteSpace: "nowrap" as const,
  },
  tagRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#EBF5FB",
    color: BLUE,
    border: `1px solid #bee3f8`,
    borderRadius: 20,
    padding: "3px 10px",
    fontSize: 12,
    fontWeight: 600,
  },
  tagRemove: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: BLUE,
    fontSize: 15,
    lineHeight: 1,
    padding: 0,
    display: "flex",
    alignItems: "center",
  },
  filterNote: {
    fontSize: 12,
    color: "#718096",
    background: "#f7fafc",
    borderRadius: 6,
    padding: "8px 12px",
    borderLeft: `3px solid ${BLUE}`,
  },
  // Summary cards
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 16,
  },
  summaryCard: {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    display: "flex",
    overflow: "hidden",
  },
  summaryAccent: {
    width: 5,
    background: BLUE,
    flexShrink: 0,
  },
  summaryBody: {
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  summaryNumber: {
    fontSize: 36,
    fontWeight: 800,
    color: "#1A2B4A",
    lineHeight: 1,
  },
  summaryLabel: {
    fontSize: 13,
    color: "#718096",
    fontWeight: 500,
  },
  // Charts
  chartsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
  },
  chartCard: {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
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
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  chartSubtitle: {
    fontSize: 12,
    color: "#a0aec0",
  },
};
