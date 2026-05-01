import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

export default function MyReportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("home.myReports")}</h1>
      </div>
      <div style={styles.content}>
        <div style={styles.empty}>
          <span style={styles.emptyIcon}>📋</span>
          <p style={styles.emptyText}>Your submitted reports will appear here</p>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { minHeight: "100vh", background: "#f4f6f9" },
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
  title: { color: "#fff", fontSize: 18, fontWeight: 700 },
  content: {
    padding: "40px 16px",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "60vh",
  },
  empty: {
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
  },
  emptyIcon: { fontSize: 64 },
  emptyText: { fontSize: 16, color: "#666" },
};