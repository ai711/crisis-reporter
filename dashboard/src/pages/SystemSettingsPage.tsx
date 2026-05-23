import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import Header from "../components/Header";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

const UN_LANGUAGES = [
  { name: "Arabic", code: "ar" },
  { name: "Chinese", code: "zh" },
  { name: "English", code: "en" },
  { name: "French", code: "fr" },
  { name: "Russian", code: "ru" },
  { name: "Spanish", code: "es" },
];

type Tab = "countries" | "languages" | "questions" | "map" | "app-content";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Country {
  name: string;
  code: string;
  official_language: string;
  is_active: boolean;
  dialling_code?: string;
}

interface Language {
  name: string;
  code: string;
  is_active: boolean;
}

interface QuestionOption {
  id: string;
  option_text: string;
  option_value: string;
  order_index: number;
}

interface ActiveQuestion {
  id: string;
  question_text: string;
  question_type: string;
  order_index: number;
  is_mandatory: boolean;
  is_active: boolean;
  is_core: boolean;
  options: QuestionOption[];
}

interface ActivePackage {
  id: string;
  version: string;
  published_at: string;
  questions: ActiveQuestion[];
}

interface QueueStatus {
  has_pending: boolean;
  pending_count: number;
}

interface QueueStatusByLang {
  has_pending: boolean;
  total_pending: number;
  by_language: { lang_code: string; lang_name: string; draft_count: number; failed_count: number }[];
  batch_progress: { completed: number; total: number; current_batch: number } | null;
}

interface LanguageLifecycle {
  id: string;
  code: string;
  name: string;
  status: string;
  is_protected: boolean;
  deprecated_at: string | null;
  removal_scheduled_at: string | null;
  created_at: string;
}

interface LockInfo {
  locked: boolean;
  locked_by: string | null;
  locked_at: string | null;
}

interface AuditEntry {
  id: number;
  event_type: string;
  lang_code: string | null;
  string_key: string | null;
  details: Record<string, unknown> | null;
  performed_by: string | null;
  dashboard_user_id: string | null;
  created_at: string;
}

interface MapSettings {
  reporting_radius_miles: number;
  building_source: string;
  country_overrides: Record<string, number>;
}

// ── Translation-management types ───────────────────────────────────────────────

interface StringKeyData {
  id: string;
  key: string;
  category: string;
  english_text: string;
  is_active: boolean;
  translations: Record<string, string>; // language_code → status
}

interface TranslationItem {
  id: string;        // empty string when status === "missing"
  string_key: string;
  english_text: string;
  translated_text: string;
  status: string;    // missing | draft | approved | published
  translated_by: string;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

interface LanguagePkg {
  id: string;
  language_code: string;
  version: string;
  status: string;
  published_at: string | null;
  created_at: string;
  string_count: number;
}

type FilterStatus = "all" | "missing" | "draft" | "approved" | "published";

const TRANSLATION_LANGS = [
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "fr", name: "French" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
];

function statusBadgeStyle(st: string): React.CSSProperties {
  const map: Record<string, [string, string, string]> = {
    missing:   ["#f7fafc", "#a0aec0", "#e2e8f0"],
    draft:     ["#fffbeb", "#d97706", "#fcd34d"],
    approved:  ["#d4edda", "#155724", "#c3e6cb"],
    published: ["#EBF5FB", BLUE,      "#bee3f8"],
  };
  const [bg, color, border] = map[st] ?? ["#f7fafc", "#718096", "#e2e8f0"];
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    color,
    border: `1px solid ${border}`,
    textTransform: "capitalize" as const,
    whiteSpace: "nowrap" as const,
  };
}

function categoryBadgeStyle(): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    background: "#f0f4f8",
    color: "#4a5568",
    border: "1px solid #e2e8f0",
  };
}

function TranslationSourcePill({ translatedBy }: { translatedBy: string }) {
  if (!translatedBy) return <span style={{ color: "#a0aec0" }}>—</span>;
  const base: React.CSSProperties = {
    display: "inline-flex",
    padding: "2px 8px",
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  };
  if (translatedBy === "google")
    return <span style={{ ...base, background: "#dcfce7", color: "#166534" }}>Google</span>;
  if (translatedBy === "libretranslate")
    return <span style={{ ...base, background: "#f3f4f6", color: "#374151" }}>LibreTranslate</span>;
  if (translatedBy === "auto")
    return <span style={{ ...base, background: "#f3f4f6", color: "#6b7280" }}>Auto</span>;
  return <span style={{ ...base, background: "#dbeafe", color: "#1e40af" }}>Manual</span>;
}

// ── Toggle Switch ──────────────────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        border: "none",
        background: checked ? "#22c55e" : "#cbd5e0",
        position: "relative",
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s",
          boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

// ── Field wrapper ──────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={s.fieldGroup}>
      <label style={s.label}>
        {label} {required && <span style={s.req}>*</span>}
      </label>
      {children}
      {error && <span style={s.fieldErr}>{error}</span>}
    </div>
  );
}

// ── Add Country Modal ──────────────────────────────────────────────────────────

function AddCountryModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [lang, setLang] = useState("");
  const [dialCode, setDialCode] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Country name is required";
    if (!code.trim()) e.code = "Country code is required";
    else if (!/^[A-Za-z]{2}$/.test(code.trim())) e.code = "Must be exactly 2 letters";
    if (!lang.trim()) e.lang = "Official language is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      await api.post("/api/countries", {
        name: name.trim(),
        code: code.trim().toUpperCase(),
        official_language: lang.trim(),
        is_active: isActive,
        dialling_code: dialCode.trim() || null,
      });
      onSuccess();
    } catch {
      setSubmitError("Failed to add country. The code may already exist.");
    } finally {
      setSubmitting(false);
    }
  }

  function clearErr(key: string) {
    setErrors((p) => { const n = { ...p }; delete n[key]; return n; });
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Add Country</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={s.form}>
          <Field label="Country Name" required error={errors.name}>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); clearErr("name"); }}
              placeholder="e.g. Haiti"
              style={{ ...s.input, borderColor: errors.name ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>
          <Field label="Country Code (2 letters)" required error={errors.code}>
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); clearErr("code"); }}
              placeholder="e.g. HT"
              maxLength={2}
              style={{ ...s.input, borderColor: errors.code ? "#e53e3e" : "#e2e8f0", textTransform: "uppercase" }}
            />
          </Field>
          <Field label="Official Language" required error={errors.lang}>
            <input
              type="text"
              value={lang}
              onChange={(e) => { setLang(e.target.value); clearErr("lang"); }}
              placeholder="e.g. French"
              style={{ ...s.input, borderColor: errors.lang ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>
          <Field label="Dialling Code">
            <input
              type="text"
              value={dialCode}
              onChange={(e) => setDialCode(e.target.value)}
              placeholder="e.g. +509"
              style={s.input}
            />
          </Field>
          <Field label="Initial Status">
            <div style={s.toggleRow}>
              <ToggleSwitch checked={isActive} onChange={setIsActive} />
              <span style={{ fontSize: 13, color: isActive ? "#155724" : "#718096", fontWeight: 500 }}>
                {isActive ? "Active" : "Inactive"}
              </span>
            </div>
          </Field>
          {submitError && <div style={s.submitError}>{submitError}</div>}
          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Adding…" : "Add Country"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Language Modal ─────────────────────────────────────────────────────────

function AddLanguageModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Language name is required";
    if (!code.trim()) e.code = "Language code is required";
    else if (!/^[a-z]{2,5}$/.test(code.trim())) e.code = "Use 2–5 lowercase letters (e.g. sw, ht)";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      await api.post("/api/languages", {
        name: name.trim(),
        code: code.trim().toLowerCase(),
      });
      onSuccess();
    } catch {
      setSubmitError("Failed to add language. The code may already exist.");
    } finally {
      setSubmitting(false);
    }
  }

  function clearErr(key: string) {
    setErrors((p) => { const n = { ...p }; delete n[key]; return n; });
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Add Language</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={s.form}>
          <Field label="Language Name" required error={errors.name}>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); clearErr("name"); }}
              placeholder="e.g. Swahili"
              style={{ ...s.input, borderColor: errors.name ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>
          <Field label="Language Code" required error={errors.code}>
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); clearErr("code"); }}
              placeholder="e.g. sw"
              style={{ ...s.input, borderColor: errors.code ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>
          {submitError && <div style={s.submitError}>{submitError}</div>}
          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Adding…" : "Add Language"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Warning Modal ─────────────────────────────────────────────────────────

function EditQuestionsWarningModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.modal, maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Edit Questions</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "24px" }}>
          <div style={s.warningBanner}>
            <span style={{ fontSize: 22 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#92400e", marginBottom: 4 }}>
                This will create a new question package version
              </div>
              <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.5 }}>
                All active devices will sync the new version on next app open. Any reports in progress on older versions may experience compatibility issues.
              </div>
            </div>
          </div>
          <p style={{ fontSize: 14, color: "#4a5568", margin: "16px 0 0", lineHeight: 1.6 }}>
            Editing questions will create a new draft version. You must publish it explicitly before it goes live.
          </p>
        </div>
        <div style={{ ...s.modalFooter, padding: "0 24px 24px" }}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...s.submitBtn, background: "#d97706" }}
            onClick={onConfirm}
          >
            Continue to Editor
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TAB 1 — Countries ──────────────────────────────────────────────────────────

function CountriesTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [successBanner, setSuccessBanner] = useState("");

  const { data: countries = [], isLoading } = useQuery<Country[]>({
    queryKey: ["countries"],
    queryFn: async () => {
      const res = await api.get<Country[]>("/api/countries");
      return res.data;
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ code, is_active }: { code: string; is_active: boolean }) => {
      await api.patch(`/api/countries/${code}`, { is_active });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["countries"] });
    },
  });

  const filtered = countries.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase())
  );

  function handleSuccess() {
    setShowAddModal(false);
    queryClient.invalidateQueries({ queryKey: ["countries"] });
    setSuccessBanner("Country added successfully");
    setTimeout(() => setSuccessBanner(""), 4000);
  }

  return (
    <div style={s.tabContent}>
      <div style={s.tabToolbar}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by country name or code…"
          style={s.searchInput}
        />
        <button style={s.addBtn} onClick={() => setShowAddModal(true)}>
          + Add Country
        </button>
      </div>

      {successBanner && <div style={s.successBanner}>{successBanner}</div>}

      {isLoading ? (
        <div style={s.loadingText}>Loading countries…</div>
      ) : filtered.length === 0 ? (
        <div style={s.emptyState}>
          <div style={{ fontSize: 40 }}>🌍</div>
          <div style={{ color: "#718096", fontSize: 14 }}>
            {search ? "No countries match your search." : "No countries configured yet."}
          </div>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Country Name</th>
                <th style={s.th}>Country Code</th>
                <th style={s.th}>Official Language</th>
                <th style={s.th}>Dialling Code</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((country) => (
                <tr key={country.code} style={s.tr}>
                  <td style={s.td}>
                    <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{country.name}</span>
                  </td>
                  <td style={s.td}>
                    <span style={s.codeBadge}>{country.code}</span>
                  </td>
                  <td style={s.td}>
                    <span style={{ color: "#4a5568" }}>{country.official_language}</span>
                  </td>
                  <td style={s.td}>
                    <span style={{ color: "#718096", fontSize: 13 }}>{country.dialling_code ?? "—"}</span>
                  </td>
                  <td style={s.td}>
                    <div style={s.toggleRow}>
                      <ToggleSwitch
                        checked={country.is_active}
                        onChange={(v) => toggleMutation.mutate({ code: country.code, is_active: v })}
                        disabled={toggleMutation.isPending}
                      />
                      <span style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: country.is_active ? "#155724" : "#718096",
                      }}>
                        {country.is_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAddModal && (
        <AddCountryModal
          onClose={() => setShowAddModal(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}

// ── TAB 2 — Languages (Translation Management) ────────────────────────────────

function daysUntil(isoDate: string | null): number {
  if (!isoDate) return 0;
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86400000);
}

function LangStatusPill({ lang }: { lang: LanguageLifecycle }) {
  if (lang.is_protected) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: "#EBF5FB", color: BLUE, border: `1px solid #bee3f8` }}>
        Protected
      </span>
    );
  }
  const map: Record<string, [string, string, string]> = {
    active:     ["#d4edda", "#155724", "#c3e6cb"],
    pending:    ["#fffbeb", "#92400e", "#fcd34d"],
    deprecated: ["#fff5f5", "#c53030", "#fc8181"],
  };
  const [bg, color, border] = map[lang.status] ?? ["#f7fafc", "#718096", "#e2e8f0"];
  const label = lang.status === "deprecated" && lang.removal_scheduled_at
    ? `Deprecated · ${daysUntil(lang.removal_scheduled_at)}d left`
    : lang.status.charAt(0).toUpperCase() + lang.status.slice(1);
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: bg, color, border: `1px solid ${border}`, whiteSpace: "nowrap" as const }}>
      {label}
    </span>
  );
}

function LanguagesTab() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";
  const isSuperadmin = user?.role === "superadmin";

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedLang, setSelectedLang] = useState("ar");
  const [filterTab, setFilterTab] = useState<FilterStatus>("draft");
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [autoTranslatingLang, setAutoTranslatingLang] = useState<string | null>(null);
  const [publishingLang, setPublishingLang] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ msg: string; ok: boolean } | null>(null);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [lockLoading, setLockLoading] = useState(false);
  const [rejectModal, setRejectModal] = useState<{ id: string; key: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [deprecateModal, setDeprecateModal] = useState<{ code: string; name: string } | null>(null);
  const [deprecateComment, setDeprecateComment] = useState("");
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditPage, setAuditPage] = useState(1);
  const [translateMsg, setTranslateMsg] = useState<string>("");
  const [translateProgress, setTranslateProgress] = useState<{ completed: number; total: number } | null>(null);
  const [showAddLanguageModal, setShowAddLanguageModal] = useState(false);
  const [highlightedLang, setHighlightedLang] = useState<string | null>(null);
  const [syncingStringKeys, setSyncingStringKeys] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [isPublishingApi, setIsPublishingApi] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ text: string; type: "success" | "error" } | null>(null);

  function showBanner(msg: string, ok = true) {
    setBanner({ msg, ok });
    setTimeout(() => setBanner(null), 6000);
  }

  // ── Lock management ──────────────────────────────────────────────────────

  async function acquireLock(langCode: string) {
    setLockLoading(true);
    try {
      await api.post(`/api/translations/lock/${langCode}`);
      setLockInfo({ locked: true, locked_by: null, locked_at: null });
    } catch (err: unknown) {
      const d = (err as { response?: { data?: { locked_by?: string; locked_at?: string } } })?.response?.data;
      setLockInfo({ locked: false, locked_by: d?.locked_by ?? null, locked_at: d?.locked_at ?? null });
    } finally {
      setLockLoading(false);
    }
  }

  async function releaseLock(langCode: string) {
    try {
      await api.post(`/api/translations/unlock/${langCode}`);
    } catch { /* ignore */ }
    setLockInfo(null);
  }

  async function forceReleaseLock(langCode: string) {
    try {
      await api.post(`/api/translations/unlock/${langCode}/admin`);
      showBanner("Lock force-released.");
      setLockInfo({ locked: true, locked_by: null, locked_at: null });
      queryClient.invalidateQueries({ queryKey: ["translations", langCode] });
    } catch {
      showBanner("Failed to force-release lock.", false);
    }
  }

  // Acquire lock on language selection
  useEffect(() => {
    acquireLock(selectedLang);
    return () => {
      releaseLock(selectedLang);
    };
  }, [selectedLang]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release lock on browser unload
  useEffect(() => {
    function handleUnload() {
      const token = localStorage.getItem("token") ?? "";
      fetch(`/api/translations/unlock/${selectedLang}`, {
        method: "POST",
        keepalive: true,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
    }
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [selectedLang]);

  // Update translateProgress whenever queueStatus refreshes during active translation
  useEffect(() => {
    if (!autoTranslatingLang || !queueStatus) return;
    const entry = queueStatus.by_language.find((l) => l.lang_code === autoTranslatingLang);
    const remaining = (entry?.draft_count ?? 0) + (entry?.failed_count ?? 0);
    // totalActive is computed in derived-data below; captured safely in closure
    setTranslateProgress((prev) =>
      prev !== null ? { completed: Math.max(0, prev.total - remaining), total: prev.total } : null
    );
  }, [queueStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: languages = [], isLoading: langsLoading } = useQuery<LanguageLifecycle[]>({
    queryKey: ["languages"],
    queryFn: async () => {
      const res = await api.get<LanguageLifecycle[]>("/api/languages");
      return res.data;
    },
  });

  const { data: stringKeys = [], isLoading: keysLoading } = useQuery<StringKeyData[]>({
    queryKey: ["string-keys"],
    queryFn: async () => {
      const res = await api.get<StringKeyData[]>("/api/string-keys");
      return res.data;
    },
  });

  const { data: translations = [], isLoading: transLoading } = useQuery<TranslationItem[]>({
    queryKey: ["translations", selectedLang],
    queryFn: async () => {
      const res = await api.get<TranslationItem[]>(`/api/translations/${selectedLang}`);
      return res.data;
    },
  });

  const { data: queueStatus } = useQuery<QueueStatusByLang>({
    queryKey: ["queue-status-by-lang"],
    queryFn: async () => {
      const res = await api.get<QueueStatusByLang>("/api/translations/queue-status");
      return res.data;
    },
    refetchInterval: autoTranslatingLang ? 10000 : 30000,
  });

  const { data: auditData } = useQuery({
    queryKey: ["translation-audit", auditPage],
    queryFn: async () => {
      const res = await api.get(`/api/translations/audit-log?page=${auditPage}&page_size=20`);
      return res.data as { total: number; page: number; items: AuditEntry[] };
    },
    enabled: auditOpen,
  });

  const { data: packages = [] } = useQuery<LanguagePkg[]>({
    queryKey: ["language-packages"],
    queryFn: async () => {
      const res = await api.get<LanguagePkg[]>("/api/language-packages");
      return res.data;
    },
  });

  // ── Derived data ─────────────────────────────────────────────────────────

  const activeKeys = stringKeys.filter((k) => k.is_active);
  const totalActive = activeKeys.length;
  const categoryMap = Object.fromEntries(stringKeys.map((k) => [k.key, k.category]));

  const coverageByLang = Object.fromEntries(
    languages.map((lang) => {
      let approved = 0;
      for (const key of activeKeys) {
        const st = key.translations[lang.code];
        if (st === "approved" || st === "published") approved++;
      }
      return [lang.code, totalActive > 0 ? Math.round((approved / totalActive) * 100) : 0];
    })
  );

  // Per-language translation status counts for the Translation Status pills (FIX 2)
  const statusByLang = Object.fromEntries(
    languages.map((lang) => {
      let missing = 0, draft = 0, published = 0;
      for (const key of activeKeys) {
        const st = key.translations[lang.code];
        if (!st || st === "missing" || st === "retired") missing++;
        else if (st === "draft" || st === "failed") draft++;
        else if (st === "approved" || st === "published") published++;
      }
      return [lang.code, { missing, draft, published }];
    })
  );

  const counts: Record<FilterStatus, number> = {
    all:       translations.length,
    missing:   translations.filter((t) => t.status === "missing").length,
    draft:     translations.filter((t) => t.status === "draft").length,
    approved:  translations.filter((t) => t.status === "approved").length,
    published: translations.filter((t) => t.status === "published").length,
  };

  const googleCount = translations.filter((t) => t.translated_by === "google").length;
  const libreCount = translations.filter((t) => t.translated_by === "libretranslate").length;
  const manualCount = translations.filter(
    (t) => t.translated_by !== "" && t.translated_by !== "google" && t.translated_by !== "libretranslate" && t.translated_by !== "auto" && t.status !== "missing"
  ).length;

  const filtered =
    filterTab === "all" ? translations : translations.filter((t) => t.status === filterTab);

  const selectedLangData = languages.find((l) => l.code === selectedLang);
  const lockHeld = lockInfo?.locked === true;
  const canEdit = lockHeld && selectedLangData?.status !== "deprecated";

  // Publish eligibility
  const langQueueEntry = queueStatus?.by_language.find((l) => l.lang_code === selectedLang);
  const hasPending = (langQueueEntry?.draft_count ?? 0) + (langQueueEntry?.failed_count ?? 0) > 0;
  const publishReady = (coverageByLang[selectedLang] ?? 0) === 100 && !hasPending;

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleLangChange(code: string) {
    await releaseLock(selectedLang);
    setSelectedLang(code);
    setFilterTab("draft");
    setEditedTexts({});
  }

  async function handleAutoTranslate(langCode: string) {
    const langName = languages.find((l) => l.code === langCode)?.name ?? langCode.toUpperCase();
    const confirmed = window.confirm(
      `Start auto-translation for ${langName}? This will translate all untranslated strings using LibreTranslate. Existing translations will not be overwritten. This runs in the background and may take a few minutes.`
    );
    if (!confirmed) return;
    setAutoTranslatingLang(langCode);
    try {
      await api.post<{ status: string; language_code: string }>(
        "/api/translations/auto-translate",
        { language_code: langCode }
      );
      queryClient.invalidateQueries({ queryKey: ["translations", langCode] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
      // Initialise progress banner — total is updated each queue-status poll
      setTranslateProgress({ completed: 0, total: totalActive });
      setTranslateMsg(`Auto-translation started for ${langName}. Check the Review Queue tab for progress.`);
      setTimeout(() => setTranslateMsg(""), 5000);
      // autoTranslatingLang intentionally NOT cleared here — progress banner
      // stays until user dismisses with ×
    } catch {
      showBanner("Auto-translate failed — check LibreTranslate configuration.", false);
      setAutoTranslatingLang(null);
      setTranslateProgress(null);
    }
  }

  function handlePublish(langCode?: string) {
    const code = langCode ?? selectedLang;
    if (!langCode && !publishReady) return;
    setPublishingLang(code);
    setShowPublishConfirm(true);
  }

  async function executePublish() {
    if (!publishingLang) return;
    setIsPublishingApi(true);
    try {
      await api.post(`/api/language-packages/publish/${publishingLang}`);
      queryClient.invalidateQueries({ queryKey: ["translations", publishingLang] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["language-packages"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
      queryClient.invalidateQueries({ queryKey: ["translation-audit"] });
      setShowPublishConfirm(false);
      setPublishMsg({ text: "Published successfully. Reporters will receive updates on next app open.", type: "success" });
      setTimeout(() => setPublishMsg(null), 5000);
      setPublishingLang(null);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Publish failed. Please try again.";
      setShowPublishConfirm(false);
      setPublishMsg({ text: detail, type: "error" });
      // publishingLang kept for retry
    } finally {
      setIsPublishingApi(false);
    }
  }

  async function handleSave(t: TranslationItem) {
    if (!canEdit) return;
    const editedText = editedTexts[t.string_key];
    if (editedText === undefined) return;
    const newText = editedText.trim();
    if (!newText || newText === t.translated_text.trim()) {
      setEditedTexts((p) => { const n = { ...p }; delete n[t.string_key]; return n; });
      return;
    }
    setSavingKeys((p) => new Set([...p, t.string_key]));
    try {
      if (t.id) {
        await api.patch(`/api/translations/${t.id}`, { translated_text: newText });
      } else {
        await api.post("/api/translations", {
          string_key: t.string_key,
          language_code: selectedLang,
          translated_text: newText,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
    } catch {
      showBanner("Failed to save translation. You may need to re-acquire the edit lock.", false);
    } finally {
      setSavingKeys((p) => { const n = new Set(p); n.delete(t.string_key); return n; });
      setEditedTexts((p) => { const n = { ...p }; delete n[t.string_key]; return n; });
    }
  }

  async function handleApprove(translationId: string) {
    if (!canEdit) { showBanner("Acquire edit lock first.", false); return; }
    try {
      await api.patch(`/api/translations/${translationId}/approve`);
      queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
      queryClient.invalidateQueries({ queryKey: ["translation-audit"] });
    } catch {
      showBanner("Failed to approve translation.", false);
    }
  }

  async function handleRejectSubmit() {
    if (!rejectModal || rejectReason.trim().length < 5) return;
    setRejectSubmitting(true);
    try {
      await api.patch(`/api/translations/${rejectModal.id}/reject`, { reason: rejectReason.trim() });
      queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
      queryClient.invalidateQueries({ queryKey: ["translation-audit"] });
      setRejectModal(null);
      setRejectReason("");
      showBanner("Translation rejected.");
    } catch {
      showBanner("Failed to reject translation.", false);
    } finally {
      setRejectSubmitting(false);
    }
  }

  async function handleApproveAll() {
    const draftIds = translations.filter((t) => t.status === "draft" && t.id).map((t) => t.id);
    if (draftIds.length === 0) { showBanner("No draft translations to approve."); return; }
    if (!canEdit) { showBanner("Acquire edit lock first.", false); return; }
    let ok = 0;
    for (const id of draftIds) {
      try { await api.patch(`/api/translations/${id}/approve`); ok++; } catch { /* continue */ }
    }
    queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
    queryClient.invalidateQueries({ queryKey: ["string-keys"] });
    queryClient.invalidateQueries({ queryKey: ["queue-status-by-lang"] });
    showBanner(`Approved ${ok} / ${draftIds.length} translations.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    setHighlightedLang(selectedLang);
    setTimeout(() => setHighlightedLang(null), 3000);
  }

  async function handleDeprecate() {
    if (!deprecateModal || deprecateComment.trim().length < 10) return;
    try {
      await api.patch(`/api/languages/${deprecateModal.code}/status`, { status: "deprecated" });
      queryClient.invalidateQueries({ queryKey: ["languages"] });
      queryClient.invalidateQueries({ queryKey: ["translation-audit"] });
      showBanner(`${deprecateModal.name} marked as deprecated.`);
      setDeprecateModal(null);
      setDeprecateComment("");
    } catch {
      showBanner("Failed to deprecate language.", false);
    }
  }

  async function handleRestoreLang(code: string) {
    try {
      await api.patch(`/api/languages/${code}/status`, { status: "active" });
      queryClient.invalidateQueries({ queryKey: ["languages"] });
      showBanner("Language restored to active.");
    } catch {
      showBanner("Failed to restore language.", false);
    }
  }

  async function handleRemoveLang(code: string, name: string) {
    if (!window.confirm(`Permanently remove language "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/languages/${code}`);
      queryClient.invalidateQueries({ queryKey: ["languages"] });
      showBanner(`${name} removed.`);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Remove failed.";
      showBanner(detail, false);
    }
  }

  async function handleSyncStringKeys() {
    setSyncingStringKeys(true);
    setSyncMsg("");
    try {
      const res = await api.post<{ created: number; retired: number }>("/api/translations/sync-string-keys");
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
      setSyncMsg(`Sync complete: ${res.data.created} new strings added, ${res.data.retired} retired.`);
      setTimeout(() => setSyncMsg(""), 6000);
    } catch {
      setSyncMsg("Sync failed. Check server logs.");
      setTimeout(() => setSyncMsg(""), 4000);
    } finally {
      setSyncingStringKeys(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={s.tabContent}>
      <style>{`@keyframes cr-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      {banner && (
        <div style={{ ...s.successBanner, background: banner.ok ? "#d4edda" : "#fff5f5", color: banner.ok ? "#155724" : "#c53030", border: `1px solid ${banner.ok ? "#c3e6cb" : "#fc8181"}` }}>
          {banner.msg}
        </div>
      )}

      {/* ── Unified Queue Summary ────────────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Translation Review Queue</span>
          {queueStatus && (
            <span style={sL.sectionMeta}>
              {queueStatus.total_pending === 0
                ? <span style={{ color: "#22c55e", fontWeight: 700 }}>All translations are up to date</span>
                : <span style={{ color: "#d97706", fontWeight: 700 }}>{queueStatus.total_pending} strings need review</span>
              }
            </span>
          )}
        </div>
        {queueStatus && queueStatus.total_pending > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 12, padding: "16px 24px" }}>
            {queueStatus.by_language.filter((l) => l.draft_count + l.failed_count > 0).map((l) => (
              <button
                key={l.lang_code}
                onClick={() => handleLangChange(l.lang_code)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 10, border: selectedLang === l.lang_code ? `2px solid ${BLUE}` : "1px solid #e2e8f0", background: selectedLang === l.lang_code ? "#EBF5FB" : "#fafafa", cursor: "pointer" }}
              >
                <span style={s.codeBadge}>{l.lang_code}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1A2B4A" }}>{l.lang_name}</span>
                {l.draft_count > 0 && (
                  <span style={{ ...sL.countBadge, background: "#fcd34d", color: "#92400e" }}>{l.draft_count} draft</span>
                )}
                {l.failed_count > 0 && (
                  <span style={{ ...sL.countBadge, background: "#fc8181", color: "#7f1d1d" }}>{l.failed_count} failed</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ padding: "16px 24px", color: "#718096", fontSize: 13, fontStyle: "italic" }}>
            {queueStatus ? "No pending translations — all clear." : "Loading queue status…"}
          </div>
        )}
      </div>

      {autoTranslatingLang ? (
        /* ── Auto-translate live progress banner (FIX 3) ─────────────────── */
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 14, height: 14, border: "2px solid #0468b1", borderTopColor: "transparent", borderRadius: "50%", animation: "cr-spin 0.8s linear infinite", flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 13, color: "#1e40af" }}>
                Auto-translating {languages.find((l) => l.code === autoTranslatingLang)?.name ?? autoTranslatingLang.toUpperCase()}...
              </span>
            </div>
            <button
              style={{ background: "none", border: "none", color: "#6b7280", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}
              onClick={() => { setAutoTranslatingLang(null); setTranslateProgress(null); }}
              title="Dismiss"
            >
              ×
            </button>
          </div>
          {translateProgress && translateProgress.total > 0 ? (
            <>
              <div style={{ marginTop: 8, background: "#e5e7eb", borderRadius: 9999, height: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "#0468b1", borderRadius: 9999, width: `${Math.round((translateProgress.completed / translateProgress.total) * 100)}%`, transition: "width 0.5s ease" }} />
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>
                {translateProgress.completed} of {translateProgress.total} strings translated
              </div>
            </>
          ) : (
            <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>Starting...</div>
          )}
        </div>
      ) : translateMsg ? (
        <div style={{ background: "#fef3c7", color: "#92400e", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>
          {translateMsg}
        </div>
      ) : null}
      {publishMsg && (
        <div style={{ background: publishMsg.type === "success" ? "#dcfce7" : "#fee2e2", color: publishMsg.type === "success" ? "#166534" : "#991b1b", padding: "8px 12px", borderRadius: 6, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{publishMsg.text}</span>
          {publishMsg.type === "error" && (
            <button
              style={{ ...sL.actionBtn, background: "#fff", color: "#991b1b", border: "1px solid #fca5a5", marginLeft: 12 }}
              onClick={() => { if (publishingLang) setShowPublishConfirm(true); }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* ── Language List ────────────────────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Languages</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
            <span style={sL.sectionMeta}>
              {!langsLoading && !keysLoading && (
                <>{languages.length} languages · {totalActive} strings</>
              )}
            </span>
            {isAdmin && (
              <button
                style={{ padding: "8px 16px", background: BLUE, color: "#fff", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                onClick={() => setShowAddLanguageModal(true)}
              >
                + Add Language
              </button>
            )}
            {isSuperadmin && (
              <button
                style={{ ...sL.actionBtn, background: "#f7fafc", color: "#4a5568", border: "1px solid #e2e8f0" }}
                onClick={handleSyncStringKeys}
                disabled={syncingStringKeys}
              >
                {syncingStringKeys ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 10, height: 10, border: "2px solid #718096", borderTopColor: "transparent", borderRadius: "50%", animation: "cr-spin 0.8s linear infinite" }} />
                    Syncing…
                  </span>
                ) : "Sync String Keys"}
              </button>
            )}
          </div>
        </div>
        {syncMsg && (
          <div style={{ padding: "8px 24px", background: syncMsg.includes("failed") ? "#fff5f5" : "#d4edda", color: syncMsg.includes("failed") ? "#c53030" : "#155724", fontSize: 13, borderBottom: "1px solid #f0f4f8" }}>
            {syncMsg}
          </div>
        )}
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Language</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Reporter Visible</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Translation Status</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {langsLoading ? (
                <tr><td colSpan={5} style={{ ...s.td, textAlign: "center", color: "#718096" }}>Loading…</td></tr>
              ) : languages.map((lang) => {
                const pct = coverageByLang[lang.code] ?? 0;
                const langQEntry = queueStatus?.by_language.find((l) => l.lang_code === lang.code);
                const pending = (langQEntry?.draft_count ?? 0) + (langQEntry?.failed_count ?? 0);
                const canPublish = pct === 100 && pending === 0 && isSuperadmin;
                const isPastRemoval = lang.removal_scheduled_at
                  ? new Date(lang.removal_scheduled_at) <= new Date()
                  : false;
                return (
                  <tr key={lang.code} style={{ ...s.tr, backgroundColor: highlightedLang === lang.code ? "#f0fdf4" : "transparent", transition: "background-color 0.5s ease" }}>
                    <td style={s.td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={s.codeBadge}>{lang.code}</span>
                        <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{lang.name}</span>
                      </div>
                    </td>
                    <td style={s.td}>
                      <LangStatusPill lang={lang} />
                    </td>
                    <td style={s.td}>
                      {lang.is_protected || lang.status === "active" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, color: "#22c55e" }}>
                          <span>✓</span>
                          <span>Visible</span>
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, color: "#a0aec0" }}>
                          <span>—</span>
                          <span>Hidden</span>
                        </span>
                      )}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, flexWrap: "wrap" as const }}>
                        {(() => {
                          const st = statusByLang[lang.code];
                          if (!st) return <span style={{ fontSize: 12, color: "#a0aec0" }}>—</span>;
                          const allPublished = st.missing === 0 && st.draft === 0 && st.published > 0;
                          return (
                            <>
                              {!allPublished && st.missing > 0 && (
                                <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, marginRight: 4, background: "#fee2e2", color: "#991b1b" }}>
                                  {st.missing} Missing
                                </span>
                              )}
                              {st.draft > 0 && (
                                <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, marginRight: 4, background: "#fef3c7", color: "#92400e" }}>
                                  {st.draft} Draft
                                </span>
                              )}
                              {st.published > 0 && (
                                <span style={{ display: "inline-flex", padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, marginRight: 4, background: "#dcfce7", color: "#166534" }}>
                                  {st.published} Published
                                </span>
                              )}
                              {st.missing === 0 && st.draft === 0 && st.published === 0 && (
                                <span style={{ fontSize: 12, color: "#a0aec0" }}>—</span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" as const }}>
                        {lang.code !== "en" && (
                          autoTranslatingLang === lang.code ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ width: 14, height: 14, border: "2px solid #fcd34d", borderTopColor: "transparent", borderRadius: "50%", animation: "cr-spin 0.8s linear infinite" }} />
                              <span style={{ fontSize: 12, color: "#6b7280" }}>Translating...</span>
                            </div>
                          ) : (
                            <button
                              style={{ ...sL.actionBtn, background: "#fffbeb", color: "#d97706", border: "1px solid #fcd34d" }}
                              onClick={() => handleAutoTranslate(lang.code)}
                              disabled={!!autoTranslatingLang}
                            >
                              Auto-translate
                            </button>
                          )
                        )}
                        {canPublish && (
                          <button
                            style={{ ...sL.actionBtn, background: "#d4edda", color: "#155724", border: "1px solid #c3e6cb" }}
                            onClick={() => handlePublish(lang.code)}
                          >
                            Publish
                          </button>
                        )}
                        {isAdmin && !lang.is_protected && lang.status === "active" && (
                          <button
                            style={{ ...sL.actionBtn, background: "#fff5f5", color: "#c53030", border: "1px solid #fc8181" }}
                            onClick={() => setDeprecateModal({ code: lang.code, name: lang.name })}
                          >
                            Deprecate
                          </button>
                        )}
                        {isAdmin && !lang.is_protected && lang.status === "deprecated" && (
                          <>
                            <button
                              style={{ ...sL.actionBtn, background: "#d4edda", color: "#155724", border: "1px solid #c3e6cb" }}
                              onClick={() => handleRestoreLang(lang.code)}
                            >
                              Restore
                            </button>
                            {isSuperadmin && isPastRemoval && (
                              <button
                                style={{ ...sL.actionBtn, background: "#1A2B4A", color: "#fff", border: "none" }}
                                onClick={() => handleRemoveLang(lang.code, lang.name)}
                              >
                                Remove now
                              </button>
                            )}
                          </>
                        )}
                        {isAdmin && !lang.is_protected && lang.status === "pending" && (
                          <button
                            style={{ ...sL.actionBtn, background: "#d4edda", color: "#155724", border: "1px solid #c3e6cb" }}
                            onClick={async () => {
                              try {
                                await api.patch(`/api/languages/${lang.code}/status`, { status: "active" });
                                queryClient.invalidateQueries({ queryKey: ["languages"] });
                              } catch { showBanner("Failed to activate.", false); }
                            }}
                          >
                            Activate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Translation Editor ───────────────────────────────────────────── */}
      <div style={{ ...sL.sectionCard, position: "relative" }}>
        {(lockLoading || transLoading) && (
          <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(255,255,255,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, borderRadius: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 20, height: 20, border: "3px solid #0468b1", borderTopColor: "transparent", borderRadius: "50%", animation: "cr-spin 0.8s linear infinite" }} />
              <span style={{ fontSize: 14, color: "#6b7280", fontWeight: 500 }}>Loading translations...</span>
            </div>
          </div>
        )}
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Edit Translations</span>
          <select
            value={selectedLang}
            onChange={(e) => handleLangChange(e.target.value)}
            style={{ ...s.select, minWidth: 200 }}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
            ))}
          </select>
        </div>

        {/* Edit lock banner */}
        {lockLoading ? (
          <div style={{ padding: "10px 24px", fontSize: 13, color: "#718096" }}>Acquiring edit lock…</div>
        ) : lockHeld ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 24px", background: "#d4edda", borderBottom: "1px solid #c3e6cb" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#155724" }}>You are editing — {selectedLangData?.name ?? selectedLang}</span>
            <button style={{ ...sL.actionBtn, background: "#fff", color: "#155724", border: "1px solid #c3e6cb" }} onClick={() => releaseLock(selectedLang)}>Release lock</button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 24px", background: "#fffbeb", borderBottom: "1px solid #fcd34d" }}>
            <span style={{ fontSize: 13, color: "#92400e" }}>
              {lockInfo?.locked_by
                ? `Currently being edited by ${lockInfo.locked_by}. You can view but not edit.`
                : "Edit lock not held — click to acquire."}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...sL.actionBtn, background: "#fff", color: "#d97706", border: "1px solid #fcd34d" }} onClick={() => acquireLock(selectedLang)}>Acquire lock</button>
              {isSuperadmin && lockInfo?.locked_by && (
                <button style={{ ...sL.actionBtn, background: "#c53030", color: "#fff", border: "none" }} onClick={() => forceReleaseLock(selectedLang)}>Force release</button>
              )}
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div style={sL.filterTabBar}>
          {(["all", "missing", "draft", "approved", "published"] as FilterStatus[]).map((tab) => (
            <button
              key={tab}
              style={{ ...sL.filterTabBtn, borderBottom: filterTab === tab ? `2px solid ${BLUE}` : "2px solid transparent", color: filterTab === tab ? BLUE : "#718096", fontWeight: filterTab === tab ? 700 : 500 }}
              onClick={() => setFilterTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              <span style={{ ...sL.countBadge, background: filterTab === tab ? BLUE : "#e2e8f0", color: filterTab === tab ? "#fff" : "#4a5568" }}>{counts[tab]}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {canEdit && counts.draft > 0 && (
            <button style={{ ...sL.actionBtn, margin: "6px 8px", background: "#d4edda", color: "#155724", border: "1px solid #c3e6cb" }} onClick={handleApproveAll}>
              Approve all Draft ({counts.draft})
            </button>
          )}
          {isSuperadmin && (
            <button
              title={!publishReady ? (hasPending ? "Review queue has pending strings" : "Coverage is not 100%") : "Publish translations"}
              style={{ ...sL.actionBtn, margin: "6px 8px", background: publishReady ? "#d4edda" : "#f0f4f8", color: publishReady ? "#155724" : "#a0aec0", border: `1px solid ${publishReady ? "#c3e6cb" : "#e2e8f0"}`, cursor: publishReady ? "pointer" : "default" }}
              onClick={() => handlePublish()}
              disabled={!publishReady || showPublishConfirm}
            >
              {isPublishingApi && publishingLang === selectedLang ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>

        {/* Service breakdown summary — C */}
        {!transLoading && (googleCount > 0 || libreCount > 0 || manualCount > 0) && (
          <div style={{ fontSize: 12, color: "#6b7280", padding: "6px 16px 4px", display: "flex", gap: 10, flexWrap: "wrap" as const }}>
            {googleCount > 0 && <span>{googleCount} via Google</span>}
            {libreCount > 0 && <span>{libreCount} via LibreTranslate</span>}
            {manualCount > 0 && <span>{manualCount} manual</span>}
          </div>
        )}

        <div style={s.tableWrap}>
          <table style={{ ...s.table, tableLayout: "fixed" as const }}>
            <colgroup>
              <col style={{ width: "14%" }} /><col style={{ width: "7%" }} /><col style={{ width: "20%" }} /><col style={{ width: "22%" }} /><col style={{ width: "9%" }} /><col style={{ width: "10%" }} /><col style={{ width: "18%" }} />
            </colgroup>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Key</th>
                <th style={s.th}>Category</th>
                <th style={s.th}>English</th>
                <th style={s.th}>Translation</th>
                <th style={s.th}>Translated By</th>
                <th style={s.th}>Status</th>
                <th style={{ ...s.th, textAlign: "center" as const }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {transLoading ? (
                <tr><td colSpan={7} style={{ ...s.td, textAlign: "center", color: "#718096" }}>Loading translations…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ ...s.td, textAlign: "center", color: "#718096", fontStyle: "italic" }}>No {filterTab === "all" ? "" : filterTab + " "}translations.</td></tr>
              ) : filtered.map((t) => {
                const isSaving = savingKeys.has(t.string_key);
                const currentText = editedTexts[t.string_key] ?? t.translated_text;
                const editable = canEdit && t.status !== "published";
                const canApprove = canEdit && !!t.id && (t.status === "draft" || t.status === "failed");
                const canReject = canEdit && !!t.id && t.status !== "published" && t.status !== "missing";
                return (
                  <tr key={t.string_key} style={s.tr}>
                    <td style={s.td}>
                      <span style={{ ...s.codeBadge, fontSize: 11, wordBreak: "break-all" as const, display: "inline-block" }}>{t.string_key}</span>
                    </td>
                    <td style={s.td}>
                      <span style={categoryBadgeStyle()}>{categoryMap[t.string_key] ?? "—"}</span>
                    </td>
                    <td style={{ ...s.td, fontSize: 12, color: "#4a5568", lineHeight: 1.4, wordBreak: "break-word" as const }}>{t.english_text}</td>
                    <td style={s.td}>
                      {editable ? (
                        <input
                          type="text"
                          value={currentText}
                          placeholder={t.status === "missing" ? "Enter translation…" : ""}
                          onChange={(e) => setEditedTexts((p) => ({ ...p, [t.string_key]: e.target.value }))}
                          onBlur={() => handleSave(t)}
                          disabled={isSaving}
                          style={{ ...s.input, width: "100%", fontSize: 12, padding: "6px 8px", opacity: isSaving ? 0.6 : 1, boxSizing: "border-box" as const }}
                        />
                      ) : (
                        <span style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.4 }}>{t.translated_text}</span>
                      )}
                      {t.rejection_reason && (
                        <div style={{ fontSize: 11, color: "#c53030", marginTop: 2 }}>Rejected: {t.rejection_reason}</div>
                      )}
                      {(t.translated_by === "google" || t.translated_by === "libretranslate" || t.translated_by === "auto") && t.status === "draft" && (
                        <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, fontStyle: "italic" }}>
                          Auto-translated · {new Date(t.updated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                        </div>
                      )}
                    </td>
                    <td style={s.td}>
                      <TranslationSourcePill translatedBy={t.translated_by} />
                    </td>
                    <td style={s.td}>
                      <span style={statusBadgeStyle(t.status)}>{t.status}</span>
                    </td>
                    <td style={{ ...s.td, textAlign: "center" as const }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" as const }}>
                        {canApprove && (
                          <button style={{ padding: "4px 10px", background: "#d4edda", color: "#155724", border: "1px solid #c3e6cb", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }} onClick={() => handleApprove(t.id)}>
                            Approve
                          </button>
                        )}
                        {canReject && (
                          <button style={{ padding: "4px 10px", background: "#fff5f5", color: "#c53030", border: "1px solid #fc8181", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }} onClick={() => { setRejectModal({ id: t.id, key: t.string_key }); setRejectReason(""); }}>
                            Reject
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Publish History ──────────────────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}><span style={sL.sectionTitle}>Publish History</span></div>
        {packages.length === 0 ? (
          <div style={{ padding: "24px 28px", color: "#718096", fontSize: 13, fontStyle: "italic" }}>No language packages published yet.</div>
        ) : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Language</th>
                  <th style={s.th}>Version</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Published</th>
                  <th style={{ ...s.th, textAlign: "right" as const }}>Strings</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id} style={s.tr}>
                    <td style={s.td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={s.codeBadge}>{pkg.language_code}</span>
                        <span style={{ color: "#4a5568" }}>{languages.find((l) => l.code === pkg.language_code)?.name ?? pkg.language_code}</span>
                      </div>
                    </td>
                    <td style={s.td}><span style={{ fontWeight: 600, color: "#1A2B4A" }}>v{pkg.version}</span></td>
                    <td style={s.td}><span style={statusBadgeStyle(pkg.status === "archived" ? "missing" : "published")}>{pkg.status}</span></td>
                    <td style={{ ...s.td, color: "#718096", fontSize: 12 }}>
                      {pkg.published_at ? new Date(pkg.published_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 600, color: "#1A2B4A" }}>{pkg.string_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Audit Trail ──────────────────────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={{ ...sL.sectionHeader, cursor: "pointer" }} onClick={() => setAuditOpen((v) => !v)}>
          <span style={sL.sectionTitle}>Audit Trail {auditOpen ? "▲" : "▼"}</span>
          <span style={sL.sectionMeta}>Translation governance actions</span>
        </div>
        {auditOpen && (
          <div>
            {!auditData ? (
              <div style={{ padding: "16px 24px", color: "#718096", fontSize: 13 }}>Loading audit log…</div>
            ) : auditData.items.length === 0 ? (
              <div style={{ padding: "16px 24px", color: "#718096", fontSize: 13, fontStyle: "italic" }}>No audit entries yet.</div>
            ) : (
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr style={s.thead}>
                      <th style={s.th}>Event</th>
                      <th style={s.th}>Language</th>
                      <th style={s.th}>String Key</th>
                      <th style={s.th}>Performed By</th>
                      <th style={s.th}>Date / Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditData.items.map((entry) => (
                      <tr key={entry.id} style={s.tr}>
                        <td style={s.td}>
                          <span style={{ ...s.codeBadge, fontSize: 11 }}>
                            {entry.event_type.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td style={{ ...s.td, color: "#4a5568" }}>{entry.lang_code ?? "—"}</td>
                        <td style={{ ...s.td, fontSize: 11, color: "#718096", wordBreak: "break-word" as const }}>{entry.string_key ?? "—"}</td>
                        <td style={{ ...s.td, color: "#4a5568" }}>{entry.performed_by ?? "system"}</td>
                        <td style={{ ...s.td, fontSize: 12, color: "#718096" }}>
                          {new Date(entry.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {auditData && auditData.total > auditPage * 20 && (
              <div style={{ padding: "12px 24px" }}>
                <button style={{ ...sL.actionBtn, background: "#EBF5FB", color: BLUE, border: `1px solid #bee3f8` }} onClick={() => setAuditPage((p) => p + 1)}>
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Reject Modal ────────────────────────────────────────────────── */}
      {rejectModal && (
        <div style={s.overlay} onClick={() => setRejectModal(null)}>
          <div style={{ ...s.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <h2 style={s.modalTitle}>Reject Translation</h2>
              <button style={s.closeBtn} onClick={() => setRejectModal(null)}>✕</button>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <div style={{ fontSize: 13, color: "#4a5568", marginBottom: 12 }}>
                Key: <strong>{rejectModal.key}</strong>
              </div>
              <Field label="Rejection reason" required error={rejectReason.trim().length > 0 && rejectReason.trim().length < 5 ? "Minimum 5 characters" : undefined}>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Describe why this translation is being rejected…"
                  rows={3}
                  style={{ ...s.input, width: "100%", resize: "vertical" as const, boxSizing: "border-box" as const }}
                />
              </Field>
            </div>
            <div style={{ ...s.modalFooter, padding: "0 24px 20px" }}>
              <button style={s.cancelBtn} onClick={() => setRejectModal(null)}>Cancel</button>
              <button
                style={{ ...s.submitBtn, background: "#c53030", opacity: rejectReason.trim().length < 5 || rejectSubmitting ? 0.6 : 1 }}
                disabled={rejectReason.trim().length < 5 || rejectSubmitting}
                onClick={handleRejectSubmit}
              >
                {rejectSubmitting ? "Rejecting…" : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Deprecate Modal ──────────────────────────────────────────────── */}
      {deprecateModal && (
        <div style={s.overlay} onClick={() => setDeprecateModal(null)}>
          <div style={{ ...s.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <h2 style={s.modalTitle}>Deprecate Language</h2>
              <button style={s.closeBtn} onClick={() => setDeprecateModal(null)}>✕</button>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <div style={s.warningBanner}>
                <span style={{ fontSize: 20 }}>⚠️</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#92400e", marginBottom: 4 }}>Deprecating {deprecateModal.name}</div>
                  <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.5 }}>This language will be scheduled for removal in 90 days. You can restore it before the deadline.</div>
                </div>
              </div>
              <Field label="Comment (required, min 10 characters)" required error={deprecateComment.trim().length > 0 && deprecateComment.trim().length < 10 ? "Minimum 10 characters" : undefined}>
                <textarea
                  value={deprecateComment}
                  onChange={(e) => setDeprecateComment(e.target.value)}
                  placeholder="Reason for deprecation…"
                  rows={2}
                  style={{ ...s.input, width: "100%", resize: "vertical" as const, boxSizing: "border-box" as const, marginTop: 12 }}
                />
              </Field>
            </div>
            <div style={{ ...s.modalFooter, padding: "0 24px 20px" }}>
              <button style={s.cancelBtn} onClick={() => setDeprecateModal(null)}>Cancel</button>
              <button
                style={{ ...s.submitBtn, background: "#c53030", opacity: deprecateComment.trim().length < 10 ? 0.6 : 1 }}
                disabled={deprecateComment.trim().length < 10}
                onClick={handleDeprecate}
              >
                Deprecate Language
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Language Modal (FIX 7) ──────────────────────────────────── */}
      {showAddLanguageModal && (
        <AddLanguageModal
          onClose={() => setShowAddLanguageModal(false)}
          onSuccess={() => {
            setShowAddLanguageModal(false);
            queryClient.invalidateQueries({ queryKey: ["languages"] });
          }}
        />
      )}

      {/* ── Publish Confirmation Modal ───────────────────────────────────── */}
      {showPublishConfirm && publishingLang && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <h2 style={{ ...s.modalTitle, fontSize: 18 }}>Publish Translation Package</h2>
            </div>
            <div style={{ padding: "24px" }}>
              <p style={{ fontSize: 14, color: "#4a5568", margin: 0, lineHeight: 1.6 }}>
                You are about to publish all approved translations for{" "}
                <strong>{languages.find((l) => l.code === publishingLang)?.name ?? publishingLang}</strong>.
                Reporters will receive these updates on their next app open. This cannot be undone.
              </p>
            </div>
            <div style={{ ...s.modalFooter, padding: "0 24px 24px" }}>
              <button
                style={{ ...s.cancelBtn, opacity: isPublishingApi ? 0.6 : 1 }}
                onClick={() => { setShowPublishConfirm(false); setPublishingLang(null); setPublishMsg(null); }}
                disabled={isPublishingApi}
              >
                Cancel
              </button>
              <button
                style={{ ...s.submitBtn, background: BLUE, opacity: isPublishingApi ? 0.7 : 1 }}
                onClick={executePublish}
                disabled={isPublishingApi}
              >
                {isPublishingApi ? "Publishing..." : "Publish Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TAB 3 — Questions ─────────────────────────────────────────────────────────

// ── Add Question Modal ────────────────────────────────────────────────────────

function AddQuestionModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [questionText, setQuestionText] = useState("");
  const [questionType, setQuestionType] = useState("single_select");
  const [isMandatory, setIsMandatory] = useState(false);
  const [availableOffline, setAvailableOffline] = useState(true);
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const needsOptions = questionType === "single_select" || questionType === "multi_select";

  function addOption() {
    setOptions((prev) => [...prev, ""]);
  }

  function removeOption(idx: number) {
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateOption(idx: number, val: string) {
    setOptions((prev) => { const n = [...prev]; n[idx] = val; return n; });
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!questionText.trim()) { setSubmitError("Question text is required."); return; }
    if (needsOptions && options.filter((o) => o.trim()).length < 2) {
      setSubmitError("At least 2 options are required for select questions.");
      return;
    }
    setSubmitError("");
    setSubmitting(true);
    try {
      await api.post("/api/question-packages/draft/questions", {
        question_text: questionText.trim(),
        question_type: questionType,
        is_mandatory: isMandatory,
        available_offline: availableOffline,
        options: needsOptions
          ? options
              .filter((o) => o.trim())
              .map((o, i) => ({ option_text: o.trim(), option_value: o.trim().toLowerCase().replace(/\s+/g, "_"), order_index: i }))
          : [],
      });
      onSuccess();
    } catch {
      setSubmitError("Failed to save question. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.modal, maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Add Question</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={s.form}>
          <Field label="Question Text" required>
            <textarea
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="Enter the question in English…"
              rows={3}
              style={{ ...s.questionTextarea, marginBottom: 0 }}
            />
          </Field>
          <Field label="Question Type" required>
            <select
              value={questionType}
              onChange={(e) => setQuestionType(e.target.value)}
              style={s.select}
            >
              <option value="single_select">Single Select</option>
              <option value="multi_select">Multi Select</option>
              <option value="text">Free Text</option>
            </select>
          </Field>
          {needsOptions && (
            <Field label="Answer Options (minimum 2 required)" required>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {options.map((opt, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => updateOption(idx, e.target.value)}
                      placeholder={`Option ${idx + 1}`}
                      style={{ ...s.input, flex: 1 }}
                    />
                    {options.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeOption(idx)}
                        style={{ background: "none", border: "none", color: "#e53e3e", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addOption}
                  style={{ padding: "7px 14px", background: "#f7fafc", border: "1.5px dashed #cbd5e0", borderRadius: 7, fontSize: 13, color: "#4a5568", cursor: "pointer", textAlign: "left" }}
                >
                  + Add option
                </button>
              </div>
            </Field>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Field label="Response">
              <div style={s.toggleRow}>
                <ToggleSwitch checked={isMandatory} onChange={setIsMandatory} />
                <span style={{ fontSize: 13, color: "#4a5568" }}>{isMandatory ? "Mandatory" : "Optional"}</span>
              </div>
            </Field>
            <Field label="Available Offline">
              <div style={s.toggleRow}>
                <ToggleSwitch checked={availableOffline} onChange={setAvailableOffline} />
                <span style={{ fontSize: 13, color: "#4a5568" }}>{availableOffline ? "Yes" : "No"}</span>
              </div>
            </Field>
          </div>
          {submitError && <div style={s.submitError}>{submitError}</div>}
          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save to Draft"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function QuestionsTab({ isAdmin, onSwitchToLanguages }: { isAdmin: boolean; onSwitchToLanguages: () => void }) {
  const queryClient = useQueryClient();
  const [showWarning, setShowWarning] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [successBanner, setSuccessBanner] = useState("");

  // FIX 2: Fetch active package from backend
  const { data: pkg, isLoading } = useQuery<ActivePackage>({
    queryKey: ["question-package-active"],
    queryFn: async () => {
      const res = await api.get<ActivePackage>("/api/question-packages/active");
      return res.data;
    },
  });

  // FIX 5: Fetch translation queue status
  const { data: queueStatus } = useQuery<QueueStatus>({
    queryKey: ["translation-queue-status"],
    queryFn: async () => {
      const res = await api.get<QueueStatus>("/api/translations/queue-status");
      return res.data;
    },
  });

  function handleAddSuccess() {
    setShowAddModal(false);
    queryClient.invalidateQueries({ queryKey: ["question-package-active"] });
    setSuccessBanner("Question saved to draft. Auto-translation is running in the background.");
    setTimeout(() => setSuccessBanner(""), 5000);
  }

  // FIX 13: Format published date from backend data
  function formatDateTime(iso: string) {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  return (
    <div style={s.tabContent}>
      {successBanner && <div style={{ ...s.successBanner, marginBottom: 16 }}>{successBanner}</div>}

      {/* Version header — FIX 13: real version and date */}
      <div style={s.versionHeader}>
        <div>
          <span style={s.versionLabel}>Current Version</span>
          {isLoading ? (
            <span style={{ ...s.versionValue, color: "#a0aec0" }}>Loading…</span>
          ) : pkg ? (
            <>
              <span style={s.versionValue}>{pkg.version}</span>
              <span style={s.versionDate}>— Published {formatDateTime(pkg.published_at)}</span>
            </>
          ) : (
            <span style={{ ...s.versionValue, color: "#a0aec0" }}>No package</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {/* FIX 5: Publish blocked if queue not empty */}
          {isAdmin && queueStatus?.has_pending && (
            <button
              style={{ ...s.editQuestionsBtn, cursor: "pointer" }}
              onClick={onSwitchToLanguages}
            >
              Review Translations First →
            </button>
          )}
          {isAdmin && !queueStatus?.has_pending && (
            <button style={s.editQuestionsBtn} onClick={() => setShowWarning(true)}>
              Edit Questions
            </button>
          )}
        </div>
      </div>

      {/* FIX 5: Translation queue warning */}
      {isAdmin && queueStatus?.has_pending && (
        <div style={{
          background: "#fffbeb",
          border: "1px solid #fcd34d",
          borderRadius: 10,
          padding: "14px 20px",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#92400e", marginBottom: 4 }}>
              Translation review queue is not empty
            </div>
            <div style={{ fontSize: 13, color: "#92400e", lineHeight: 1.5 }}>
              All translated strings must be reviewed and approved before publishing a new question package.{" "}
              <button
                onClick={onSwitchToLanguages}
                style={{ background: "none", border: "none", color: "#92400e", textDecoration: "underline", cursor: "pointer", fontSize: 13, padding: 0 }}
              >
                Go to Languages tab to review →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FIX 4: Add Question button (Admin only) */}
      {isAdmin && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button style={s.addBtn} onClick={() => setShowAddModal(true)}>
            + Add Question
          </button>
        </div>
      )}

      {/* Question cards — FIX 2+3: from backend, core badge, locked */}
      {isLoading ? (
        <div style={s.loadingText}>Loading questions…</div>
      ) : (
        <div style={s.questionList}>
          {(pkg?.questions ?? []).map((q, idx) => (
            <div key={q.id} style={s.questionCard}>
              <div style={s.questionCardHeader}>
                <span style={s.questionNum}>Q{idx + 1}</span>
                <span style={s.typeBadge}>{q.question_type.replace("_", " ")}</span>
                {/* FIX 3: Core badge */}
                {q.is_core && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#fff",
                    background: BLUE,
                    padding: "2px 8px",
                    borderRadius: 10,
                  }}>
                    Core
                  </span>
                )}
                {/* FIX 3: Required label for core mandatory questions */}
                {q.is_core ? (
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#718096", marginLeft: "auto" }}>
                    {q.is_mandatory ? "Required" : "Optional"}
                  </span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 600, color: q.is_mandatory ? "#155724" : "#718096", marginLeft: "auto" }}>
                    {q.is_mandatory ? "Mandatory" : "Optional"}
                  </span>
                )}
              </div>
              {/* FIX 3: Core questions read-only */}
              <p style={s.questionText}>{q.question_text}</p>
              {q.question_type !== "text" && (
                <div style={s.optionsList}>
                  {q.options.map((opt, oIdx) => (
                    <div key={oIdx} style={s.optionItem}>
                      <span style={s.optionBullet}>{q.question_type === "single_select" ? "◯" : "□"}</span>
                      <span style={{ fontSize: 13, color: "#4a5568" }}>{opt.option_text}</span>
                    </div>
                  ))}
                </div>
              )}
              {q.question_type === "text" && (
                <div style={s.textFieldPreview}>Free text response</div>
              )}
            </div>
          ))}
        </div>
      )}

      {showWarning && (
        <EditQuestionsWarningModal
          onClose={() => setShowWarning(false)}
          onConfirm={() => setShowWarning(false)}
        />
      )}

      {showAddModal && (
        <AddQuestionModal
          onClose={() => setShowAddModal(false)}
          onSuccess={handleAddSuccess}
        />
      )}
    </div>
  );
}

// ── TAB 4 — Map Settings ──────────────────────────────────────────────────────

function MapSettingsTab() {
  const queryClient = useQueryClient();
  const [radius, setRadius] = useState(50);
  const [buildingSource, setBuildingSource] = useState("osm");
  const [countryOverrides, setCountryOverrides] = useState<Record<string, number>>({});
  const [radiusSaving, setRadiusSaving] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [overridesSaving, setOverridesSaving] = useState(false);
  const [radiusSaved, setRadiusSaved] = useState(false);
  const [sourceSaved, setSourceSaved] = useState(false);
  const [overridesSaved, setOverridesSaved] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // FIX 8: Fetch from the correct /api/settings/map endpoint with miles
  const { data: mapSettings } = useQuery<MapSettings>({
    queryKey: ["map-settings"],
    queryFn: async () => {
      const res = await api.get<MapSettings>("/api/settings/map");
      return res.data;
    },
  });

  // Apply fetched settings when they load (once)
  useEffect(() => {
    if (mapSettings && !settingsLoaded) {
      setRadius(mapSettings.reporting_radius_miles ?? 50);
      setBuildingSource(mapSettings.building_source ?? "osm");
      setCountryOverrides(mapSettings.country_overrides ?? {});
      setSettingsLoaded(true);
    }
  }, [mapSettings, settingsLoaded]);

  // Active countries for override table
  const { data: countries = [] } = useQuery<Country[]>({
    queryKey: ["countries"],
    queryFn: async () => {
      const res = await api.get<Country[]>("/api/countries");
      return res.data;
    },
  });
  const activeCountries = countries.filter((c) => c.is_active);

  async function saveRadius() {
    setRadiusSaving(true);
    try {
      await api.patch("/api/settings/map", { reporting_radius_miles: radius });
      queryClient.invalidateQueries({ queryKey: ["map-settings"] });
      setRadiusSaved(true);
      setTimeout(() => setRadiusSaved(false), 3000);
    } catch {
      alert("Failed to save radius setting.");
    } finally {
      setRadiusSaving(false);
    }
  }

  async function saveSource() {
    setSourceSaving(true);
    try {
      await api.patch("/api/settings/map", { building_source: buildingSource });
      queryClient.invalidateQueries({ queryKey: ["map-settings"] });
      setSourceSaved(true);
      setTimeout(() => setSourceSaved(false), 3000);
    } catch {
      alert("Failed to save building source setting.");
    } finally {
      setSourceSaving(false);
    }
  }

  async function saveOverrides() {
    setOverridesSaving(true);
    try {
      // Remove zero/empty overrides (treat as "use global default")
      const cleaned: Record<string, number> = {};
      for (const [code, val] of Object.entries(countryOverrides)) {
        if (val > 0) cleaned[code] = val;
      }
      await api.patch("/api/settings/map", { country_overrides: cleaned });
      queryClient.invalidateQueries({ queryKey: ["map-settings"] });
      setOverridesSaved(true);
      setTimeout(() => setOverridesSaved(false), 3000);
    } catch {
      alert("Failed to save country overrides.");
    } finally {
      setOverridesSaving(false);
    }
  }

  return (
    <div style={s.tabContent}>
      <div style={s.settingsCardList}>
        {/* Reporting Radius — FIX 8: miles */}
        <div style={s.settingsCard}>
          <div style={s.settingsCardHeader}>
            <div>
              <div style={s.settingsCardTitle}>Reporting Radius</div>
              <div style={s.settingsCardDesc}>
                Default map view radius around reporter location
              </div>
            </div>
          </div>
          <div style={s.settingsCardBody}>
            <div style={s.inlineInputGroup}>
              <input
                type="number"
                min={1}
                max={500}
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                style={{ ...s.input, width: 100, textAlign: "center" }}
              />
              <span style={{ fontSize: 14, color: "#4a5568", fontWeight: 500 }}>miles</span>
              <button
                style={{ ...s.submitBtn, opacity: radiusSaving ? 0.7 : 1 }}
                onClick={saveRadius}
                disabled={radiusSaving}
              >
                {radiusSaving ? "Saving…" : "Save"}
              </button>
              {radiusSaved && <span style={s.savedTick}>✓ Saved</span>}
            </div>
          </div>
        </div>

        {/* Country-specific overrides — FIX 8 */}
        {activeCountries.length > 0 && (
          <div style={s.settingsCard}>
            <div style={s.settingsCardHeader}>
              <div>
                <div style={s.settingsCardTitle}>Country-Specific Radius Overrides</div>
                <div style={s.settingsCardDesc}>
                  Leave blank to use the global default ({radius} miles)
                </div>
              </div>
            </div>
            <div style={s.settingsCardBody}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflowY: "auto" }}>
                {activeCountries.map((c) => (
                  <div key={c.code} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ ...s.codeBadge, minWidth: 36 }}>{c.code}</span>
                    <span style={{ fontSize: 13, color: "#2d3748", flex: 1 }}>{c.name}</span>
                    <input
                      type="number"
                      min={0}
                      max={500}
                      placeholder={String(radius)}
                      value={countryOverrides[c.code] ?? ""}
                      onChange={(e) => setCountryOverrides((prev) => {
                        const val = Number(e.target.value);
                        const next = { ...prev };
                        if (!e.target.value) { delete next[c.code]; } else { next[c.code] = val; }
                        return next;
                      })}
                      style={{ ...s.input, width: 80, textAlign: "center" }}
                    />
                    <span style={{ fontSize: 12, color: "#718096" }}>mi</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
                <button
                  style={{ ...s.submitBtn, opacity: overridesSaving ? 0.7 : 1 }}
                  onClick={saveOverrides}
                  disabled={overridesSaving}
                >
                  {overridesSaving ? "Saving…" : "Save Overrides"}
                </button>
                {overridesSaved && <span style={s.savedTick}>✓ Saved</span>}
              </div>
            </div>
          </div>
        )}

        {/* Building Footprints Source */}
        <div style={s.settingsCard}>
          <div style={s.settingsCardHeader}>
            <div>
              <div style={s.settingsCardTitle}>Building Footprints Source</div>
              <div style={s.settingsCardDesc}>
                Data source used to load building footprints on the reporter map
              </div>
            </div>
          </div>
          <div style={s.settingsCardBody}>
            <div style={s.inlineInputGroup}>
              <select
                value={buildingSource}
                onChange={(e) => setBuildingSource(e.target.value)}
                style={{ ...s.select, minWidth: 280 }}
              >
                <option value="osm">OpenStreetMap (OSM) — default</option>
                <option value="microsoft">Microsoft Building Footprints</option>
              </select>
              <button
                style={{ ...s.submitBtn, opacity: sourceSaving ? 0.7 : 1 }}
                onClick={saveSource}
                disabled={sourceSaving}
              >
                {sourceSaving ? "Saving…" : "Save"}
              </button>
              {sourceSaved && <span style={s.savedTick}>✓ Saved</span>}
            </div>
            {buildingSource === "microsoft" && (
              <div style={{ marginTop: 10, fontSize: 13, color: "#744210" }}>
                Requires Microsoft Building Footprint dataset to be loaded. Contact your system administrator.
              </div>
            )}
            {buildingSource === "microsoft" && (
              <div style={{
                marginTop: 12,
                background: "#FFFBEB",
                border: "1px solid #F6AD55",
                borderRadius: 8,
                padding: "10px 14px",
                fontSize: 13,
                color: "#744210",
              }}>
                <strong>Microsoft Building Footprints selected.</strong> This dataset must be separately loaded into the database before it takes effect. Reporters will continue using OSM footprints until the dataset is available.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TAB 5 — App Content ───────────────────────────────────────────────────────

const DISASTER_TYPES = [
  { key: "earthquake", label: "Earthquake" },
  { key: "flood", label: "Flood" },
  { key: "hurricane", label: "Hurricane / Cyclone" },
  { key: "landslide", label: "Landslide" },
  { key: "tsunami", label: "Tsunami" },
  { key: "fire", label: "Wildfire / Building Fire" },
  { key: "drought", label: "Drought" },
  { key: "conflict", label: "Conflict / Civil Unrest" },
  { key: "epidemic", label: "Epidemic / Disease Outbreak" },
];

type AcKey = "tc" | "onboarding" | "safety-tips" | "reporting-guidelines" | "first-aid" | "error-messages" | "system-messages";

interface SimpleContent { content: string; version: number; updated_at: string | null; }
interface DDSlide { title: string; dos: string[]; donts: string[]; }
interface BulletSlide { title: string; bullets: string[]; }
interface STData { slides: DDSlide[]; version: number; updated_at: string | null; }
interface SWData { slides: BulletSlide[]; version: number; updated_at: string | null; }

// ── Accordion wrapper ─────────────────────────────────────────────────────────

function AccordionSection({
  label,
  isOpen,
  onToggle,
  badge,
  children,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "#fff", borderRadius: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "18px 24px",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          borderBottom: isOpen ? "1px solid #f0f4f8" : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#1A2B4A" }}>{label}</span>
          {badge && (
            <span style={{ fontSize: 11, fontWeight: 600, background: "#EBF5FB", color: BLUE, padding: "2px 8px", borderRadius: 10 }}>
              {badge}
            </span>
          )}
        </div>
        <span style={{ fontSize: 14, color: "#718096" }}>{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && <div>{children}</div>}
    </div>
  );
}

// ── Content save bar ──────────────────────────────────────────────────────────

function ContentSaveBar({
  onSave,
  onCancel,
  saving,
  saved,
}: {
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  saved: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
      <button style={s.cancelBtn} onClick={onCancel}>Cancel</button>
      <button
        style={{ ...s.submitBtn, opacity: saving ? 0.7 : 1 }}
        onClick={onSave}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save Changes"}
      </button>
      {saved && <span style={{ fontSize: 13, fontWeight: 600, color: "#22c55e" }}>✓ Saved</span>}
    </div>
  );
}

// ── Simple text section (T&C + Onboarding) ────────────────────────────────────

function TextSection({
  contentType,
  tcWarning,
  isAdmin,
}: {
  contentType: "tc" | "onboarding";
  tcWarning?: boolean;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<SimpleContent>({
    queryKey: ["content", contentType],
    queryFn: async () => {
      const res = await api.get(`/api/content/${contentType}`);
      return res.data;
    },
  });

  function startEdit() {
    setDraft(data?.content ?? "");
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/content/${contentType}`, { content: draft });
      queryClient.invalidateQueries({ queryKey: ["content", contentType] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setEditing(false);
    } catch {
      // keep editing state open on error
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return <div style={{ padding: "20px 24px", color: "#718096", fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ padding: "20px 24px" }}>
      {tcWarning && (
        <div style={{ ...s.warningBanner, marginBottom: 16 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#92400e" }}>
            Changing Terms and Conditions will require all reporters to re-accept on their next app open.
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#718096", marginBottom: 14 }}>
        <span>Version <strong style={{ color: "#1A2B4A" }}>{data?.version ?? 1}</strong></span>
        <span>
          Last updated:{" "}
          <strong style={{ color: "#1A2B4A" }}>
            {data?.updated_at ? new Date(data.updated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "Never"}
          </strong>
        </span>
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            style={{
              width: "100%",
              padding: "12px",
              border: "1.5px solid #e2e8f0",
              borderRadius: 8,
              fontSize: 13,
              fontFamily: "inherit",
              color: "#1A2B4A",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <ContentSaveBar onSave={handleSave} onCancel={cancelEdit} saving={saving} saved={saved} />
        </>
      ) : (
        <>
          <div style={{
            padding: "14px 16px",
            background: "#f7fafc",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            fontSize: 13,
            color: "#4a5568",
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            minHeight: 80,
          }}>
            {data?.content || <span style={{ color: "#a0aec0", fontStyle: "italic" }}>No content set yet.</span>}
          </div>
          {isAdmin && (
            <button
              onClick={startEdit}
              style={{ ...s.editQuestionsBtn, marginTop: 14, fontSize: 13, padding: "8px 18px" }}
            >
              Edit
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Disaster type row (inside Safety Tips) ────────────────────────────────────

function DisasterTypeRow({ typeKey, label, isAdmin }: { typeKey: string; label: string; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftSlides, setDraftSlides] = useState<DDSlide[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<STData>({
    queryKey: ["content", "safety-tips", typeKey],
    queryFn: async () => {
      const res = await api.get(`/api/content/safety-tips/${typeKey}`);
      return res.data;
    },
    enabled: isOpen,
  });

  function startEdit() {
    setDraftSlides((data?.slides ?? []).map((sl) => ({
      title: sl.title,
      dos: [...sl.dos],
      donts: [...sl.donts],
    })));
    setEditing(true);
  }

  function cancelEdit() { setEditing(false); }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/content/safety-tips/${typeKey}`, { slides: draftSlides });
      queryClient.invalidateQueries({ queryKey: ["content", "safety-tips", typeKey] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setEditing(false);
    } catch {
      // keep state open
    } finally {
      setSaving(false);
    }
  }

  function updateSlide(idx: number, field: keyof DDSlide, value: string | string[]) {
    setDraftSlides((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  function addSlide() {
    setDraftSlides((prev) => [...prev, { title: "", dos: [""], donts: [""] }]);
  }

  function removeSlide(idx: number) {
    setDraftSlides((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ borderTop: "1px solid #f0f4f8" }}>
      <button
        onClick={() => { setIsOpen((o) => !o); if (editing) setEditing(false); }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "13px 20px",
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "#a0aec0" }}>
            {data?.slides.length ?? 0} slide{(data?.slides.length ?? 0) !== 1 ? "s" : ""}
          </span>
          <span style={{ fontSize: 12, color: "#718096" }}>{isOpen ? "▲" : "▼"}</span>
        </div>
      </button>

      {isOpen && (
        <div style={{ padding: "0 20px 18px" }}>
          {isLoading ? (
            <div style={{ color: "#718096", fontSize: 13, padding: "8px 0" }}>Loading…</div>
          ) : editing ? (
            <div>
              {draftSlides.map((slide, idx) => (
                <div key={idx} style={{ background: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "16px", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#718096", textTransform: "uppercase" }}>Slide {idx + 1}</span>
                    {draftSlides.length > 1 && (
                      <button
                        onClick={() => removeSlide(idx)}
                        style={{ fontSize: 12, color: "#c53030", background: "none", border: "1px solid #fc8181", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#4a5568", display: "block", marginBottom: 4 }}>Title</label>
                    <input
                      type="text"
                      value={slide.title}
                      onChange={(e) => updateSlide(idx, "title", e.target.value)}
                      style={{ ...s.input, width: "100%", fontSize: 13, boxSizing: "border-box" as const }}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#155724", display: "block", marginBottom: 4 }}>
                        ✓ Dos (one per line)
                      </label>
                      <textarea
                        value={slide.dos.join("\n")}
                        onChange={(e) => updateSlide(idx, "dos", e.target.value.split("\n"))}
                        rows={4}
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #c3e6cb", borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" as const }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#c53030", display: "block", marginBottom: 4 }}>
                        ✕ Don'ts (one per line)
                      </label>
                      <textarea
                        value={slide.donts.join("\n")}
                        onChange={(e) => updateSlide(idx, "donts", e.target.value.split("\n"))}
                        rows={4}
                        style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #fc8181", borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" as const }}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={addSlide}
                style={{ padding: "8px 16px", background: "#fff", border: "1.5px dashed #cbd5e0", borderRadius: 8, fontSize: 13, color: "#4a5568", cursor: "pointer", width: "100%", marginBottom: 12 }}
              >
                + Add Slide
              </button>
              <ContentSaveBar onSave={handleSave} onCancel={cancelEdit} saving={saving} saved={saved} />
            </div>
          ) : (
            <div>
              {(data?.slides ?? []).length === 0 ? (
                <div style={{ color: "#a0aec0", fontSize: 13, fontStyle: "italic", padding: "8px 0" }}>No slides configured.</div>
              ) : (
                (data?.slides ?? []).map((slide, idx) => (
                  <div key={idx} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: idx < (data?.slides.length ?? 1) - 1 ? "1px solid #f0f4f8" : "none" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1A2B4A", marginBottom: 8 }}>
                      {slide.title || `Slide ${idx + 1}`}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#155724", textTransform: "uppercase", marginBottom: 4 }}>Dos</div>
                        <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                          {slide.dos.filter(Boolean).map((d, i) => (
                            <li key={i} style={{ fontSize: 12, color: "#4a5568", marginBottom: 2 }}>{d}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#c53030", textTransform: "uppercase", marginBottom: 4 }}>Don'ts</div>
                        <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                          {slide.donts.filter(Boolean).map((d, i) => (
                            <li key={i} style={{ fontSize: 12, color: "#4a5568", marginBottom: 2 }}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ))
              )}
              {isAdmin && (
                <button
                  onClick={startEdit}
                  style={{ ...s.editQuestionsBtn, fontSize: 13, padding: "7px 16px", marginTop: 6 }}
                >
                  Edit
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Slideshow section (Reporting Guidelines + First Aid) ──────────────────────

function SlideshowSection({
  contentType,
  isAdmin,
}: {
  contentType: "reporting-guidelines" | "first-aid";
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftSlides, setDraftSlides] = useState<BulletSlide[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<SWData>({
    queryKey: ["content", contentType],
    queryFn: async () => {
      const res = await api.get(`/api/content/${contentType}`);
      return res.data;
    },
  });

  function startEdit() {
    setDraftSlides((data?.slides ?? []).map((sl) => ({ title: sl.title, bullets: [...sl.bullets] })));
    setEditing(true);
  }

  function cancelEdit() { setEditing(false); }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/content/${contentType}`, { slides: draftSlides });
      queryClient.invalidateQueries({ queryKey: ["content", contentType] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setEditing(false);
    } catch {
      // keep open
    } finally {
      setSaving(false);
    }
  }

  function updateSlide(idx: number, field: keyof BulletSlide, value: string | string[]) {
    setDraftSlides((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  function addSlide() {
    setDraftSlides((prev) => [...prev, { title: "", bullets: [""] }]);
  }

  function removeSlide(idx: number) {
    setDraftSlides((prev) => prev.filter((_, i) => i !== idx));
  }

  if (isLoading) {
    return <div style={{ padding: "20px 24px", color: "#718096", fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#718096", marginBottom: 16 }}>
        <span>Version <strong style={{ color: "#1A2B4A" }}>{data?.version ?? 1}</strong></span>
        <span>
          Last updated:{" "}
          <strong style={{ color: "#1A2B4A" }}>
            {data?.updated_at ? new Date(data.updated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "Never"}
          </strong>
        </span>
      </div>

      {editing ? (
        <div>
          {draftSlides.map((slide, idx) => (
            <div key={idx} style={{ background: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "16px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#718096", textTransform: "uppercase" }}>Slide {idx + 1}</span>
                {draftSlides.length > 1 && (
                  <button
                    onClick={() => removeSlide(idx)}
                    style={{ fontSize: 12, color: "#c53030", background: "none", border: "1px solid #fc8181", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}
                  >
                    Remove Slide
                  </button>
                )}
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#4a5568", display: "block", marginBottom: 4 }}>Title</label>
                <input
                  type="text"
                  value={slide.title}
                  onChange={(e) => updateSlide(idx, "title", e.target.value)}
                  style={{ ...s.input, width: "100%", fontSize: 13, boxSizing: "border-box" as const }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#4a5568", display: "block", marginBottom: 4 }}>
                  Bullet Points (one per line)
                </label>
                <textarea
                  value={slide.bullets.join("\n")}
                  onChange={(e) => updateSlide(idx, "bullets", e.target.value.split("\n"))}
                  rows={4}
                  style={{ width: "100%", padding: "8px 10px", border: "1.5px solid #e2e8f0", borderRadius: 7, fontSize: 12, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box" as const }}
                />
              </div>
            </div>
          ))}
          <button
            onClick={addSlide}
            style={{ padding: "8px 16px", background: "#fff", border: "1.5px dashed #cbd5e0", borderRadius: 8, fontSize: 13, color: "#4a5568", cursor: "pointer", width: "100%", marginBottom: 12 }}
          >
            + Add Slide
          </button>
          <ContentSaveBar onSave={handleSave} onCancel={cancelEdit} saving={saving} saved={saved} />
        </div>
      ) : (
        <div>
          {(data?.slides ?? []).length === 0 ? (
            <div style={{ color: "#a0aec0", fontSize: 13, fontStyle: "italic" }}>No slides configured.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {(data?.slides ?? []).map((slide, idx) => (
                <div key={idx} style={{ background: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 18px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1A2B4A", marginBottom: 8 }}>
                    <span style={{ ...s.questionNum, marginRight: 10 }}>{idx + 1}</span>
                    {slide.title || `Slide ${idx + 1}`}
                  </div>
                  <ul style={{ margin: 0, padding: "0 0 0 18px" }}>
                    {slide.bullets.filter(Boolean).map((b, i) => (
                      <li key={i} style={{ fontSize: 13, color: "#4a5568", marginBottom: 4 }}>{b}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {isAdmin && (
            <button
              onClick={startEdit}
              style={{ ...s.editQuestionsBtn, fontSize: 13, padding: "8px 18px", marginTop: 16 }}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Message list section (Error Messages + System Messages) — FIX 9 ──────────

interface MessageItem { key: string; text: string; }
interface MessageListData { items: MessageItem[]; version: number; updated_at: string | null; }

function MessageListSection({
  contentType,
  isAdmin,
}: {
  contentType: "error_messages" | "system_messages";
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftItems, setDraftItems] = useState<MessageItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<MessageListData>({
    queryKey: ["content", contentType],
    queryFn: async () => {
      const res = await api.get<MessageListData>(`/api/content/${contentType}`);
      return res.data;
    },
  });

  function startEdit() {
    setDraftItems((data?.items ?? []).map((it) => ({ ...it })));
    setEditing(true);
  }

  function cancelEdit() { setEditing(false); }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/content/${contentType}`, { items: draftItems });
      queryClient.invalidateQueries({ queryKey: ["content", contentType] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setEditing(false);
    } catch {
      // keep open
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return <div style={{ padding: "20px 24px", color: "#718096", fontSize: 13 }}>Loading…</div>;
  }

  const items = data?.items ?? [];

  return (
    <div style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#718096", marginBottom: 14 }}>
        <span>Version <strong style={{ color: "#1A2B4A" }}>{data?.version ?? 1}</strong></span>
        <span>
          Last updated:{" "}
          <strong style={{ color: "#1A2B4A" }}>
            {data?.updated_at ? new Date(data.updated_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "Never"}
          </strong>
        </span>
      </div>

      {editing ? (
        <div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {draftItems.map((item, idx) => (
              <div key={item.key} style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 12, alignItems: "center" }}>
                <span style={{ ...s.codeBadge, fontSize: 11 }}>{item.key}</span>
                <input
                  type="text"
                  value={item.text}
                  onChange={(e) => setDraftItems((prev) => {
                    const next = [...prev];
                    next[idx] = { ...next[idx], text: e.target.value };
                    return next;
                  })}
                  style={{ ...s.input, fontSize: 13 }}
                />
              </div>
            ))}
          </div>
          <ContentSaveBar onSave={handleSave} onCancel={cancelEdit} saving={saving} saved={saved} />
        </div>
      ) : (
        <div>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={{ ...s.th, width: 220 }}>Key</th>
                  <th style={s.th}>Message Text</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key} style={s.tr}>
                    <td style={s.td}>
                      <span style={{ ...s.codeBadge, fontSize: 11 }}>{item.key}</span>
                    </td>
                    <td style={{ ...s.td, fontSize: 13, color: "#4a5568", lineHeight: 1.5 }}>
                      {item.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isAdmin && (
            <button
              onClick={startEdit}
              style={{ ...s.editQuestionsBtn, marginTop: 14, fontSize: 13, padding: "8px 18px" }}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main AppContentTab ────────────────────────────────────────────────────────

function AppContentTab({ isAdmin }: { isAdmin: boolean }) {
  const [openSection, setOpenSection] = useState<AcKey | null>("tc");

  function toggle(section: AcKey) {
    setOpenSection((prev) => (prev === section ? null : section));
  }

  return (
    <div style={{ ...s.tabContent }}>
      {/* 1 — Terms and Conditions */}
      <AccordionSection
        label="Terms and Conditions"
        isOpen={openSection === "tc"}
        onToggle={() => toggle("tc")}
      >
        <TextSection contentType="tc" tcWarning isAdmin={isAdmin} />
      </AccordionSection>

      {/* 2 — Onboarding Content */}
      <AccordionSection
        label="Onboarding Content"
        isOpen={openSection === "onboarding"}
        onToggle={() => toggle("onboarding")}
      >
        <TextSection contentType="onboarding" isAdmin={isAdmin} />
      </AccordionSection>

      {/* 3 — Safety Tips */}
      <AccordionSection
        label="Safety Tips"
        isOpen={openSection === "safety-tips"}
        onToggle={() => toggle("safety-tips")}
        badge={`${DISASTER_TYPES.length} disaster types`}
      >
        <div>
          {DISASTER_TYPES.map((dt) => (
            <DisasterTypeRow key={dt.key} typeKey={dt.key} label={dt.label} isAdmin={isAdmin} />
          ))}
        </div>
      </AccordionSection>

      {/* 4 — Reporting Guidelines */}
      <AccordionSection
        label="Reporting Guidelines"
        isOpen={openSection === "reporting-guidelines"}
        onToggle={() => toggle("reporting-guidelines")}
        badge="5 slides"
      >
        <SlideshowSection contentType="reporting-guidelines" isAdmin={isAdmin} />
      </AccordionSection>

      {/* 5 — First Aid */}
      <AccordionSection
        label="First Aid"
        isOpen={openSection === "first-aid"}
        onToggle={() => toggle("first-aid")}
        badge="6 slides"
      >
        <SlideshowSection contentType="first-aid" isAdmin={isAdmin} />
      </AccordionSection>

      {/* 6 — Error Messages — FIX 9 */}
      <AccordionSection
        label="Error Messages"
        isOpen={openSection === "error-messages"}
        onToggle={() => toggle("error-messages")}
      >
        <MessageListSection contentType="error_messages" isAdmin={isAdmin} />
      </AccordionSection>

      {/* 7 — System Messages — FIX 9 */}
      <AccordionSection
        label="System Messages"
        isOpen={openSection === "system-messages"}
        onToggle={() => toggle("system-messages")}
      >
        <MessageListSection contentType="system_messages" isAdmin={isAdmin} />
      </AccordionSection>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SystemSettingsPage() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<Tab>("countries");
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  const tabs: { key: Tab; label: string }[] = [
    { key: "countries", label: "Countries" },
    { key: "languages", label: "Languages" },
    { key: "questions", label: "Questions" },
    { key: "map", label: "Map Settings" },
    { key: "app-content", label: "App Content" },
  ];

  return (
    <div style={s.page}>
      <Header title="App Configuration" subtitle="Manage countries, languages, questions, and map configuration" />

      {/* FIX 12: Offline sync info banner — always visible above tabs */}
      <div style={{
        background: "#EBF5FB",
        borderBottom: "1px solid #bee3f8",
        padding: "12px 32px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        color: "#1a5276",
      }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>ℹ</span>
        <span>
          Changes saved here take effect immediately for online reporters.
          Reporters who are offline will receive updates on their next successful sync.
        </span>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            style={{
              ...s.tabBtn,
              borderBottom: activeTab === tab.key ? `3px solid ${BLUE}` : "3px solid transparent",
              color: activeTab === tab.key ? BLUE : "#718096",
              fontWeight: activeTab === tab.key ? 700 : 500,
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div style={s.tabPanelWrap}>
        {activeTab === "countries" && <CountriesTab />}
        {activeTab === "languages" && <LanguagesTab />}
        {activeTab === "questions" && (
          <QuestionsTab
            isAdmin={isAdmin}
            onSwitchToLanguages={() => setActiveTab("languages")}
          />
        )}
        {activeTab === "map" && <MapSettingsTab />}
        {activeTab === "app-content" && <AppContentTab isAdmin={isAdmin} />}
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
  // Tabs
  tabBar: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    padding: "0 32px",
    gap: 4,
  },
  tabBtn: {
    padding: "14px 20px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 14,
    transition: "all 0.15s",
    whiteSpace: "nowrap" as const,
  },
  tabPanelWrap: {
    flex: 1,
    overflowY: "auto",
  },
  tabContent: {
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  // Toolbar
  tabToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  searchInput: {
    flex: 1,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    background: "#fff",
    outline: "none",
    maxWidth: 360,
  },
  addBtn: {
    padding: "10px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  // Success banner
  successBanner: {
    background: "#d4edda",
    color: "#155724",
    border: "1px solid #c3e6cb",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
  },
  // Table
  tableWrap: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "12px 16px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "14px 16px", fontSize: 13, color: "#2d3748", verticalAlign: "middle" },
  codeBadge: {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 5,
    background: "#f0f4f8",
    color: "#4a5568",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    fontFamily: "monospace",
  },
  alwaysAvailableBadge: {
    display: "inline-block",
    padding: "4px 12px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    background: "#EBF5FB",
    color: BLUE,
    border: `1px solid #bee3f8`,
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  // Loading / empty
  loadingText: { padding: 40, textAlign: "center", color: "#718096", fontSize: 14 },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    padding: 60,
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  // Questions tab
  versionHeader: {
    background: "#fff",
    borderRadius: 12,
    padding: "18px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  versionLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginRight: 8,
  },
  versionValue: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  versionDate: {
    fontSize: 13,
    color: "#718096",
    marginLeft: 4,
  },
  editQuestionsBtn: {
    padding: "10px 20px",
    background: "#fff",
    color: BLUE,
    border: `1.5px solid ${BLUE}`,
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  questionList: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  questionCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  questionCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  questionNum: {
    fontSize: 12,
    fontWeight: 800,
    color: BLUE,
    background: "#EBF5FB",
    padding: "3px 10px",
    borderRadius: 5,
    letterSpacing: 0.3,
  },
  typeBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: "#718096",
    background: "#f0f4f8",
    padding: "3px 10px",
    borderRadius: 5,
    textTransform: "capitalize" as const,
  },
  questionText: {
    fontSize: 14,
    fontWeight: 600,
    color: "#1A2B4A",
    margin: "0 0 12px",
    lineHeight: 1.5,
  },
  questionTextarea: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    resize: "vertical" as const,
    marginBottom: 12,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  },
  optionsList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  optionItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  optionBullet: {
    fontSize: 14,
    color: "#a0aec0",
    flexShrink: 0,
    width: 16,
  },
  textFieldPreview: {
    fontSize: 13,
    color: "#a0aec0",
    fontStyle: "italic",
    padding: "8px 12px",
    background: "#f7fafc",
    borderRadius: 6,
    border: "1px dashed #e2e8f0",
  },
  // Map settings
  settingsCardList: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    maxWidth: 700,
  },
  settingsCard: {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  settingsCardHeader: {
    padding: "18px 24px",
    borderBottom: "1px solid #f0f4f8",
  },
  settingsCardTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 4,
  },
  settingsCardDesc: {
    fontSize: 13,
    color: "#718096",
  },
  settingsCardBody: {
    padding: "18px 24px",
  },
  inlineInputGroup: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap" as const,
  },
  savedTick: {
    fontSize: 13,
    fontWeight: 600,
    color: "#22c55e",
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
    background: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 480,
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
    background: "#fff",
    zIndex: 1,
  },
  modalTitle: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", margin: 0 },
  closeBtn: {
    background: "transparent",
    border: "none",
    fontSize: 18,
    color: "#718096",
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
  fieldGroup: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: "#4a5568" },
  req: { color: "#e53e3e" },
  input: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    background: "#fff",
  },
  fieldErr: { fontSize: 12, color: "#e53e3e", fontWeight: 500 },
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
    background: "#fff",
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
    color: "#fff",
    border: "none",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  // Warning modal
  warningBanner: {
    background: "#fffbeb",
    border: "1px solid #fcd34d",
    borderRadius: 8,
    padding: "14px 16px",
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
  },
  // File input
  fileInputWrap: {
    border: "1.5px dashed #e2e8f0",
    borderRadius: 7,
    padding: "10px 14px",
    background: "#f7fafc",
  },
  fileLabel: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    cursor: "pointer",
  },
  fileBrowseBtn: {
    padding: "6px 14px",
    background: "#fff",
    border: "1px solid #cbd5e0",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    color: "#4a5568",
    whiteSpace: "nowrap" as const,
  },
};

// ── Languages-tab-specific styles ─────────────────────────────────────────────

const sL: Record<string, React.CSSProperties> = {
  sectionCard: {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 24px",
    borderBottom: "1px solid #f0f4f8",
    gap: 16,
    flexWrap: "wrap" as const,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  sectionMeta: {
    fontSize: 13,
    color: "#718096",
  },
  progressBar: {
    width: 80,
    height: 6,
    background: "#e2e8f0",
    borderRadius: 3,
    overflow: "hidden",
    flexShrink: 0,
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
    transition: "width 0.3s",
  },
  actionBtn: {
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    border: "1px solid transparent",
  },
  filterTabBar: {
    display: "flex",
    gap: 0,
    borderBottom: "1px solid #f0f4f8",
    padding: "0 8px",
    background: "#fafafa",
  },
  filterTabBtn: {
    padding: "10px 16px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 6,
    transition: "all 0.15s",
    whiteSpace: "nowrap" as const,
  },
  countBadge: {
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 700,
    minWidth: 20,
    textAlign: "center" as const,
  },
};
