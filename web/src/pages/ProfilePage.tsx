import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconBack() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0468B1"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconPerson() {
  return (
    <svg
      width={36}
      height={36}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#9CA3AF"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const navigate = useNavigate();
  const { reporterId } = useAuthStore();

  // Form fields
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  // C5/C6: Photo upload state
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [emailError, setEmailError] = useState("");

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch existing profile on mount
  useEffect(() => {
    if (!reporterId) {
      setLoading(false);
      return;
    }
    api
      .get<ReporterProfile>(`/api/reporters/${reporterId}`)
      .then((res) => {
        const p = res.data;
        setFirstName(p.first_name ?? "");
        setLastName(p.last_name ?? "");
        setEmail(p.email ?? "");
        setPhone(p.phone_number ?? "");
        setPhotoUrl(p.profile_photo_url ?? null);
      })
      .catch(() => {
        // Profile may not exist yet — start with empty fields
      })
      .finally(() => setLoading(false));
  }, [reporterId]);

  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  const displayPhoto = photoPreview ?? photoUrl;
  const completion = calcCompletion(firstName, lastName, email, phone, displayPhoto);
  const initials = getInitials(firstName, lastName);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handlePhoneChange = (value: string) => {
    setPhone(value.replace(/[^\d\s+\-()]/g, ""));
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (emailError && (value === "" || EMAIL_RE.test(value))) {
      setEmailError("");
    }
  };

  // C5/C6: Photo file selection handler
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setPhotoPreview(objectUrl);
    setPhotoFile(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handleSave = async () => {
    if (email.trim() && !EMAIL_RE.test(email.trim())) {
      setEmailError("Please enter a valid email address");
      return;
    }
    setEmailError("");

    if (!reporterId) return;
    setSaving(true);
    setSaveStatus("idle");

    try {
      // C5/C6: Upload photo first if a new one was selected
      if (photoFile) {
        const formData = new FormData();
        formData.append("photo", photoFile);
        const photoRes = await api.post<{ profile_photo_url: string }>(
          `/api/reporters/${reporterId}/photo`,
          formData,
          { headers: { "Content-Type": "multipart/form-data" } }
        );
        setPhotoUrl(photoRes.data.profile_photo_url);
        setPhotoFile(null);
        setPhotoPreview(null);
      }

      await api.patch(`/api/reporters/${reporterId}`, {
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
        email: email.trim() || null,
        phone_number: phone.trim() || null,
      });
      setSaveStatus("success");
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  // ── C8: Anonymous reporter gate — shown after all hooks ───────────────────

  if (!reporterId) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
            <IconBack />
          </button>
          <span style={s.headerTitle}>My Profile</span>
          <div style={{ minWidth: 44, flexShrink: 0 }} />
        </header>
        <div style={s.anonGate}>
          <p style={s.anonGateHeading}>
            Create a free account to save your profile and earn badges.
          </p>
          <p style={s.anonGateSubtext}>
            You can still submit reports anonymously without an account.
          </p>
          <div style={s.anonGateBtns}>
            <button
              onClick={() => navigate("/login")}
              style={s.loginBtn}
            >
              Log In
            </button>
            <button
              onClick={() => navigate("/login?mode=register")}
              style={s.registerBtn}
            >
              Create Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading spinner ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={s.page}>
        <header style={s.header}>
          <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
            <IconBack />
          </button>
          <span style={s.headerTitle}>My Profile</span>
          <div style={{ minWidth: 44, flexShrink: 0 }} />
        </header>
        <div style={s.loadingWrap}>
          <div style={s.spinner} />
        </div>
      </div>
    );
  }

  // ── Full profile form ──────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
          <IconBack />
        </button>
        <span style={s.headerTitle}>My Profile</span>
        <div style={{ width: 36 }} />
      </header>

      <div style={s.content}>
        {/* ── Completion bar ── */}
        <div style={s.completionWrap}>
          <p style={s.completionLabel}>Profile {completion}% complete</p>
          <div style={s.barTrack}>
            <div
              style={{
                ...s.barFill,
                width: `${completion}%`,
                transition: "width 0.4s ease",
              }}
            />
          </div>
        </div>

        {/* ── Avatar ── */}
        <div style={s.avatarSection}>
          <div style={s.avatarCircle}>
            {displayPhoto ? (
              <img src={displayPhoto} alt="Profile" style={s.avatarImg} />
            ) : initials ? (
              <span style={s.avatarInitials}>{initials}</span>
            ) : (
              <IconPerson />
            )}
          </div>
          {/* C5/C6: Real photo upload — file picker on desktop, camera on mobile */}
          <button
            style={s.editPhotoBtn}
            onClick={() => photoInputRef.current?.click()}
          >
            Edit photo
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture={isMobileBrowser() ? "environment" : undefined}
            style={{ display: "none" }}
            onChange={handlePhotoSelect}
          />
        </div>

        {/* ── Profile fields ── */}
        <div style={s.card}>
          {/* First Name */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>First Name</label>
            <input
              style={s.fieldInput}
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value.slice(0, 100))}
              placeholder="Enter your first name"
              maxLength={100}
            />
          </div>

          <div style={s.divider} />

          {/* Last Name */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>Last Name</label>
            <input
              style={s.fieldInput}
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value.slice(0, 100))}
              placeholder="Enter your last name"
              maxLength={100}
            />
          </div>

          <div style={s.divider} />

          {/* Email */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>Email Address</label>
            <input
              style={{
                ...s.fieldInput,
                borderColor: emailError ? "#FC8181" : "transparent",
                borderWidth: emailError ? 1 : 0,
                borderStyle: "solid",
              }}
              type="email"
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
              placeholder="Enter your email"
              inputMode="email"
            />
            {emailError && <p style={s.inlineError}>{emailError}</p>}
          </div>

          <div style={s.divider} />

          {/* Phone */}
          <div style={s.fieldGroup}>
            <label style={s.fieldLabel}>Phone Number</label>
            <input
              style={s.fieldInput}
              type="tel"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              placeholder="Optional"
              inputMode="tel"
            />
          </div>
        </div>

        {/* ── Save button ── */}
        <button
          style={{
            ...s.saveBtn,
            opacity: saving ? 0.7 : 1,
            cursor: saving ? "not-allowed" : "pointer",
          }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save Profile"}
        </button>

        {/* ── Feedback messages ── */}
        {saveStatus === "success" && (
          <div style={s.successMsg}>Profile saved</div>
        )}
        {saveStatus === "error" && (
          <div style={s.errorMsg}>
            Could not save profile. Please try again.
          </div>
        )}

        {/* ── Anonymous note ── */}
        <p style={s.anonNote}>
          All profile fields are optional. You can submit reports anonymously.
        </p>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    background: "#F6F3F2",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    position: "sticky" as const,
    top: 0,
    zIndex: 50,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    height: 56,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    flexShrink: 0,
    boxSizing: "border-box" as const,
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
    color: "#0468B1",
  },
  headerTitle: {
    color: "#1B1C1C",
    fontSize: 17,
    fontWeight: 600,
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap" as const,
  },
  // C8: Anonymous gate styles
  anonGate: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "40px 24px",
  },
  anonGateHeading: {
    color: "#1A2B4A",
    fontSize: "1rem",
    fontWeight: 600,
    margin: "0 0 8px",
    lineHeight: 1.4,
  },
  anonGateSubtext: {
    color: "#718096",
    fontSize: "0.875rem",
    margin: "0 0 24px",
    lineHeight: 1.5,
  },
  anonGateBtns: {
    display: "flex",
    gap: 12,
    justifyContent: "center",
    flexWrap: "wrap",
  },
  loginBtn: {
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 24px",
    fontWeight: 700,
    cursor: "pointer",
    fontSize: 15,
  },
  registerBtn: {
    background: "transparent",
    color: "#0468B1",
    border: "1px solid #0468B1",
    borderRadius: 8,
    padding: "12px 24px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 15,
  },
  loadingWrap: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: 36,
    height: 36,
    border: "3px solid #E2E8F0",
    borderTop: "3px solid #0468B1",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  content: {
    flex: 1,
    padding: "24px 16px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  completionWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  completionLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#4A5568",
    margin: 0,
  },
  barTrack: {
    height: 8,
    background: "#E2E8F0",
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    background: "#0468B1",
    borderRadius: 4,
  },
  avatarSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
  },
  avatarCircle: {
    width: 96,
    height: 96,
    borderRadius: "50%",
    background: "#E3F2FD",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    border: "2px solid #BFDBFE",
  },
  avatarImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  avatarInitials: {
    fontSize: 28,
    fontWeight: 700,
    color: "#0468B1",
    lineHeight: 1,
  },
  editPhotoBtn: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 3,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #E2E8F0",
    overflow: "hidden",
  },
  fieldGroup: {
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#9CA3AF",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  fieldInput: {
    width: "100%",
    fontSize: 15,
    color: "#1A2B4A",
    background: "transparent",
    border: "none",
    outline: "none",
    padding: 0,
    boxSizing: "border-box",
  },
  inlineError: {
    fontSize: 12,
    color: "#E53E3E",
    margin: 0,
    marginTop: 2,
  },
  divider: {
    height: 1,
    background: "#F0F4F8",
    marginLeft: 16,
  },
  saveBtn: {
    width: "100%",
    padding: "15px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 9999,
    fontSize: 16,
    fontWeight: 600,
    transition: "opacity 0.15s",
    fontFamily: "inherit",
  },
  successMsg: {
    background: "#F0FFF4",
    border: "1px solid #9AE6B4",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    color: "#276749",
    fontWeight: 500,
    textAlign: "center",
  },
  errorMsg: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    color: "#C53030",
    textAlign: "center",
  },
  anonNote: {
    fontSize: 12,
    color: "#9CA3AF",
    textAlign: "center",
    margin: 0,
    lineHeight: 1.5,
  },
};
