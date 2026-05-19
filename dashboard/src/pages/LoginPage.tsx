import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../services/auth";
import { useAuthStore } from "../stores/authStore";
import axios from "axios";
import api, { tokenStorage, resetExpiredPassword } from "../services/api";

// ── UNDP logo SVG ─────────────────────────────────────────────────────────────

function UndpLogo() {
  return (
    <svg
      width={64}
      height={64}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="UNDP logo"
    >
      <rect width={64} height={64} rx={10} fill="#0468B1" />
      <text
        x={32}
        y={26}
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="800"
        fontSize={18}
        letterSpacing={1}
      >
        UN
      </text>
      <text
        x={32}
        y={46}
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="800"
        fontSize={18}
        letterSpacing={1}
      >
        DP
      </text>
    </svg>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        border: "2.5px solid rgba(255,255,255,0.35)",
        borderTopColor: "#ffffff",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        verticalAlign: "middle",
        marginRight: 8,
        flexShrink: 0,
      }}
    />
  );
}

// ── Error message map ─────────────────────────────────────────────────────────

const PASSWORD_EXPIRED = "PASSWORD_EXPIRED" as const;

function resolveError(err: unknown): string | typeof PASSWORD_EXPIRED {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail as string | undefined;

    if (status === 403 && detail === "password_expired") {
      return PASSWORD_EXPIRED;
    }
    if (status === 401 && detail === "invalid_credentials") {
      return "The email address or password you entered is not correct. Please try again.";
    }
    if (status === 403 && detail === "account_deactivated") {
      return "Your account has been deactivated. Please contact your administrator.";
    }
    if (status === 429 && detail === "too_many_attempts") {
      return "Too many failed attempts. Please wait 15 minutes before trying again.";
    }
  }
  return "Something went wrong. Please try again.";
}

function passwordStrength(pwd: string): { level: number; label: string; color: string } {
  let score = 0;
  if (pwd.length >= 10) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[a-z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (score <= 1) return { level: score, label: "Weak", color: "#e53e3e" };
  if (score <= 3) return { level: score, label: "Fair", color: "#ed8936" };
  if (score === 4) return { level: score, label: "Good", color: "#38a169" };
  return { level: score, label: "Strong", color: "#276749" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setUser } = useAuthStore();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Session-expiry / reason banner — shown when redirected with ?reason=expired
  const reason = searchParams.get("reason");
  const [sessionMsg, setSessionMsg] = useState(
    reason === "expired" ? "Your session has expired. Please log in again." : ""
  );

  // Password-expired inline reset panel
  const [passwordExpired, setPasswordExpired] = useState(false);
  const [resetCurrentPwd, setResetCurrentPwd] = useState("");
  const [resetNewPwd, setResetNewPwd] = useState("");
  const [resetConfirmPwd, setResetConfirmPwd] = useState("");
  const [showResetNewPwd, setShowResetNewPwd] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");

  // Clear the session message as soon as the user starts typing
  const clearSessionMsg = () => setSessionMsg("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearSessionMsg();
    setError("");
    setLoading(true);

    try {
      const { user } = await login(email, password);
      setUser(user);
      navigate("/map");
    } catch (err) {
      const resolved = resolveError(err);
      if (resolved === PASSWORD_EXPIRED) {
        setPasswordExpired(true);
        setResetCurrentPwd(password);
        setResetError("");
      } else {
        setError(resolved);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetExpiredPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resetNewPwd !== resetConfirmPwd) {
      setResetError("New passwords do not match.");
      return;
    }
    setResetLoading(true);
    setResetError("");
    try {
      const response = await resetExpiredPassword(email, resetCurrentPwd, resetNewPwd);
      const { access_token, refresh_token } = response.data as {
        access_token: string;
        refresh_token: string;
      };
      tokenStorage.setTokens(access_token, refresh_token);
      const meResponse = await api.get("/api/dashboard/auth/me");
      setUser(meResponse.data);
      navigate("/map");
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const detail = err.response?.data?.detail as string | undefined;
        if (detail === "invalid_credentials") {
          setResetError("Current password is incorrect.");
        } else if (typeof detail === "string" && detail.startsWith("Password must")) {
          setResetError(detail);
        } else if (detail === "new_password_same_as_current") {
          setResetError("New password must be different from the current password.");
        } else if (typeof detail === "string" && detail.includes("different")) {
          setResetError(detail);
        } else {
          setResetError("Failed to reset password. Please try again.");
        }
      } else {
        setResetError("Failed to reset password. Please try again.");
      }
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <>
      {/* Keyframe animation injected as a global style tag */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div style={styles.container}>
        <div style={styles.card}>
          {/* Logo + wordmark */}
          <div style={styles.logoSection}>
            <UndpLogo />
            <h1 style={styles.appName}>Crisis Reporter</h1>
            <p style={styles.subtitle}>UNDP Staff Dashboard</p>
          </div>

          {/* Session-expiry message (shown when ?reason=expired) */}
          {sessionMsg && (
            <div style={styles.sessionMsg}>{sessionMsg}</div>
          )}

          {/* Login form */}
          <form onSubmit={handleLogin} style={styles.form} noValidate>
            <div style={styles.field}>
              <label style={styles.label}>Email Address</label>
              <input
                style={styles.input}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                  setPasswordExpired(false);
                  clearSessionMsg();
                }}
                placeholder="your@email.com"
                required
                autoFocus
                autoComplete="email"
                disabled={loading}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Password</label>
              <div style={styles.passwordWrap}>
                <input
                  style={{ ...styles.input, ...styles.passwordInput }}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                    setPasswordExpired(false);
                    clearSessionMsg();
                  }}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  style={styles.eyeBtn}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                  disabled={loading}
                >
                  {showPassword ? (
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Inline error — shown below password field, above the button */}
            {error && <div style={styles.error} role="alert">{error}</div>}

            <button
              type="submit"
              style={{
                ...styles.submitBtn,
                opacity: loading ? 0.85 : 1,
                cursor: loading ? "not-allowed" : "pointer",
              }}
              disabled={loading}
            >
              {loading && <Spinner />}
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>

          {/* Password-expired inline reset panel */}
          {passwordExpired && (
            <div style={styles.expiredPanel}>
              <p style={styles.expiredTitle}>Your password has expired and must be changed before you can log in.</p>
              <form onSubmit={handleResetExpiredPassword} style={{ display: "flex", flexDirection: "column", gap: 14 }} noValidate>
                <div style={styles.field}>
                  <label style={styles.label}>Current Password</label>
                  <input
                    style={styles.input}
                    type="password"
                    value={resetCurrentPwd}
                    onChange={(e) => { setResetCurrentPwd(e.target.value); setResetError(""); }}
                    placeholder="Current password"
                    required
                    autoComplete="current-password"
                    disabled={resetLoading}
                  />
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>New Password</label>
                  <div style={styles.passwordWrap}>
                    <input
                      style={{ ...styles.input, ...styles.passwordInput }}
                      type={showResetNewPwd ? "text" : "password"}
                      value={resetNewPwd}
                      onChange={(e) => { setResetNewPwd(e.target.value); setResetError(""); }}
                      placeholder="New password"
                      required
                      autoComplete="new-password"
                      disabled={resetLoading}
                    />
                    <button
                      type="button"
                      style={styles.eyeBtn}
                      onClick={() => setShowResetNewPwd((v) => !v)}
                      aria-label={showResetNewPwd ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showResetNewPwd ? (
                        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {resetNewPwd && (() => {
                    const s = passwordStrength(resetNewPwd);
                    return (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ height: 4, borderRadius: 2, background: "#e2e8f0" }}>
                          <div style={{ height: "100%", borderRadius: 2, width: `${(s.level / 5) * 100}%`, background: s.color, transition: "width 0.2s" }} />
                        </div>
                        <span style={{ fontSize: 12, color: s.color, fontWeight: 500 }}>{s.label}</span>
                      </div>
                    );
                  })()}
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>Confirm New Password</label>
                  <input
                    style={styles.input}
                    type="password"
                    value={resetConfirmPwd}
                    onChange={(e) => { setResetConfirmPwd(e.target.value); setResetError(""); }}
                    placeholder="Confirm new password"
                    required
                    autoComplete="new-password"
                    disabled={resetLoading}
                  />
                </div>

                {resetError && <div style={styles.error} role="alert">{resetError}</div>}

                <button
                  type="submit"
                  style={{
                    ...styles.submitBtn,
                    opacity: resetLoading ? 0.85 : 1,
                    cursor: resetLoading ? "not-allowed" : "pointer",
                  }}
                  disabled={resetLoading}
                >
                  {resetLoading && <Spinner />}
                  {resetLoading ? "Updating…" : "Change Password and Sign In"}
                </button>
              </form>
            </div>
          )}

          <p style={styles.footer}>
            Authorised UNDP staff only. Access is logged.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "#1A2B4A",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "48px 40px",
    width: "100%",
    maxWidth: 420,
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
  },
  logoSection: {
    textAlign: "center",
    marginBottom: 32,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
  },
  appName: {
    fontSize: 24,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    margin: 0,
  },
  sessionMsg: {
    background: "#fff8e1",
    color: "#7a5c00",
    padding: "12px 16px",
    borderRadius: 8,
    fontSize: 14,
    border: "1px solid #ffe082",
    marginBottom: 20,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: "#1A2B4A",
  },
  input: {
    padding: "12px 16px",
    borderRadius: 8,
    border: "1.5px solid #e0e0e0",
    fontSize: 15,
    outline: "none",
    transition: "border-color 0.15s",
    width: "100%",
    boxSizing: "border-box" as const,
    background: "#fff",
  },
  passwordWrap: {
    position: "relative",
  },
  passwordInput: {
    paddingRight: 44,
  },
  eyeBtn: {
    position: "absolute",
    right: 12,
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#718096",
    padding: 4,
    display: "flex",
    alignItems: "center",
  },
  error: {
    background: "#fdecea",
    color: "#d32f2f",
    padding: "12px 16px",
    borderRadius: 8,
    fontSize: 14,
    border: "1px solid #f5c6cb",
  },
  submitBtn: {
    padding: "14px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    marginTop: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
  },
  footer: {
    textAlign: "center",
    fontSize: 12,
    color: "#999",
    marginTop: 24,
  },
  expiredPanel: {
    marginTop: 24,
    background: "#FFFBEB",
    border: "1.5px solid #F6AD55",
    borderRadius: 12,
    padding: "20px 20px 24px",
  },
  expiredTitle: {
    fontSize: 14,
    color: "#744210",
    fontWeight: 500,
    marginBottom: 16,
    marginTop: 0,
    lineHeight: 1.5,
  },
};
