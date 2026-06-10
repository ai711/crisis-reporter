import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SideMenu from "./SideMenu";
import IOSInstallBanner from "./IOSInstallBanner";

const TAB_ROUTES = ["/", "/map", "/my-reports"];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const isTabRoute = TAB_ROUTES.includes(location.pathname);
  const isMapPage = location.pathname === "/map";
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="app-container">
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
      <IOSInstallBanner />

      {isTabRoute && (
        <header className="page-header">
          <button
            className="page-header-back"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="page-header-title">{t('app.name')}</span>
          <div className="page-header-spacer" />
        </header>
      )}

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          ...(isMapPage ? { overflow: "hidden" } : {}),
          // H3: account for bottom nav height (64px) + iPhone home-bar safe area
          ...(isTabRoute && !isMapPage ? { paddingBottom: "max(80px, calc(64px + env(safe-area-inset-bottom, 0px)))" } : {}),
        }}
      >
        {children}
      </main>

      {isTabRoute && (
        <nav className="bottom-nav">
          {[
            { label: t('nav.home'), path: "/", icon: "home" },
            { label: t('nav.map'), path: "/map", icon: "map" },
            { label: t('nav.reports'), path: "/my-reports", icon: "assignment" },
          ].map(({ label, path, icon }) => (
            <button
              key={path}
              className={`nav-item ${isActive(path) ? "active" : "inactive"}`}
              onClick={() => navigate(path)}
            >
              <span className="material-symbols-outlined">{icon}</span>
              <span className="nav-item-label">{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
