import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import { logoutReporter } from "../services/auth";
import { loadLanguagePackage } from "../i18n";
import api from "../services/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Country {
  code: string;
  name: string;
  is_active: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const UN_LANGUAGES = [
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

function getLanguageName(code: string): string {
  return UN_LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}

// ── Icons ─────────────────────────────────────────────────────────────────────

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

function IconChevron() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#CBD5E0"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#4A5568"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const navigate = useNavigate();
  useTranslation(); // keeps i18next react context active for language switching
  const { setCountry, setLanguage, reset } = useAuthStore();

  const [modal, setModal] = useState<"country" | "language" | null>(null);

  // Read current values from localStorage as source of truth
  const [currentCountryCode, setCurrentCountryCode] = useState(
    () => { try { return localStorage.getItem("cr_country") ?? ""; } catch { return ""; } }
  );
  const [currentLangCode, setCurrentLangCode] = useState(
    () => { try { return localStorage.getItem("cr_language") ?? "en"; } catch { return "en"; } }
  );

  // Language loading state for the settings modal
  const [langLoadingCode, setLangLoadingCode] = useState<string | null>(null);
  const [langLoadError, setLangLoadError] = useState<string | null>(null);
  const [langCacheNote, setLangCacheNote] = useState(false);
  const prevLangCodeRef = useRef(currentLangCode);

  // Country modal state
  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(false);
  const [countriesError, setCountriesError] = useState("");
  const [countrySearch, setCountrySearch] = useState("");
  const [inactiveCountry, setInactiveCountry] = useState<Country | null>(null);

  // Fetch countries only when the country modal first opens
  useEffect(() => {
    if (modal !== "country" || countries.length > 0) return;
    setCountriesLoading(true);
    setCountriesError("");
    api
      .get<Country[]>("/api/countries")
      .then((res) => setCountries(res.data))
      .catch(() =>
        setCountriesError("Could not load countries. Please try again.")
      )
      .finally(() => setCountriesLoading(false));
  }, [modal, countries.length]);

  const currentCountryName =
    countries.find((c) => c.code === currentCountryCode)?.name ??
    currentCountryCode;

  const filteredCountries = countries.filter((c) =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  const openCountryModal = () => {
    setInactiveCountry(null);
    setCountrySearch("");
    setModal("country");
  };

  const handleCountrySelect = (country: Country) => {
    if (!country.is_active) {
      setInactiveCountry(country);
      return;
    }
    localStorage.setItem("cr_country", country.code);
    setCountry(country.code);
    setCurrentCountryCode(country.code);
    setInactiveCountry(null);
    setModal(null);
  };

  const handleLanguageSelect = async (code: string) => {
    if (code === currentLangCode) { setModal(null); return; }
    setLangLoadingCode(code);
    setLangLoadError(null);
    setLangCacheNote(false);

    const result = await loadLanguagePackage(code);
    setLangLoadingCode(null);

    if (!result.success) {
      setLangLoadError(
        "Could not load the language package. Please check your connection and try again."
      );
      return; // Keep modal open for retry.
    }

    // Remove the old language package from localStorage to free up space.
    try { localStorage.removeItem(`cr_language_package_${prevLangCodeRef.current}`); } catch { /* ignore */ }
    prevLangCodeRef.current = code;

    try { localStorage.setItem("cr_language", code); } catch { /* ignore */ }
    setLanguage(code);
    setCurrentLangCode(code);
    if (result.fromCache) setLangCacheNote(true);

    // i18n.changeLanguage is called inside loadLanguagePackage — no direct call needed.
    setModal(null);
  };

  const handleSignOut = () => {
    logoutReporter();
    reset();
    navigate("/onboarding");
  };

  const closeModal = () => {
    setModal(null);
    setInactiveCountry(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div style={s.page}>
        {/* Header */}
        <header style={s.header}>
          <button
            style={s.backBtn}
            onClick={() => navigate("/")}
            aria-label="Back"
          >
            <IconBack />
          </button>
          <span style={s.headerTitle}>Settings</span>
          {/* Spacer keeps title centred */}
          <div style={{ width: 36 }} />
        </header>

        <div style={s.content}>
          {/* ── ACCOUNT ── */}
          <p style={s.sectionLabel}>ACCOUNT</p>
          <div style={s.card}>
            <button style={s.row} onClick={openCountryModal}>
              <span style={s.rowLabel}>Change Country</span>
              <div style={s.rowRight}>
                <span style={s.rowValue}>{currentCountryName || "—"}</span>
                <IconChevron />
              </div>
            </button>
            <div style={s.divider} />
            <button style={s.row} onClick={() => setModal("language")}>
              <span style={s.rowLabel}>Change Language</span>
              <div style={s.rowRight}>
                <span style={s.rowValue}>{getLanguageName(currentLangCode)}</span>
                <IconChevron />
              </div>
            </button>
          </div>

          {/* ── ABOUT ── */}
          <p style={s.sectionLabel}>ABOUT</p>
          <div style={s.card}>
            <div style={s.rowStatic}>
              <span style={s.rowLabel}>Version</span>
              <span style={s.rowValue}>1.0.0</span>
            </div>
            <div style={s.divider} />
            <button
              style={s.row}
              onClick={() => navigate("/onboarding?step=terms")}
            >
              <span style={s.rowLabel}>Terms and Conditions</span>
              <IconChevron />
            </button>
            <div style={s.divider} />
            <button
              style={s.row}
              onClick={() => alert("Privacy Policy coming soon")}
            >
              <span style={s.rowLabel}>Privacy Policy</span>
              <IconChevron />
            </button>
          </div>

          {/* ── SESSION ── */}
          <p style={s.sectionLabel}>SESSION</p>
          <div style={s.card}>
            <button style={s.row} onClick={handleSignOut}>
              <span style={{ ...s.rowLabel, color: "#E53E3E" }}>Sign Out</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Country modal ── */}
      {modal === "country" && (
        <div style={s.overlay} onClick={closeModal}>
          <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={s.sheetHandle} />
            <div style={s.sheetHeader}>
              <span style={s.sheetTitle}>Select Country</span>
              <button
                style={s.closeBtn}
                onClick={closeModal}
                aria-label="Close"
              >
                <IconClose />
              </button>
            </div>
            <div style={{ padding: "0 20px" }}>
              <input
                style={s.searchInput}
                type="text"
                placeholder="Search countries..."
                value={countrySearch}
                onChange={(e) => {
                  setCountrySearch(e.target.value);
                  setInactiveCountry(null);
                }}
                autoFocus
              />
            </div>
            <div style={s.listScroll}>
              {countriesLoading && <p style={s.hint}>Loading countries…</p>}
              {!countriesLoading && countriesError && (
                <p style={s.errorText}>{countriesError}</p>
              )}
              {!countriesLoading && !countriesError && filteredCountries.length === 0 && (
                <p style={s.hint}>No countries match your search.</p>
              )}
              {filteredCountries.map((country) => (
                <button
                  key={country.code}
                  style={{
                    ...s.listItem,
                    background:
                      country.code === currentCountryCode
                        ? "#E8F4FD"
                        : "#fff",
                    borderColor:
                      country.code === currentCountryCode
                        ? "#0468B1"
                        : "#E2E8F0",
                  }}
                  onClick={() => handleCountrySelect(country)}
                >
                  <span>{country.name}</span>
                  {country.code === currentCountryCode && (
                    <span style={s.checkIcon}>✓</span>
                  )}
                </button>
              ))}
            </div>
            {inactiveCountry && (
              <div style={s.warningBox}>
                We are unable to provide any assistance for your region at
                this moment.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Language modal ── */}
      {modal === "language" && (
        <div style={s.overlay} onClick={langLoadingCode ? undefined : closeModal}>
          <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={s.sheetHandle} />
            <div style={s.sheetHeader}>
              <span style={s.sheetTitle}>Select Language</span>
              <button
                style={s.closeBtn}
                onClick={langLoadingCode ? undefined : closeModal}
                aria-label="Close"
                disabled={!!langLoadingCode}
              >
                <IconClose />
              </button>
            </div>
            <div style={{ padding: "0 20px 32px" }}>
              {langLoadError && (
                <div style={s.langErrorBox}>{langLoadError}</div>
              )}
              {langCacheNote && (
                <p style={s.langCacheNote}>
                  Using saved language data. Some text may not be fully updated.
                </p>
              )}
              <div style={s.langGrid}>
                {UN_LANGUAGES.map((lang) => {
                  const isSelected = currentLangCode === lang.code;
                  const isLoading = langLoadingCode === lang.code;
                  return (
                    <button
                      key={lang.code}
                      style={{
                        ...s.langItem,
                        background: isSelected ? "#0468B1" : "#fff",
                        color: isSelected ? "#fff" : "#1A2B4A",
                        borderColor: isSelected ? "#0468B1" : "#E2E8F0",
                        opacity: langLoadingCode && !isLoading ? 0.5 : 1,
                        position: "relative",
                      }}
                      onClick={() => handleLanguageSelect(lang.code)}
                      disabled={!!langLoadingCode}
                    >
                      {isLoading ? "Loading…" : lang.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  content: {
    flex: 1,
    padding: "24px 16px 40px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#9CA3AF",
    letterSpacing: 0.8,
    marginTop: 16,
    marginBottom: 4,
    paddingLeft: 4,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #E2E8F0",
    overflow: "hidden",
  },
  row: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "15px 16px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
  },
  rowStatic: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "15px 16px",
  },
  rowLabel: {
    fontSize: 15,
    color: "#1A2B4A",
    fontWeight: 400,
  },
  rowRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  rowValue: {
    fontSize: 14,
    color: "#9CA3AF",
  },
  divider: {
    height: 1,
    background: "#F0F4F8",
    marginLeft: 16,
  },
  // ── Modal overlay ────────────────────────────────────────────────────────────
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.48)",
    zIndex: 1000,
    display: "flex",
    alignItems: "flex-end",
  },
  sheet: {
    background: "#fff",
    borderRadius: "16px 16px 0 0",
    width: "100%",
    maxWidth: 480,
    margin: "0 auto",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 -4px 24px rgba(0,0,0,0.12)",
  },
  sheetHandle: {
    width: 36,
    height: 4,
    background: "#E2E8F0",
    borderRadius: 2,
    margin: "12px auto 0",
    flexShrink: 0,
  },
  sheetHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px 12px",
    flexShrink: 0,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  searchInput: {
    width: "100%",
    padding: "11px 14px",
    borderRadius: 8,
    border: "1.5px solid #E2E8F0",
    fontSize: 15,
    outline: "none",
    background: "#F7FAFC",
    boxSizing: "border-box",
    marginBottom: 12,
  },
  listScroll: {
    flex: 1,
    overflowY: "auto",
    padding: "0 20px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    paddingBottom: 8,
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
    transition: "all 0.1s",
    background: "#fff",
    flexShrink: 0,
  },
  checkIcon: {
    color: "#0468B1",
    fontWeight: 700,
    fontSize: 16,
    flexShrink: 0,
  },
  warningBox: {
    margin: "8px 20px 16px",
    background: "#FFFBEB",
    border: "1px solid #FCD34D",
    borderRadius: 8,
    padding: "12px 14px",
    fontSize: 14,
    color: "#92400E",
    lineHeight: 1.5,
    flexShrink: 0,
  },
  langGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    paddingTop: 4,
  },
  langItem: {
    padding: "16px 12px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 600,
    textAlign: "center",
    transition: "all 0.1s",
  },
  hint: {
    color: "#9CA3AF",
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
    padding: "12px 0",
  },
  langErrorBox: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 13,
    color: "#C53030",
    lineHeight: 1.5,
    marginBottom: 12,
  },
  langCacheNote: {
    fontSize: 12,
    color: "#718096",
    fontStyle: "italic",
    margin: "0 0 10px",
  },
};
