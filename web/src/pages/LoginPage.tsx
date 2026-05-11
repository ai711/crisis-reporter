import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { tokenStorage } from "../services/api";

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
      stroke="#fff"
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
  const { setReporter } = useAuthStore();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
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
          ?.detail ?? "Invalid email or password.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.page}>
      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate("/")} aria-label="Back">
          <IconBack />
        </button>
        <span style={s.headerTitle}>Sign In</span>
        <div style={{ width: 34 }} />
      </header>

      <main style={s.main}>
        <form style={s.form} onSubmit={handleSubmit} noValidate>
          <div style={s.fieldGroup}>
            <label style={s.label} htmlFor="login-email">Email</label>
            <input
              id="login-email"
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
            <label style={s.label} htmlFor="login-password">Password</label>
            <div style={s.passwordWrap}>
              <input
                id="login-password"
                style={{ ...s.input, paddingRight: 48 }}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
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

          {error && <p style={s.errorMsg}>{error}</p>}

          <button
            type="submit"
            style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }}
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p style={s.signupPrompt}>
          Don't have an account?{" "}
          <button style={s.signupLink} onClick={() => navigate("/profile")}>
            Set up your profile →
          </button>
        </p>
      </main>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#F7FAFC",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    width: "100%",
    margin: "0 auto",
  },
  header: {
    background: "#0468B1",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
  },
  main: {
    flex: 1,
    padding: "32px 24px 40px",
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
  },
};
