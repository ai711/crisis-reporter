import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

const BLUE = "#0468B1";

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

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface MenuItem {
  icon: string;
  label: string;
  route: string;
  primary?: boolean;
}

// A9 fix: "Home" removed — Home is reached via the wordmark.
// A7 fix: "Report an Incident" added first as a primary action item.
// A7 fix: final order matches spec exactly.
const MENU_ITEMS: MenuItem[] = [
  { icon: "🚨", label: "Report an Incident",       route: "/report",       primary: true },
  { icon: "🗺️",  label: "Map",                      route: "/map" },
  { icon: "📋", label: "My Reports",               route: "/my-reports" },
  { icon: "🛡️", label: "Safety Tips",              route: "/safety-tips" },
  { icon: "👤", label: "Reporter Profile",         route: "/profile" },
  { icon: "🏅", label: "Badges & Certifications", route: "/badges" },
  { icon: "❓", label: "FAQ",                      route: "/faq" },
  { icon: "⚙️", label: "Settings",                 route: "/settings" },
  { icon: "ℹ️",  label: "About Crisis Reporter",   route: "/about" },
];

function IconClose() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#717782" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function SideMenu({ open, onClose }: SideMenuProps) {
  const navigate = useNavigate();
  const location = useLocation(); // A10: read current route for active highlighting
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();
  const [profile, setProfile] = useState<ReporterProfile | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  const MENU_LABEL_KEYS: Record<string, string> = {
    "Report an Incident": 'home.reportButton',
    "Map": 'nav.map',
    "My Reports": 'home.myReports',
    "Safety Tips": 'menu.safety_tips',
    "Reporter Profile": 'menu.profile',
    "Badges & Certifications": 'badges.title',
    "FAQ": 'faq.title',
    "Settings": 'settings.title',
    "About Crisis Reporter": 'about.title',
  };

  useEffect(() => {
    // Check if a deferred install prompt is already available (captured at startup).
    const existing = (window as Window & { __pwaInstallPrompt?: BeforeInstallPromptEvent }).__pwaInstallPrompt;
    if (existing) {
      installPromptRef.current = existing;
      setCanInstall(true);
    }

    const handler = (e: Event) => {
      e.preventDefault();
      installPromptRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);

    window.addEventListener("appinstalled", () => setCanInstall(false));

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  async function handleInstall() {
    if (!installPromptRef.current) return;
    await installPromptRef.current.prompt();
    const { outcome } = await installPromptRef.current.userChoice;
    if (outcome === "accepted") {
      installPromptRef.current = null;
      setCanInstall(false);
    }
    onClose();
  }

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

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function handleNavigate(route: string) {
    onClose();
    navigate(route);
  }

  const rawName = displayName(profile);
  const name = rawName === "Anonymous Reporter" ? t('profile.anonymous') : rawName;
  const completion = profile ? calcCompletion(profile) : 0;

  const content = (
    <>
      {/* Overlay — tap outside to close */}
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

      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: "78vw",
          maxWidth: 304,
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
        {/* A9: Close button at top-right of the drawer */}
        <button
          onClick={onClose}
          aria-label="Close menu"
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            zIndex: 10,
          }}
        >
          <IconClose />
        </button>

        {/* Profile section */}
        <button
          onClick={() => handleNavigate("/profile")}
          style={{
            background: BLUE,
            padding: "28px 48px 20px 20px", // right padding leaves room for close btn
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
            flexShrink: 0,
          }}
        >
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

          <p style={{ color: "#fff", fontSize: 15, fontWeight: 700, margin: "0 0 4px", lineHeight: 1.3 }}>
            {name}
          </p>
          <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, margin: "0 0 12px" }}>
            {t('profile.completion_label', { completion })}
          </p>

          <div style={{ height: 5, background: "rgba(255,255,255,0.25)", borderRadius: 3, overflow: "hidden" }}>
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
          {MENU_ITEMS.map((item) => {
            // A10: "Report an Incident" never carries an active state.
            const isActive = !item.primary && location.pathname === item.route;

            if (item.primary) {
              return (
                <button
                  key={item.label}
                  onClick={() => handleNavigate(item.route)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    width: "100%",
                    padding: "14px 20px",
                    background: BLUE,
                    border: "none",
                    borderLeft: "3px solid transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    margin: "6px 0",
                  }}
                >
                  <span style={{ fontSize: 20, flexShrink: 0, width: 26, textAlign: "center" }}>
                    {item.icon}
                  </span>
                  <span style={{ fontSize: 14, color: "#fff", fontWeight: 700 }}>
                    {t(MENU_LABEL_KEYS[item.label] ?? item.label)}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={item.label}
                onClick={() => handleNavigate(item.route)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  width: "100%",
                  padding: "13px 20px",
                  // A10: active route: left border + blue bg + blue bold text
                  background: isActive ? "#F0F4FF" : "transparent",
                  border: "none",
                  borderLeft: isActive ? `3px solid ${BLUE}` : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "#f7fafc";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0, width: 26, textAlign: "center" }}>
                  {item.icon}
                </span>
                <span style={{ fontSize: 14, color: isActive ? BLUE : "#2d3748", fontWeight: isActive ? 700 : 500 }}>
                  {t(MENU_LABEL_KEYS[item.label] ?? item.label)}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Divider */}
        <div style={{ height: 1, background: "#e2e8f0", flexShrink: 0 }} />

        {/* PWA Install button — only rendered when browser supports it and app isn't installed */}
        {canInstall && (
          <div style={{ padding: "12px 16px 4px", flexShrink: 0 }}>
            <button
              onClick={handleInstall}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "11px 16px",
                background: "#EBF4FF",
                border: `1.5px solid ${BLUE}`,
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: 18 }}>📲</span>
              <div>
                <p style={{ fontSize: 13, color: BLUE, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
                  Install App
                </p>
                <p style={{ fontSize: 11, color: "#4a6fa5", margin: 0, lineHeight: 1.3 }}>
                  Add to home screen
                </p>
              </div>
            </button>
          </div>
        )}

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
