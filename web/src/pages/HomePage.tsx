import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { WEB_SESSION_ID } from "../utils/sessionId";
import { detectPlatform } from "../services/auth";
import api, { tokenStorage } from "../services/api";
import CrisisTypeModal from "../components/CrisisTypeModal";
import { loadLanguagePackageFromCache } from "../i18n";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setReporter } = useAuthStore();

  const [crisisModalOpen, setCrisisModalOpen] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [loginPromptBusy, setLoginPromptBusy] = useState(false);

  // B19: Welcome card — shown only if not previously dismissed
  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    try { return localStorage.getItem("cr_welcome_dismissed") !== "true"; } catch { return true; }
  });

  // B21: Dismiss welcome card and write flag to localStorage
  const dismissWelcome = () => {
    setWelcomeVisible(false);
    try { localStorage.setItem("cr_welcome_dismissed", "true"); } catch { /* ignore */ }
  };

  // Apply cached language on mount so returning users see the correct language immediately
  useEffect(() => {
    const applyLanguage = async () => {
      const savedLang = localStorage.getItem("cr_language");
      if (savedLang && savedLang !== "en") {
        await loadLanguagePackageFromCache(savedLang);
      }
    };
    applyLanguage();
  }, []);

  // C: Question package version check — once per browser session, completely silent
  useEffect(() => {
    const sessionKey = "cr_qp_version_checked";
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "true"); // Lock immediately to prevent duplicate checks

    const runVersionCheck = async () => {
      try {
        const cached = localStorage.getItem("cr_question_package");
        const cachedVersion = cached
          ? (JSON.parse(cached) as { version?: string }).version ?? null
          : null;
        const langCode = localStorage.getItem("cr_language") || "en";

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(
          `${API_URL}/api/question-packages/active?lang=${langCode}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!res.ok) return;
        const data: unknown = await res.json();
        if (typeof data !== "object" || data === null) return;

        const pkg = data as { version?: string };
        if (pkg.version === cachedVersion) return; // Already up to date

        // Newer version available — write silently, no UI change
        try { localStorage.setItem("cr_question_package", JSON.stringify(data)); } catch { /* storage full — ignore */ }
      } catch {
        // Network error or abort — silent fail, cached package used by the report flow
      }
    };

    runVersionCheck();
  }, []);

  // Post-onboarding destination redirect
  useEffect(() => {
    try {
      const hasId = localStorage.getItem("cr_reporter_id");
      if (!hasId) return;
      const next = sessionStorage.getItem("cr_post_onboarding_next");
      if (next) {
        sessionStorage.removeItem("cr_post_onboarding_next");
        navigate(next, { replace: true });
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Login prompt — shown 2 s after first load if no Reporter ID exists
  useEffect(() => {
    try {
      const alreadyPrompted = localStorage.getItem("cr_login_prompted");
      const hasReporterId = localStorage.getItem("cr_reporter_id");
      if (alreadyPrompted || hasReporterId) return;
      const timer = setTimeout(() => {
        localStorage.setItem("cr_login_prompted", "true");
        setLoginPromptOpen(true);
      }, 2000);
      return () => clearTimeout(timer);
    } catch { /* ignore */ }
  }, []);

  // B19: Also dismiss welcome when reporter taps Report an Incident
  const handleReportClick = () => {
    dismissWelcome();
    navigate("/report");
  };

  // Anonymous reporter registration ("Skip for now" path)
  const registerAnonymous = async () => {
    setLoginPromptBusy(true);
    setLoginPromptOpen(false);

    let assignedId: string | null = null;

    try {
      const res = await api.post<{ reporter_id: string; access_token?: string; refresh_token?: string }>(
        "/api/reporters/register",
        {
          device_id: WEB_SESSION_ID,
          platform: detectPlatform(),
          country_code: (() => { try { return localStorage.getItem("cr_country"); } catch { return null; } })(),
          language_code: (() => { try { return localStorage.getItem("cr_language") || "en"; } catch { return "en"; } })(),
          tc_accepted_at: new Date().toISOString(),
        }
      );
      assignedId = res.data.reporter_id;
      if (res.data.access_token) {
        tokenStorage.setTokens(res.data.access_token, res.data.refresh_token ?? "", res.data.reporter_id);
      }
      if (res.data.reporter_id) {
        setReporter(res.data.reporter_id, false);
        localStorage.setItem("cr_reporter_id", res.data.reporter_id);
      }
    } catch {
      assignedId = `local_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    }

    try { localStorage.setItem("cr_reporter_id", assignedId); } catch { /* ignore */ }
    setReporter(assignedId, false);
    setLoginPromptBusy(false);

    try {
      const next = sessionStorage.getItem("cr_post_onboarding_next");
      if (next) {
        sessionStorage.removeItem("cr_post_onboarding_next");
        navigate(next, { replace: true });
      }
    } catch { /* ignore */ }
  };

  const { data: reportsData, isLoading: reportsLoading, isError: reportsError } = useQuery({
    queryKey: ['my-reports-home'],
    queryFn: async () => {
      const res = await api.get('/api/reports/my', { params: { limit: 3 } });
      if (!res.data) return { reports: [], total: 0 };
      return { reports: res.data.reports || res.data.items || res.data || [], total: 0 };
    },
    enabled: !!tokenStorage.getAccessToken(),
    staleTime: 60000,
    retry: false,
    throwOnError: false,
  });

  return (
    <div style={s.page}>
      {/* B16: Crisis type modal — fully bundled, no network call */}
      {crisisModalOpen && <CrisisTypeModal onClose={() => setCrisisModalOpen(false)} />}

      {/* ── Main content ── */}
      <main style={s.main}>
        {/* B19–21: Dismissible welcome card — first-visit only */}
        {welcomeVisible && (
          <div style={s.welcomeCard}>
            <p style={s.welcomeText}>
              {t('home.welcomeText')}
            </p>
            <button style={s.welcomeGotItBtn} onClick={dismissWelcome}>
              {t('home.welcomeGotIt')}
            </button>
          </div>
        )}

        {/* B14: Primary action — full-width, dominant */}
        <button style={s.reportBtn} onClick={handleReportClick}>
          {t('home.reportButton')}
        </button>

        {/* B15: "What can I report?" link — directly below the button */}
        <button style={s.whatLink} onClick={() => setCrisisModalOpen(true)}>
          {t('home.whatCanReport')}
        </button>

        {reportsLoading ? (
          <div style={{padding: '16px 20px', textAlign: 'center',
            fontSize: 14, color: '#717782'}}>
            {t('home.loadingReports')}
          </div>
        ) : reportsError ? (
          <div style={{padding: '20px 16px'}}>
            <div style={{background: 'white', borderRadius: 16, padding: '20px',
              textAlign: 'center'}}>
              <div style={{fontSize: 32, marginBottom: 8}}>📋</div>
              <div style={{fontSize: 15, fontWeight: 600, color: '#1B1C1C',
                marginBottom: 4}}>{t('home.noReportsTitle')}</div>
              <div style={{fontSize: 13, color: '#717782'}}>
                {t('home.noReportsBody')}
              </div>
            </div>
          </div>
        ) : reportsData?.reports?.length === 0 ? (
          <div style={{padding: '20px 16px'}}>
            <div style={{background: 'white', borderRadius: 16, padding: '20px',
              textAlign: 'center'}}>
              <div style={{fontSize: 32, marginBottom: 8}}>📋</div>
              <div style={{fontSize: 15, fontWeight: 600, color: '#1B1C1C',
                marginBottom: 4}}>{t('home.noReportsTitle')}</div>
              <div style={{fontSize: 13, color: '#717782'}}>
                {t('home.firstReportHint')}
              </div>
            </div>
          </div>
        ) : (
          <div style={{padding: '0 16px'}}>
            <div style={{fontSize: 11, fontWeight: 700, color: '#717782',
              textTransform: 'uppercase', letterSpacing: '1.2px',
              marginBottom: 8, marginTop: 16}}>
              {t('home.recentReports')}
            </div>
            {reportsData?.reports?.slice(0, 3).map((report: any) => (
              <div key={report.id} style={{background: 'white', borderRadius: 16,
                padding: '14px 16px', marginBottom: 10,
                display: 'flex', alignItems: 'center', gap: 12}}>
                <div style={{width: 8, height: 8, borderRadius: 4, flexShrink: 0,
                  background: report.flag_status === 'green' ? '#38A169'
                    : report.flag_status === 'red' ? '#E53E3E'
                    : report.flag_status === 'orange' ? '#F2994A'
                    : '#9CA3AF'}} />
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontSize: 13, fontWeight: 600, color: '#1B1C1C',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    {report.building_name || report.infrastructure_name || 'Unnamed location'}
                  </div>
                  <div style={{fontSize: 11, color: '#717782', marginTop: 2}}>
                    {report.damage_level} · {new Date(report.submitted_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ── Login prompt bottom sheet ── */}
      {loginPromptOpen && (
        <div style={s.promptOverlay} onClick={() => setLoginPromptOpen(false)}>
          <div style={s.promptSheet} onClick={(e) => e.stopPropagation()}>
            <div style={s.promptHandle} />
            <h2 style={s.promptTitle}>{t('loginPrompt.title')}</h2>
            <p style={s.promptBody}>{t('loginPrompt.body')}</p>
            <div style={s.promptButtons}>
              <button
                style={s.promptBtnPrimary}
                onClick={() => { setLoginPromptOpen(false); navigate("/login"); }}
              >
                {t('settings.login')}
              </button>
              <button
                style={s.promptBtnOutline}
                onClick={() => { setLoginPromptOpen(false); navigate("/profile"); }}
              >
                {t('settings.register')}
              </button>
              <button
                style={s.promptBtnSkip}
                disabled={loginPromptBusy}
                onClick={registerAnonymous}
              >
                {loginPromptBusy ? t('loginPrompt.settingUp') : t('loginPrompt.skip')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    flex: 1,
    background: "var(--color-background)",
    display: "flex",
    flexDirection: "column",
  },
  main: {
    flex: 1,
    padding: "20px 20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  // B19: Welcome card
  welcomeCard: {
    background: "#F0F4FF",
    border: "1px solid #D0E4FF",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  welcomeText: {
    fontSize: "0.875rem",
    color: "#1A2B4A",
    lineHeight: 1.6,
    margin: 0,
  },
  welcomeGotItBtn: {
    alignSelf: "flex-start",
    background: "transparent",
    border: "1px solid #0468B1",
    color: "#0468B1",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  reportBtn: {
    width: "100%",
    padding: "16px 20px",
    background: "var(--color-primary)",
    color: "#fff",
    border: "none",
    borderRadius: 9999,
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: 0.2,
    boxShadow: "0 4px 16px rgba(4,104,177,0.28)",
    fontFamily: "var(--font-family)",
    minHeight: 52,
  },
  // B15: "What can I report?" link
  whatLink: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    textDecoration: "underline",
    textAlign: "center",
    padding: "4px 0",
    marginTop: -8, // pull up closer to the button
  },
  reportsCard: {
    background: "var(--color-white)",
    border: "1px solid var(--color-border)",
    borderRadius: 16,
    padding: "16px",
  },
  reportsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  reportsText: { fontSize: 14, color: "#2D3748", margin: 0, lineHeight: 1.5 },
  reportsCount: { color: "#0468B1", fontWeight: 700 },
  viewAllBtn: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  promptOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.48)",
    zIndex: 1000,
    display: "flex",
    alignItems: "flex-end",
  },
  promptSheet: {
    background: "#fff",
    borderRadius: "16px 16px 0 0",
    width: "100%",
    maxWidth: 480,
    margin: "0 auto",
    padding: "0 20px 40px",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.12)",
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  promptHandle: {
    width: 36,
    height: 4,
    background: "#E2E8F0",
    borderRadius: 2,
    margin: "12px auto 20px",
    flexShrink: 0,
  },
  promptTitle: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", margin: "0 0 10px", lineHeight: 1.35 },
  promptBody: { fontSize: 14, color: "#4A5568", lineHeight: 1.6, margin: "0 0 24px" },
  promptButtons: { display: "flex", flexDirection: "column", gap: 10 },
  promptBtnPrimary: {
    width: "100%",
    padding: "15px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
  promptBtnOutline: {
    width: "100%",
    padding: "14px",
    background: "#fff",
    color: "#0468B1",
    border: "2px solid #0468B1",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  promptBtnSkip: {
    width: "100%",
    padding: "12px",
    background: "transparent",
    color: "#9CA3AF",
    border: "none",
    borderRadius: 10,
    fontSize: 15,
    cursor: "pointer",
  },
};
