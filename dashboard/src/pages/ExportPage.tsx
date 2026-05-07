import { useState, useEffect, useRef, useCallback } from "react";
import Header from "../components/Header";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

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

interface ExportHistoryItem {
  id: string;
  report_type: string;
  date_from: string;
  date_to: string;
  format: string;
  generated_at: string;
  download_url: string;
}

interface GenerateResponse {
  job_id: string;
}

interface JobStatusResponse {
  status: "pending" | "processing" | "complete" | "failed";
  download_url?: string;
}

// ── Report type definitions ────────────────────────────────────────────────────

const REPORT_TYPES: ReportTypeConfig[] = [
  {
    id: "standard_damage",
    name: "Standard Damage Report",
    description:
      "Clean summary of confirmed damage reports for external sharing. Includes location, damage level, infrastructure type, and photos.",
    formats: ["CSV", "GeoJSON"],
  },
  {
    id: "full_data",
    name: "Full Data Report",
    description:
      "Complete dataset for internal analysis including all fields, flag history, and reporter metadata.",
    formats: ["CSV", "JSON"],
  },
  {
    id: "reporter_activity",
    name: "Reporter Activity Report",
    description: "Reporter engagement and submission statistics.",
    formats: ["CSV"],
  },
  {
    id: "flagged_reports",
    name: "Flagged Reports Report",
    description:
      "Reports currently flagged for review or discarded. For audit and quality assurance purposes.",
    formats: ["CSV", "JSON"],
  },
  {
    id: "project_summary",
    name: "Project Summary Report",
    description:
      "Summary statistics and damage breakdown for a specific project.",
    formats: ["CSV", "PDF"],
  },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  REPORT_TYPES.map((t) => [t.id, t.name])
);

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

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: "2px solid rgba(255,255,255,0.4)",
        borderTop: "2px solid #fff",
        borderRadius: "50%",
        animation: "ex-spin 0.7s linear infinite",
        verticalAlign: "middle",
        marginRight: 8,
      }}
    />
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ExportPage() {
  // Report type
  const [selectedId, setSelectedId] = useState<string>("");
  const selectedType = REPORT_TYPES.find((t) => t.id === selectedId) ?? null;

  // Config
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [country, setCountry] = useState("");
  const [format, setFormat] = useState("");
  const [countries, setCountries] = useState<Country[]>([]);

  // Validation
  const [errors, setErrors] = useState<{ dateFrom?: string; dateTo?: string }>({});

  // Generate / polling
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    kind: "error" | "success" | "info";
    text: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History
  const [history, setHistory] = useState<ExportHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    api
      .get<Country[]>("/api/countries")
      .then((r) => setCountries(r.data))
      .catch(() => {});
  }, []);

  const fetchHistory = useCallback(() => {
    setHistoryLoading(true);
    api
      .get<ExportHistoryItem[]>("/api/exports/history")
      .then((r) => setHistory(r.data.slice(0, 10)))
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Auto-select first format when report type changes
  useEffect(() => {
    setFormat(selectedType ? selectedType.formats[0] : "");
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function selectType(id: string) {
    setSelectedId(id);
    setStatusMsg(null);
  }

  function validate(): boolean {
    const e: typeof errors = {};
    if (!dateFrom) e.dateFrom = "Start date is required";
    if (!dateTo) e.dateTo = "End date is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleGenerate() {
    if (!validate()) return;

    if (pollRef.current) clearInterval(pollRef.current);
    setGenerating(true);
    setStatusMsg(null);

    try {
      const res = await api.post<GenerateResponse>("/api/exports/generate", {
        report_type: selectedId,
        date_from: dateFrom,
        date_to: dateTo,
        country_filter: country || null,
        format,
      });

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
              text: "Export generation failed. Please try again.",
            });
          }
        } catch {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setGenerating(false);
          setStatusMsg({
            kind: "error",
            text: "Export generation failed. Please try again.",
          });
        }
      }, 2000);
    } catch {
      setGenerating(false);
      setStatusMsg({
        kind: "error",
        text: "Export generation failed. Please try again.",
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const canGenerate = !!selectedId && !!dateFrom && !!dateTo && !!format && !generating;

  return (
    <div style={s.page}>
      <style>{`@keyframes ex-spin { to { transform: rotate(360deg); } }`}</style>

      <Header title="Export Data" subtitle="Generate and download crisis reports" />

      <div style={s.content}>
        {/* ── Report type cards ── */}
        <section style={s.section}>
          <h2 style={s.sectionTitle}>Select Report Type</h2>
          <div style={s.cardGrid}>
            {REPORT_TYPES.map((rt) => {
              const active = selectedId === rt.id;
              return (
                <button
                  key={rt.id}
                  onClick={() => selectType(rt.id)}
                  style={{
                    ...s.card,
                    borderColor: active ? BLUE : "#e2e8f0",
                    background: active ? "#EBF5FB" : "#fff",
                    boxShadow: active
                      ? `0 0 0 1px ${BLUE}`
                      : "0 1px 3px rgba(0,0,0,0.06)",
                  }}
                >
                  <div style={s.cardName}>{rt.name}</div>
                  <div style={s.cardFormats}>
                    {rt.formats.map((f) => (
                      <span key={f} style={s.formatPill}>
                        {f}
                      </span>
                    ))}
                  </div>
                  <div style={s.cardDesc}>{rt.description}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Configuration panel ── */}
        <section style={s.section}>
          <h2 style={s.sectionTitle}>Configuration</h2>
          <div style={s.panel}>
            {/* Date range */}
            <div style={s.panelRow}>
              <div style={s.field}>
                <label style={s.label}>
                  Start Date <span style={s.req}>*</span>
                </label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    if (errors.dateFrom) setErrors((p) => ({ ...p, dateFrom: undefined }));
                  }}
                  style={{
                    ...s.input,
                    borderColor: errors.dateFrom ? "#e53e3e" : "#e2e8f0",
                  }}
                />
                {errors.dateFrom && (
                  <span style={s.fieldErr}>{errors.dateFrom}</span>
                )}
              </div>

              <div style={s.field}>
                <label style={s.label}>
                  End Date <span style={s.req}>*</span>
                </label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    if (errors.dateTo) setErrors((p) => ({ ...p, dateTo: undefined }));
                  }}
                  style={{
                    ...s.input,
                    borderColor: errors.dateTo ? "#e53e3e" : "#e2e8f0",
                  }}
                />
                {errors.dateTo && (
                  <span style={s.fieldErr}>{errors.dateTo}</span>
                )}
              </div>

              {/* Country filter */}
              <div style={s.field}>
                <label style={s.label}>Country (optional)</label>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  style={s.select}
                >
                  <option value="">All countries</option>
                  {countries.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Format selector */}
            {selectedType && (
              <div style={s.formatSection}>
                <label style={s.label}>Format</label>
                <div style={s.radioGroup}>
                  {selectedType.formats.map((f) => (
                    <label key={f} style={s.radioLabel}>
                      <input
                        type="radio"
                        name="export-format"
                        value={f}
                        checked={format === f}
                        onChange={() => setFormat(f)}
                        style={{ accentColor: BLUE, marginRight: 6 }}
                      />
                      {f}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {!selectedType && (
              <p style={s.hintText}>Select a report type above to choose a format.</p>
            )}
          </div>
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

        {/* ── Generate button ── */}
        <button
          style={{
            ...s.generateBtn,
            opacity: canGenerate ? 1 : 0.6,
            cursor: canGenerate ? "pointer" : "not-allowed",
          }}
          onClick={handleGenerate}
          disabled={!canGenerate}
        >
          {generating ? (
            <>
              <Spinner />
              Generating export…
            </>
          ) : (
            "Generate Export"
          )}
        </button>

        {/* ── Export history ── */}
        <section style={s.section}>
          <h2 style={s.sectionTitle}>Export History</h2>
          {historyLoading ? (
            <p style={s.hintText}>Loading history…</p>
          ) : history.length === 0 ? (
            <p style={s.hintText}>No exports generated yet.</p>
          ) : (
            <div style={s.historyTable}>
              {/* Header row */}
              <div style={{ ...s.historyRow, ...s.historyHeader }}>
                <span>Report Type</span>
                <span>Date Range</span>
                <span>Format</span>
                <span>Generated</span>
                <span />
              </div>
              {history.map((item) => (
                <div key={item.id} style={s.historyRow}>
                  <span style={s.historyCell}>
                    {TYPE_LABEL[item.report_type] ?? item.report_type}
                  </span>
                  <span style={s.historyCell}>
                    {fmtDate(item.date_from)} – {fmtDate(item.date_to)}
                  </span>
                  <span style={s.historyCell}>
                    <span style={s.formatPill}>{item.format}</span>
                  </span>
                  <span style={s.historyCell}>{fmtDate(item.generated_at)}</span>
                  <span style={s.historyCell}>
                    <button
                      style={s.redownloadBtn}
                      onClick={() => triggerDownload(item.download_url)}
                    >
                      Re-download
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
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
    padding: "28px 36px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 28,
    maxWidth: 1200,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  // Cards
  cardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 16,
  },
  card: {
    padding: "18px 16px",
    borderRadius: 10,
    border: "1.5px solid",
    cursor: "pointer",
    textAlign: "left",
    background: "#fff",
    transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  cardName: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  cardFormats: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  formatPill: {
    fontSize: 11,
    fontWeight: 600,
    color: BLUE,
    background: "#EBF5FB",
    padding: "2px 8px",
    borderRadius: 4,
    display: "inline-block",
  },
  cardDesc: {
    fontSize: 13,
    color: "#718096",
    lineHeight: 1.5,
  },
  // Configuration panel
  panel: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
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
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#4a5568",
  },
  req: {
    color: "#e53e3e",
  },
  input: {
    padding: "9px 12px",
    borderRadius: 7,
    border: "1.5px solid",
    fontSize: 14,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
  },
  select: {
    padding: "9px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    background: "#fff",
    minWidth: 200,
  },
  fieldErr: {
    fontSize: 12,
    color: "#e53e3e",
    fontWeight: 500,
  },
  formatSection: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  radioGroup: {
    display: "flex",
    gap: 20,
    flexWrap: "wrap",
  },
  radioLabel: {
    fontSize: 14,
    color: "#2d3748",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    fontWeight: 500,
  },
  hintText: {
    fontSize: 13,
    color: "#a0aec0",
    margin: 0,
  },
  // Status
  statusBox: {
    padding: "13px 16px",
    borderRadius: 8,
    border: "1px solid",
    fontSize: 14,
    fontWeight: 500,
  },
  // Generate button
  generateBtn: {
    padding: "13px 0",
    width: "100%",
    maxWidth: 480,
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 9,
    fontSize: 15,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  // History
  historyTable: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    overflow: "hidden",
  },
  historyRow: {
    display: "grid",
    gridTemplateColumns: "2fr 2fr 100px 1.2fr 110px",
    alignItems: "center",
    padding: "12px 18px",
    borderBottom: "1px solid #f0f4f8",
    gap: 12,
  },
  historyHeader: {
    background: "#f7fafc",
    fontSize: 12,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: "1px solid #e2e8f0",
  },
  historyCell: {
    fontSize: 13,
    color: "#2d3748",
  },
  redownloadBtn: {
    padding: "6px 12px",
    background: "#EBF5FB",
    color: BLUE,
    border: `1px solid #bee3f8`,
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
};
