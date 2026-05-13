import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import SideMenu from "./SideMenu";
import api from "../services/api";

const DESKTOP_NAV_HEIGHT = 64;

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return width;
}

function IconHamburger() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#1A2B4A" strokeWidth={2} strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

interface ReporterProfile {
  first_name: string | null;
  last_name: string | null;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const width = useWindowWidth();
  const isDesktop = width > 768;
  const navigate = useNavigate();
  const location = useLocation();
  const { reporterId } = useAuthStore();
  const isMapPage = location.pathname === "/map";

  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [reporterName, setReporterName] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reporterId) { setReporterName(null); return; }
    api.get<ReporterProfile>(`/api/reporters/${reporterId}`)
      .then((res) => {
        const full = [res.data.first_name, res.data.last_name].filter(Boolean).join(" ").trim();
        setReporterName(full || null);
      })
      .catch(() => {});
  }, [reporterId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const handleLogout = () => {
    try {
      localStorage.removeItem("cr_reporter_id");
      localStorage.removeItem("cr_tc_accepted");
    } catch { /* ignore */ }
    setDropdownOpen(false);
    navigate("/onboarding");
  };

  const truncatedName = reporterName
    ? (reporterName.length > 20 ? reporterName.slice(0, 20) + "…" : reporterName)
    : "My Account";

  const isActive = (path: string) => location.pathname === path;

  // ── Desktop nav ────────────────────────────────────────────────────────
  const desktopNav = (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 100,
      background: "#FFFFFF",
      borderBottom: "1px solid #E2E8F0",
      height: DESKTOP_NAV_HEIGHT,
      display: "flex",
      alignItems: "center",
      padding: "0 24px",
      flexShrink: 0,
    }}>
      <button
        onClick={() => navigate("/")}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, marginRight: 40, flexShrink: 0 }}
      >
        <span style={{ color: "#0468B1", fontWeight: 700, fontSize: "1.125rem" }}>Crisis Reporter</span>
      </button>

      <nav style={{ display: "flex", alignItems: "center", flex: 1 }}>
        {[
          { label: "Map", path: "/map" },
          { label: "My Reports", path: "/my-reports" },
        ].map(({ label, path }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            style={{
              background: "none",
              border: "none",
              borderBottom: isActive(path) ? "2px solid #0468B1" : "2px solid transparent",
              cursor: "pointer",
              color: isActive(path) ? "#0468B1" : "#1A2B4A",
              fontWeight: 500,
              fontSize: "0.9rem",
              padding: "0 16px",
              height: DESKTOP_NAV_HEIGHT,
              display: "flex",
              alignItems: "center",
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
        <button
          onClick={() => navigate("/report")}
          style={{
            background: "#0468B1",
            color: "#FFFFFF",
            border: "none",
            borderRadius: 8,
            padding: "10px 20px",
            fontWeight: 700,
            fontSize: "0.9rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Report an Incident
        </button>

        {reporterId ? (
          <div ref={dropdownRef} style={{ position: "relative" }}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "#1A2B4A",
                fontWeight: 500,
                fontSize: "0.9rem",
              }}
            >
              <span>{truncatedName}</span>
              <IconChevronDown />
            </button>

            {dropdownOpen && (
              <div style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                right: 0,
                background: "#fff",
                borderRadius: 8,
                boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                minWidth: 200,
                zIndex: 200,
                overflow: "hidden",
              }}>
                {([
                  { label: "Reporter Profile", path: "/profile" },
                  { label: "Badges and Certifications", path: "/badges" },
                  { label: "Settings", path: "/settings" },
                ] as { label: string; path: string }[]).map(({ label, path }) => (
                  <button
                    key={path}
                    onClick={() => { navigate(path); setDropdownOpen(false); }}
                    style={dropdownItemStyle}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F7FAFC"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                  >
                    {label}
                  </button>
                ))}
                <div style={{ height: 1, background: "#E2E8F0" }} />
                <button
                  onClick={handleLogout}
                  style={{ ...dropdownItemStyle, color: "#E53E3E" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#FFF5F5"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                >
                  Log Out
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <button
              onClick={() => navigate("/login")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#0468B1", fontWeight: 500, fontSize: "0.9rem" }}
            >
              Log In
            </button>
            <button
              onClick={() => navigate("/profile")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#0468B1", fontWeight: 500, fontSize: "0.9rem" }}
            >
              Create Account
            </button>
          </div>
        )}
      </div>
    </header>
  );

  // ── Mobile nav ─────────────────────────────────────────────────────────
  const mobileNav = (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 100,
      background: "#FFFFFF",
      borderBottom: "1px solid #E2E8F0",
      height: 56,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 20px",
      flexShrink: 0,
    }}>
      <button
        onClick={() => setMenuOpen(true)}
        aria-label="Open menu"
        style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", width: 30 }}
      >
        <IconHamburger />
      </button>
      <button
        onClick={() => navigate("/")}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <span style={{ color: "#0468B1", fontWeight: 700, fontSize: "1.125rem" }}>Crisis Reporter</span>
      </button>
      <div style={{ width: 30 }} />
    </header>
  );

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      ...(isMapPage ? { height: "100vh", overflow: "hidden" } : { minHeight: "100vh" }),
    }}>
      {!isDesktop && <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />}
      {isDesktop ? desktopNav : mobileNav}
      <main style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        ...(isMapPage ? { overflow: "hidden" } : {}),
      }}>
        {isMapPage ? (
          children
        ) : (
          <div style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "0 24px",
            width: "100%",
            boxSizing: "border-box",
            flex: 1,
            display: "flex",
            flexDirection: "column",
          }}>
            {children}
          </div>
        )}
      </main>
    </div>
  );
}

const dropdownItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "12px 16px",
  background: "none",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  fontSize: "0.875rem",
  color: "#1A2B4A",
};
