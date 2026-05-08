import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReporterProfile {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  profile_photo_url: string | null;
}

interface SideMenuProps {
  open: boolean;
  onClose: () => void;
}

// ── Profile helpers ────────────────────────────────────────────────────────────

function calcCompletion(p: ReporterProfile): number {
  let n = 0;
  if (p.first_name?.trim()) n++;
  if (p.last_name?.trim()) n++;
  if (p.email?.trim()) n++;
  if (p.phone_number?.trim()) n++;
  if (p.profile_photo_url) n++;
  return n * 20;
}

function displayName(p: ReporterProfile | null): string {
  if (!p) return "Anonymous Reporter";
  const full = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return full || "Anonymous Reporter";
}

// ── Menu items ─────────────────────────────────────────────────────────────────

interface MenuItem {
  icon: string;
  label: string;
  route?: string;
  action?: "about";
}

const MENU_ITEMS: MenuItem[] = [
  { icon: "🏠", label: "Home",                      route: "/" },
  { icon: "🗺️",  label: "Map",                       route: "/map" },
  { icon: "📋", label: "My Reports",                route: "/my-reports" },
  { icon: "🛡️", label: "Safety Tips",               route: "/safety-tips" },
  { icon: "👤", label: "Reporter Profile",          route: "/profile" },
  { icon: "🏅", label: "Badges & Certifications",  route: "/badges" },
  { icon: "❓", label: "FAQ",                       route: "/faq" },
  { icon: "⚙️", label: "Settings",                  route: "/settings" },
  { icon: "ℹ️",  label: "About Crisis Reporter",    action: "about" },
];

// ── SideMenu ───────────────────────────────────────────────────────────────────

export default function SideMenu({ open, onClose }: SideMenuProps) {
  const navigate = useNavigate();
  const { reporterId } = useAuthStore();
  const [profile, setProfile] = useState<ReporterProfile | null>(null);

  const fetchProfile = useCallback(() => {
    if (!reporterId || profile) return;
    api
      .get<ReporterProfile>(`/api/reporters/${reporterId}`)
      .then((res) => setProfile(res.data))
      .catch(() => {});
  }, [reporterId, profile]);

  useEffect(() => {
    if (open) fetchProfile();
  }, [open, fetchProfile]);

  // Block body scroll when menu is open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function handleNavigate(route: string) {
    onClose();
    navigate(route);
  }

  function handleItemClick(item: MenuItem) {
    if (item.action === "about") {
      handleNavigate("/about");
      return;
    }
    if (item.route) handleNavigate(item.route);
  }

  const name = displayName(profile);
  const completion = profile ? calcCompletion(profile) : 0;

  const content = (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: open ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0)",
          zIndex: 1000,
          transition: "background 0.25s ease",
          pointerEvents: open ? "auto" : "none",
        }}
      />

      {/* Drawer */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: 288,
          maxWidth: "85vw",
          background: "#fff",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
          boxShadow: "4px 0 24px rgba(0,0,0,0.14)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
          overflowY: "auto",
        }}
      >
        {/* Profile section */}
        <button
          onClick={() => handleNavigate("/profile")}
          style={{
            background: BLUE,
            padding: "28px 20px 20px",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
            flexShrink: 0,
          }}
        >
          {/* Avatar circle */}
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              marginBottom: 12,
              color: "#fff",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {profile?.first_name
              ? (profile.first_name[0] + (profile.last_name?.[0] ?? "")).toUpperCase()
              : "👤"}
          </div>

          <p
            style={{
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              margin: "0 0 4px",
              lineHeight: 1.3,
            }}
          >
            {name}
          </p>
          <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, margin: "0 0 12px" }}>
            Profile {completion}% complete
          </p>

          {/* Completion bar */}
          <div
            style={{
              height: 5,
              background: "rgba(255,255,255,0.25)",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${completion}%`,
                background: "#fff",
                borderRadius: 3,
                transition: "width 0.4s ease",
              }}
            />
          </div>
        </button>

        {/* Divider */}
        <div style={{ height: 1, background: "#e2e8f0", flexShrink: 0 }} />

        {/* Menu items */}
        <nav style={{ flex: 1, padding: "8px 0" }}>
          {MENU_ITEMS.map((item) => (
            <button
              key={item.label}
              onClick={() => handleItemClick(item)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                width: "100%",
                padding: "13px 20px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "#f7fafc";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              <span style={{ fontSize: 20, flexShrink: 0, width: 26, textAlign: "center" }}>
                {item.icon}
              </span>
              <span style={{ fontSize: 14, color: "#2d3748", fontWeight: 500 }}>
                {item.label}
              </span>
            </button>
          ))}
        </nav>

        {/* Divider */}
        <div style={{ height: 1, background: "#e2e8f0", flexShrink: 0 }} />

        {/* Footer */}
        <div style={{ padding: "16px 20px", flexShrink: 0 }}>
          <p style={{ fontSize: 11, color: "#a0aec0", margin: "0 0 2px", fontWeight: 500 }}>
            Crisis Reporter v1.0.0
          </p>
          <p style={{ fontSize: 11, color: "#a0aec0", margin: 0, fontWeight: 600, letterSpacing: 0.5 }}>
            UNDP
          </p>
        </div>
      </div>

    </>
  );

  return createPortal(content, document.body);
}
