import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReporterProfile {
  reporter_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  profile_photo_url: string | null;
  is_verified: boolean;
}

type SaveStatus = "idle" | "success" | "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMobileBrowser(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function calcCompletion(
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
  photoUrl: string | null
): number {
  let n = 0;
  if (firstName.trim()) n++;
  if (lastName.trim()) n++;
  if (email.trim()) n++;
  if (phone.trim()) n++;
  if (photoUrl) n++;
  return n * 20;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getInitials(first: string, last: string): string {
  const a = first.trim()[0] ?? "";
  const b = last.trim()[0] ?? "";
  return (a + b).toUpperCase();
}

const COUNTRY_CODES = [
  "+1", "+7", "+20", "+27", "+30", "+31", "+32", "+33", "+34", "+36",
  "+39", "+40", "+41", "+43", "+44", "+45", "+46", "+47", "+48", "+49",
  "+52", "+54", "+55", "+56", "+57", "+58", "+60", "+61", "+62", "+63",
  "+64", "+65", "+66", "+81", "+82", "+84", "+86", "+90", "+91", "+92",
  "+98", "+212", "+213", "+216", "+218", "+234", "+254", "+255", "+256",
  "+880", "+886", "+960", "+961", "+962", "+963", "+964", "+965", "+966",
  "+967", "+968", "+971", "+972", "+974", "+975", "+976", "+977", "+992",
  "+993", "+994", "+995", "+996", "+998",
];

function parsePhoneNumber(stored: string): { code: string; number: string } {
  if (!stored) return { code: "+1", number: "" };
  // Sort longest codes first to avoid "+1" matching "+12..." prematurely
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.length - a.length);
  const match = sorted.find((c) => stored.startsWith(c));
  if (match) return { code: match, number: stored.slice(match.length).trim() };
  return { code: "+1", number: stored };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();

  // Form state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCountryCode, setPhoneCountryCode] = useState("+1");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  // Photo upload
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [emailError, setEmailError] = useState("");
  const [isDirty, setIsDirty] = useState(false);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load profile ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Skip API call for session-only local IDs — backend has never seen them
    if (!reporterId || reporterId.startsWith("local_")) { setLoading(false); return; }
    api
      .get<ReporterProfile>(`/api/reporters/${reporterId}`)
      .then((res) => {
        const p = res.data;
        setFirstName(p.first_name ?? "");
        setLastName(p.last_name ?? "");
        setEmail(p.email ?? "");
        const parsed = parsePhoneNumber(p.phone_number ?? "");
        setPhoneCountryCode(parsed.code);
        setPhone(parsed.number);
        setPhotoUrl(p.profile_photo_url ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [reporterId]);

  useEffect(() => {
    return () => { if (successTimer.current) clearTimeout(successTimer.current); };
  }, []);

  const displayPhoto = photoPreview ?? photoUrl;
  const completion = calcCompletion(firstName, lastName, email, phone, displayPhoto);
  const initials = getInitials(firstName, lastName);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handlePhoneChange = (value: string) => {
    setPhone(value.replace(/[^\d\s\-()]/g, ""));
    setIsDirty(true);
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setIsDirty(true);
    if (emailError && (value === "" || EMAIL_RE.test(value))) setEmailError("");
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoFile(file);
    setIsDirty(true);
    e.target.value = "";
  };

  const handleSave = async () => {
    if (!isDirty || saving) return;
    if (email.trim() && !EMAIL_RE.test(email.trim())) {
      setEmailError(t("profile.email_invalid"));
      return;
    }
    setEmailError("");
    if (!reporterId) return;

    setSaving(true);
    setSaveStatus("idle");

    try {
      if (photoFile) {
        const fd = new FormData();
        fd.append("photo", photoFile);
        const res = await api.post<{ profile_photo_url: string }>(
          `/api/reporters/${reporterId}/photo`, fd,
          { headers: { "Content-Type": "multipart/form-data" } }
        );
        setPhotoUrl(res.data.profile_photo_url);
        setPhotoFile(null);
        setPhotoPreview(null);
      }

      await api.patch(`/api/reporters/${reporterId}`, {
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
        email: email.trim() || null,
        phone_number: phone.trim() ? `${phoneCountryCode}${phone.trim()}` : null,
      });

      setSaveStatus("success");
      setIsDirty(false);
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSaveStatus("idle"), 2500);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  // ── Anonymous gate ──────────────────────────────────────────────────────────
  // Treat local_ IDs (offline-created fallbacks the backend never saw) the same
  // as no ID — show the login/register prompt rather than an empty profile form.
  if (!reporterId || reporterId.startsWith("local_")) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
            <span className="material-symbols-outlined" style={{ color: "#0468B1", fontSize: 24, lineHeight: 1 }}>
              arrow_back
            </span>
          </button>
          <span style={s.headerTitle}>{t("profile.title")}</span>
          <div style={{ minWidth: 44, flexShrink: 0 }} />
        </header>
        <div style={s.anonGate}>
          <div style={s.anonGateIcon}>
            <span className="material-symbols-outlined" style={{ color: "#0468B1", fontSize: 48, fontVariationSettings: "'FILL' 1" }}>
              person
            </span>
          </div>
          <p style={s.anonGateHeading}>{t("profile.anon_gate_heading")}</p>
          <p style={s.anonGateSubtext}>{t("profile.anon_gate_subtext")}</p>
          <div style={s.anonGateBtns}>
            <button onClick={() => navigate("/login")} style={s.loginBtn}>{t("settings.login")}</button>
            <button onClick={() => navigate("/login?mode=register")} style={s.registerBtn}>{t("settings.register")}</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
            <span className="material-symbols-outlined" style={{ color: "#0468B1", fontSize: 24, lineHeight: 1 }}>
              arrow_back
            </span>
          </button>
          <span style={s.headerTitle}>{t("profile.title")}</span>
          <div style={{ minWidth: 44, flexShrink: 0 }} />
        </header>
        <div style={s.loadingWrap}>
          <div style={s.spinner} />
        </div>
      </div>
    );
  }

  // ── Full profile ────────────────────────────────────────────────────────────
  const canSave = isDirty && !saving;

  return (
    <div style={s.page}>
      {/* ── Header ── */}
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
          <span className="material-symbols-outlined" style={{ color: "#0468B1", fontSize: 24, lineHeight: 1 }}>
            arrow_back
          </span>
        </button>
        <span style={s.headerTitle}>{t("profile.title")}</span>
        <div style={{ minWidth: 44, flexShrink: 0 }} />
      </header>

      {/* ── Scrollable body ── */}
      <div style={s.body}>

        {/* Avatar section */}
        <section style={s.avatarSection}>
          <div style={s.avatarWrapper}>
            <div
              style={s.avatarCircle}
              onClick={() => photoInputRef.current?.click()}
              role="button"
              aria-label="Change profile photo"
            >
              {displayPhoto ? (
                <img src={displayPhoto} alt="Profile" style={s.avatarImg} />
              ) : initials ? (
                <span style={s.avatarInitials}>{initials}</span>
              ) : (
                <span
                  className="material-symbols-outlined"
                  style={{ color: "#717782", fontSize: 56, lineHeight: 1, userSelect: "none" }}
                >
                  person
                </span>
              )}
            </div>
            <button
              style={s.cameraBadge}
              onClick={() => photoInputRef.current?.click()}
              aria-label="Upload photo"
            >
              <span
                className="material-symbols-outlined"
                style={{ color: "#fff", fontSize: 18, lineHeight: 1, fontVariationSettings: "'FILL' 1" }}
              >
                photo_camera
              </span>
            </button>
          </div>
          <button style={s.editPhotoBtn} onClick={() => photoInputRef.current?.click()}>
            {displayPhoto ? t("profile.edit_photo") : t("profile.add_photo")}
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture={isMobileBrowser() ? "environment" : undefined}
            style={{ display: "none" }}
            onChange={handlePhotoSelect}
          />
        </section>

        {/* Completion bar */}
        <section style={s.completionSection}>
          <div style={s.completionRow}>
            <span style={s.completionTitle}>{t("profile.completion_heading")}</span>
            <span style={s.completionPct}>{completion}%</span>
          </div>
          <div style={s.barTrack}>
            <div style={{ ...s.barFill, width: `${completion}%`, transition: "width 0.4s ease" }} />
          </div>
          <p style={s.completionHint}>
            {t("profile.completion_hint")}
          </p>
        </section>

        {/* Info notice */}
        <div style={s.infoNotice}>
          <span
            className="material-symbols-outlined"
            style={{ color: "#0468B1", fontSize: 20, flexShrink: 0, lineHeight: 1, fontVariationSettings: "'FILL' 1" }}
          >
            info
          </span>
          <p style={s.infoNoticeText}>{t("profile.anon_note")}</p>
        </div>

        {/* Form fields */}
        <div style={s.formFields}>

          {/* First Name */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>{t("profile.first_name_optional")}</label>
            <input
              style={s.fieldInput}
              type="text"
              value={firstName}
              onChange={(e) => { setFirstName(e.target.value.slice(0, 100)); setIsDirty(true); }}
              placeholder={t("profile.first_name_placeholder")}
              maxLength={100}
            />
          </div>

          {/* Last Name */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>{t("profile.last_name_optional")}</label>
            <input
              style={s.fieldInput}
              type="text"
              value={lastName}
              onChange={(e) => { setLastName(e.target.value.slice(0, 100)); setIsDirty(true); }}
              placeholder={t("profile.last_name_placeholder")}
              maxLength={100}
            />
          </div>

          {/* Email */}
          <div style={s.fieldGroup}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 6 }}>
              <label style={{ ...s.fieldLabel, marginBottom: 0 }}>{t("profile.email_optional")}</label>
              <span style={s.fieldHint}>{t("profile.email_hint")}</span>
            </div>
            <input
              style={{
                ...s.fieldInput,
                ...(emailError ? { outline: "1.5px solid #E53E3E" } : {}),
              }}
              type="email"
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
              placeholder={t("profile.email_placeholder")}
              inputMode="email"
              autoComplete="email"
            />
            {emailError && <p style={s.inlineError}>{emailError}</p>}
          </div>

          {/* Mobile Number */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>{t("profile.phone_optional")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              {/* Country code select */}
              <div style={{ position: "relative", flexShrink: 0 }}>
                <select
                  style={s.countryCodeSelect}
                  value={phoneCountryCode}
                  onChange={(e) => { setPhoneCountryCode(e.target.value); setIsDirty(true); }}
                >
                  {COUNTRY_CODES.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
                <span
                  className="material-symbols-outlined"
                  style={{
                    position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                    fontSize: 16, color: "#717782", pointerEvents: "none", lineHeight: 1,
                  }}
                >
                  expand_more
                </span>
              </div>
              <input
                style={{ ...s.fieldInput, flex: 1, margin: 0 }}
                type="tel"
                value={phone}
                onChange={(e) => handlePhoneChange(e.target.value)}
                placeholder={t("profile.phone_placeholder")}
                inputMode="tel"
              />
            </div>
          </div>
        </div>

        {/* Status banners */}
        {saveStatus === "success" && (
          <div style={s.successMsg}>
            <span className="material-symbols-outlined" style={{ color: "#276749", fontSize: 18, fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
            {t("profile.save_success")}
          </div>
        )}
        {saveStatus === "error" && (
          <div style={s.errorMsg}>
            <span className="material-symbols-outlined" style={{ color: "#C53030", fontSize: 18 }}>
              error
            </span>
            {t("profile.save_error")}
          </div>
        )}

        {/* Spacer for fixed footer */}
        <div style={{ height: 120 }} />
      </div>

      {/* ── Fixed footer ── */}
      <div style={s.footer}>
        <button
          style={{ ...s.saveBtn, ...(canSave ? {} : s.saveBtnDisabled) }}
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? t("common.saving") : t("profile.save_btn")}
        </button>
        <p style={s.footerHint}>{t("profile.footer_hint")}</p>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#F6F3F2",
    display: "flex",
    flexDirection: "column",
  },

  // Header
  header: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    background: "rgba(252,249,248,0.92)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    height: 56,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    flexShrink: 0,
    boxSizing: "border-box",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    flexShrink: 0,
    padding: 0,
  },
  headerTitle: {
    color: "#1B1C1C",
    fontSize: 17,
    fontWeight: 600,
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
  },

  // Body
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "28px 24px 0",
  },

  // Avatar
  avatarSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    marginBottom: 28,
  },
  avatarWrapper: {
    position: "relative",
    display: "inline-flex",
  },
  avatarCircle: {
    width: 128,
    height: 128,
    borderRadius: "50%",
    background: "#E4E2E1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    cursor: "pointer",
  },
  avatarImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  avatarInitials: {
    fontSize: 42,
    fontWeight: 700,
    color: "#0468B1",
    lineHeight: 1,
    userSelect: "none",
  },
  cameraBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "#0468B1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "3px solid #F6F3F2",
    boxSizing: "border-box",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(4,104,177,0.3)",
  },
  editPhotoBtn: {
    marginTop: 12,
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    fontFamily: "inherit",
  },

  // Completion
  completionSection: {
    marginBottom: 16,
  },
  completionRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  completionTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: "#414751",
  },
  completionPct: {
    fontSize: 15,
    fontWeight: 700,
    color: "#0468B1",
  },
  barTrack: {
    height: 8,
    background: "#E4E2E1",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  barFill: {
    height: "100%",
    background: "#0468B1",
    borderRadius: 4,
  },
  completionHint: {
    fontSize: 12,
    color: "#717782",
    margin: 0,
    lineHeight: 1.45,
    opacity: 0.85,
  },

  // Info notice
  infoNotice: {
    background: "rgba(4,104,177,0.06)",
    border: "1px solid rgba(4,104,177,0.15)",
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    margin: "16px 0 24px",
  },
  infoNoticeText: {
    fontSize: 13,
    color: "#00497F",
    margin: 0,
    lineHeight: 1.5,
    flex: 1,
    fontWeight: 500,
  },

  // Form fields
  formFields: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#717782",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 10,
    color: "#0468B1",
    fontStyle: "italic",
    fontWeight: 500,
    opacity: 0.85,
  },
  fieldInput: {
    width: "100%",
    height: 48,
    padding: "0 14px",
    background: "#F0EDED",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    color: "#1B1C1C",
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
  countryCodeSelect: {
    height: 48,
    width: 90,
    padding: "0 28px 0 12px",
    background: "#F0EDED",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    color: "#1B1C1C",
    outline: "none",
    appearance: "none",
    WebkitAppearance: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 600,
  },
  inlineError: {
    fontSize: 12,
    color: "#E53E3E",
    margin: "4px 0 0",
  },

  // Status messages
  successMsg: {
    marginTop: 16,
    background: "rgba(56,161,105,0.08)",
    border: "1px solid rgba(56,161,105,0.3)",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    color: "#276749",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  errorMsg: {
    marginTop: 16,
    background: "rgba(197,48,48,0.06)",
    border: "1px solid rgba(197,48,48,0.2)",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    color: "#C53030",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },

  // Fixed footer
  footer: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    background: "#F6F3F2",
    padding: "12px 24px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    zIndex: 40,
  },
  saveBtn: {
    width: "100%",
    height: 52,
    background: "linear-gradient(135deg, #0468B1, #00508A)",
    color: "#fff",
    border: "none",
    borderRadius: 14,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 4px 14px rgba(4,104,177,0.3)",
    transition: "opacity 0.15s",
  },
  saveBtnDisabled: {
    background: "#E4E2E1",
    color: "#9CA3AF",
    cursor: "not-allowed",
    boxShadow: "none",
  },
  footerHint: {
    fontSize: 11,
    color: "#9CA3AF",
    textAlign: "center",
    margin: 0,
    fontWeight: 500,
    letterSpacing: 0.2,
  },

  // Anonymous gate
  anonGate: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "40px 24px",
  },
  anonGateIcon: {
    width: 80,
    height: 80,
    borderRadius: "50%",
    background: "rgba(4,104,177,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  anonGateHeading: {
    color: "#1B1C1C",
    fontSize: 18,
    fontWeight: 700,
    margin: "0 0 8px",
    lineHeight: 1.4,
  },
  anonGateSubtext: {
    color: "#717782",
    fontSize: 14,
    margin: "0 0 28px",
    lineHeight: 1.6,
    maxWidth: 280,
  },
  anonGateBtns: {
    display: "flex",
    gap: 12,
    justifyContent: "center",
    flexWrap: "wrap",
  },
  loginBtn: {
    background: "linear-gradient(135deg, #0468B1, #00508A)",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "12px 28px",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 15,
    fontFamily: "inherit",
  },
  registerBtn: {
    background: "transparent",
    color: "#0468B1",
    border: "1.5px solid #0468B1",
    borderRadius: 10,
    padding: "12px 28px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 15,
    fontFamily: "inherit",
  },

  // Loading
  loadingWrap: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: 36,
    height: 36,
    border: "3px solid #E4E2E1",
    borderTop: "3px solid #0468B1",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
};
