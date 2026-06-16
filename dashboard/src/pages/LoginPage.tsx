import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { login } from "../services/auth";
import { useAuthStore } from "../stores/authStore";
import axios from "axios";
import api, { tokenStorage, resetExpiredPassword } from "../services/api";
import { usePageTitle } from "../hooks/usePageTitle";

// ── UNDP logo SVG ─────────────────────────────────────────────────────────────

function UndpLogo() {
  return (
    <svg
      width={44}
      height={44}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="UNDP logo"
    >
      <rect width={64} height={64} rx={10} fill="#0468b1" />
      <text
        x={32}
        y={26}
        textAnchor="middle"
        fill="#ffffff"
        fontFamily="Inter, Arial, Helvetica, sans-serif"
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
        fontFamily="Inter, Arial, Helvetica, sans-serif"
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
        animation: "cr-spin 0.7s linear infinite",
        verticalAlign: "middle",
        marginRight: 8,
        flexShrink: 0,
      }}
    />
  );
}

// ── Eye icon SVGs ─────────────────────────────────────────────────────────────

function EyeOff() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function EyeOn() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
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
  if (score <= 1) return { level: score, label: "Weak", color: "#ba1a1a" };
  if (score <= 3) return { level: score, label: "Fair", color: "#e07b00" };
  if (score === 4) return { level: score, label: "Good", color: "#2e7d32" };
  return { level: score, label: "Strong", color: "#1b5e20" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LoginPage() {
  usePageTitle("Sign In");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setUser } = useAuthStore();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reason = searchParams.get("reason");
  const [sessionMsg, setSessionMsg] = useState(
    reason === "session_expired" ? "Your session has expired. Please log in again." : ""
  );

  const [passwordExpired, setPasswordExpired] = useState(false);
  const [resetCurrentPwd, setResetCurrentPwd] = useState("");
  const [resetNewPwd, setResetNewPwd] = useState("");
  const [resetConfirmPwd, setResetConfirmPwd] = useState("");
  const [showResetNewPwd, setShowResetNewPwd] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");

  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

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
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .login-input {
          width: 100%;
          background: #f2f4f7;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 12px 16px;
          font-size: 14px;
          font-family: 'Inter', sans-serif;
          color: #191c1e;
          outline: none;
          transition: border-color 0.2s, background 0.2s;
          box-sizing: border-box;
        }
        .login-input::placeholder { color: rgba(113,119,130,0.6); }
        .login-input:focus { border-bottom-color: var(--c-primary); background: #eceef1; }
        .login-input-wrap { position: relative; }
        .login-input-bar {
          position: absolute;
          bottom: 0; left: 0;
          height: 2px;
          width: 0;
          background: var(--c-primary);
          transition: width 0.25s ease;
        }
        .login-input-wrap:focus-within .login-input-bar { width: 100%; }
        .login-submit-btn {
          width: 100%;
          background: linear-gradient(135deg, var(--c-primary) 0%, var(--c-primary-container) 100%);
          color: #fff;
          border: none;
          border-radius: 4px;
          padding: 14px;
          font-size: 15px;
          font-weight: 700;
          font-family: 'Inter', sans-serif;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: opacity 0.15s, transform 0.1s;
          letter-spacing: 0.01em;
        }
        .login-submit-btn:hover:not(:disabled) { opacity: 0.93; }
        .login-submit-btn:active:not(:disabled) { transform: scale(0.98); }
        .login-submit-btn:disabled { opacity: 0.8; cursor: not-allowed; }
        .login-eye-btn {
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          cursor: pointer;
          color: #717782;
          padding: 4px;
          display: flex;
          align-items: center;
          transition: color 0.15s;
        }
        .login-eye-btn:hover { color: var(--c-primary); }
        .expired-panel {
          margin-top: 24px;
          background: #fffbeb;
          border-radius: 8px;
          padding: 20px;
          border-left: 4px solid #e07b00;
          animation: fadeIn 0.2s ease;
        }
        .strength-bar-bg {
          height: 3px;
          border-radius: 2px;
          background: #e6e8eb;
          margin-top: 8px;
        }
        .strength-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.2s, background 0.2s;
        }
      `}</style>

      <main style={s.page}>
        {/* ── Left branding panel ── */}
        <section style={s.leftPanel}>
          {/* Subtle diagonal texture overlay */}
          <div style={s.leftOverlay} />

          <div style={s.leftTop}>
            <div style={s.logoCircle}>
              <UndpLogo />
            </div>
          </div>

          <div style={s.leftMid}>
            <h1 style={s.brandTitle}>Crisis Reporter</h1>
            <p style={s.brandSubtitle}>UNDP Crisis Damage Reporting Dashboard</p>
            <div style={s.brandDivider} />
            <p style={s.brandDesc}>
              A secure platform for UNDP staff and response teams to monitor, review,
              and act on community damage reports in real time.
            </p>
          </div>

          <div style={s.leftBottom}>
            <p style={s.brandDisclaimer}>FOR AUTHORISED UNDP PERSONNEL ONLY</p>
          </div>
        </section>

        {/* ── Right auth panel ── */}
        <section style={s.rightPanel}>
          {/* Faint hub icon watermark */}
          <div style={s.watermark}>
            <svg width={192} height={192} viewBox="0 0 24 24" fill="none" stroke="#00508a" strokeWidth={0.5} opacity={0.08}>
              <circle cx="12" cy="12" r="3" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
              <line x1="4.22" y1="4.22" x2="7.05" y2="7.05" />
              <line x1="16.95" y1="16.95" x2="19.78" y2="19.78" />
              <line x1="4.22" y1="19.78" x2="7.05" y2="16.95" />
              <line x1="16.95" y1="7.05" x2="19.78" y2="4.22" />
            </svg>
          </div>

          {/* Login card */}
          <div style={s.card}>
            <header style={s.cardHeader}>
              <h2 style={s.cardTitle}>Sign In to Dashboard</h2>
              <p style={s.cardSubtitle}>Enter your credentials to access the intelligence node.</p>
            </header>

            <div style={s.cardDivider} />

            {/* Session-expiry banner */}
            {sessionMsg && (
              <div style={s.sessionBanner} role="alert">
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {sessionMsg}
              </div>
            )}

            {/* Main login form */}
            <form onSubmit={handleLogin} style={s.form} noValidate>
              {/* Email */}
              <div style={s.field}>
                <label style={s.label} htmlFor="login-email">Email Address</label>
                <div className="login-input-wrap">
                  <input
                    className="login-input"
                    id="login-email"
                    type="email"
                    value={email}
                    onFocus={() => setEmailFocused(true)}
                    onBlur={() => setEmailFocused(false)}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError("");
                      setPasswordExpired(false);
                      clearSessionMsg();
                    }}
                    placeholder="your.name@undp.org"
                    required
                    autoFocus
                    autoComplete="email"
                    disabled={loading}
                    style={emailFocused ? { borderBottomColor: "var(--c-primary)", background: "#eceef1" } : {}}
                  />
                </div>
              </div>

              {/* Password */}
              <div style={s.field}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label style={s.label} htmlFor="login-password">Password</label>
                </div>
                <div className="login-input-wrap" style={{ position: "relative" }}>
                  <input
                    className="login-input"
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
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
                    style={{ paddingRight: 44, ...(passwordFocused ? { borderBottomColor: "var(--c-primary)", background: "#eceef1" } : {}) }}
                  />
                  <button
                    type="button"
                    className="login-eye-btn"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    tabIndex={-1}
                    disabled={loading}
                  >
                    {showPassword ? <EyeOff /> : <EyeOn />}
                  </button>
                </div>
              </div>

              {error && (
                <div style={s.errorBox} role="alert">
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="login-submit-btn"
                disabled={loading}
              >
                {loading && <Spinner />}
                {loading ? "Signing in…" : "Sign In"}
                {!loading && (
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                )}
              </button>
            </form>

            {/* Password-expired inline reset panel */}
            {passwordExpired && (
              <div className="expired-panel">
                <p style={s.expiredTitle}>
                  Your password has expired and must be changed before you can sign in.
                </p>
                <form onSubmit={handleResetExpiredPassword} style={{ display: "flex", flexDirection: "column", gap: 16 }} noValidate>
                  <div style={s.field}>
                    <label style={s.label}>Current Password</label>
                    <div className="login-input-wrap">
                      <input
                        className="login-input"
                        type="password"
                        value={resetCurrentPwd}
                        onChange={(e) => { setResetCurrentPwd(e.target.value); setResetError(""); }}
                        placeholder="Current password"
                        required
                        autoComplete="current-password"
                        disabled={resetLoading}
                      />
                    </div>
                  </div>

                  <div style={s.field}>
                    <label style={s.label}>New Password</label>
                    <div className="login-input-wrap" style={{ position: "relative" }}>
                      <input
                        className="login-input"
                        type={showResetNewPwd ? "text" : "password"}
                        value={resetNewPwd}
                        onChange={(e) => { setResetNewPwd(e.target.value); setResetError(""); }}
                        placeholder="New password"
                        required
                        autoComplete="new-password"
                        disabled={resetLoading}
                        style={{ paddingRight: 44 }}
                      />
                      <button
                        type="button"
                        className="login-eye-btn"
                        onClick={() => setShowResetNewPwd((v) => !v)}
                        aria-label={showResetNewPwd ? "Hide password" : "Show password"}
                        tabIndex={-1}
                      >
                        {showResetNewPwd ? <EyeOff /> : <EyeOn />}
                      </button>
                    </div>
                    {resetNewPwd && (() => {
                      const str = passwordStrength(resetNewPwd);
                      return (
                        <div>
                          <div className="strength-bar-bg">
                            <div
                              className="strength-bar-fill"
                              style={{ width: `${(str.level / 5) * 100}%`, background: str.color }}
                            />
                          </div>
                          <span style={{ fontSize: 11, color: str.color, fontWeight: 600, marginTop: 3, display: "block" }}>{str.label}</span>
                        </div>
                      );
                    })()}
                  </div>

                  <div style={s.field}>
                    <label style={s.label}>Confirm New Password</label>
                    <div className="login-input-wrap">
                      <input
                        className="login-input"
                        type="password"
                        value={resetConfirmPwd}
                        onChange={(e) => { setResetConfirmPwd(e.target.value); setResetError(""); }}
                        placeholder="Confirm new password"
                        required
                        autoComplete="new-password"
                        disabled={resetLoading}
                      />
                    </div>
                  </div>

                  {resetError && (
                    <div style={s.errorBox} role="alert">
                      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      {resetError}
                    </div>
                  )}

                  <button
                    type="submit"
                    className="login-submit-btn"
                    disabled={resetLoading}
                  >
                    {resetLoading && <Spinner />}
                    {resetLoading ? "Updating…" : "Change Password & Sign In"}
                  </button>
                </form>
              </div>
            )}

            {/* Footer */}
            <footer style={s.cardFooter}>
              <p style={s.footerNote}>
                All session activity is monitored and logged in compliance with UNDP global security protocols.
              </p>
              <div style={s.encryptedBadge}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="#00508a" stroke="none">
                  <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
                </svg>
                <span style={s.encryptedText}>256-BIT ENCRYPTED CONNECTION</span>
              </div>
            </footer>
          </div>

          {/* Bottom footer links */}
          <div style={s.pageFooter}>
            <a style={s.footerLink} href="#">Privacy Policy</a>
            <a style={s.footerLink} href="#">Terms of Service</a>
            <a style={s.footerLink} href="#">Support Portal</a>
          </div>
        </section>
      </main>
    </>
  );
}

// ── Style tokens ──────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    height: "100vh",
    width: "100%",
    overflow: "hidden",
    fontFamily: "'Inter', sans-serif",
  },

  // Left panel
  leftPanel: {
    width: "45%",
    background: "#081b39",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "48px 40px",
    position: "relative",
    overflow: "hidden",
    textAlign: "center",
  },
  leftOverlay: {
    position: "absolute",
    inset: 0,
    background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 40px)",
    pointerEvents: "none",
  },
  leftTop: {
    zIndex: 1,
    marginTop: 16,
  },
  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    background: "#ffffff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
    margin: "0 auto",
  },
  leftMid: {
    zIndex: 1,
    maxWidth: 360,
  },
  brandTitle: {
    fontSize: 40,
    fontWeight: 900,
    color: "#ffffff",
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
    margin: "0 0 8px",
  },
  brandSubtitle: {
    fontSize: 15,
    fontWeight: 500,
    color: "rgba(255,255,255,0.75)",
    letterSpacing: "0.02em",
    margin: "0 0 28px",
  },
  brandDivider: {
    width: 48,
    height: 1,
    background: "rgba(255,255,255,0.18)",
    margin: "0 auto 28px",
  },
  brandDesc: {
    fontSize: 15,
    color: "rgba(182,198,238,0.9)",
    lineHeight: 1.7,
    fontWeight: 300,
  },
  leftBottom: {
    zIndex: 1,
    marginBottom: 8,
  },
  brandDisclaimer: {
    fontSize: 10,
    fontWeight: 700,
    color: "rgba(255,255,255,0.35)",
    letterSpacing: "0.2em",
  },

  // Right panel
  rightPanel: {
    flex: 1,
    background: "#f2f4f7",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px",
    position: "relative",
    overflow: "auto",
  },
  watermark: {
    position: "absolute",
    top: 40,
    right: 40,
    pointerEvents: "none",
    userSelect: "none",
  },

  // Card
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#ffffff",
    borderRadius: 8,
    padding: "40px",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04), 0 12px 40px rgba(8,27,57,0.08)",
    outline: "1px solid rgba(193,199,210,0.15)",
    animation: "fadeIn 0.25s ease",
  },
  cardHeader: {
    marginBottom: 24,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--c-primary)",
    margin: "0 0 6px",
    letterSpacing: "-0.01em",
  },
  cardSubtitle: {
    fontSize: 13,
    color: "#414751",
    margin: 0,
  },
  cardDivider: {
    height: 1,
    background: "#e6e8eb",
    marginBottom: 28,
  },

  // Form
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 22,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: "#191c1e",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },

  // Alerts
  sessionBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "#fef3c7",
    color: "#78350f",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 20,
    borderLeft: "3px solid #f59e0b",
  },
  errorBox: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    background: "rgba(186,26,26,0.06)",
    color: "#ba1a1a",
    padding: "12px 14px",
    borderRadius: 4,
    fontSize: 13,
    lineHeight: 1.5,
  },

  // Card footer
  cardFooter: {
    marginTop: 28,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: "center",
  },
  footerNote: {
    fontSize: 11,
    color: "rgba(65,71,81,0.6)",
    textAlign: "center",
    lineHeight: 1.6,
    fontStyle: "italic",
    margin: 0,
  },
  encryptedBadge: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 18px",
    background: "#f2f4f7",
    borderRadius: 999,
  },
  encryptedText: {
    fontSize: 10,
    fontWeight: 700,
    color: "#4e5e80",
    letterSpacing: "0.12em",
  },

  // Password expired
  expiredTitle: {
    fontSize: 13,
    color: "#78350f",
    fontWeight: 500,
    marginBottom: 16,
    marginTop: 0,
    lineHeight: 1.6,
  },

  // Page footer
  pageFooter: {
    position: "absolute",
    bottom: 28,
    display: "flex",
    gap: 28,
  },
  footerLink: {
    fontSize: 11,
    fontWeight: 500,
    color: "#717782",
    textDecoration: "none",
    transition: "color 0.15s",
  },
};
