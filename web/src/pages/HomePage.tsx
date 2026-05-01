import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { getQueueCount, syncQueue } from "../utils/offlineQueue";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isVerified } = useAuthStore();
  const [queueCount, setQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    // Load queue count
    getQueueCount().then(setQueueCount);

    // Monitor online status
    const handleOnline = () => {
      setIsOnline(true);
      syncQueue(API_URL).then(() => getQueueCount().then(setQueueCount));
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>🆘</span>
          <h1 style={styles.appName}>{t("app.name")}</h1>
        </div>
        <button
          style={styles.settingsBtn}
          onClick={() => navigate("/settings")}
        >
          ⚙️
        </button>
      </div>

      {/* Offline banner */}
      {!isOnline && (
        <div style={styles.offlineBanner}>
          📵 {t("offline.banner")}
        </div>
      )}

      {/* Queue banner */}
      {queueCount > 0 && (
        <div style={styles.queueBanner}>
          🔄 {t("home.queuedReports", { count: queueCount })}
        </div>
      )}

      {/* Main content */}
      <div style={styles.content}>
        {/* UNDP branding */}
        <div style={styles.brandCard}>
          <p style={styles.brandText}>
            Powered by UNDP Crisis Response
          </p>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
          }}>
            <div style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: isOnline ? "#4caf50" : "#ff9800",
            }} />
            <span style={{ fontSize: 13, color: "#666" }}>
              {isOnline ? "Connected" : "Offline mode"}
            </span>
          </div>
        </div>

        {/* Report button */}
        <button
          style={styles.reportButton}
          onClick={() => navigate("/report")}
        >
          <span style={styles.reportIcon}>📋</span>
          <span>{t("home.reportButton")}</span>
        </button>

        {/* Secondary actions */}
        <div style={styles.secondaryActions}>
          <button
            style={styles.secondaryButton}
            onClick={() => navigate("/map")}
          >
            🗺️ View Map
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => navigate("/my-reports")}
          >
            📁 {t("home.myReports")}
          </button>
        </div>
      </div>

      {/* Bottom nav */}
        <div style={styles.bottomNav}>
        <button style={styles.navItem} onClick={() => navigate("/")}>
          <span>🏠</span>
          <span style={styles.navLabel}>Home</span>
        </button>
        <button style={styles.navItem} onClick={() => navigate("/map")}>
          <span>🗺️</span>
          <span style={styles.navLabel}>Map</span>
        </button>
        <button style={styles.navItem} onClick={() => navigate("/my-reports")}>
          <span>📁</span>
          <span style={styles.navLabel}>Reports</span>
        </button>
      </div>
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
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logo: {
    fontSize: 24,
  },
  appName: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
  },
  settingsBtn: {
    background: "transparent",
    border: "none",
    fontSize: 22,
    cursor: "pointer",
  },
  offlineBanner: {
    background: "#ff9800",
    color: "#fff",
    padding: "10px 16px",
    fontSize: 13,
    textAlign: "center",
  },
  queueBanner: {
    background: "#0468B1",
    color: "#fff",
    padding: "10px 16px",
    fontSize: 13,
    textAlign: "center",
  },
  content: {
    flex: 1,
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  brandCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "16px 20px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  brandText: {
    fontSize: 14,
    color: "#666",
    fontWeight: 500,
  },
  reportButton: {
    width: "100%",
    padding: "20px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    boxShadow: "0 4px 16px rgba(4,104,177,0.3)",
  },
  reportIcon: {
    fontSize: 24,
  },
  secondaryActions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  secondaryButton: {
    padding: "16px",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 12,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    color: "#1A2B4A",
  },
  bottomNav: {
    background: "#fff",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "space-around",
    padding: "8px 0",
  },
  navItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "8px 16px",
    fontSize: 20,
  },
  navLabel: {
    fontSize: 11,
    color: "#666",
  },
};