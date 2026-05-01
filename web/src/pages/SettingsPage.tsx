import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { logoutReporter } from "../services/auth";

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "zh", name: "中文" },
  { code: "fr", name: "Français" },
  { code: "ru", name: "Русский" },
  { code: "es", name: "Español" },
];

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { languageCode, countryCode, isVerified, setLanguage, reset } =
    useAuthStore();

  const handleLanguageChange = (code: string) => {
    setLanguage(code);
    i18n.changeLanguage(code);
    localStorage.setItem("cr_language", code);
  };

  const handleLogout = () => {
    logoutReporter();
    reset();
    navigate("/onboarding");
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>
          ←
        </button>
        <h1 style={styles.title}>{t("settings.title")}</h1>
      </div>

      <div style={styles.content}>
        {/* Account status */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{t("settings.account")}</h2>
          <div style={styles.card}>
            <div style={styles.row}>
              <span style={styles.label}>Status</span>
              <span style={{
                ...styles.badge,
                background: isVerified ? "#d4edda" : "#e8f4fd",
                color: isVerified ? "#155724" : "#0468B1",
              }}>
                {isVerified ? "Verified" : "Anonymous"}
              </span>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>{t("settings.country")}</span>
              <span style={styles.value}>{countryCode || "—"}</span>
            </div>
          </div>
        </div>

        {/* Language */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>{t("settings.language")}</h2>
          <div style={styles.languageGrid}>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                style={{
                  ...styles.langBtn,
                  background: languageCode === lang.code ? "#0468B1" : "#fff",
                  color: languageCode === lang.code ? "#fff" : "#1A2B4A",
                  borderColor:
                    languageCode === lang.code ? "#0468B1" : "#e0e0e0",
                }}
                onClick={() => handleLanguageChange(lang.code)}
              >
                {lang.name}
              </button>
            ))}
          </div>
        </div>

        {/* Logout */}
        <div style={styles.section}>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            {t("settings.logout")} / Reset App
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "#f4f6f9",
  },
  header: {
    background: "#1A2B4A",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
  },
  content: {
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "4px 0",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  label: {
    fontSize: 15,
    color: "#1A2B4A",
  },
  value: {
    fontSize: 15,
    color: "#666",
  },
  badge: {
    padding: "4px 10px",
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 500,
  },
  languageGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  langBtn: {
    padding: "14px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 500,
  },
  logoutBtn: {
    width: "100%",
    padding: "16px",
    background: "#fff",
    color: "#d32f2f",
    border: "1.5px solid #d32f2f",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
};