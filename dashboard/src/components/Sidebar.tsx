import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

// ── Navigation item definitions ───────────────────────────────────────────────
// Order is fixed and must never change. Visibility is role-filtered.

const NAV_ITEMS = [
  {
    path: "/map",
    icon: "🗺️",
    label: "Main Map View",
    requiredRole: null,
  },
  {
    path: "/reports",
    icon: "📋",
    label: "Reports Page",
    requiredRole: null,
  },
  {
    path: "/locations",
    icon: "📍",
    label: "Location Page",
    requiredRole: null,
  },
  {
    path: "/review-queue",
    icon: "🔍",
    label: "Review Queue",
    requiredRole: null,
  },
  {
    path: "/analytics",
    icon: "📊",
    label: "Analytics and Statistics",
    requiredRole: null,
  },
  {
    path: "/reporters",
    icon: "👥",
    label: "Reporter Profiles",
    requiredRole: null,
  },
  {
    path: "/export",
    icon: "📤",
    label: "Export",
    requiredRole: null,
  },
  {
    path: "/projects",
    icon: "🌐",
    label: "Projects",
    requiredRole: null,
  },
  {
    path: "/users",
    icon: "🔑",
    label: "Manage Users",
    requiredRole: "admin" as const,
  },
  {
    path: "/roles",
    icon: "🛡️",
    label: "Manage Roles",
    requiredRole: "admin" as const,
  },
  {
    path: "/settings",
    icon: "⚙️",
    label: "App Configuration",
    requiredRole: "admin" as const,
  },
  {
    path: "/dashboard-settings",
    icon: "🛠️",
    label: "Dashboard Settings",
    requiredRole: "superadmin" as const,
  },
] as const;

// ── Role visibility helper ────────────────────────────────────────────────────

type Role = "admin" | "analyst" | "superadmin";

function canSee(
  requiredRole: "admin" | "superadmin" | null,
  userRole: Role | undefined
): boolean {
  if (!requiredRole) return true;
  if (!userRole) return false;
  if (requiredRole === "superadmin") return userRole === "superadmin";
  // "admin" level — admin and superadmin can see it
  return userRole === "admin" || userRole === "superadmin";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();

  const visibleItems = NAV_ITEMS.filter((item) =>
    canSee(item.requiredRole, user?.role)
  );

  return (
    <div style={styles.sidebar}>
      {/* Brand logo */}
      <div style={styles.logo}>
        <span style={styles.logoIcon}>🆘</span>
        <div>
          <div style={styles.logoTitle}>Crisis Reporter</div>
          <div style={styles.logoSub}>UNDP Dashboard</div>
        </div>
      </div>

      {/* Navigation */}
      <nav style={styles.nav} aria-label="Primary navigation">
        {visibleItems.map((item) => {
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
              aria-current={isActive ? "page" : undefined}
            >
              <span style={styles.navIcon}>{item.icon}</span>
              <span style={styles.navLabel}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* User info — name and role only; logout is in the profile panel */}
      <div style={styles.userSection}>
        <div style={styles.userAvatar}>
          {user?.full_name?.charAt(0)?.toUpperCase() ?? "U"}
        </div>
        <div style={styles.userInfo}>
          <div style={styles.userName}>{user?.full_name}</div>
          <div style={styles.userRole}>{user?.role}</div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
    padding: "20px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
  },
  logoIcon: {
    fontSize: 28,
    flexShrink: 0,
  },
  logoTitle: {
    color: "#fff",
    fontWeight: 700,
    fontSize: 15,
    lineHeight: 1.2,
  },
  logoSub: {
    color: "#7AAFD4",
    fontSize: 11,
  },
  nav: {
    flex: 1,
    padding: "12px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    overflowY: "auto",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 14px",
    borderRadius: 7,
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
    fontWeight: 500,
    transition: "all 0.12s",
    width: "100%",
  },
  navIcon: {
    fontSize: 16,
    width: 22,
    textAlign: "center",
    flexShrink: 0,
  },
  navLabel: {
    flex: 1,
    lineHeight: 1.3,
  },
  userSection: {
    padding: "14px 16px",
    borderTop: "1px solid rgba(255,255,255,0.1)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  userAvatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.15)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 15,
    fontWeight: 700,
    flexShrink: 0,
  },
  userInfo: {
    minWidth: 0,
  },
  userName: {
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as React.CSSProperties["whiteSpace"],
  },
  userRole: {
    color: "#7AAFD4",
    fontSize: 11,
    textTransform: "capitalize" as React.CSSProperties["textTransform"],
  },
};
