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

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface MenuItem {
  icon: string;       // Material Symbols icon name
  label: string;
  route: string;
  primary?: boolean;
}

const MENU_ITEMS: MenuItem[] = [
  { icon: "campaign",    label: "Report an Incident",       route: "/report",       primary: true },
  { icon: "map",         label: "Map",                      route: "/map" },
  { icon: "assignment",  label: "My Reports",               route: "/my-reports" },
  { icon: "shield",      label: "Safety Tips",              route: "/safety-tips" },
  { icon: "person",      label: "Reporter Profile",         route: "/profile" },
  { icon: "star",        label: "Badges & Certifications",  route: "/badges" },
  { icon: "help",        label: "FAQ",                      route: "/faq" },
  { icon: "settings",    label: "Settings",                 route: "/settings" },
  { icon: "info",        label: "About Crisis Reporter",    route: "/about" },
];

export default function SideMenu({ open, onClose }: SideMenuProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { reporterId, isVerified } = useAuthStore();
  const [profile, setProfile] = useState<ReporterProfile | null>(null);
  const prevReporterIdRef = useRef<string | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [canInstallIOS, setCanInstallIOS] = useState(false);
  const [hoveredRoute, setHoveredRoute] = useState<string | null>(null);

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
    return () => { window.removeEventListener("beforeinstallprompt", handler); };
  }, []);

  // ── iOS install detection ─────────────────────────────────────────────────
  useEffect(() => {
    const ua = navigator.userAgent;
    // L4: navigator.platform is deprecated; fall back to feature sniffing for
    // iPadOS 13+ which reports "MacIntel" but has maxTouchPoints > 1.
    // Also check the more robust navigator.maxTouchPoints directly.
    const isIOS =
      /iphone|ipad|ipod/i.test(ua) ||
      (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isIOS && !isStandalone) setCanInstallIOS(true);
    // Hide button once installed
    window.addEventListener("appinstalled", () => setCanInstallIOS(false));
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

  function handleIOSInstall() {
    onClose();
    window.dispatchEvent(new CustomEvent("cr:show-ios-install"));
  }

  const fetchProfile = useCallback(() => {
    if (!reporterId) return;
    api.get<ReporterProfile>(`/api/reporters/${reporterId}`)
      .then((res) => setProfile(res.data))
      .catch(() => {});
  }, [reporterId]);

  // Clear cached profile whenever the logged-in user changes (login / logout).
  useEffect(() => {
    if (reporterId !== prevReporterIdRef.current) {
      prevReporterIdRef.current = reporterId;
      setProfile(null);
    }
  }, [reporterId]);

  useEffect(() => {
    if (open) fetchProfile();
  }, [open, fetchProfile]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const SIDE_MENU_TAB_ROUTES = ["/", "/map", "/my-reports"];

  function handleNavigate(route: string) {
    onClose();
    navigate(route, SIDE_MENU_TAB_ROUTES.includes(route) ? { replace: true } : undefined);
  }

  const initials = reporterId
    ? profile?.first_name && profile?.last_name
      ? (profile.first_name[0] + profile.last_name[0]).toUpperCase()
      : profile?.first_name
        ? profile.first_name[0].toUpperCase()
        : profile?.email
          ? profile.email[0].toUpperCase()
          : "?"
    : "?";

  const displayName = reporterId
    ? profile?.first_name && profile?.last_name
      ? `${profile.first_name} ${profile.last_name}`
      : profile?.first_name
        ? profile.first_name
        : profile?.email
          ? profile.email
          : isVerified
            ? t("sidemenu.verified_reporter")
            : t("sidemenu.anonymous_reporter")
    : "";

  const content = (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: open ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0)",
          backdropFilter: open ? "blur(2px)" : "none",
          WebkitBackdropFilter: open ? "blur(2px)" : "none",
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
          background: "#FFFFFF",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
          boxShadow: "4px 0 24px rgba(0,0,0,0.14)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)",
          overflowY: "auto",
          borderTopRightRadius: 16,
          borderBottomRightRadius: 16,
        }}
      >
        {/* ── Header: Brand + Close ── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "28px 20px 20px",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "rgba(4,104,177,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <span
                className="material-symbols-outlined"
                style={{ color: BLUE, fontSize: 22, fontVariationSettings: "'FILL' 1" }}
              >
                shield
              </span>
            </div>
            <span style={{ fontSize: 20, fontWeight: 900, color: BLUE, fontFamily: "inherit" }}>
              Crisis Reporter
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              width: 40,
              height: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F0EDED"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <span className="material-symbols-outlined" style={{ color: "#717782", fontSize: 22 }}>close</span>
          </button>
        </div>

        {/* Subtle divider */}
        <div style={{ height: 1, background: "rgba(193,199,210,0.5)", flexShrink: 0 }} />

        {/* ── User identity strip ── */}
        {reporterId && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 20px 8px",
            flexShrink: 0,
          }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: isVerified ? BLUE : "#9CA3AF",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              overflow: "hidden",
            }}>
              {profile?.profile_photo_url ? (
                <img
                  src={profile.profile_photo_url}
                  alt=""
                  style={{ width: 40, height: 40, objectFit: "cover" }}
                />
              ) : (
                <span style={{ color: "#fff", fontSize: 15, fontWeight: 700, lineHeight: 1 }}>
                  {initials}
                </span>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#1B1C1C",
                margin: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {displayName}
              </p>
              {isVerified ? (
                <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 2 }}>
                  <span
                    className="material-symbols-outlined"
                    style={{ color: "#16A34A", fontSize: 13, fontVariationSettings: "'FILL' 1" }}
                  >
                    verified
                  </span>
                  <span style={{ fontSize: 12, color: "#16A34A", fontWeight: 500 }}>
                    {t("sidemenu.verified_reporter")}
                  </span>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>
                  {t("sidemenu.anonymous_reporter")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Menu items ── */}
        <nav style={{ flex: 1, padding: "0 16px", display: "flex", flexDirection: "column", gap: 4 }}>
          {MENU_ITEMS.map((item) => {
            const isActive = !item.primary && location.pathname === item.route;
            const isHovered = hoveredRoute === item.route;

            if (item.primary) {
              return (
                <button
                  key={item.label}
                  onClick={() => handleNavigate(item.route)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "14px 16px",
                    background: BLUE,
                    border: "none",
                    borderRadius: 12,
                    cursor: "pointer",
                    textAlign: "left",
                    marginBottom: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <span className="material-symbols-outlined" style={{ color: "#fff", fontSize: 22, flexShrink: 0 }}>
                      {item.icon}
                    </span>
                    <span style={{ fontSize: 15, color: "#fff", fontWeight: 700, fontFamily: "inherit" }}>
                      {t(MENU_LABEL_KEYS[item.label] ?? item.label)}
                    </span>
                  </div>
                  <span className="material-symbols-outlined" style={{ color: "rgba(255,255,255,0.7)", fontSize: 18 }}>chevron_right</span>
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
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "14px 16px",
                  background: isActive ? "rgba(4,104,177,0.07)" : isHovered ? "#F6F3F2" : "transparent",
                  border: "none",
                  borderRadius: 12,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "background 0.12s",
                }}
                onMouseEnter={() => setHoveredRoute(item.route)}
                onMouseLeave={() => setHoveredRoute(null)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span
                    className="material-symbols-outlined"
                    style={{ color: isActive ? BLUE : "#414751", fontSize: 22, flexShrink: 0 }}
                  >
                    {item.icon}
                  </span>
                  <span style={{
                    fontSize: 15,
                    color: isActive ? BLUE : "#1B1C1C",
                    fontWeight: isActive ? 700 : 500,
                    fontFamily: "inherit",
                  }}>
                    {t(MENU_LABEL_KEYS[item.label] ?? item.label)}
                  </span>
                </div>
                <span className="material-symbols-outlined" style={{ color: "#C1C7D2", fontSize: 18 }}>chevron_right</span>
              </button>
            );
          })}
        </nav>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(193,199,210,0.3)", flexShrink: 0, margin: "8px 0 0" }} />

        {/* PWA Install button — Chrome / Android */}
        {canInstall && (
          <div style={{ padding: "12px 16px 4px", flexShrink: 0 }}>
            <button
              onClick={handleInstall}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "12px 16px",
                background: "rgba(4,104,177,0.07)",
                border: `1.5px solid ${BLUE}`,
                borderRadius: 12,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span className="material-symbols-outlined" style={{ color: BLUE, fontSize: 20 }}>install_mobile</span>
              <div>
                <p style={{ fontSize: 13, color: BLUE, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
                  {t("sidemenu.install_app")}
                </p>
                <p style={{ fontSize: 11, color: "#4a6fa5", margin: 0, lineHeight: 1.3 }}>
                  {t("sidemenu.add_to_home_screen")}
                </p>
              </div>
            </button>
          </div>
        )}

        {/* PWA Install button — iOS / Safari */}
        {canInstallIOS && (
          <div style={{ padding: "12px 16px 4px", flexShrink: 0 }}>
            <button
              onClick={handleIOSInstall}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "12px 16px",
                background: "rgba(4,104,177,0.07)",
                border: `1.5px solid ${BLUE}`,
                borderRadius: 12,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span className="material-symbols-outlined" style={{ color: BLUE, fontSize: 20 }}>install_mobile</span>
              <div>
                <p style={{ fontSize: 13, color: BLUE, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
                  {t("sidemenu.install_app")}
                </p>
                <p style={{ fontSize: 11, color: "#4a6fa5", margin: 0, lineHeight: 1.3 }}>
                  {t("sidemenu.add_to_home_screen")}
                </p>
              </div>
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: "16px 24px 24px", flexShrink: 0 }}>
          <p style={{ fontSize: 12, color: "#9CA3AF", margin: 0, fontWeight: 500, letterSpacing: "0.05em" }}>
            {t("sidemenu.version")}
          </p>
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
