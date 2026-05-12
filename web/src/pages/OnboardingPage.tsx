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

type Step = "onboarding" | "terms";

// ── Icons ─────────────────────────────────────────────────────────────────────

function ShieldIcon() {
  return (
    <svg width="30" height="34" viewBox="0 0 30 34" fill="white" aria-hidden="true">
      <path d="M15 0L0 5.5V16C0 24.84 6.4 33.1 15 35C23.6 33.1 30 24.84 30 16V5.5L15 0ZM12.5 24.5L6 18L7.76 16.24L12.5 20.97L22.24 11.23L24 13L12.5 24.5Z" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#0468B1" aria-hidden="true">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
    </svg>
  );
}

function ChevronDownIcon({ color = "#718096" }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={color} style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M7 10l5 5 5-5z" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#A0AEC0" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="#A0AEC0" aria-hidden="true">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  );
}

// ── Shared header ─────────────────────────────────────────────────────────────

function OnboardingHeader() {
  return (
    <div style={s.headerArea}>
      <div style={s.shieldContainer}>
        <ShieldIcon />
      </div>
      <p style={s.appName}>Crisis Reporter</p>
      <p style={s.appSubtitle}>
        Helping UNDP respond faster to crises around the world
      </p>
    </div>
  );
}

// ── Country modal (bottom sheet) ──────────────────────────────────────────────

function CountryModal({
  countries,
  search,
  onSearch,
  selected,
  onSelect,
  onClose,
}: {
  countries: CachedCountry[];
  search: string;
  onSearch: (v: string) => void;
  selected: CachedCountry | null;
  onSelect: (c: CachedCountry) => void;
  onClose: () => void;
}) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.bottomSheet} onClick={(e) => e.stopPropagation()}>
        <div style={s.sheetHandle} />
        <div style={s.sheetHeader}>
          <span style={s.sheetTitle}>Select country</span>
          <button style={s.sheetClose} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: "0 16px 12px" }}>
          <input
            style={s.searchInput}
            type="text"
            placeholder="Search countries..."
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div style={s.countryList}>
          {countries.length === 0 && (
            <p style={s.hint}>No countries match your search.</p>
          )}
          {countries.map((c) => (
            <button
              key={c.code}
              style={{
                ...s.countryItem,
                background: selected?.code === c.code ? "#EBF5FB" : "#fff",
                color: c.is_active ? "#1A2B4A" : "#A0AEC0",
              }}
              onClick={() => onSelect(c)}
            >
              <span style={{ flex: 1, textAlign: "left" }}>{c.name}</span>
              {!c.is_active && (
                <span style={{ fontSize: 11, color: "#A0AEC0", marginRight: 6 }}>
                  Unavailable
                </span>
              )}
              {selected?.code === c.code && (
                <span style={{ color: "#0468B1", fontWeight: 700 }}>✓</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── More languages modal ──────────────────────────────────────────────────────

function MoreLangsModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        style={{ ...s.bottomSheet, maxHeight: "50vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={s.sheetHandle} />
        <div style={s.sheetHeader}>
          <span style={s.sheetTitle}>More languages</span>
          <button style={s.sheetClose} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: "8px 20px 28px" }}>
          <p style={{ fontSize: 14, color: "#718096", lineHeight: 1.65, marginBottom: 20 }}>
            Additional language support is coming soon. Currently, Crisis Reporter
            supports the 6 UN official languages plus your country's official language.
          </p>
          <button
            style={{
              ...s.continueBtn,
              background: "#0468B1",
              color: "#fff",
              fontWeight: 700,
              cursor: "pointer",
            }}
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Terms screen ──────────────────────────────────────────────────────────────

function TermsScreen({
  tcText,
  onAgree,
  onDecline,
  showDeclineMsg,
}: {
  tcText: string;
  onAgree: () => void;
  onDecline: () => void;
  showDeclineMsg: boolean;
}) {
  return (
    <div style={s.page}>
      <div style={s.scrollArea}>
        <OnboardingHeader />
        <div style={s.section}>
          <p style={s.sectionTitle}>Terms and Conditions</p>
          <p style={{ fontSize: 14, color: "#718096" }}>
            Please read and accept the terms below to continue.
          </p>
          <div style={s.tcCard}>
            <p style={s.tcText}>{tcText}</p>
          </div>
          {showDeclineMsg && (
            <div style={s.errorBox}>
              You must accept the Terms and Conditions to use Crisis Reporter.
              Refreshing this page will require restarting setup.
            </div>
          )}
        </div>
        <div style={{ height: 180 }} />
      </div>
      <div style={s.footer}>
        <button
          className="cr-continue-btn"
          style={{
            ...s.continueBtn,
            background: "#0468B1",
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
          }}
          onClick={onAgree}
        >
          I Agree
        </button>
        <button style={s.declineBtn} onClick={onDecline}>
          Decline
        </button>
        <div style={s.footerNote}>
          <LockIcon />
          <span>Your data is secured by UNDP Privacy Protocols</span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const rawNext = searchParams.get("next");
  const nextPath = rawNext ? decodeURIComponent(rawNext) : "/";
  const stepParam = searchParams.get("step");

  const { setCountry, setLanguage, setOnboarded } = useAuthStore();

  const [step, setStep] = useState<Step>(
    stepParam === "terms" ? "terms" : "onboarding"
  );

  // Country
  const [countries, setCountries] = useState<CachedCountry[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [countriesError, setCountriesError] = useState<"network" | "nocache" | null>(null);
  const [fromCachedCountries, setFromCachedCountries] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<CachedCountry | null>(null);
  const [countryModalOpen, setCountryModalOpen] = useState(false);

  // Language
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [officialLang, setOfficialLang] = useState<Language | null>(null);
  const [langPackageLoading, setLangPackageLoading] = useState(false);
  const [langPackageError, setLangPackageError] = useState(false);
  const [langFromCache, setLangFromCache] = useState(false);
  const [moreLangsModalOpen, setMoreLangsModalOpen] = useState(false);

  // Terms
  const [showDeclineMsg, setShowDeclineMsg] = useState(false);

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

  // Fetch official language whenever an active country is selected.
  useEffect(() => {
    if (!selectedCountry || !selectedCountry.is_active) {
      setOfficialLang(null);
      return;
    }
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
          });
        } else {
          setOfficialLang(null);
        }
      })
      .catch(() => setOfficialLang(null));
  }, [selectedCountry]);

  const handleCountrySelect = (country: CachedCountry) => {
    setSelectedCountry(country);
    setSelectedLanguage("");
    setOfficialLang(null);
    setLangPackageError(false);
    setLangFromCache(false);
    setCountryModalOpen(false);
    setCountrySearch("");
  };

  const handleContinue = async () => {
    if (!selectedCountry?.is_active || !selectedLanguage || langPackageLoading) return;
    setLangPackageLoading(true);
    setLangPackageError(false);
    setLangFromCache(false);

    try { localStorage.setItem("cr_country", selectedCountry.code); } catch { /* ignore */ }
    setCountry(selectedCountry.code);

    const result = await loadLanguagePackage(selectedLanguage);
    setLangPackageLoading(false);

    if (!result.success) {
      setLangPackageError(true);
      return;
    }

    try { localStorage.setItem("cr_language", selectedLanguage); } catch { /* ignore */ }
    setLanguage(selectedLanguage);

    if (result.fromCache) setLangFromCache(true);

    setStep("terms");
  };

  // D5: handleAgree is synchronous — Reporter ID assignment deferred to HomePage.
  const handleAgree = () => {
    try { sessionStorage.removeItem("cr_tc_declined"); } catch { /* ignore */ }
    try {
      localStorage.setItem("cr_tc_accepted", new Date().toISOString());
      // D6: Record T&C version alongside the acceptance timestamp.
      localStorage.setItem("cr_tc_version", i18n.t("tc_version"));
    } catch { /* ignore */ }
    setOnboarded();
    if (nextPath !== "/") {
      try { sessionStorage.setItem("cr_post_onboarding_next", nextPath); } catch { /* ignore */ }
    }
    navigate("/", { replace: true });
  };

  // D4: Write decline flag to sessionStorage so main.tsx can reset state on refresh.
  const handleDecline = () => {
    try { sessionStorage.setItem("cr_tc_declined", "true"); } catch { /* ignore */ }
    setShowDeclineMsg(true);
  };

  if (step === "terms") {
    return (
      <TermsScreen
        tcText={t("tc_text")}
        onAgree={handleAgree}
        onDecline={handleDecline}
        showDeclineMsg={showDeclineMsg}
      />
    );
  }

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  const canContinue = !!(selectedCountry?.is_active && selectedLanguage);

  const pillLanguages: Language[] = [
    ...UN_LANGUAGES,
    ...(officialLang ? [officialLang] : []),
  ];

  return (
    <div style={s.page}>
      <div style={s.scrollArea}>
        <OnboardingHeader />

        {/* ── Country section ── */}
        <div style={s.section}>
          <p style={s.sectionLabel}>SELECT YOUR COUNTRY</p>

          {countriesError === "nocache" ? (
            <div style={s.blockingError}>
              <p style={{ fontWeight: 600, marginBottom: 6 }}>No internet connection</p>
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                An internet connection is required. Please check your connection and refresh.
              </p>
              <button style={s.retryBtn} onClick={() => window.location.reload()}>
                Refresh
              </button>
            </div>
          ) : (
            <>
              <button
                style={s.selectorRow}
                onClick={() => !countriesLoading && setCountryModalOpen(true)}
                disabled={countriesLoading}
                aria-label="Select country"
              >
                {selectedCountry ? (
                  <>
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <LocationIcon />
                      <span style={{ fontSize: 15, color: "#1A2B4A", fontWeight: 500 }}>
                        {selectedCountry.name}
                      </span>
                    </span>
                    <ChevronDownIcon color="#0468B1" />
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 15, color: "#718096" }}>
                      {countriesLoading ? "Loading countries…" : "Select your country"}
                    </span>
                    <ChevronDownIcon />
                  </>
                )}
              </button>

              {/* Info note — only when no country selected */}
              {!selectedCountry && (
                <div style={s.infoRow}>
                  <InfoIcon />
                  <span style={s.infoText}>
                    Only countries with active UNDP operations are available
                  </span>
                </div>
              )}

              {/* Inactive country warning */}
              {selectedCountry && !selectedCountry.is_active && (
                <div style={s.warningBox}>
                  We are unable to provide assistance for your region at this time.
                </div>
              )}

              {fromCachedCountries && (
                <p style={s.cacheNote}>
                  Showing saved country list. Some updates may not be reflected.
                </p>
              )}
            </>
          )}
        </div>

        {/* ── Language section — animates in when active country is selected ── */}
        {selectedCountry?.is_active && (
          <div
            key={selectedCountry.code}
            className="cr-lang-section-enter"
            style={s.section}
          >
            <p style={s.sectionLabel}>SELECT YOUR LANGUAGE</p>

            <div style={s.pillGrid}>
              {pillLanguages.map((lang) => {
                const isSel = selectedLanguage === lang.code;
                return (
                  <button
                    key={lang.code}
                    style={{
                      ...s.pill,
                      background: isSel ? "#0468B1" : "#F7FAFC",
                      color: isSel ? "#fff" : "#1A2B4A",
                      fontWeight: isSel ? 700 : 500,
                      border: isSel ? "2px solid #0468B1" : "2px solid #E2E8F0",
                      boxShadow: isSel ? "0 2px 8px rgba(4,104,177,0.25)" : "none",
                    }}
                    onClick={() => {
                      setSelectedLanguage(lang.code);
                      setLangPackageError(false);
                      setLangFromCache(false);
                    }}
                    disabled={langPackageLoading}
                  >
                    <span>{lang.name}</span>
                    {isSel && <CheckCircleIcon />}
                  </button>
                );
              })}

              {/* + More pill */}
              <button
                style={{
                  ...s.pill,
                  background: "#F7FAFC",
                  color: "#718096",
                  border: "2px solid #E2E8F0",
                  fontStyle: "italic",
                  fontWeight: 400,
                  justifyContent: "center",
                }}
                onClick={() => setMoreLangsModalOpen(true)}
                disabled={langPackageLoading}
              >
                <span>+ More</span>
              </button>
            </div>

            {langFromCache && (
              <p style={s.cacheNote}>
                Using saved language data. Some text may not be fully updated.
              </p>
            )}

            {langPackageError && (
              <div style={s.errorBox}>
                Could not load language. Check your connection and try again.
              </div>
            )}
          </div>
        )}

        {/* Spacer so content clears the fixed footer */}
        <div style={{ height: 124 }} />
      </div>

      {/* ── Fixed footer ── */}
      <div style={s.footer}>
        <button
          className="cr-continue-btn"
          style={{
            ...s.continueBtn,
            background: canContinue ? "#0468B1" : "#EDF2F7",
            color: canContinue ? "#fff" : "#A0AEC0",
            fontWeight: canContinue ? 700 : 400,
            cursor: canContinue ? "pointer" : "not-allowed",
          }}
          onClick={handleContinue}
          disabled={!canContinue || langPackageLoading}
        >
          {langPackageLoading ? (
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <span style={s.spinner} />
              Loading…
            </span>
          ) : (
            "Continue"
          )}
        </button>
        <div style={s.footerNote}>
          <LockIcon />
          <span>Your data is secured by UNDP Privacy Protocols</span>
        </div>
      </div>

      {/* ── Modals ── */}
      {countryModalOpen && (
        <CountryModal
          countries={filteredCountries}
          search={countrySearch}
          onSearch={setCountrySearch}
          selected={selectedCountry}
          onSelect={handleCountrySelect}
          onClose={() => { setCountryModalOpen(false); setCountrySearch(""); }}
        />
      )}

      {moreLangsModalOpen && (
        <MoreLangsModal onClose={() => setMoreLangsModalOpen(false)} />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#FAFBFC",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    margin: "0 auto",
    position: "relative",
  },
  scrollArea: {
    flex: 1,
    overflowY: "auto",
  },
  headerArea: {
    textAlign: "center",
    padding: "40px 24px 28px",
    background: "#fff",
    borderBottom: "1px solid #EDF2F7",
  },
  shieldContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    background: "#0468B1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0 auto 14px",
  },
  appName: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: "0 0 6px",
    letterSpacing: -0.3,
  },
  appSubtitle: {
    fontSize: 13,
    color: "#718096",
    maxWidth: 280,
    margin: "0 auto",
    lineHeight: 1.55,
  },
  section: {
    padding: "20px 20px 0",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: "0.65rem",
    fontWeight: 700,
    color: "#718096",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    margin: 0,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  selectorRow: {
    width: "100%",
    height: 56,
    background: "#F7FAFC",
    border: "1.5px solid #E2E8F0",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  },
  infoRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
  },
  infoText: {
    fontSize: "0.75rem",
    color: "#A0AEC0",
    lineHeight: 1.45,
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
  blockingError: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 10,
    padding: 16,
    fontSize: 14,
    color: "#C53030",
    lineHeight: 1.55,
  },
  cacheNote: {
    fontSize: 12,
    color: "#718096",
    margin: 0,
    fontStyle: "italic",
  },
  pillGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  pill: {
    height: 48,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    cursor: "pointer",
    fontSize: 15,
    width: "100%",
    transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
    boxSizing: "border-box",
  },
  errorBox: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 14,
    color: "#C53030",
    lineHeight: 1.5,
  },
  footer: {
    position: "fixed",
    bottom: 0,
    left: "50%",
    transform: "translateX(-50%)",
    width: "100%",
    maxWidth: 480,
    background: "rgba(255,255,255,0.85)",
    backdropFilter: "blur(12px)",
    padding: "16px 20px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    borderTop: "1px solid rgba(226,232,240,0.6)",
    boxSizing: "border-box",
    zIndex: 100,
  },
  continueBtn: {
    width: "100%",
    height: 56,
    borderRadius: 12,
    border: "none",
    fontSize: 16,
    transition: "background 0.15s, opacity 0.15s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  declineBtn: {
    width: "100%",
    height: 48,
    borderRadius: 12,
    background: "transparent",
    border: "1.5px solid #E2E8F0",
    color: "#718096",
    fontSize: 15,
    cursor: "pointer",
  },
  footerNote: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    fontSize: "0.7rem",
    color: "#A0AEC0",
  },
  spinner: {
    display: "inline-block",
    width: 16,
    height: 16,
    border: "2px solid rgba(255,255,255,0.4)",
    borderTop: "2px solid #fff",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    flexShrink: 0,
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
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  bottomSheet: {
    background: "#fff",
    borderRadius: "16px 16px 0 0",
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    width: "100%",
    maxWidth: 480,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    background: "#E2E8F0",
    borderRadius: 2,
    margin: "12px auto 4px",
    flexShrink: 0,
  },
  sheetHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 20px 12px",
    borderBottom: "1px solid #EDF2F7",
    flexShrink: 0,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "#1A2B4A",
  },
  sheetClose: {
    background: "none",
    border: "none",
    fontSize: 16,
    color: "#718096",
    cursor: "pointer",
    padding: 4,
    lineHeight: 1,
  },
  searchInput: {
    width: "100%",
    padding: "11px 16px",
    borderRadius: 8,
    border: "1.5px solid #E2E8F0",
    fontSize: 15,
    outline: "none",
    background: "#F7FAFC",
    boxSizing: "border-box",
  },
  countryList: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 8px 16px",
  },
  countryItem: {
    display: "flex",
    alignItems: "center",
    padding: "12px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontSize: 15,
    width: "100%",
    transition: "background 0.1s",
    gap: 8,
  },
  hint: {
    color: "#718096",
    fontSize: 14,
    textAlign: "center",
    padding: "20px 0",
    margin: 0,
  },
  tcCard: {
    background: "#F7FAFC",
    border: "1px solid #E2E8F0",
    borderRadius: 12,
    padding: 16,
    maxHeight: "50vh",
    overflowY: "auto",
  },
  tcText: {
    fontSize: "0.875rem",
    color: "#2D3748",
    lineHeight: 1.75,
    margin: 0,
  },
};
