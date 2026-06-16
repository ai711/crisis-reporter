import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { tokenStorage } from "../services/api";
import { registerReporter } from "../services/auth";

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  reporter_id: string;
  is_verified: boolean;
}

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

function IconEye({ open }: { open: boolean }) {
  return open ? (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { setReporter } = useAuthStore();

  const isRegisterMode = new URLSearchParams(location.search).get("mode") === "register";
  const [mode, setMode] = useState<"login" | "register">(isRegisterMode ? "register" : "login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError(t('login.validation'));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api.post<LoginResponse>("/api/reporters/login", {
        email: email.trim(),
        password,
      });
      const { access_token, refresh_token, reporter_id, is_verified } = res.data;
      tokenStorage.setTokens(access_token, refresh_token, reporter_id);
      setReporter(reporter_id, is_verified);
      navigate("/");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? t('login.invalid_credentials');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError(t('login.validation'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('register.password_mismatch') || "Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError(t('register.password_too_short') || "Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const countryCode = localStorage.getItem("cr_country") ?? "US";
      const languageCode = localStorage.getItem("cr_language") ?? "en";
      const tokens = await registerReporter(email.trim(), password, countryCode, languageCode);
      setReporter(String(tokens.reporter_id), tokens.is_verified);
      navigate("/");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? (t('register.error') || "Registration failed. Please try again.");
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError("");
    setPassword("");
    setConfirmPassword("");
  };

  const isLogin = mode === "login";

  return (
    <div style={s.page}>
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
          <IconBack />
        </button>
        <span style={s.headerTitle}>{isLogin ? t('login.title') : (t('register.title') || "Create Account")}</span>
        <div style={{ minWidth: 44, flexShrink: 0 }} />
      </header>

      {/* Mode switcher */}
      <div style={s.modeSwitcher}>
        <button
          style={{ ...s.modeBtn, ...(isLogin ? s.modeBtnActive : {}) }}
          onClick={() => switchMode("login")}
        >
          {t('login.title')}
        </button>
        <button
          style={{ ...s.modeBtn, ...(!isLogin ? s.modeBtnActive : {}) }}
          onClick={() => switchMode("register")}
        >
          {t('register.title') || "Create Account"}
        </button>
      </div>

      <main style={s.main}>
        <form style={s.form} onSubmit={isLogin ? handleLogin : handleRegister} noValidate>
          <div style={s.fieldGroup}>
            <label style={s.label} htmlFor="auth-email">{t('login.email_label')}</label>
            <input
              id="auth-email"
              style={s.input}
              type="email"
              autoComplete="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label} htmlFor="auth-password">{t('login.password_label')}</label>
            <div style={s.passwordWrap}>
              <input
                id="auth-password"
                style={{ ...s.input, paddingRight: 48 }}
                type={showPassword ? "text" : "password"}
                autoComplete={isLogin ? "current-password" : "new-password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                style={s.eyeBtn}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                <IconEye open={showPassword} />
              </button>
            </div>
          </div>

          {!isLogin && (
            <div style={s.fieldGroup}>
              <label style={s.label} htmlFor="auth-confirm">{t('register.confirm_password') || "Confirm Password"}</label>
              <div style={s.passwordWrap}>
                <input
                  id="auth-confirm"
                  style={{ ...s.input, paddingRight: 48 }}
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={loading}
                />
                <button
                  type="button"
                  style={s.eyeBtn}
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  <IconEye open={showConfirm} />
                </button>
              </div>
            </div>
          )}

          {!isLogin && (
            <p style={s.hint}>
              {t('register.hint') || "No email verification required. You can log in immediately after creating your account."}
            </p>
          )}

          {error && <p style={s.errorMsg}>{error}</p>}

          <button
            type="submit"
            style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }}
            disabled={loading}
          >
            {loading
              ? (isLogin ? t('login.signing_in') : (t('register.creating') || "Creating account…"))
              : (isLogin ? t('login.submit_btn') : (t('register.submit_btn') || "Create Account"))}
          </button>
        </form>

        {isLogin && (
          <p style={s.signupPrompt}>
            {t('login.no_account')}{" "}
            <button style={s.signupLink} onClick={() => switchMode("register")}>
              {t('register.title') || "Create Account"}
            </button>
          </p>
        )}

        {!isLogin && (
          <p style={s.signupPrompt}>
            {t('register.already_have_account') || "Already have an account?"}{" "}
            <button style={s.signupLink} onClick={() => switchMode("login")}>
              {t('login.title')}
            </button>
          </p>
        )}
      </main>
    </div>
  );
}

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
  modeSwitcher: {
    display: "flex",
    margin: "16px 24px 0",
    background: "#E4E2E1",
    borderRadius: 10,
    padding: 4,
    gap: 4,
    flexShrink: 0,
  },
  modeBtn: {
    flex: 1,
    padding: "10px 12px",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    background: "transparent",
    color: "#717782",
    transition: "all 0.15s",
    fontFamily: "inherit",
  },
  modeBtnActive: {
    background: "#fff",
    color: "#0468B1",
    boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
  },
  main: {
    flex: 1,
    padding: "24px 24px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#4A5568",
    letterSpacing: "0.02em",
  },
  input: {
    width: "100%",
    padding: "13px 16px",
    borderRadius: 10,
    border: "1.5px solid #E2E8F0",
    fontSize: 15,
    outline: "none",
    background: "#fff",
    boxSizing: "border-box" as const,
    color: "#1A2B4A",
    fontFamily: "inherit",
  },
  passwordWrap: {
    position: "relative",
  },
  eyeBtn: {
    position: "absolute",
    right: 12,
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
  },
  hint: {
    fontSize: 13,
    color: "#718096",
    margin: 0,
    lineHeight: 1.5,
  },
  errorMsg: {
    fontSize: 14,
    color: "#E53E3E",
    margin: 0,
    padding: "10px 14px",
    background: "#FFF5F5",
    border: "1px solid #FEB2B2",
    borderRadius: 8,
  },
  submitBtn: {
    width: "100%",
    padding: "16px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 4,
    fontFamily: "inherit",
  },
  signupPrompt: {
    fontSize: 14,
    color: "#718096",
    textAlign: "center",
    marginTop: 28,
  },
  signupLink: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    fontFamily: "inherit",
  },
};
