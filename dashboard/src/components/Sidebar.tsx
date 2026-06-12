import { NavLink } from "react-router-dom";
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
  BookOpen,
  type LucideIcon,
} from "lucide-react";

// ── Nav item type ─────────────────────────────────────────────────────────────

type NavItem = {
  path: string;
  icon: LucideIcon;
  label: string;
  sectionKey: string | null;
};

// ── Navigation definitions ────────────────────────────────────────────────────

const MAIN_NAV: NavItem[] = [
  { path: "/map",          icon: Map,         label: "Map View",          sectionKey: "main_map_view"            },
  { path: "/reports",      icon: FileText,    label: "Reports",           sectionKey: "reports_page"             },
  { path: "/locations",    icon: MapPin,      label: "Locations",         sectionKey: "location_page"            },
  { path: "/review-queue", icon: AlertCircle, label: "Review Queue",      sectionKey: "review_queue"             },
  { path: "/analytics",    icon: BarChart2,   label: "Analytics",         sectionKey: "analytics_and_statistics" },
  { path: "/reporters",    icon: Users,       label: "Reporter Profiles", sectionKey: "reporter_profiles"        },
  { path: "/export",       icon: Download,    label: "Export",            sectionKey: "export"                   },
  { path: "/projects",     icon: Folder,      label: "Projects",          sectionKey: "projects"                 },
];

const ADMIN_NAV: NavItem[] = [
  { path: "/users",               icon: UserCog,           label: "Manage Users",       sectionKey: "manage_users"       },
  { path: "/roles",               icon: Shield,            label: "Manage Roles",       sectionKey: "manage_roles"       },
  { path: "/settings",            icon: Settings,          label: "App Configuration",  sectionKey: "app_configuration"  },
  { path: "/content",             icon: BookOpen,          label: "Content Management", sectionKey: "content_management"  },
  { path: "/dashboard-settings",  icon: SlidersHorizontal, label: "Dashboard Settings", sectionKey: null                 },
];

// ── Shield brand mark ─────────────────────────────────────────────────────────

function BrandShield() {
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7L12 2z"
        fill="white"
        fillOpacity={0.88}
      />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar() {
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
  const isAdminOrAbove = user?.role === "superadmin" || user?.role === "admin";

  function isVisible(item: NavItem): boolean {
    if (item.path === "/dashboard-settings") return user?.role === "superadmin";
    if (!item.sectionKey) return true;
    if (isAdminOrAbove) return true;
    return user?.role_permissions?.[item.sectionKey]?.view === true;
  }

  const visibleMain = MAIN_NAV.filter(isVisible);
  const visibleAdmin = ADMIN_NAV.filter(isVisible);
  const avatarLetter = user?.full_name?.charAt(0)?.toUpperCase() ?? "U";

  return (
    <aside className="sidebar">

      {/* ── Brand ──────────────────────────────────────────────────────────── */}
      <div className="sidebar-brand">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandShield />
          <div>
            <div className="sidebar-brand-name">Crisis Reporter</div>
          </div>
        </div>
      </div>

      {/* ── Navigation ─────────────────────────────────────────────────────── */}
      <nav className="sidebar-nav" aria-label="Primary navigation">

        {visibleMain.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
          >
            <item.icon size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, lineHeight: 1.3 }}>{item.label}</span>
            {item.path === "/review-queue" && totalQueueCount > 0 && (
              <span className="sidebar-badge">{totalQueueCount}</span>
            )}
            {item.path === "/projects" && activeProjectCount > 0 && (
              <span
                className="sidebar-badge"
                style={{ background: "var(--c-primary-container)" }}
              >
                {activeProjectCount}
              </span>
            )}
          </NavLink>
        ))}

        {visibleAdmin.length > 0 && (
          <>
            <div className="sidebar-section-label">Administration</div>
            {visibleAdmin.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `sidebar-item${isActive ? " active" : ""}`}
              >
                <item.icon size={16} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, lineHeight: 1.3 }}>{item.label}</span>
              </NavLink>
            ))}
          </>
        )}

      </nav>

      {/* ── User footer ────────────────────────────────────────────────────── */}
      <div className="sidebar-footer">
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 700,
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {user?.profile_photo_url ? (
            <img
              src={user.profile_photo_url}
              alt="Profile"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            avatarLetter
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="sidebar-footer-name"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {user?.full_name}
          </div>
          <div className="sidebar-footer-role">{user?.role}</div>
        </div>
      </div>

    </aside>
  );
}
