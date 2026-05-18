import { useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import { getReviewQueueCounts, getDashboardProjects } from "../services/api";
import type { ReviewQueueCounts, ProjectsListResponse } from "../types";
import {
  Map,
  FileText,
  MapPin,
  AlertCircle,
  BarChart2,
  Users,
  Download,
  Folder,
  UserCog,
  Shield,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

// ── Navigation item definitions ───────────────────────────────────────────────

type NavRole = "admin" | "superadmin" | null;

type NavItem = {
  path: string;
  icon: LucideIcon;
  label: string;
  requiredRole: NavRole;
};

const NAV_ITEMS: NavItem[] = [
  { path: "/map",              icon: Map,              label: "Main Map View",           requiredRole: null        },
  { path: "/reports",          icon: FileText,         label: "Reports Page",            requiredRole: null        },
  { path: "/locations",        icon: MapPin,           label: "Location Page",           requiredRole: null        },
  { path: "/review-queue",     icon: AlertCircle,      label: "Review Queue",            requiredRole: null        },
  { path: "/analytics",        icon: BarChart2,        label: "Analytics and Statistics",requiredRole: null        },
  { path: "/reporters",        icon: Users,            label: "Reporter Profiles",       requiredRole: null        },
  { path: "/export",           icon: Download,         label: "Export",                  requiredRole: null        },
  { path: "/projects",         icon: Folder,           label: "Projects",                requiredRole: null        },
  { path: "/users",            icon: UserCog,          label: "Manage Users",            requiredRole: "admin"     },
  { path: "/roles",            icon: Shield,           label: "Manage Roles",            requiredRole: "admin"     },
  { path: "/settings",         icon: Settings,         label: "App Configuration",       requiredRole: "admin"     },
  { path: "/dashboard-settings", icon: SlidersHorizontal, label: "Dashboard Settings",  requiredRole: "superadmin"},
];

// ── Role visibility helper ────────────────────────────────────────────────────

type Role = "admin" | "analyst" | "superadmin";

function canSee(requiredRole: NavRole, userRole: Role | undefined): boolean {
  if (!requiredRole) return true;
  if (!userRole) return false;
  if (requiredRole === "superadmin") return userRole === "superadmin";
  return userRole === "admin" || userRole === "superadmin";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();

  const { data: countsData } = useQuery<ReviewQueueCounts>({
    queryKey: ["review-queue-counts"],
    queryFn: async () => {
      const res = await getReviewQueueCounts();
      return res.data as ReviewQueueCounts;
    },
    refetchInterval: 20000,
    staleTime: 0,
  });

  const totalQueueCount = countsData
    ? countsData.tab1_count + countsData.tab2_count + countsData.tab3_count + countsData.tab4_count
    : 0;

  const { data: activeProjectsData } = useQuery<ProjectsListResponse>({
    queryKey: ["active-projects-count"],
    queryFn: async () => {
      const res = await getDashboardProjects({ status: "active", limit: 1 });
      return res.data as ProjectsListResponse;
    },
    refetchInterval: 60000,
    staleTime: 55000,
  });

  const activeProjectCount = activeProjectsData?.total ?? 0;

  const visibleItems = NAV_ITEMS.filter((item) =>
    canSee(item.requiredRole, user?.role)
  );

  return (
    <div style={styles.sidebar}>
      {/* Brand logo */}
      <div style={styles.logo}>
        <svg
          width={28}
          height={28}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#7AAFD4"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div>
          <div style={styles.logoTitle}>Crisis Reporter</div>
          <div style={styles.logoSub}>UNDP Dashboard</div>
        </div>
      </div>

      {/* Navigation */}
      <nav style={styles.nav} aria-label="Primary navigation">
        {visibleItems.map((item) => {
          const isActive = location.pathname === item.path;
          const IconComponent = item.icon;
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
              <IconComponent
                size={18}
                color={isActive ? "#fff" : "#A0B4CC"}
                style={{ flexShrink: 0 }}
              />
              <span style={styles.navLabel}>{item.label}</span>
              {item.path === "/review-queue" && totalQueueCount > 0 && (
                <span style={{
                  background: "#f44336",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 10,
                  padding: "2px 7px",
                  minWidth: 18,
                  textAlign: "center" as const,
                  lineHeight: 1.4,
                  flexShrink: 0,
                }}>
                  {totalQueueCount}
                </span>
              )}
              {item.path === "/projects" && activeProjectCount > 0 && (
                <span style={{
                  background: "#0468B1",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 10,
                  padding: "2px 7px",
                  minWidth: 18,
                  textAlign: "center" as const,
                  lineHeight: 1.4,
                  flexShrink: 0,
                }}>
                  {activeProjectCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User info */}
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
