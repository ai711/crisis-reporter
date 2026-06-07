import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import Header from "../components/Header";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "var(--c-primary-container)";

const CRISIS_TYPES = [
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

// ── Types ──────────────────────────────────────────────────────────────────────

type CrisisStatus = "active" | "inactive" | "archived";

interface Crisis {
  id: string;
  name: string;
  countries: string[];
  crisis_type: string;
  start_date: string;
  status: CrisisStatus;
  report_count: number;
}

interface Country {
  id: string;
  name: string;
}

interface CreateCrisisPayload {
  name: string;
  country_id: string;
  crisis_type: string;
  start_date: string;
  description?: string;
  set_active: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CrisisStatus }) {
  const cfg: Record<CrisisStatus, { label: string; bg: string; color: string }> = {
    active: { label: "Active", bg: "#d4edda", color: "#155724" },
    inactive: { label: "Inactive", bg: "var(--c-surface-high)", color: "#4a5568" },
    archived: { label: "Archived", bg: "#cbd5e0", color: "var(--c-text-primary)" },
  };
  const { label, bg, color } = cfg[status] ?? cfg.inactive;
  return (
    <span style={{ ...s.badge, background: bg, color }}>
      {label}
    </span>
  );
}

// ── Create Crisis Modal ────────────────────────────────────────────────────────

interface ModalProps {
  countries: Country[];
  onClose: () => void;
  onSuccess: () => void;
}

function CreateCrisisModal({ countries, onClose, onSuccess }: ModalProps) {
  const [name, setName] = useState("");
  const [countryId, setCountryId] = useState("");
  const [crisisType, setCrisisType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [description, setDescription] = useState("");
  const [setActive, setSetActive] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Crisis name is required";
    if (name.length > 200) e.name = "Must be 200 characters or fewer";
    if (!countryId) e.countryId = "Country is required";
    if (!crisisType) e.crisisType = "Crisis type is required";
    if (!startDate) e.startDate = "Start date is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitError("");
    setSubmitting(true);
    const payload: CreateCrisisPayload = {
      name: name.trim(),
      country_id: countryId,
      crisis_type: crisisType,
      start_date: startDate,
      set_active: setActive,
    };
    if (description.trim()) payload.description = description.trim();
    try {
      await api.post("/api/crises", payload);
      onSuccess();
    } catch {
      setSubmitError("Failed to create crisis. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Create New Crisis</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={s.form}>
          {/* Crisis Name */}
          <div style={s.field}>
            <label style={s.label}>
              Crisis Name <span style={s.req}>*</span>
            </label>
            <input
              type="text"
              value={name}
              maxLength={200}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((p) => ({ ...p, name: "" }));
              }}
              placeholder="e.g. Turkey–Syria Earthquake 2023"
              style={{ ...s.input, borderColor: errors.name ? "#e53e3e" : "var(--c-surface-high)" }}
            />
            {errors.name && <span style={s.fieldErr}>{errors.name}</span>}
            <span style={s.charCount}>{name.length}/200</span>
          </div>

          {/* Country */}
          <div style={s.field}>
            <label style={s.label}>
              Country <span style={s.req}>*</span>
            </label>
            <select
              value={countryId}
              onChange={(e) => {
                setCountryId(e.target.value);
                if (errors.countryId) setErrors((p) => ({ ...p, countryId: "" }));
              }}
              style={{ ...s.select, borderColor: errors.countryId ? "#e53e3e" : "var(--c-surface-high)" }}
            >
              <option value="">Select a country…</option>
              {countries.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {errors.countryId && <span style={s.fieldErr}>{errors.countryId}</span>}
          </div>

          {/* Crisis Type */}
          <div style={s.field}>
            <label style={s.label}>
              Crisis Type <span style={s.req}>*</span>
            </label>
            <select
              value={crisisType}
              onChange={(e) => {
                setCrisisType(e.target.value);
                if (errors.crisisType) setErrors((p) => ({ ...p, crisisType: "" }));
              }}
              style={{ ...s.select, borderColor: errors.crisisType ? "#e53e3e" : "var(--c-surface-high)" }}
            >
              <option value="">Select crisis type…</option>
              {CRISIS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {errors.crisisType && <span style={s.fieldErr}>{errors.crisisType}</span>}
          </div>

          {/* Start Date */}
          <div style={s.field}>
            <label style={s.label}>
              Start Date <span style={s.req}>*</span>
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (errors.startDate) setErrors((p) => ({ ...p, startDate: "" }));
              }}
              style={{ ...s.input, borderColor: errors.startDate ? "#e53e3e" : "var(--c-surface-high)" }}
            />
            {errors.startDate && <span style={s.fieldErr}>{errors.startDate}</span>}
          </div>

          {/* Description */}
          <div style={s.field}>
            <label style={s.label}>Description (optional)</label>
            <textarea
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the crisis…"
              rows={3}
              style={s.textarea}
            />
            <span style={s.charCount}>{description.length}/500</span>
          </div>

          {/* Set as Active checkbox */}
          <label style={s.checkboxLabel}>
            <input
              type="checkbox"
              checked={setActive}
              onChange={(e) => setSetActive(e.target.checked)}
              style={{ accentColor: BLUE, marginRight: 8 }}
            />
            Set as Active immediately
          </label>

          {submitError && (
            <div style={s.submitError}>{submitError}</div>
          )}

          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Creating…" : "Create Crisis"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Crisis Card ────────────────────────────────────────────────────────────────

interface CrisisCardProps {
  crisis: Crisis;
  onSetActive: (id: string) => void;
  onArchive: (id: string) => void;
  mutating: boolean;
}

function CrisisCard({ crisis, onSetActive, onArchive, mutating }: CrisisCardProps) {
  const isActive = crisis.status === "active";
  const isArchived = crisis.status === "archived";

  return (
    <div style={s.crisisCard}>
      <div style={s.cardTop}>
        <div style={s.cardLeft}>
          <div style={s.crisisName}>{crisis.name}</div>
          <div style={s.crisisMeta}>
            <span style={s.metaItem}>
              <span className="material-symbols-outlined" style={{ fontSize: 14, verticalAlign: "middle", marginRight: 3 }}>public</span>
              {Array.isArray(crisis.countries) && crisis.countries.length > 0
                ? crisis.countries.join(", ")
                : "—"}
            </span>
            <span style={s.metaDot}>·</span>
            <span style={s.metaItem}>
              <span className="material-symbols-outlined" style={{ fontSize: 14, verticalAlign: "middle", marginRight: 3 }}>bolt</span>
              {crisis.crisis_type}
            </span>
            <span style={s.metaDot}>·</span>
            <span style={s.metaItem}>
              <span className="material-symbols-outlined" style={{ fontSize: 14, verticalAlign: "middle", marginRight: 3 }}>calendar_today</span>
              {fmtDate(crisis.start_date)}
            </span>
          </div>
          <div style={s.reportCount}>
            {crisis.report_count.toLocaleString()} report{crisis.report_count !== 1 ? "s" : ""} submitted
          </div>
        </div>
        <div style={s.cardRight}>
          <StatusBadge status={crisis.status} />
        </div>
      </div>

      <div style={s.cardActions}>
        {!isActive && !isArchived && (
          <button
            style={{ ...s.setActiveBtn, opacity: mutating ? 0.6 : 1 }}
            onClick={() => onSetActive(crisis.id)}
            disabled={mutating}
          >
            Set as Active
          </button>
        )}
        {!isArchived && (
          <button
            style={{ ...s.archiveBtn, opacity: mutating ? 0.6 : 1 }}
            onClick={() => onArchive(crisis.id)}
            disabled={mutating}
          >
            Archive
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function CrisisManagementPage() {
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [successBanner, setSuccessBanner] = useState("");
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  // Fetch crises
  const { data: crises = [], isLoading } = useQuery<Crisis[]>({
    queryKey: ["crises"],
    queryFn: async () => {
      const res = await api.get<Crisis[]>("/api/crises");
      return res.data;
    },
  });

  // Fetch countries for modal
  const { data: countries = [] } = useQuery<Country[]>({
    queryKey: ["countries"],
    queryFn: async () => {
      const res = await api.get<Country[]>("/api/countries");
      return res.data;
    },
  });

  // PATCH crisis status
  const patchMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: CrisisStatus }) => {
      await api.patch(`/api/crises/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crises"] });
      setMutatingId(null);
    },
    onError: () => {
      setMutatingId(null);
    },
  });

  function handleSetActive(id: string) {
    setMutatingId(id);
    patchMutation.mutate({ id, status: "active" });
  }

  function handleArchive(id: string) {
    setMutatingId(id);
    patchMutation.mutate({ id, status: "archived" });
  }

  function handleCreateSuccess() {
    setShowModal(false);
    queryClient.invalidateQueries({ queryKey: ["crises"] });
    setSuccessBanner("Crisis created successfully");
  }

  // Auto-dismiss success banner
  useEffect(() => {
    if (!successBanner) return;
    const t = setTimeout(() => setSuccessBanner(""), 4000);
    return () => clearTimeout(t);
  }, [successBanner]);

  const activeCrisis = crises.find((c) => c.status === "active");

  return (
    <div style={s.page}>
      <Header title="Crisis Management" />
      {/* Toolbar row — action button + active crisis context */}
      <div style={s.headerRow}>
        {activeCrisis && (
          <p style={s.pageSubtitle}>
            Active crisis: <strong>{activeCrisis.name}</strong>
          </p>
        )}
        <div style={{ marginLeft: "auto" }}>
          <button style={s.createBtn} onClick={() => setShowModal(true)}>
            + Create New Crisis
          </button>
        </div>
      </div>

      {successBanner && (
        <div style={s.successBanner}>{successBanner}</div>
      )}

      <div style={s.content}>
        {isLoading ? (
          <div style={s.loading}>Loading crises…</div>
        ) : crises.length === 0 ? (
          <div style={s.empty}>
            <div style={s.emptyIcon}>
              <span className="material-symbols-outlined" style={{ fontSize: 40, color: "var(--c-text-muted)", fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 48" }}>public</span>
            </div>
            <div style={s.emptyText}>No crises yet.</div>
            <div style={s.emptyHint}>Click "Create New Crisis" to get started.</div>
          </div>
        ) : (
          <div style={s.crisisList}>
            {crises.map((crisis) => (
              <CrisisCard
                key={crisis.id}
                crisis={crisis}
                onSetActive={handleSetActive}
                onArchive={handleArchive}
                mutating={mutatingId === crisis.id}
              />
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <CreateCrisisModal
          countries={countries}
          onClose={() => setShowModal(false)}
          onSuccess={handleCreateSuccess}
        />
      )}
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
  headerRow: {
    background: "var(--c-surface-lowest)",
    borderBottom: "1px solid #e0e0e0",
    padding: "16px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  pageSubtitle: {
    fontSize: 13,
    color: "var(--c-text-muted)",
    marginTop: 4,
    marginBottom: 0,
  },
  createBtn: {
    padding: "10px 20px",
    background: BLUE,
    color: "var(--c-surface-lowest)",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  successBanner: {
    background: "#d4edda",
    color: "#155724",
    border: "1px solid #c3e6cb",
    padding: "12px 32px",
    fontSize: 14,
    fontWeight: 500,
  },
  content: {
    flex: 1,
    padding: "28px 32px",
    overflowY: "auto",
  },
  loading: {
    padding: 60,
    textAlign: "center",
    color: "var(--c-text-muted)",
    fontSize: 15,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 80,
    gap: 12,
  },
  emptyIcon: { fontSize: 48 },
  emptyText: { fontSize: 18, fontWeight: 700, color: "var(--c-text-primary)" },
  emptyHint: { fontSize: 14, color: "var(--c-text-muted)" },
  crisisList: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    maxWidth: 960,
  },
  // Crisis card
  crisisCard: {
    background: "var(--c-surface-lowest)",
    borderRadius: 12,
    border: "1px solid #e2e8f0",
    boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  },
  cardLeft: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
  },
  cardRight: {
    flexShrink: 0,
  },
  crisisName: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    lineHeight: 1.3,
  },
  crisisMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  metaItem: {
    fontSize: 13,
    color: "#4a5568",
  },
  metaDot: {
    color: "#cbd5e0",
    fontSize: 13,
  },
  reportCount: {
    fontSize: 13,
    color: "var(--c-text-muted)",
    fontWeight: 500,
  },
  badge: {
    display: "inline-block",
    padding: "5px 14px",
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
  },
  cardActions: {
    display: "flex",
    gap: 10,
    borderTop: "1px solid #f0f4f8",
    paddingTop: 14,
  },
  setActiveBtn: {
    padding: "8px 18px",
    background: BLUE,
    color: "var(--c-surface-lowest)",
    border: "none",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  archiveBtn: {
    padding: "8px 18px",
    background: "var(--c-surface-lowest)",
    color: "#4a5568",
    border: "1px solid #cbd5e0",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Modal
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    background: "var(--c-surface-lowest)",
    borderRadius: 14,
    width: "100%",
    maxWidth: 540,
    maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    borderBottom: "1px solid #e2e8f0",
    position: "sticky",
    top: 0,
    background: "var(--c-surface-lowest)",
    zIndex: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    fontSize: 18,
    color: "var(--c-text-muted)",
    cursor: "pointer",
    lineHeight: 1,
    padding: 4,
  },
  form: {
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
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
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid",
    fontSize: 14,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid",
    fontSize: 14,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
  },
  textarea: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
    resize: "vertical" as const,
    fontFamily: "inherit",
  },
  charCount: {
    fontSize: 11,
    color: "#a0aec0",
    textAlign: "right" as const,
    marginTop: -2,
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    fontSize: 14,
    color: "var(--c-text-primary)",
    cursor: "pointer",
    fontWeight: 500,
  },
  submitError: {
    background: "#fff5f5",
    color: "#c53030",
    border: "1px solid #fc8181",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 500,
  },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    padding: "10px 20px",
    background: "var(--c-surface-lowest)",
    color: "#4a5568",
    border: "1px solid #cbd5e0",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  submitBtn: {
    padding: "10px 24px",
    background: BLUE,
    color: "var(--c-surface-lowest)",
    border: "none",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
