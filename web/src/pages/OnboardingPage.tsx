import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { loadLanguagePackage } from "../i18n";
import { getPreFetchedCountries } from "../utils/countryListCache";
import type { CachedCountry } from "../utils/countryListCache";
import api from "../services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Language {
  code: string;
  name: string;
  highlighted?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const UN_LANGUAGES: Language[] = [
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

const UN_LANGUAGE_CODES = new Set(UN_LANGUAGES.map((l) => l.code));

type Step = "country" | "language" | "terms";

function getInitialStep(): Step {
  try {
    if (!localStorage.getItem("cr_country")) return "country";
    if (!localStorage.getItem("cr_language")) return "language";
    if (!localStorage.getItem("cr_tc_accepted")) return "terms";
  } catch { /* ignore */ }
  return "country";
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const rawNext = searchParams.get("next");
  const nextPath = rawNext ? decodeURIComponent(rawNext) : "/";
  const stepParam = searchParams.get("step") as Step | null;

  const { setCountry, setLanguage, setOnboarded } = useAuthStore();

  const [step, setStep] = useState<Step>(() => {
    if (stepParam && (["country", "language", "terms"] as Step[]).includes(stepParam)) {
      return stepParam;
    }
    return getInitialStep();
  });

  // Country step
  const [countries, setCountries] = useState<CachedCountry[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [countriesError, setCountriesError] = useState<"network" | "nocache" | null>(null);
  const [fromCachedCountries, setFromCachedCountries] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<CachedCountry | null>(null);

  // Language step
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [officialLang, setOfficialLang] = useState<Language | null>(null);
  const [langFetchDone, setLangFetchDone] = useState(false);
  const [langPackageLoading, setLangPackageLoading] = useState(false);
  const [langPackageError, setLangPackageError] = useState(false);
  const [langFromCache, setLangFromCache] = useState(false);

  // Terms step
  const [showDeclineMsg, setShowDeclineMsg] = useState(false);

  // Consume the pre-fetched country list (started in main.tsx before React mounted).
  useEffect(() => {
    getPreFetchedCountries().then((result) => {
      if (result.data && result.data.length > 0) {
        setCountries(result.data);
        setFromCachedCountries(result.fromCache);
        setCountriesError(null);
      } else {
        setCountriesError("nocache");
      }
      setCountriesLoading(false);
    });
  }, []);

  // Fetch the country's official language when the language step becomes active.
  useEffect(() => {
    if (step !== "language" || !selectedCountry || langFetchDone) return;
    api
      .get<{ official_language?: string; official_language_name?: string }>(
        `/api/countries/${selectedCountry.code}`
      )
      .then((res) => {
        const { official_language, official_language_name } = res.data;
        if (official_language && !UN_LANGUAGE_CODES.has(official_language)) {
          setOfficialLang({
            code: official_language,
            name: official_language_name ?? official_language.toUpperCase(),
            highlighted: true,
          });
        }
      })
      .catch(() => { /* Official language is supplementary — silently ignore */ })
      .finally(() => setLangFetchDone(true));
  }, [step, selectedCountry, langFetchDone]);

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const stepNumber = step === "country" ? 1 : step === "language" ? 2 : 3;

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleCountryNext = () => {
    if (!selectedCountry?.is_active) return;
    try { localStorage.setItem("cr_country", selectedCountry.code); } catch { /* ignore */ }
    setCountry(selectedCountry.code);
    setStep("language");
  };

  const handleBackToCountry = () => {
    setOfficialLang(null);
    setLangFetchDone(false);
    setSelectedLanguage("");
    setLangPackageError(false);
    setLangFromCache(false);
    setStep("country");
  };

  const handleLanguageNext = async () => {
    if (!selectedLanguage || langPackageLoading) return;
    setLangPackageLoading(true);
    setLangPackageError(false);
    setLangFromCache(false);

    const result = await loadLanguagePackage(selectedLanguage);

    setLangPackageLoading(false);

    if (!result.success) {
      setLangPackageError(true);
      return; // Stay on language step — reporter must retry.
    }

    try { localStorage.setItem("cr_language", selectedLanguage); } catch { /* ignore */ }
    setLanguage(selectedLanguage);

    if (result.fromCache) setLangFromCache(true);

    setStep("terms");
  };

  // D5: handleAgree is now synchronous — Reporter ID assignment deferred to HomePage.
  const handleAgree = () => {
    // Clear decline flag if the reporter declined earlier in this session.
    try { sessionStorage.removeItem("cr_tc_declined"); } catch { /* ignore */ }

    try {
      localStorage.setItem("cr_tc_accepted", new Date().toISOString());
      // D6: Record the T&C version alongside the acceptance timestamp.
      localStorage.setItem("cr_tc_version", i18n.t("tc_version"));
    } catch { /* ignore */ }

    setOnboarded();

    // Store intended destination so HomePage can navigate there after Reporter ID is assigned.
    if (nextPath !== "/") {
      try { sessionStorage.setItem("cr_post_onboarding_next", nextPath); } catch { /* ignore */ }
    }

    navigate("/", { replace: true });
  };

  // D4: Write decline flag to sessionStorage. On page refresh, main.tsx detects
  // this flag, clears country/language, and redirects to country selection.
  const handleDecline = () => {
    try { sessionStorage.setItem("cr_tc_declined", "true"); } catch { /* ignore */ }
    setShowDeclineMsg(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.logoIcon}>🆘</span>
        <span style={s.logoText}>Crisis Reporter</span>
      </div>

      {/* Progress indicator */}
      <div style={s.progressRow}>
        <div style={s.progressTrack}>
          {([1, 2, 3] as const).map((n) => (
            <div key={n} style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  ...s.progressDot,
                  width: n === stepNumber ? 12 : 8,
                  height: n === stepNumber ? 12 : 8,
                  background: n <= stepNumber ? "#0468B1" : "#CBD5E0",
                }}
              />
              {n < 3 && (
                <div
                  style={{
                    ...s.progressLine,
                    background: n < stepNumber ? "#0468B1" : "#CBD5E0",
                  }}
                />
              )}
            </div>
          ))}
        </div>
        <span style={s.progressLabel}>Step {stepNumber} of 3</span>
      </div>

      {/* Step content */}
      <div style={s.content}>
        {step === "country" && (
          <CountryStep
            countries={filteredCountries}
            loading={countriesLoading}
            error={countriesError}
            fromCache={fromCachedCountries}
            search={search}
            onSearch={setSearch}
            selected={selectedCountry}
            onSelect={setSelectedCountry}
            onNext={handleCountryNext}
          />
        )}
        {step === "language" && (
          <LanguageStep
            selected={selectedLanguage}
            onSelect={(code) => {
              setSelectedLanguage(code);
              setLangPackageError(false);
              setLangFromCache(false);
            }}
            officialLang={officialLang}
            loading={langPackageLoading}
            hasError={langPackageError}
            fromCache={langFromCache}
            onNext={handleLanguageNext}
            onBack={handleBackToCountry}
          />
        )}
        {step === "terms" && (
          <TermsStep
            tcText={t("tc_text")}
            onAgree={handleAgree}
            onDecline={handleDecline}
            showDeclineMsg={showDeclineMsg}
            onBack={() => setStep("language")}
          />
        )}
      </div>
    </div>
  );
}

// ── Country step ──────────────────────────────────────────────────────────────

function CountryStep({
  countries,
  loading,
  error,
  fromCache,
  search,
  onSearch,
  selected,
  onSelect,
  onNext,
}: {
  countries: CachedCountry[];
  loading: boolean;
  error: "network" | "nocache" | null;
  fromCache: boolean;
  search: string;
  onSearch: (v: string) => void;
  selected: CachedCountry | null;
  onSelect: (c: CachedCountry) => void;
  onNext: () => void;
}) {
  const canContinue = selected?.is_active === true;

  if (error === "nocache") {
    return (
      <>
        <h2 style={s.stepTitle}>Select your country</h2>
        <div style={s.blockingErrorBox}>
          <p style={{ margin: 0, fontWeight: 600 }}>No internet connection</p>
          <p style={{ margin: "6px 0 0" }}>
            An internet connection is required to use Crisis Reporter. Please
            check your connection and refresh the page.
          </p>
          <button style={s.retryBtn} onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h2 style={s.stepTitle}>Select your country</h2>
      <p style={s.stepSubtitle}>
        Choose the country where you are reporting from.
      </p>

      {/* K2: Pill-style search input */}
      <input
        style={s.searchInputPill}
        type="text"
        placeholder="Search countries..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        autoFocus
      />

      {fromCache && (
        <p style={s.cacheNote}>
          Showing saved country list. Some updates may not be reflected.
        </p>
      )}

      <div style={s.listScroll}>
        {loading && <p style={s.hint}>Loading countries...</p>}
        {!loading && error === "network" && (
          <p style={s.errorText}>Could not load countries. Showing saved list.</p>
        )}
        {!loading && !error && countries.length === 0 && (
          <p style={s.hint}>No countries match your search.</p>
        )}
        {countries.map((country) => (
          <button
            key={country.code}
            style={{
              ...s.listItem,
              background: selected?.code === country.code ? "#E8F4FD" : "#fff",
              borderColor:
                selected?.code === country.code ? "#0468B1" : "#E2E8F0",
            }}
            onClick={() => onSelect(country)}
          >
            <span>{country.name}</span>
            {selected?.code === country.code && (
              <span style={s.checkIcon}>✓</span>
            )}
          </button>
        ))}
      </div>

      {selected && !selected.is_active && (
        <div style={s.warningBox}>
          We are unable to provide any assistance for your region at this moment.
        </div>
      )}

      <button
        style={{
          ...s.primaryBtn,
          opacity: canContinue ? 1 : 0.45,
          cursor: canContinue ? "pointer" : "not-allowed",
        }}
        onClick={onNext}
        disabled={!canContinue}
      >
        Next
      </button>
    </>
  );
}

// ── Language step ─────────────────────────────────────────────────────────────

function LanguageStep({
  selected,
  onSelect,
  officialLang,
  loading,
  hasError,
  fromCache,
  onNext,
  onBack,
}: {
  selected: string;
  onSelect: (code: string) => void;
  officialLang: Language | null;
  loading: boolean;
  hasError: boolean;
  fromCache: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <h2 style={s.stepTitle}>Select your language</h2>
      <p style={s.stepSubtitle}>
        Choose the language you'd like to use in the app.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {officialLang && (
          <button
            style={{
              ...s.langItem,
              gridColumn: "span 2",
              background: selected === officialLang.code ? "#0468B1" : "#EBF4FF",
              color: selected === officialLang.code ? "#fff" : "#0468B1",
              borderColor: "#0468B1",
              borderWidth: 2,
            }}
            onClick={() => onSelect(officialLang.code)}
            disabled={loading}
          >
            <span style={s.officialBadge}>Official Language</span>
            <span>{officialLang.name}</span>
          </button>
        )}

        <div style={s.langGrid}>
          {UN_LANGUAGES.map((lang) => {
            const isSelected = selected === lang.code;
            return (
              <button
                key={lang.code}
                style={{
                  ...s.langItem,
                  background: isSelected ? "#0468B1" : "#fff",
                  color: isSelected ? "#fff" : "#1A2B4A",
                  borderColor: isSelected ? "#0468B1" : "#E2E8F0",
                }}
                onClick={() => onSelect(lang.code)}
                disabled={loading}
              >
                <span>{lang.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {fromCache && (
        <p style={s.cacheNote}>
          Using saved language data. Some text may not be fully updated.
        </p>
      )}

      {hasError && (
        <div style={s.errorBox}>
          Could not load the language package. Please check your connection and
          try again.
        </div>
      )}

      {/* C3/C4: Button is disabled with loading indicator while fetch runs. */}
      <button
        style={{
          ...s.primaryBtn,
          opacity: selected && !loading ? 1 : 0.45,
          cursor: selected && !loading ? "pointer" : "not-allowed",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
        }}
        onClick={onNext}
        disabled={!selected || loading}
      >
        {loading ? (
          <>
            <span style={s.spinnerInline} />
            Loading language…
          </>
        ) : (
          hasError ? "Retry" : "Next"
        )}
      </button>

      <button style={s.backBtn} onClick={onBack} disabled={loading}>
        ← Back
      </button>
    </>
  );
}

// ── Terms step ────────────────────────────────────────────────────────────────

function TermsStep({
  tcText,
  onAgree,
  onDecline,
  showDeclineMsg,
  onBack,
}: {
  tcText: string;
  onAgree: () => void;
  onDecline: () => void;
  showDeclineMsg: boolean;
  onBack: () => void;
}) {
  return (
    <>
      <h2 style={s.stepTitle}>Terms and Conditions</h2>
      <p style={s.stepSubtitle}>
        Please read and accept the terms below to continue.
      </p>

      {/* D1: T&C text comes from the language package (i18n), not a hardcoded constant. */}
      <div style={s.tcBox}>
        <p style={s.tcText}>{tcText}</p>
      </div>

      {showDeclineMsg && (
        <div style={s.errorBox}>
          You must accept the Terms and Conditions to use Crisis Reporter.
          If you refresh this page, you will be asked to restart setup.
        </div>
      )}

      {/* D5: I Agree no longer creates an anonymous session — that moves to HomePage. */}
      <button style={s.primaryBtn} onClick={onAgree}>
        I Agree
      </button>

      <button style={s.declineBtn} onClick={onDecline}>
        Decline
      </button>

      <button style={s.backBtn} onClick={onBack}>
        ← Back
      </button>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    margin: "0 auto",
  },
  header: {
    background: "#0468B1",
    padding: "20px 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  logoIcon: { fontSize: 26 },
  logoText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: 0.3,
  },
  progressRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: "14px 24px",
    borderBottom: "1px solid #EDF2F7",
    background: "#F7FAFC",
  },
  progressTrack: { display: "flex", alignItems: "center" },
  progressDot: { borderRadius: "50%", transition: "all 0.2s" },
  progressLine: {
    width: 40,
    height: 2,
    margin: "0 3px",
    transition: "background 0.2s",
  },
  progressLabel: { fontSize: 13, color: "#4A5568", fontWeight: 500 },
  content: {
    flex: 1,
    padding: "24px 20px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  stepTitle: { fontSize: 22, fontWeight: 700, color: "#1A2B4A", margin: 0 },
  stepSubtitle: { fontSize: 14, color: "#718096", margin: 0 },
  // K2: Pill-style search input (borderRadius: 9999px = full pill)
  searchInputPill: {
    width: "100%",
    padding: "12px 20px",
    borderRadius: "9999px",
    border: "1px solid #D0D5DD",
    fontSize: 15,
    outline: "none",
    background: "#FFFFFF",
    boxSizing: "border-box",
  },
  listScroll: {
    flex: 1,
    overflowY: "auto",
    maxHeight: "40vh",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  listItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "13px 16px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 15,
    textAlign: "left",
    width: "100%",
    transition: "all 0.12s",
    background: "#fff",
  },
  checkIcon: { color: "#0468B1", fontWeight: 700, fontSize: 16, flexShrink: 0 },
  cacheNote: {
    fontSize: 12,
    color: "#718096",
    margin: 0,
    fontStyle: "italic",
  },
  warningBox: {
    background: "#FFFBEB",
    border: "1px solid #FCD34D",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 14,
    color: "#92400E",
    lineHeight: 1.5,
  },
  blockingErrorBox: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 10,
    padding: "16px",
    fontSize: 14,
    color: "#C53030",
    lineHeight: 1.55,
  },
  langGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  langItem: {
    padding: "16px 12px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 600,
    textAlign: "center",
    transition: "all 0.12s",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    width: "100%",
  },
  officialBadge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.8,
    opacity: 0.75,
  },
  tcBox: {
    background: "#F7FAFC",
    border: "1px solid #E2E8F0",
    borderRadius: 8,
    padding: "16px",
    overflowY: "auto",
    maxHeight: "30vh",
  },
  tcText: { fontSize: 15, color: "#2D3748", lineHeight: 1.65, margin: 0 },
  errorBox: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 14,
    color: "#C53030",
    lineHeight: 1.5,
  },
  primaryBtn: {
    width: "100%",
    padding: "15px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    marginTop: 4,
    transition: "opacity 0.15s",
    cursor: "pointer",
  },
  declineBtn: {
    width: "100%",
    padding: "13px",
    background: "#fff",
    color: "#E53E3E",
    border: "1.5px solid #FC8181",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
  },
  backBtn: {
    width: "100%",
    padding: "10px",
    background: "transparent",
    color: "#718096",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
  },
  retryBtn: {
    marginTop: 12,
    padding: "10px 20px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  spinnerInline: {
    display: "inline-block",
    width: 16,
    height: 16,
    border: "2px solid rgba(255,255,255,0.4)",
    borderTop: "2px solid #fff",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    flexShrink: 0,
  },
  hint: { color: "#718096", fontSize: 14, textAlign: "center", padding: "20px 0", margin: 0 },
  errorText: { color: "#E53E3E", fontSize: 14, textAlign: "center", margin: 0 },
};
