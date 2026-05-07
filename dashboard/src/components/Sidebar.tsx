import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { logout } from "../services/auth";

const NAV_ITEMS = [
  { path: "/", icon: "🗺️", label: "Map", adminOnly: false },
  { path: "/crises", icon: "🌐", label: "Crisis Management", adminOnly: false },
  { path: "/reports", icon: "📋", label: "Reports", adminOnly: false },
  { path: "/report-queue", icon: "📥", label: "Report Queue", adminOnly: false },
  { path: "/review-queue", icon: "🔍", label: "Review Queue", adminOnly: false },
  { path: "/reporters", icon: "👥", label: "Reporters", adminOnly: false },
  { path: "/analytics", icon: "📊", label: "Analytics", adminOnly: false },
  { path: "/export", icon: "📤", label: "Export", adminOnly: false },
  { path: "/users", icon: "🔑", label: "User Management", adminOnly: true },
  { path: "/settings", icon: "⚙️", label: "Settings", adminOnly: false },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, reset } = useAuthStore();

  const handleLogout = () => {
    logout();
    reset();
    navigate("/login");
  };

  return (
    <div style={styles.sidebar}>
      {/* Logo */}
      <div style={styles.logo}>
        <span style={styles.logoIcon}>🆘</span>
        <div>
          <div style={styles.logoTitle}>Crisis Reporter</div>
          <div style={styles.logoSub}>UNDP Dashboard</div>
        </div>
      </div>

      {/* Nav items */}
      <nav style={styles.nav}>
        {NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === "admin").map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <button
              key={item.path}
              style={{
                ...styles.navItem,
                background: isActive ? "#0468B1" : "transparent",
                color: isActive ? "#fff" : "#A0B4CC",
              }}
              onClick={() => navigate(item.path)}
            >
              <span style={styles.navIcon}>{item.icon}</span>
              <span style={styles.navLabel}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* User info */}
      <div style={styles.userSection}>
        <div style={styles.userInfo}>
          <div style={styles.userName}>{user?.full_name}</div>
          <div style={styles.userRole}>{user?.role}</div>
        </div>
        <button style={styles.logoutBtn} onClick={handleLogout}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 240,
    minWidth: 240,
    background: "#1A2B4A",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    position: "fixed",
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 100,
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "24px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
  },
  logoIcon: {
    fontSize: 32,
  },
  logoTitle: {
    color: "#fff",
    fontWeight: 700,
    fontSize: 16,
  },
  logoSub: {
    color: "#7AAFD4",
    fontSize: 12,
  },
  nav: {
    flex: 1,
    padding: "16px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    overflowY: "auto",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 14,
    fontWeight: 500,
    transition: "all 0.15s",
    width: "100%",
  },
  navIcon: {
    fontSize: 18,
    width: 24,
    textAlign: "center",
  },
  navLabel: {
    flex: 1,
  },
  userSection: {
    padding: "16px 20px",
    borderTop: "1px solid rgba(255,255,255,0.1)",
  },
  userInfo: {
    marginBottom: 12,
  },
  userName: {
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
  },
  userRole: {
    color: "#7AAFD4",
    fontSize: 12,
    textTransform: "capitalize",
  },
  logoutBtn: {
    width: "100%",
    padding: "8px",
    background: "transparent",
    color: "#A0B4CC",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
};