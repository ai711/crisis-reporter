import { useState } from "react";
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

const CORE_QUESTIONS = [
  {
    id: "q1",
    text: "What type of damage has occurred?",
    type: "single-select",
    options: ["Structural collapse", "Partial collapse", "Flood damage", "Fire damage", "Infrastructure damage", "Other"],
  },
  {
    id: "q2",
    text: "What is the severity of the damage?",
    type: "single-select",
    options: ["Minimal — habitable", "Partial — uninhabitable", "Complete — destroyed"],
  },
  {
    id: "q3",
    text: "What type of infrastructure is affected?",
    type: "multi-select",
    options: ["Residential building", "Commercial building", "Hospital / Health centre", "School / Education", "Bridge / Road", "Utility / Power"],
  },
  {
    id: "q4",
    text: "Are there any casualties or people in need of immediate assistance?",
    type: "single-select",
    options: ["No casualties", "Minor injuries reported", "Serious injuries reported", "Fatalities reported", "Unknown"],
  },
  {
    id: "q5",
    text: "Provide any additional details about the damage",
    type: "text",
    options: [],
  },
];

type Tab = "countries" | "languages" | "questions" | "map" | "app-content";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Country {
  name: string;
  code: string;
  official_language: string;
  is_active: boolean;
}

interface Language {
  name: string;
  code: string;
  is_active: boolean;
}

interface MapSettings {
  reporting_radius_km: number;
  building_source: string;
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
  const [fileName, setFileName] = useState("");
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
          <Field label="Translation File (JSON)">
            <div style={s.fileInputWrap}>
              <label style={s.fileLabel}>
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
                />
                <span style={s.fileBrowseBtn}>Browse</span>
                <span style={{ fontSize: 13, color: "#718096" }}>
                  {fileName || "No file selected"}
                </span>
              </label>
            </div>
            <p style={{ fontSize: 11, color: "#a0aec0", margin: "4px 0 0" }}>
              Optional — upload a JSON translation file to enable this language in the app.
            </p>
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

function LanguagesTab() {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const [selectedLang, setSelectedLang] = useState("ar");
  const [filterTab, setFilterTab] = useState<FilterStatus>("draft");
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [autoTranslatingLang, setAutoTranslatingLang] = useState<string | null>(null);
  const [publishingLang, setPublishingLang] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ msg: string; ok: boolean } | null>(null);

  function showBanner(msg: string, ok = true) {
    setBanner({ msg, ok });
    setTimeout(() => setBanner(null), 6000);
  }

  // ── Queries ──────────────────────────────────────────────────────────────

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

  const { data: packages = [] } = useQuery<LanguagePkg[]>({
    queryKey: ["language-packages"],
    queryFn: async () => {
      const res = await api.get<LanguagePkg[]>("/api/language-packages");
      return res.data;
    },
  });

  // ── Coverage computation ─────────────────────────────────────────────────

  const activeKeys = stringKeys.filter((k) => k.is_active);
  const totalActive = activeKeys.length;

  const coverageData = TRANSLATION_LANGS.map((lang) => {
    let translated = 0, approved = 0, published = 0;
    for (const key of activeKeys) {
      const st = key.translations[lang.code];
      if (st) translated++;
      if (st === "approved" || st === "published") approved++;
      if (st === "published") published++;
    }
    const coveragePct = totalActive > 0 ? Math.round((approved / totalActive) * 100) : 0;
    return { ...lang, translated, approved, published, total: totalActive, coveragePct };
  });

  const fullyTranslated = coverageData.filter((l) => l.coveragePct === 100).length;

  // ── Category lookup (from string-keys data) ──────────────────────────────

  const categoryMap = Object.fromEntries(stringKeys.map((k) => [k.key, k.category]));

  // ── Filter counts ────────────────────────────────────────────────────────

  const counts: Record<FilterStatus, number> = {
    all:       translations.length,
    missing:   translations.filter((t) => t.status === "missing").length,
    draft:     translations.filter((t) => t.status === "draft").length,
    approved:  translations.filter((t) => t.status === "approved").length,
    published: translations.filter((t) => t.status === "published").length,
  };

  const filtered =
    filterTab === "all" ? translations : translations.filter((t) => t.status === filterTab);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleAutoTranslate(langCode: string) {
    setAutoTranslatingLang(langCode);
    try {
      const res = await api.post<{ translated: number; skipped: number; failed: number }>(
        "/api/translations/auto-translate",
        { language_code: langCode }
      );
      queryClient.invalidateQueries({ queryKey: ["translations", langCode] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      const { translated, failed } = res.data;
      showBanner(
        `Auto-translated ${translated} strings for ${langCode.toUpperCase()}${failed > 0 ? `, ${failed} failed` : ""}.`
      );
    } catch {
      showBanner("Auto-translate failed — check LibreTranslate configuration.", false);
    } finally {
      setAutoTranslatingLang(null);
    }
  }

  async function handlePublish(langCode: string) {
    if (
      !window.confirm(
        `Publish all approved translations for ${langCode.toUpperCase()}? A new language package version will be created.`
      )
    )
      return;
    setPublishingLang(langCode);
    try {
      await api.post(`/api/language-packages/publish/${langCode}`);
      queryClient.invalidateQueries({ queryKey: ["translations", langCode] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
      queryClient.invalidateQueries({ queryKey: ["language-packages"] });
      showBanner(`Language package for ${langCode.toUpperCase()} published successfully.`);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Publish failed.";
      showBanner(detail, false);
    } finally {
      setPublishingLang(null);
    }
  }

  async function handleSave(t: TranslationItem) {
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
    } catch {
      // Keep edited text so user doesn't lose work
    } finally {
      setSavingKeys((p) => { const n = new Set(p); n.delete(t.string_key); return n; });
      setEditedTexts((p) => { const n = { ...p }; delete n[t.string_key]; return n; });
    }
  }

  async function handleApprove(translationId: string) {
    try {
      await api.patch(`/api/translations/${translationId}/approve`);
      queryClient.invalidateQueries({ queryKey: ["translations", selectedLang] });
      queryClient.invalidateQueries({ queryKey: ["string-keys"] });
    } catch {
      showBanner("Failed to approve translation.", false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={s.tabContent}>
      {banner && (
        <div style={{
          ...s.successBanner,
          background: banner.ok ? "#d4edda" : "#fff5f5",
          color: banner.ok ? "#155724" : "#c53030",
          border: `1px solid ${banner.ok ? "#c3e6cb" : "#fc8181"}`,
        }}>
          {banner.msg}
        </div>
      )}

      {/* ── Section 1: Coverage Overview ────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Translation Coverage</span>
          {!keysLoading && (
            <span style={sL.sectionMeta}>
              Total strings: <strong>{totalActive}</strong>
              {" · "}
              Fully translated: <strong>{fullyTranslated} / {TRANSLATION_LANGS.length}</strong>
            </span>
          )}
        </div>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Language</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Translated</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Approved</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Published</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Coverage</th>
                <th style={{ ...s.th, textAlign: "right" as const }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keysLoading ? (
                <tr>
                  <td colSpan={6} style={{ ...s.td, textAlign: "center", color: "#718096" }}>
                    Loading…
                  </td>
                </tr>
              ) : (
                coverageData.map((lang) => (
                  <tr key={lang.code} style={s.tr}>
                    <td style={s.td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={s.codeBadge}>{lang.code}</span>
                        <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{lang.name}</span>
                      </div>
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#4a5568" }}>
                      {lang.translated} / {lang.total}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#4a5568" }}>
                      {lang.approved} / {lang.total}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const, color: "#4a5568" }}>
                      {lang.published} / {lang.total}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                        <div style={sL.progressBar}>
                          <div
                            style={{
                              ...sL.progressFill,
                              width: `${lang.coveragePct}%`,
                              background:
                                lang.coveragePct === 100
                                  ? "#22c55e"
                                  : lang.coveragePct >= 50
                                  ? "#d97706"
                                  : "#e53e3e",
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#1A2B4A", minWidth: 36 }}>
                          {lang.coveragePct}%
                        </span>
                      </div>
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const }}>
                      {isAdmin && (
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <button
                            style={{
                              ...sL.actionBtn,
                              background: "#fffbeb",
                              color: "#d97706",
                              border: "1px solid #fcd34d",
                              opacity: autoTranslatingLang === lang.code ? 0.6 : 1,
                            }}
                            onClick={() => handleAutoTranslate(lang.code)}
                            disabled={autoTranslatingLang === lang.code}
                          >
                            {autoTranslatingLang === lang.code ? "Translating…" : "Auto-translate"}
                          </button>
                          <button
                            style={{
                              ...sL.actionBtn,
                              background: lang.coveragePct === 100 ? "#d4edda" : "#f0f4f8",
                              color: lang.coveragePct === 100 ? "#155724" : "#a0aec0",
                              border: `1px solid ${lang.coveragePct === 100 ? "#c3e6cb" : "#e2e8f0"}`,
                              opacity: publishingLang === lang.code ? 0.6 : 1,
                              cursor: lang.coveragePct === 100 ? "pointer" : "default",
                            }}
                            onClick={() => lang.coveragePct === 100 && handlePublish(lang.code)}
                            disabled={lang.coveragePct < 100 || publishingLang === lang.code}
                          >
                            {publishingLang === lang.code ? "Publishing…" : "Publish"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 2: Translation Review Queue ─────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Translation Review Queue</span>
          <select
            value={selectedLang}
            onChange={(e) => {
              setSelectedLang(e.target.value);
              setFilterTab("draft");
              setEditedTexts({});
            }}
            style={{ ...s.select, minWidth: 180 }}
          >
            {TRANSLATION_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </div>

        {/* Filter tabs */}
        <div style={sL.filterTabBar}>
          {(["all", "missing", "draft", "approved", "published"] as FilterStatus[]).map((tab) => (
            <button
              key={tab}
              style={{
                ...sL.filterTabBtn,
                borderBottom: filterTab === tab ? `2px solid ${BLUE}` : "2px solid transparent",
                color: filterTab === tab ? BLUE : "#718096",
                fontWeight: filterTab === tab ? 700 : 500,
              }}
              onClick={() => setFilterTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              <span
                style={{
                  ...sL.countBadge,
                  background: filterTab === tab ? BLUE : "#e2e8f0",
                  color: filterTab === tab ? "#fff" : "#4a5568",
                }}
              >
                {counts[tab]}
              </span>
            </button>
          ))}
        </div>

        <div style={s.tableWrap}>
          <table style={{ ...s.table, tableLayout: "fixed" as const }}>
            <colgroup>
              <col style={{ width: "17%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "23%" }} />
              <col style={{ width: "28%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "13%" }} />
            </colgroup>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>String Key</th>
                <th style={s.th}>Category</th>
                <th style={s.th}>English Text</th>
                <th style={s.th}>Translated Text</th>
                <th style={s.th}>Status</th>
                <th style={{ ...s.th, textAlign: "center" as const }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {transLoading ? (
                <tr>
                  <td colSpan={6} style={{ ...s.td, textAlign: "center", color: "#718096" }}>
                    Loading translations…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    style={{ ...s.td, textAlign: "center", color: "#718096", fontStyle: "italic" }}
                  >
                    No {filterTab === "all" ? "" : filterTab + " "}translations.
                  </td>
                </tr>
              ) : (
                filtered.map((t) => {
                  const isSaving = savingKeys.has(t.string_key);
                  const currentText = editedTexts[t.string_key] ?? t.translated_text;
                  const canEdit = t.status !== "published";
                  const canApprove = !!t.id && t.status === "draft";
                  return (
                    <tr key={t.string_key} style={s.tr}>
                      <td style={s.td}>
                        <span
                          style={{
                            ...s.codeBadge,
                            fontSize: 11,
                            wordBreak: "break-all" as const,
                            display: "inline-block",
                          }}
                        >
                          {t.string_key}
                        </span>
                      </td>
                      <td style={s.td}>
                        <span style={categoryBadgeStyle()}>
                          {categoryMap[t.string_key] ?? "—"}
                        </span>
                      </td>
                      <td
                        style={{
                          ...s.td,
                          fontSize: 12,
                          color: "#4a5568",
                          lineHeight: 1.4,
                          wordBreak: "break-word" as const,
                        }}
                      >
                        {t.english_text}
                      </td>
                      <td style={s.td}>
                        {canEdit ? (
                          <input
                            type="text"
                            value={currentText}
                            placeholder={t.status === "missing" ? "Enter translation…" : ""}
                            onChange={(e) =>
                              setEditedTexts((p) => ({
                                ...p,
                                [t.string_key]: e.target.value,
                              }))
                            }
                            onBlur={() => handleSave(t)}
                            disabled={isSaving}
                            style={{
                              ...s.input,
                              width: "100%",
                              fontSize: 12,
                              padding: "6px 8px",
                              opacity: isSaving ? 0.6 : 1,
                              boxSizing: "border-box" as const,
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: 12, color: "#4a5568", lineHeight: 1.4 }}>
                            {t.translated_text}
                          </span>
                        )}
                      </td>
                      <td style={s.td}>
                        <span style={statusBadgeStyle(t.status)}>{t.status}</span>
                      </td>
                      <td style={{ ...s.td, textAlign: "center" as const }}>
                        {canApprove && (
                          <button
                            style={{
                              padding: "5px 12px",
                              background: "#d4edda",
                              color: "#155724",
                              border: "1px solid #c3e6cb",
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                            onClick={() => handleApprove(t.id)}
                          >
                            Approve
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 3: Publish History ───────────────────────────────────── */}
      <div style={sL.sectionCard}>
        <div style={sL.sectionHeader}>
          <span style={sL.sectionTitle}>Publish History</span>
        </div>
        {packages.length === 0 ? (
          <div style={{ padding: "24px 28px", color: "#718096", fontSize: 13, fontStyle: "italic" }}>
            No language packages published yet.
          </div>
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
                        <span style={{ color: "#4a5568" }}>
                          {TRANSLATION_LANGS.find((l) => l.code === pkg.language_code)?.name ??
                            pkg.language_code}
                        </span>
                      </div>
                    </td>
                    <td style={s.td}>
                      <span style={{ fontWeight: 600, color: "#1A2B4A" }}>v{pkg.version}</span>
                    </td>
                    <td style={s.td}>
                      <span
                        style={statusBadgeStyle(pkg.status === "archived" ? "missing" : "published")}
                      >
                        {pkg.status}
                      </span>
                    </td>
                    <td style={{ ...s.td, color: "#718096", fontSize: 12 }}>
                      {pkg.published_at
                        ? new Date(pkg.published_at).toLocaleDateString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                    <td style={{ ...s.td, textAlign: "right" as const, fontWeight: 600, color: "#1A2B4A" }}>
                      {pkg.string_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── TAB 3 — Questions ─────────────────────────────────────────────────────────

type QuestionEditorEntry = {
  id: string;
  text: string;
  type: string;
  options: string[];
};

function QuestionsTab({ isAdmin }: { isAdmin: boolean }) {
  const [showWarning, setShowWarning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftQuestions, setDraftQuestions] = useState<QuestionEditorEntry[]>(
    CORE_QUESTIONS.map((q) => ({ ...q, options: [...q.options] }))
  );
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState("");

  async function handleSaveDraft() {
    setSaving(true);
    try {
      const res = await api.post<{ version: string }>("/api/question-packages", {
        questions: draftQuestions,
      });
      setSavedVersion(res.data.version);
      setEditing(false);
      setSuccessBanner(`Draft version ${res.data.version} saved.`);
      setTimeout(() => setSuccessBanner(""), 4000);
    } catch {
      alert("Failed to save draft. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!savedVersion) return;
    if (!window.confirm(`Publish version ${savedVersion}? All devices will sync this on next open.`)) return;
    setPublishing(true);
    try {
      await api.patch(`/api/question-packages/${savedVersion}/publish`);
      setSuccessBanner(`Version ${savedVersion} published successfully.`);
      setSavedVersion(null);
      setTimeout(() => setSuccessBanner(""), 4000);
    } catch {
      alert("Failed to publish. Please try again.");
    } finally {
      setPublishing(false);
    }
  }

  function updateQuestion(idx: number, field: keyof QuestionEditorEntry, value: string) {
    setDraftQuestions((prev) => {
      const next = [...prev];
      if (field === "options") return next;
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  function updateOption(qIdx: number, oIdx: number, value: string) {
    setDraftQuestions((prev) => {
      const next = [...prev];
      const opts = [...next[qIdx].options];
      opts[oIdx] = value;
      next[qIdx] = { ...next[qIdx], options: opts };
      return next;
    });
  }

  return (
    <div style={s.tabContent}>
      {successBanner && <div style={{ ...s.successBanner, marginBottom: 16 }}>{successBanner}</div>}

      {/* Version header */}
      <div style={s.versionHeader}>
        <div>
          <span style={s.versionLabel}>Current Version</span>
          <span style={s.versionValue}>1.0.0</span>
          <span style={s.versionDate}>— Published 12 May 2026</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {savedVersion && (
            <button
              style={{ ...s.addBtn, background: "#22c55e" }}
              onClick={handlePublish}
              disabled={publishing}
            >
              {publishing ? "Publishing…" : `Publish v${savedVersion}`}
            </button>
          )}
          {isAdmin && !editing && (
            <button style={s.editQuestionsBtn} onClick={() => setShowWarning(true)}>
              Edit Questions
            </button>
          )}
          {editing && (
            <>
              <button style={s.cancelBtn} onClick={() => setEditing(false)}>
                Discard
              </button>
              <button
                style={{ ...s.submitBtn, opacity: saving ? 0.7 : 1 }}
                onClick={handleSaveDraft}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save Draft"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Question cards */}
      <div style={s.questionList}>
        {draftQuestions.map((q, idx) => (
          <div key={q.id} style={s.questionCard}>
            <div style={s.questionCardHeader}>
              <span style={s.questionNum}>Q{idx + 1}</span>
              <span style={s.typeBadge}>{q.type}</span>
            </div>
            {editing ? (
              <textarea
                value={q.text}
                onChange={(e) => updateQuestion(idx, "text", e.target.value)}
                style={s.questionTextarea}
                rows={2}
              />
            ) : (
              <p style={s.questionText}>{q.text}</p>
            )}
            {q.type !== "text" && (
              <div style={s.optionsList}>
                {q.options.map((opt, oIdx) => (
                  <div key={oIdx} style={s.optionItem}>
                    <span style={s.optionBullet}>{q.type === "single-select" ? "◯" : "□"}</span>
                    {editing ? (
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => updateOption(idx, oIdx, e.target.value)}
                        style={{ ...s.input, flex: 1, padding: "6px 10px", fontSize: 13 }}
                      />
                    ) : (
                      <span style={{ fontSize: 13, color: "#4a5568" }}>{opt}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {q.type === "text" && !editing && (
              <div style={s.textFieldPreview}>Free text response</div>
            )}
          </div>
        ))}
      </div>

      {showWarning && (
        <EditQuestionsWarningModal
          onClose={() => setShowWarning(false)}
          onConfirm={() => {
            setShowWarning(false);
            setEditing(true);
          }}
        />
      )}
    </div>
  );
}

// ── TAB 4 — Map Settings ──────────────────────────────────────────────────────

function MapSettingsTab() {
  const [radius, setRadius] = useState(50);
  const [buildingSource, setBuildingSource] = useState("osm");
  const [radiusSaving, setRadiusSaving] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [radiusSaved, setRadiusSaved] = useState(false);
  const [sourceSaved, setSourceSaved] = useState(false);

  const { data: settings } = useQuery<MapSettings>({
    queryKey: ["map-settings"],
    queryFn: async () => {
      const res = await api.get<MapSettings>("/api/settings");
      return res.data;
    },
    onSuccess: (data: MapSettings) => {
      setRadius(data.reporting_radius_km ?? 50);
      setBuildingSource(data.building_source ?? "osm");
    },
  } as Parameters<typeof useQuery>[0]);

  // Apply fetched settings when they load
  if (settings && radius === 50 && buildingSource === "osm") {
    if (settings.reporting_radius_km !== undefined) setRadius(settings.reporting_radius_km);
    if (settings.building_source !== undefined) setBuildingSource(settings.building_source);
  }

  async function saveRadius() {
    setRadiusSaving(true);
    try {
      await api.patch("/api/settings", { reporting_radius_km: radius });
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
      await api.patch("/api/settings", { building_source: buildingSource });
      setSourceSaved(true);
      setTimeout(() => setSourceSaved(false), 3000);
    } catch {
      alert("Failed to save building source setting.");
    } finally {
      setSourceSaving(false);
    }
  }

  return (
    <div style={s.tabContent}>
      <div style={s.settingsCardList}>
        {/* Reporting Radius */}
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
              <span style={{ fontSize: 14, color: "#4a5568", fontWeight: 500 }}>kilometres</span>
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

        {/* Building Footprints Source */}
        <div style={s.settingsCard}>
          <div style={s.settingsCardHeader}>
            <div>
              <div style={s.settingsCardTitle}>Building Footprints Source</div>
              <div style={s.settingsCardDesc}>
                Data source used to load building footprints on the map
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
                <option value="osm">OpenStreetMap (Overpass API)</option>
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

type AcKey = "tc" | "onboarding" | "safety-tips" | "reporting-guidelines" | "first-aid";

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
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SystemSettingsPage() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<Tab>("countries");
  const isAdmin = user?.role === "admin";

  const tabs: { key: Tab; label: string }[] = [
    { key: "countries", label: "Countries" },
    { key: "languages", label: "Languages" },
    { key: "questions", label: "Questions" },
    { key: "map", label: "Map Settings" },
    { key: "app-content", label: "App Content" },
  ];

  return (
    <div style={s.page}>
      <Header title="System Settings" subtitle="Manage countries, languages, questions, and map configuration" />

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
        {activeTab === "questions" && <QuestionsTab isAdmin={isAdmin} />}
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
