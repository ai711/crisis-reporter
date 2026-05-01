import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { createAnonymousSession } from "../services/auth";

const COUNTRIES = [
  { code: "AF", name: "Afghanistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "CM", name: "Cameroon" },
  { code: "CD", name: "Congo (DRC)" },
  { code: "ET", name: "Ethiopia" },
  { code: "GT", name: "Guatemala" },
  { code: "HT", name: "Haiti" },
  { code: "HN", name: "Honduras" },
  { code: "IN", name: "India" },
  { code: "IQ", name: "Iraq" },
  { code: "JO", name: "Jordan" },
  { code: "KE", name: "Kenya" },
  { code: "LB", name: "Lebanon" },
  { code: "LY", name: "Libya" },
  { code: "ML", name: "Mali" },
  { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar" },
  { code: "NP", name: "Nepal" },
  { code: "NG", name: "Nigeria" },
  { code: "PK", name: "Pakistan" },
  { code: "PH", name: "Philippines" },
  { code: "SO", name: "Somalia" },
  { code: "SS", name: "South Sudan" },
  { code: "SD", name: "Sudan" },
  { code: "SY", name: "Syria" },
  { code: "TR", name: "Turkey" },
  { code: "UA", name: "Ukraine" },
  { code: "YE", name: "Yemen" },
  { code: "ZW", name: "Zimbabwe" },
];

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

export default function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { setCountry, setLanguage, setOnboarded, setReporter } = useAuthStore();

  const [step, setStep] = useState<"country" | "language">("country");
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const filteredCountries = COUNTRIES.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCountrySelect = (code: string) => {
    setSelectedCountry(code);
    setError("");
  };

  const handleCountryContinue = () => {
    if (!selectedCountry) {
      setError("Please select a country to continue");
      return;
    }
    setStep("language");
  };

  const handleLanguageSelect = (code: string) => {
    setSelectedLanguage(code);
    i18n.changeLanguage(code);
    localStorage.setItem("cr_language", code);
  };

  const handleFinish = async () => {
    setLoading(true);
    setError("");
    try {
      const session = await createAnonymousSession(
        selectedCountry,
        selectedLanguage
      );
      setReporter(session.reporter_id, session.is_verified);
      setCountry(selectedCountry);
      setLanguage(selectedLanguage);
      setOnboarded();
      navigate("/");
    } catch {
      setError("Could not connect. Please check your internet connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>🆘</div>
        <h1 style={styles.appName}>{t("app.name")}</h1>
        <p style={styles.subtitle}>UNDP Crisis Damage Reporting</p>
      </div>

      {step === "country" ? (
        <div style={styles.content}>
          <h2 style={styles.stepTitle}>{t("onboarding.selectCountry")}</h2>

          <input
            style={styles.searchInput}
            type="text"
            placeholder={t("onboarding.countryPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div style={styles.listContainer}>
            {filteredCountries.map((country) => (
              <button
                key={country.code}
                style={{
                  ...styles.listItem,
                  background:
                    selectedCountry === country.code ? "#E8F4FD" : "#fff",
                  borderColor:
                    selectedCountry === country.code ? "#0468B1" : "#e0e0e0",
                }}
                onClick={() => handleCountrySelect(country.code)}
              >
                <span>{country.name}</span>
                {selectedCountry === country.code && (
                  <span style={styles.checkmark}>✓</span>
                )}
              </button>
            ))}
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={{
              ...styles.primaryButton,
              opacity: selectedCountry ? 1 : 0.5,
            }}
            onClick={handleCountryContinue}
            disabled={!selectedCountry}
          >
            {t("onboarding.continue")}
          </button>
        </div>
      ) : (
        <div style={styles.content}>
          <h2 style={styles.stepTitle}>{t("onboarding.selectLanguage")}</h2>

          <div style={styles.languageGrid}>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                style={{
                  ...styles.languageItem,
                  background:
                    selectedLanguage === lang.code ? "#0468B1" : "#fff",
                  color: selectedLanguage === lang.code ? "#fff" : "#1a2b4a",
                  borderColor:
                    selectedLanguage === lang.code ? "#0468B1" : "#e0e0e0",
                }}
                onClick={() => handleLanguageSelect(lang.code)}
              >
                {lang.name}
              </button>
            ))}
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={{
              ...styles.primaryButton,
              opacity: loading ? 0.7 : 1,
            }}
            onClick={handleFinish}
            disabled={loading}
          >
            {loading ? "Setting up..." : t("onboarding.continue")}
          </button>

          <button
            style={styles.backButton}
            onClick={() => setStep("country")}
          >
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "#f4f6f9",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    background: "#1A2B4A",
    color: "#fff",
    padding: "40px 24px 32px",
    textAlign: "center",
  },
  logo: {
    fontSize: 48,
    marginBottom: 12,
  },
  appName: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#A0B4CC",
  },
  content: {
    flex: 1,
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  stepTitle: {
    fontSize: 20,
    fontWeight: 600,
    color: "#1A2B4A",
    marginBottom: 8,
  },
  searchInput: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    fontSize: 16,
    outline: "none",
    background: "#fff",
  },
  listContainer: {
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
    padding: "14px 16px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 16,
    textAlign: "left",
    transition: "all 0.15s",
  },
  checkmark: {
    color: "#0468B1",
    fontWeight: 700,
    fontSize: 18,
  },
  languageGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  languageItem: {
    padding: "16px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 500,
    transition: "all 0.15s",
  },
  primaryButton: {
    width: "100%",
    padding: "16px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 8,
  },
  backButton: {
    width: "100%",
    padding: "12px",
    background: "transparent",
    color: "#666",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
  },
  error: {
    color: "#d32f2f",
    fontSize: 14,
    textAlign: "center",
  },
};