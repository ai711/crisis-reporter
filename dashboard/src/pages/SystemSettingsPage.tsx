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

type Tab = "countries" | "languages" | "questions" | "map";

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

// ── TAB 2 — Languages ──────────────────────────────────────────────────────────

function LanguagesTab() {
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const [successBanner, setSuccessBanner] = useState("");

  const { data: extraLanguages = [], isLoading } = useQuery<Language[]>({
    queryKey: ["languages"],
    queryFn: async () => {
      const res = await api.get<Language[]>("/api/languages");
      return res.data;
    },
  });

  function handleSuccess() {
    setShowAddModal(false);
    queryClient.invalidateQueries({ queryKey: ["languages"] });
    setSuccessBanner("Language added successfully");
    setTimeout(() => setSuccessBanner(""), 4000);
  }

  return (
    <div style={s.tabContent}>
      <div style={s.tabToolbar}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, color: "#718096" }}>
            The 6 UN official languages are always available and cannot be removed.
          </p>
        </div>
        <button style={s.addBtn} onClick={() => setShowAddModal(true)}>
          + Add Language
        </button>
      </div>

      {successBanner && <div style={s.successBanner}>{successBanner}</div>}

      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr style={s.thead}>
              <th style={s.th}>Language</th>
              <th style={s.th}>Code</th>
              <th style={s.th}>Availability</th>
            </tr>
          </thead>
          <tbody>
            {UN_LANGUAGES.map((lang) => (
              <tr key={lang.code} style={s.tr}>
                <td style={s.td}>
                  <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{lang.name}</span>
                </td>
                <td style={s.td}>
                  <span style={s.codeBadge}>{lang.code}</span>
                </td>
                <td style={s.td}>
                  <span style={s.alwaysAvailableBadge}>Always Available</span>
                </td>
              </tr>
            ))}
            {!isLoading && extraLanguages.map((lang) => (
              <tr key={lang.code} style={s.tr}>
                <td style={s.td}>
                  <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{lang.name}</span>
                </td>
                <td style={s.td}>
                  <span style={s.codeBadge}>{lang.code}</span>
                </td>
                <td style={s.td}>
                  <span style={{
                    ...s.alwaysAvailableBadge,
                    background: lang.is_active ? "#d4edda" : "#e2e8f0",
                    color: lang.is_active ? "#155724" : "#4a5568",
                    border: `1px solid ${lang.is_active ? "#c3e6cb" : "#cbd5e0"}`,
                  }}>
                    {lang.is_active ? "Active" : "Inactive"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAddModal && (
        <AddLanguageModal
          onClose={() => setShowAddModal(false)}
          onSuccess={handleSuccess}
        />
      )}
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
