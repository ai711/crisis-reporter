import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { createAnonymousSession } from "../services/auth";
import api from "../services/api";
import { useTranslation } from "react-i18next";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Country {
  code: string;
  name: string;
  is_active: boolean;
}

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

const TC_TEXT =
  "By using Crisis Reporter you agree to submit accurate damage reports and allow UNDP to use your submitted data for crisis response coordination. Your location and photos will be stored securely.";

type Step = "country" | "language" | "terms";

function getInitialStep(): Step {
  if (!localStorage.getItem("cr_country")) return "country";
  if (!localStorage.getItem("cr_language")) return "language";
  if (!localStorage.getItem("cr_tc_accepted")) return "terms";
  return "country";
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const rawNext = searchParams.get("next");
  const nextPath = rawNext ? decodeURIComponent(rawNext) : "/";
  const stepParam = searchParams.get("step") as Step | null;

  const { setCountry, setLanguage, setOnboarded, setReporter } = useAuthStore();

  const [step, setStep] = useState<Step>(() => {
    if (stepParam && (["country", "language", "terms"] as Step[]).includes(stepParam)) {
      return stepParam;
    }
    return getInitialStep();
  });

  // Country step
  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [countriesError, setCountriesError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<Country | null>(null);

  // Language step
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [officialLang, setOfficialLang] = useState<Language | null>(null);
  const [langFetchDone, setLangFetchDone] = useState(false);

  // Terms step
  const [showDeclineMsg, setShowDeclineMsg] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");

  // Fetch countries on mount
  useEffect(() => {
    api
      .get<Country[]>("/api/countries")
      .then((res) => setCountries(res.data))
      .catch(() =>
        setCountriesError("Could not load countries. Please try again.")
      )
      .finally(() => setCountriesLoading(false));
  }, []);

  // Fetch official language when language step activates
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
      .catch(() => {
        // Official language is an enhancement — silently ignore errors
      })
      .finally(() => setLangFetchDone(true));
  }, [step, selectedCountry, langFetchDone]);

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const stepNumber = step === "country" ? 1 : step === "language" ? 2 : 3;

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleCountryNext = () => {
    if (!selectedCountry?.is_active) return;
    localStorage.setItem("cr_country", selectedCountry.code);
    setCountry(selectedCountry.code);
    setStep("language");
  };

  const handleBackToCountry = () => {
    // Reset official lang so it re-fetches if country changes
    setOfficialLang(null);
    setLangFetchDone(false);
    setStep("country");
  };

  const handleLanguageNext = () => {
    if (!selectedLanguage) return;
    localStorage.setItem("cr_language", selectedLanguage);
    setLanguage(selectedLanguage);
    i18n.changeLanguage(selectedLanguage);
    setStep("terms");
  };

  const handleAgree = async () => {
    localStorage.setItem("cr_tc_accepted", new Date().toISOString());
    setFinishing(true);
    setFinishError("");
    try {
      const countryCode = localStorage.getItem("cr_country")!;
      const langCode = localStorage.getItem("cr_language")!;
      const session = await createAnonymousSession(countryCode, langCode);
      setReporter(session.reporter_id, session.is_verified);
      setOnboarded();
      navigate(nextPath, { replace: true });
    } catch {
      setFinishError(
        "Could not connect. Please check your internet connection."
      );
      setFinishing(false);
    }
  };

  const handleDecline = () => setShowDeclineMsg(true);

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
            onSelect={setSelectedLanguage}
            officialLang={officialLang}
            onNext={handleLanguageNext}
            onBack={handleBackToCountry}
          />
        )}
        {step === "terms" && (
          <TermsStep
            onAgree={handleAgree}
            onDecline={handleDecline}
            showDeclineMsg={showDeclineMsg}
            finishing={finishing}
            finishError={finishError}
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
  search,
  onSearch,
  selected,
  onSelect,
  onNext,
}: {
  countries: Country[];
  loading: boolean;
  error: string;
  search: string;
  onSearch: (v: string) => void;
  selected: Country | null;
  onSelect: (c: Country) => void;
  onNext: () => void;
}) {
  const canContinue = selected?.is_active === true;

  return (
    <>
      <h2 style={s.stepTitle}>Select your country</h2>
      <p style={s.stepSubtitle}>
        Choose the country where you are reporting from.
      </p>

      <input
        style={s.searchInput}
        type="text"
        placeholder="Search countries..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        autoFocus
      />

      <div style={s.listScroll}>
        {loading && <p style={s.hint}>Loading countries...</p>}
        {!loading && error && <p style={s.errorText}>{error}</p>}
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
          We are unable to provide any assistance for your region at this
          moment.
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
  onNext,
  onBack,
}: {
  selected: string;
  onSelect: (code: string) => void;
  officialLang: Language | null;
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
              >
                <span>{lang.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <button
        style={{
          ...s.primaryBtn,
          opacity: selected ? 1 : 0.45,
          cursor: selected ? "pointer" : "not-allowed",
        }}
        onClick={onNext}
        disabled={!selected}
      >
        Next
      </button>

      <button style={s.backBtn} onClick={onBack}>
        ← Back
      </button>
    </>
  );
}

// ── Terms step ────────────────────────────────────────────────────────────────

function TermsStep({
  onAgree,
  onDecline,
  showDeclineMsg,
  finishing,
  finishError,
  onBack,
}: {
  onAgree: () => void;
  onDecline: () => void;
  showDeclineMsg: boolean;
  finishing: boolean;
  finishError: string;
  onBack: () => void;
}) {
  return (
    <>
      <h2 style={s.stepTitle}>Terms and Conditions</h2>
      <p style={s.stepSubtitle}>
        Please read and accept the terms below to continue.
      </p>

      <div style={s.tcBox}>
        <p style={s.tcText}>{TC_TEXT}</p>
      </div>

      {showDeclineMsg && (
        <div style={s.errorBox}>
          You must accept the Terms and Conditions to use Crisis Reporter.
        </div>
      )}

      {finishError && <p style={s.errorText}>{finishError}</p>}

      <button
        style={{
          ...s.primaryBtn,
          opacity: finishing ? 0.7 : 1,
          cursor: finishing ? "not-allowed" : "pointer",
        }}
        onClick={onAgree}
        disabled={finishing}
      >
        {finishing ? "Setting up..." : "I Agree"}
      </button>

      <button style={s.declineBtn} onClick={onDecline} disabled={finishing}>
        Decline
      </button>

      <button style={s.backBtn} onClick={onBack} disabled={finishing}>
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
  logoIcon: {
    fontSize: 26,
  },
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
  progressTrack: {
    display: "flex",
    alignItems: "center",
  },
  progressDot: {
    borderRadius: "50%",
    transition: "all 0.2s",
  },
  progressLine: {
    width: 40,
    height: 2,
    margin: "0 3px",
    transition: "background 0.2s",
  },
  progressLabel: {
    fontSize: 13,
    color: "#4A5568",
    fontWeight: 500,
  },
  content: {
    flex: 1,
    padding: "24px 20px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  stepSubtitle: {
    fontSize: 14,
    color: "#718096",
    margin: 0,
  },
  searchInput: {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    border: "1.5px solid #E2E8F0",
    fontSize: 15,
    outline: "none",
    background: "#F7FAFC",
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
  checkIcon: {
    color: "#0468B1",
    fontWeight: 700,
    fontSize: 16,
    flexShrink: 0,
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
  langGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
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
  tcText: {
    fontSize: 15,
    color: "#2D3748",
    lineHeight: 1.65,
    margin: 0,
  },
  errorBox: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 14,
    color: "#C53030",
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
  hint: {
    color: "#718096",
    fontSize: 14,
    textAlign: "center",
    padding: "20px 0",
    margin: 0,
  },
  errorText: {
    color: "#E53E3E",
    fontSize: 14,
    textAlign: "center",
    margin: 0,
  },
};
