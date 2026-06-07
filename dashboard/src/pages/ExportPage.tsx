import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import Header from "../components/Header";
import api from "../services/api";
import { useHasAccess } from "../hooks/useHasAccess";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "var(--c-primary-container)";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReportTypeConfig {
  id: string;
  name: string;
  description: string;
  formats: string[];
}

interface Country {
  id: string;
  name: string;
}

interface CrisisOption {
  id: string;
  name: string;
}

interface ExportHistoryItem {
  id: string;
  report_type: string;
  date_from: string;
  date_to: string;
  format: string;
  generated_at: string;
  created_at: string;
  download_url: string;
  country_filter: string[] | null;
  damage_level: string[] | null;
  crisis_type: string[] | null;
  flag_status: string[] | null;
  platform: string[] | null;
  project_id: string | null;
}

interface GenerateResponse {
  job_id: string;
}

interface JobStatusResponse {
  status: "pending" | "processing" | "complete" | "failed";
  download_url?: string;
  error?: string;
}

interface StatusMsg {
  kind: "error" | "success" | "info";
  text: string;
}

// ── Report type definitions ────────────────────────────────────────────────────

// Report types that carry an "internal use only" warning for GeoJSON / GeoPackage
const INTERNAL_GEO_TYPES = new Set(["full_data", "flagged_reports"]);

// Material Symbols icon name per report type
const TYPE_ICON: Record<string, string> = {
  standard_damage:   "analytics",
  full_data:         "database",
  reporter_activity: "person_pin",
  flagged_reports:   "flag",
  project_summary:   "folder",
};

const REPORT_TYPES: ReportTypeConfig[] = [
  {
    id: "standard_damage",
    name: "Standard Damage Report",
    description:
      "Location, damage level, infrastructure type, and RAPIDA-compatible field names. No reporter identity data — safe for sharing with external partners and humanitarian organisations.",
    formats: ["CSV", "GeoJSON", "GeoPackage", "Shapefile"],
  },
  {
    id: "full_data",
    name: "Full Data Report",
    description:
      "All core fields plus device ID, IP address, flag history, and submission metadata. For internal UNDP analysis only — must not be shared externally.",
    formats: ["CSV", "GeoJSON", "GeoPackage"],
  },
  {
    id: "reporter_activity",
    name: "Reporter Activity Report",
    description:
      "One row per unique reporter — submission counts, profile status, and badge data. No personal information by default. For UNDP programme and adoption analysis.",
    formats: ["CSV"],
  },
  {
    id: "flagged_reports",
    name: "Flagged Reports Report",
    description:
      "All reports that triggered automatic flag checks, including review outcomes and reviewer comments. For quality assurance and internal audit only.",
    formats: ["CSV", "GeoJSON", "GeoPackage"],
  },
  {
    id: "project_summary",
    name: "Project Summary Report",
    description:
      "Damage breakdown, distribution statistics, and submission timeline scoped to a specific project. For donor updates and stakeholder reporting. Project selection is required.",
    formats: ["CSV", "GeoJSON", "GeoPackage", "Shapefile"],
  },
];

const FORMAT_VALUE: Record<string, string> = {
  CSV:        "csv",
  GeoJSON:    "geojson",
  Shapefile:  "shapefile",
  GeoPackage: "geopackage",
};

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  REPORT_TYPES.map((t) => [t.id, t.name])
);

// ── Filter option definitions ──────────────────────────────────────────────────

const FLAG_STATUS_OPTIONS = [
  { value: "green",     label: "Green"     },
  { value: "orange",    label: "Orange"    },
  { value: "grey",      label: "Grey"      },
  { value: "red",       label: "Red"       },
  { value: "discarded", label: "Discarded" },
];

const DAMAGE_LEVEL_OPTIONS = [
  { value: "complete", label: "Completely Destroyed"  },
  { value: "partial",  label: "Partially Damaged"     },
  { value: "minimal",  label: "Minimal or No Damage"  },
];

const CRISIS_TYPE_OPTIONS = [
  { value: "Earthquake",           label: "Earthquake"           },
  { value: "Flood",                label: "Flood"                },
  { value: "Tsunami",              label: "Tsunami"              },
  { value: "Hurricane or Cyclone", label: "Hurricane or Cyclone" },
  { value: "Wildfire",             label: "Wildfire"             },
  { value: "Explosion",            label: "Explosion"            },
  { value: "Chemical Incident",    label: "Chemical Incident"    },
  { value: "Conflict",             label: "Conflict"             },
  { value: "Civil Unrest",         label: "Civil Unrest"         },
];

const PLATFORM_OPTIONS = [
  { value: "ios",     label: "Native App iOS"     },
  { value: "android", label: "Native App Android" },
  { value: "pwa",     label: "PWA"                },
  { value: "web",     label: "Plain Web"          },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFilters(item: ExportHistoryItem): string {
  const parts: string[] = [];
  if (item.country_filter?.length)
    parts.push(`Country: ${item.country_filter.join(", ")}`);
  if (item.damage_level?.length)
    parts.push(`Damage: ${item.damage_level.join(", ")}`);
  if (item.crisis_type?.length)
    parts.push(`Crisis: ${item.crisis_type.join(", ")}`);
  const isDefaultStatus =
    !item.flag_status ||
    (item.flag_status.length === 2 &&
      item.flag_status.includes("green") &&
      item.flag_status.includes("orange"));
  if (!isDefaultStatus && item.flag_status?.length)
    parts.push(`Status: ${item.flag_status.join(", ")}`);
  if (item.platform?.length)
    parts.push(`Platform: ${item.platform.join(", ")}`);
  if (item.project_id) parts.push(`Project: ${item.project_id}`);
  return parts.length > 0 ? parts.join(" | ") : "Default filters";
}

// ── ButtonSpinner (inline, white, for use inside dark buttons) ────────────────

function ButtonSpinner({ size = 16 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: "2px solid rgba(255,255,255,0.4)",
        borderTop: "2px solid #fff",
        borderRadius: "50%",
        animation: "cr-spin 0.7s linear infinite",
        verticalAlign: "middle",
        marginRight: 8,
        flexShrink: 0,
      }}
    />
  );
}

// ── CheckboxGroup ──────────────────────────────────────────────────────────────

function CheckboxGroup({
  label,
  options,
  selected,
  onChange,
  note,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (vals: string[]) => void;
  note?: string;
}) {
  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }
  return (
    <div style={s.filterGroup}>
      <div className="input-label">{label}</div>
      <div style={s.checkboxRow}>
        {options.map((opt) => (
          <label key={opt.value} style={s.checkboxLabel}>
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => toggle(opt.value)}
              style={{ accentColor: BLUE, marginRight: 5 }}
            />
            {opt.label}
          </label>
        ))}
      </div>
      {note && <div style={s.filterNote}>{note}</div>}
    </div>
  );
}

// ── CountryMultiSelect ─────────────────────────────────────────────────────────

function CountryMultiSelect({
  countries,
  selected,
  onChange,
}: {
  countries: Country[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((v) => v !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  const label =
    selected.length === 0
      ? "All countries"
      : selected.length === 1
      ? countries.find((c) => c.id === selected[0])?.name ?? selected[0]
      : `${selected.length} countries selected`;

  return (
    <div style={s.filterGroup}>
      <div className="input-label">Country</div>
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={s.multiSelectBtn}
        >
          {label}
          <span style={{ marginLeft: 8, fontSize: 10 }}>▼</span>
        </button>
        {open && (
          <div style={s.multiSelectDropdown}>
            {countries.length === 0 ? (
              <div style={{ padding: "8px 12px", color: "var(--c-text-muted)", fontSize: 13 }}>
                No countries available
              </div>
            ) : (
              countries.map((c) => (
                <label key={c.id} style={s.dropdownItem}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    style={{ accentColor: BLUE, marginRight: 8 }}
                  />
                  {c.name}
                </label>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ExportPage() {
  const location = useLocation();
  const today = new Date().toISOString().split("T")[0];

  // Report type
  const [selectedId, setSelectedId] = useState<string>("");
  const selectedType = REPORT_TYPES.find((t) => t.id === selectedId) ?? null;

  // Date range
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Filters
  const [flagStatusFilter, setFlagStatusFilter] = useState<string[]>([
    "green",
    "orange",
  ]);
  const [countryFilter, setCountryFilter] = useState<string[]>([]);
  const [damageLevelFilter, setDamageLevelFilter] = useState<string[]>([]);
  const [crisisTypeFilter, setCrisisTypeFilter] = useState<string[]>([]);
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState("");

  // Format
  const [format, setFormat] = useState("");

  // Data sources
  const [countries, setCountries] = useState<Country[]>([]);
  const [crises, setCrises] = useState<CrisisOption[]>([]);

  // Validation
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Generate / polling
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<StatusMsg | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History
  const [history, setHistory] = useState<ExportHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Re-download state
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null);
  const redownloadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Effects ──────────────────────────────────────────────────────────────────

  // Pre-populate from Analytics page navigation state
  useEffect(() => {
    const prefill = (
      location.state as { prefill?: Record<string, unknown> } | null
    )?.prefill;
    if (!prefill) return;
    if (prefill.date_from) setDateFrom(prefill.date_from as string);
    if (prefill.date_to) setDateTo(prefill.date_to as string);
    if (prefill.country) {
      const vals = Array.isArray(prefill.country)
        ? (prefill.country as string[])
        : [prefill.country as string];
      setCountryFilter(vals);
    }
    if (prefill.crisis_type) {
      const vals = Array.isArray(prefill.crisis_type)
        ? (prefill.crisis_type as string[])
        : [prefill.crisis_type as string];
      setCrisisTypeFilter(vals);
    }
    if (prefill.report_type) setSelectedId(prefill.report_type as string);
    if (prefill.project_id) setProjectFilter(String(prefill.project_id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api
      .get<Country[]>("/api/countries")
      .then((r) => setCountries(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<CrisisOption[]>("/api/crises")
      .then((r) => setCrises(r.data))
      .catch(() => {});
  }, []);

  const fetchHistory = useCallback(() => {
    setHistoryLoading(true);
    api
      .get<ExportHistoryItem[]>("/api/exports/history")
      .then((r) => setHistory(r.data.slice(0, 20)))
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Auto-select first format when report type changes
  useEffect(() => {
    setFormat(selectedType ? FORMAT_VALUE[selectedType.formats[0]] : "");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup polls on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (redownloadPollRef.current) clearInterval(redownloadPollRef.current);
    };
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function selectType(id: string) {
    setSelectedId(id);
    setStatusMsg(null);
    setErrors({});
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!dateFrom) e.dateFrom = "Start date is required";
    if (!dateTo) e.dateTo = "End date is required";
    if (dateFrom && dateTo && dateTo < dateFrom)
      e.dateTo = "End date cannot be before start date";
    if (selectedId === "project_summary" && !projectFilter)
      e.project = "Project selection is required for Project Summary Report";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleGenerate() {
    if (!validate()) return;
    if (pollRef.current) clearInterval(pollRef.current);
    setGenerating(true);
    setStatusMsg(null);

    const body: Record<string, unknown> = {
      report_type: selectedId,
      format,
      date_from: dateFrom,
      date_to: dateTo,
      flag_status: flagStatusFilter.length > 0 ? flagStatusFilter : null,
    };
    if (countryFilter.length > 0) body.country_filter = countryFilter;
    if (damageLevelFilter.length > 0) body.damage_level = damageLevelFilter;
    if (crisisTypeFilter.length > 0) body.crisis_type = crisisTypeFilter;
    if (platformFilter.length > 0) body.platform = platformFilter;
    if (projectFilter) body.project_id = projectFilter;

    try {
      const res = await api.post<GenerateResponse>(
        "/api/exports/generate",
        body
      );
      const { job_id } = res.data;

      pollRef.current = setInterval(async () => {
        try {
          const { data } = await api.get<JobStatusResponse>(
            `/api/exports/${job_id}/status`
          );
          if (data.status === "complete" && data.download_url) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setGenerating(false);
            triggerDownload(data.download_url);
            setStatusMsg({ kind: "success", text: "Export ready — download started." });
            fetchHistory();
          } else if (data.status === "failed") {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setGenerating(false);
            setStatusMsg({
              kind: "error",
              text: data.error || "Export generation failed. Please try again or reduce the date range and retry.",
            });
          }
        } catch {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setGenerating(false);
          setStatusMsg({
            kind: "error",
            text: "Export generation failed. Please try again or reduce the date range and retry.",
          });
        }
      }, 2000);
    } catch {
      setGenerating(false);
      setStatusMsg({
        kind: "error",
        text: "Export generation failed. Please try again or reduce the date range and retry.",
      });
    }
  }

  async function handleRedownload(jobId: string) {
    if (redownloadPollRef.current) clearInterval(redownloadPollRef.current);
    setRedownloadingId(jobId);

    try {
      const res = await api.post<GenerateResponse>(
        `/api/exports/${jobId}/redownload`
      );
      const { job_id: newJobId } = res.data;

      redownloadPollRef.current = setInterval(async () => {
        try {
          const { data } = await api.get<JobStatusResponse>(
            `/api/exports/${newJobId}/status`
          );
          if (data.status === "complete" && data.download_url) {
            clearInterval(redownloadPollRef.current!);
            redownloadPollRef.current = null;
            setRedownloadingId(null);
            triggerDownload(data.download_url);
            fetchHistory();
          } else if (data.status === "failed") {
            clearInterval(redownloadPollRef.current!);
            redownloadPollRef.current = null;
            setRedownloadingId(null);
            setStatusMsg({ kind: "error", text: "Re-download failed. Please try again." });
          }
        } catch {
          clearInterval(redownloadPollRef.current!);
          redownloadPollRef.current = null;
          setRedownloadingId(null);
        }
      }, 2000);
    } catch {
      setRedownloadingId(null);
      setStatusMsg({ kind: "error", text: "Re-download failed. Please try again." });
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────────

  const canExport = useHasAccess("export", true);

  const canGenerate =
    canExport &&
    !!selectedId &&
    !!dateFrom &&
    !!dateTo &&
    dateTo >= dateFrom &&
    !!format &&
    !generating &&
    (selectedId !== "project_summary" || !!projectFilter);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      <style>{`
        @keyframes ex-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .ex-type-card { transition: box-shadow 0.15s, transform 0.15s, border-color 0.15s; }
        .ex-type-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(4,104,177,0.13) !important; }
        .ex-format-btn { transition: box-shadow 0.15s, filter 0.15s; }
        .ex-format-btn:hover { filter: brightness(0.93); }
        .ex-history-row { transition: background 0.12s; }
        .ex-history-row:hover { background: var(--c-surface-low) !important; }
        .ex-history-row .ex-dl-btn { opacity: 0; transition: opacity 0.12s; }
        .ex-history-row:hover .ex-dl-btn { opacity: 1 !important; }
      `}</style>

      <Header title="Export" subtitle="Download structured data reports on demand" />

      <div style={s.content}>

        {/* ── LEFT COLUMN ── */}
        <div style={s.leftCol}>

          {/* STEP 1 — Select Report Template */}
          <section style={s.section}>
            <div style={s.stepHeader}>
              <div style={s.stepCircle}>1</div>
              <span className="section-label">Select Report Template</span>
            </div>
            <div style={s.cardGrid}>
              {REPORT_TYPES.map((rt) => {
                const active = selectedId === rt.id;
                return (
                  <button
                    key={rt.id}
                    className="ex-type-card"
                    onClick={() => selectType(rt.id)}
                    style={{
                      ...s.card,
                      position: "relative",
                      border: active
                        ? `2px solid ${BLUE}`
                        : "2px solid transparent",
                      background: active
                        ? "rgba(4,104,177,0.04)"
                        : "var(--c-surface-lowest)",
                      boxShadow: active
                        ? `0 0 0 4px rgba(4,104,177,0.08), var(--shadow-sm)`
                        : "var(--shadow-sm)",
                    }}
                  >
                    {/* Active checkmark badge */}
                    {active && (
                      <div style={s.cardCheck}>✓</div>
                    )}

                    {/* Material Symbol icon */}
                    <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: 28,
                        color: active ? BLUE : "var(--c-text-muted)",
                        fontVariationSettings: active
                          ? "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 28"
                          : "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 28",
                        transition: "color 0.15s, font-variation-settings 0.15s",
                        marginBottom: 4,
                        display: "block",
                      }}
                    >
                      {TYPE_ICON[rt.id] ?? "description"}
                    </span>

                    <div style={s.cardName}>{rt.name}</div>

                    <div style={s.cardFormats}>
                      {rt.formats.map((f) => (
                        <span key={f} style={s.formatPill}>{f}</span>
                      ))}
                    </div>

                    <div style={s.cardDesc}>{rt.description}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* STEP 2 — Configure Data Filters */}
          <section style={s.section}>
            <div style={s.stepHeader}>
              <div style={s.stepCircle}>2</div>
              <span className="section-label">Configure Data Filters</span>
            </div>
            <div style={s.panel}>

              {/* Date range */}
              <div style={s.panelRow}>
                <div style={s.field}>
                  <label className="input-label">
                    Start Date <span style={s.req}>*</span>
                  </label>
                  <input
                    type="date"
                    value={dateFrom}
                    max={today}
                    onChange={(e) => {
                      setDateFrom(e.target.value);
                      setErrors((p) => ({ ...p, dateFrom: undefined as unknown as string }));
                    }}
                    style={{
                      ...s.input,
                      borderColor: errors.dateFrom ? "#e53e3e" : "var(--c-surface-high)",
                    }}
                  />
                  {errors.dateFrom && (
                    <span style={s.fieldErr}>{errors.dateFrom}</span>
                  )}
                </div>

                <div style={s.field}>
                  <label className="input-label">
                    End Date <span style={s.req}>*</span>
                  </label>
                  <input
                    type="date"
                    value={dateTo}
                    max={today}
                    min={dateFrom || undefined}
                    onChange={(e) => {
                      setDateTo(e.target.value);
                      setErrors((p) => ({ ...p, dateTo: undefined as unknown as string }));
                    }}
                    style={{
                      ...s.input,
                      borderColor: errors.dateTo ? "#e53e3e" : "var(--c-surface-high)",
                    }}
                  />
                  {errors.dateTo && (
                    <span style={s.fieldErr}>{errors.dateTo}</span>
                  )}
                </div>
              </div>

              <p style={s.dateHint}>
                Large date ranges may take longer to generate. For best
                performance, export in date ranges of 90 days or less.
              </p>

              {/* Inclusion note */}
              <div style={s.inclusionNote}>
                Showing confirmed reports only — Grey, Red, and Discarded reports
                excluded by default. Use the Flag Status filter below to include
                other statuses.
              </div>

              {/* Filters */}
              <CheckboxGroup
                label="Flag Status"
                options={FLAG_STATUS_OPTIONS}
                selected={flagStatusFilter}
                onChange={setFlagStatusFilter}
              />

              <CountryMultiSelect
                countries={countries}
                selected={countryFilter}
                onChange={setCountryFilter}
              />

              <CheckboxGroup
                label="Damage Level"
                options={DAMAGE_LEVEL_OPTIONS}
                selected={damageLevelFilter}
                onChange={setDamageLevelFilter}
              />

              <CheckboxGroup
                label="Crisis Type"
                options={CRISIS_TYPE_OPTIONS}
                selected={crisisTypeFilter}
                onChange={setCrisisTypeFilter}
              />

              <CheckboxGroup
                label="Platform"
                options={PLATFORM_OPTIONS}
                selected={platformFilter}
                onChange={setPlatformFilter}
              />

              {/* Project filter */}
              <div style={s.filterGroup}>
                <label className="input-label">
                  Project{" "}
                  {selectedId === "project_summary" && (
                    <span style={s.req}>* Required for Project Summary Report</span>
                  )}
                </label>
                <select
                  value={projectFilter}
                  onChange={(e) => {
                    setProjectFilter(e.target.value);
                    setErrors((p) => ({ ...p, project: undefined as unknown as string }));
                  }}
                  style={{
                    ...s.select,
                    borderColor: errors.project ? "#e53e3e" : "var(--c-surface-high)",
                  }}
                >
                  <option value="">All projects</option>
                  {crises.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {errors.project && (
                  <span style={s.fieldErr}>{errors.project}</span>
                )}
              </div>
            </div>
          </section>

          {/* STEP 3 — Output Format */}
          <section style={s.section}>
            <div style={s.stepHeader}>
              <div style={s.stepCircle}>3</div>
              <span className="section-label">Output Format</span>
            </div>
            {selectedType ? (
              <div style={s.formatSection}>
                <div style={s.formatBtnRow}>
                  {selectedType.formats.map((f) => {
                    const isActive = format === FORMAT_VALUE[f];
                    return (
                      <button
                        key={f}
                        className="ex-format-btn"
                        onClick={() => setFormat(FORMAT_VALUE[f])}
                        style={{
                          padding: "10px 28px",
                          borderRadius: 999,
                          border: "none",
                          cursor: "pointer",
                          fontWeight: 700,
                          fontSize: 14,
                          background: isActive ? BLUE : "var(--c-surface-high)",
                          color: isActive ? "#fff" : "var(--c-text-primary)",
                          boxShadow: isActive
                            ? "0 2px 10px rgba(4,104,177,0.28)"
                            : "none",
                        }}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>

                {format === "shapefile" && (
                  <p style={s.formatHint}>
                    Shapefile exports are delivered as a ZIP archive containing
                    all required component files.
                  </p>
                )}
                {format === "geopackage" && (
                  <p style={s.formatHint}>
                    GeoPackage exports are delivered as a single .gpkg file
                    compatible with QGIS and ArcGIS.
                  </p>
                )}
                {INTERNAL_GEO_TYPES.has(selectedId) &&
                  (format === "geojson" || format === "geopackage") && (
                  <p style={{
                    ...s.formatHint,
                    background: "#FFF8E1",
                    border: "1px solid #FFB74D",
                    color: "#7B4F00",
                  }}>
                    For internal use only — this format includes device and IP data.
                  </p>
                )}
              </div>
            ) : (
              <p style={s.hintText}>
                Select a report template above to choose a format.
              </p>
            )}
          </section>

          {/* ── Status message ── */}
          {statusMsg && (
            <div
              style={{
                ...s.statusBox,
                background:
                  statusMsg.kind === "error"
                    ? "#FFF5F5"
                    : statusMsg.kind === "success"
                    ? "#F0FFF4"
                    : "#EBF8FF",
                borderColor:
                  statusMsg.kind === "error"
                    ? "#FC8181"
                    : statusMsg.kind === "success"
                    ? "#68D391"
                    : "#90CDF4",
                color:
                  statusMsg.kind === "error"
                    ? "#C53030"
                    : statusMsg.kind === "success"
                    ? "#276749"
                    : "#2B6CB0",
              }}
            >
              {statusMsg.text}
            </div>
          )}
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div style={s.rightCol}>

          {/* EXPORT SUMMARY PANEL */}
          <div style={{ ...s.summaryCard, position: "sticky", top: 92, marginBottom: 16 }}>
            <div className="section-label" style={{ marginBottom: 16 }}>Export Summary</div>

            {[
              {
                label: "Template",
                value: selectedType?.name ?? null,
                missing: !selectedType,
              },
              {
                label: "Date Range",
                value: dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : null,
                missing: !dateFrom || !dateTo,
              },
              {
                label: "Format",
                value: format ? format.toUpperCase() : null,
                missing: !format,
              },
              {
                label: "Flag Status",
                value:
                  flagStatusFilter.length > 0
                    ? flagStatusFilter.join(", ")
                    : "All",
                missing: false,
              },
            ].map((row) => (
              <div key={row.label} style={s.summaryRow}>
                <span style={s.summaryRowLabel}>{row.label}</span>
                {row.missing ? (
                  <span style={s.summaryMissing}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>warning</span> Not set
                  </span>
                ) : (
                  <span style={s.summaryRowValue}>{row.value}</span>
                )}
              </div>
            ))}

            <button
              style={{
                width: "100%",
                marginTop: 20,
                padding: "14px 0",
                background: canGenerate
                  ? "linear-gradient(135deg, var(--c-primary) 0%, var(--c-primary-container) 100%)"
                  : "var(--c-surface-high)",
                color: canGenerate ? "#fff" : "var(--c-text-muted)",
                border: "none",
                borderRadius: "var(--radius-lg)",
                fontWeight: 700,
                fontSize: 15,
                cursor: canGenerate ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                boxShadow: canGenerate
                  ? "0 4px 16px rgba(4,104,177,0.28)"
                  : "none",
                transition: "box-shadow 0.2s",
              }}
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              {generating ? (
                <>
                  <ButtonSpinner />
                  Generating — please wait
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: 20, fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>download</span>
                  Generate &amp; Download
                </>
              )}
            </button>
            <p style={s.processingNote}>
              Background job — export runs on server, download starts automatically
            </p>
          </div>

          {/* RECENT EXPORTS PANEL */}
          <div className="card card-padded" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span className="section-label">Recent Exports</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>
                Last 20 exports
              </span>
            </div>

            {historyLoading ? (
              <p style={s.hintText}>Loading history…</p>
            ) : history.length === 0 ? (
              <p style={s.hintText}>No exports generated yet.</p>
            ) : (
              history.slice(0, 8).map((item) => {
                const isRedownloading = redownloadingId === item.id;
                return (
                  <div key={item.id} className="ex-history-row" style={s.exportItem}>
                    <div style={s.exportItemIcon}>
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--c-primary-container)", fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 20" }}>description</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={s.exportItemName}>
                        {TYPE_LABEL[item.report_type] ?? item.report_type}
                      </div>
                      <div style={s.exportItemMeta}>
                        {fmtDate(item.date_from)} – {fmtDate(item.date_to)} · {item.format.toUpperCase()}
                      </div>
                      <div style={{ ...s.exportItemMeta, marginTop: 1 }}>
                        {fmtDateTime(item.created_at || item.generated_at)} · {formatFilters(item)}
                      </div>
                    </div>
                    <button
                      className="ex-dl-btn"
                      style={{
                        padding: "5px 10px",
                        background: "transparent",
                        color: BLUE,
                        border: `1.5px solid ${BLUE}`,
                        borderRadius: "var(--radius-md)",
                        fontSize: 14,
                        fontWeight: 700,
                        cursor: isRedownloading ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                      onClick={() => !isRedownloading && handleRedownload(item.id)}
                      disabled={isRedownloading}
                    >
                      {isRedownloading ? (
                        <span
                          style={{
                            display: "inline-block",
                            width: 11,
                            height: 11,
                            border: `1.5px solid ${BLUE}`,
                            borderTop: "1.5px solid transparent",
                            borderRadius: "50%",
                            animation: "cr-spin 0.7s linear infinite",
                          }}
                        />
                      ) : (
                        "↓"
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* SYSTEM STATUS */}
          <div style={s.statusPanel}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ position: "relative", flexShrink: 0, width: 14, height: 14 }}>
                <div style={{
                  width: 10,
                  height: 10,
                  background: "#00753b",
                  borderRadius: "50%",
                  position: "absolute",
                  top: 2,
                  left: 2,
                }} />
                <div style={{
                  width: 14,
                  height: 14,
                  background: "rgba(0,117,59,0.25)",
                  borderRadius: "50%",
                  position: "absolute",
                  top: 0,
                  left: 0,
                  animation: "ex-pulse 2.2s ease-in-out infinite",
                }} />
              </div>
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: "var(--c-text-primary)", margin: 0 }}>
                  Export Service: Operational
                </p>
                <p style={{ fontSize: 11, color: "var(--c-text-muted)", margin: "3px 0 0", lineHeight: 1.45 }}>
                  Large exports may take up to 2 minutes. Download starts automatically on completion.
                </p>
              </div>
            </div>
          </div>
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
    padding: "28px 36px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "row",
    gap: 28,
    alignItems: "flex-start",
    maxWidth: 1400,
  },
  // Two-column layout
  leftCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 28,
    minWidth: 0,
  },
  rightCol: {
    width: 360,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
  },
  // Step structure
  stepHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  stepCircle: {
    width: 28,
    height: 28,
    background: "var(--c-primary-container)",
    color: "white",
    borderRadius: "50%",
    fontSize: "var(--text-sm)",
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  // Cards
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  card: {
    padding: "20px 18px",
    borderRadius: "var(--radius-lg)",
    cursor: "pointer",
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  cardCheck: {
    position: "absolute",
    top: 12,
    right: 14,
    width: 22,
    height: 22,
    background: BLUE,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 12,
    fontWeight: 900,
    lineHeight: "1",
  },
  cardName: {
    fontSize: "var(--text-base)",
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  cardFormats: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  formatPill: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--c-primary-container)",
    background: "rgba(4,104,177,0.08)",
    padding: "2px 8px",
    borderRadius: "var(--radius-sm)",
    display: "inline-block",
  },
  cardDesc: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-muted)",
    lineHeight: 1.5,
    marginTop: 2,
  },
  // Configuration panel
  panel: {
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderRadius: "var(--radius-lg)",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    boxShadow: "var(--shadow-sm)",
  },
  panelRow: {
    display: "flex",
    gap: 24,
    flexWrap: "wrap",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 180,
  },
  req: {
    color: "var(--c-error)",
    fontWeight: 600,
  },
  input: {
    padding: "9px 12px",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid",
    fontSize: 14,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
  },
  select: {
    padding: "9px 12px",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid",
    fontSize: 14,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    minWidth: 200,
    maxWidth: 360,
  },
  fieldErr: {
    fontSize: 12,
    color: "var(--c-error)",
    fontWeight: 500,
  },
  dateHint: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    fontStyle: "italic",
    margin: 0,
    marginTop: -8,
  },
  inclusionNote: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-secondary)",
    background: "rgba(4,104,177,0.06)",
    border: "1px solid rgba(4,104,177,0.12)",
    borderRadius: "var(--radius-md)",
    padding: "10px 14px",
    lineHeight: 1.5,
  },
  filterGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  checkboxRow: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
    marginTop: 8,
  },
  checkboxLabel: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-secondary)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    fontWeight: 500,
    userSelect: "none",
  },
  filterNote: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    marginTop: 6,
    lineHeight: 1.4,
  },
  multiSelectBtn: {
    padding: "9px 12px",
    borderRadius: "var(--radius-md)",
    border: "1.5px solid var(--c-surface-high)",
    fontSize: 14,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    cursor: "pointer",
    textAlign: "left",
    minWidth: 220,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  multiSelectDropdown: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 100,
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
    minWidth: 240,
    maxHeight: 280,
    overflowY: "auto",
    padding: "4px 0",
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    padding: "8px 14px",
    fontSize: 13,
    cursor: "pointer",
    color: "var(--c-text-primary)",
    userSelect: "none",
  },
  // Format step
  formatSection: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  formatBtnRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  formatHint: {
    fontSize: 12,
    color: "var(--c-text-secondary)",
    background: "rgba(4,104,177,0.06)",
    border: "1px solid rgba(4,104,177,0.12)",
    borderRadius: "var(--radius-md)",
    padding: "8px 12px",
    margin: 0,
    lineHeight: 1.5,
  },
  hintText: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-subtle)",
    margin: 0,
  },
  // Status message
  statusBox: {
    padding: "13px 16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid",
    fontSize: 14,
    fontWeight: 500,
  },
  // Summary panel
  summaryCard: {
    background: "var(--c-surface-lowest)",
    border: "1px solid var(--c-surface-high)",
    borderLeft: "4px solid #FFC107",
    borderRadius: "var(--radius-lg)",
    padding: "24px",
    boxShadow: "var(--shadow-sm)",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "9px 0",
    borderBottom: "1px solid var(--c-border-ghost)",
  },
  summaryRowLabel: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-muted)",
  },
  summaryRowValue: {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--c-text-primary)",
    textAlign: "right",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  summaryMissing: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: "#D97706",
    fontSize: 13,
    fontWeight: 600,
  },
  processingNote: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-subtle)",
    textAlign: "center",
    marginTop: 8,
    marginBottom: 0,
  },
  // Recent exports list
  exportItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 6px",
    borderBottom: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-md)",
    cursor: "default",
  },
  exportItemIcon: {
    width: 36,
    height: 36,
    background: "var(--c-surface-low)",
    borderRadius: "var(--radius-md)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  exportItemName: {
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--c-text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  exportItemMeta: {
    fontSize: "var(--text-xs)",
    color: "var(--c-text-muted)",
    marginTop: 2,
  },
  // System status panel
  statusPanel: {
    background: "var(--c-surface-high)",
    border: "1px solid var(--c-border-ghost)",
    borderRadius: "var(--radius-lg)",
    padding: "16px 18px",
  },
};
