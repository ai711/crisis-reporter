import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import React, { Suspense, lazy, useEffect } from "react";
import AppLayout from "./components/AppLayout";
import i18n, { loadLanguagePackageFromCache } from "./i18n";

const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const MyReportsPage = lazy(() => import("./pages/MyReportsPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const SafetyTipsPage = lazy(() => import("./pages/SafetyTipsPage"));
const BadgesPage = lazy(() => import("./pages/BadgesPage"));
const FAQPage = lazy(() => import("./pages/FAQPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));

// ── D6: T&C version check — runs once at module load, before any route renders.
// If the stored acceptance version doesn't match the current bundled version,
// clear the acceptance so the reporter must re-accept before proceeding.
(function checkTcVersionAndClear() {
  try {
    const stored = localStorage.getItem("cr_tc_version");
    if (!stored) return; // Never accepted, or acceptance predates versioning.
    const current = i18n.t("tc_version");
    if (current && current !== "tc_version" && stored !== current) {
      localStorage.removeItem("cr_tc_accepted");
      localStorage.removeItem("cr_tc_version");
    }
  } catch { /* localStorage unavailable */ }
})();

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '100vh', padding: 24,
          background: '#F6F3F2', fontFamily: 'Public Sans, sans-serif'
        }}>
          <div style={{fontSize: 48, marginBottom: 16}}>⚠️</div>
          <div style={{fontSize: 18, fontWeight: 700, color: '#1B1C1C',
            marginBottom: 8}}>Something went wrong</div>
          <div style={{fontSize: 14, color: '#717782', textAlign: 'center',
            marginBottom: 24}}>{this.state.error}</div>
          <button
            onClick={() => window.location.reload()}
            style={{background: '#0468B1', color: 'white', border: 'none',
              borderRadius: 9999, padding: '12px 24px', fontSize: 14,
              fontWeight: 700, cursor: 'pointer'}}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoadingSpinner() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#E4E2E1",
    }}>
      <div style={{
        width: 40,
        height: 40,
        border: "4px solid #e0e0e0",
        borderTop: "4px solid #0468B1",
        borderRadius: "50%",
        animation: "spin 1s linear infinite",
      }} />
    </div>
  );
}

// Returns the first incomplete onboarding phase, or null if fully onboarded.
// Country and language are now one combined screen ("onboarding"), so both
// missing states collapse to the same redirect target.
function getFirstMissingStep(): "onboarding" | "terms" | null {
  try {
    if (!localStorage.getItem("cr_country") || !localStorage.getItem("cr_language"))
      return "onboarding";
    if (!localStorage.getItem("cr_tc_accepted")) return "terms";
  } catch {
    return "onboarding";
  }
  return null;
}

// Redirects to the first incomplete onboarding phase, storing the intended URL.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const missingStep = getFirstMissingStep();
  if (missingStep) {
    const next = encodeURIComponent(location.pathname + location.search);
    const to =
      missingStep === "terms"
        ? `/onboarding?step=terms&next=${next}`
        : `/onboarding?next=${next}`;
    return <Navigate to={to} replace />;
  }
  return <>{children}</>;
}

// Redirects away from onboarding if already complete, unless a specific step
// is requested (e.g. viewing T&C from Settings via ?step=terms).
function OnboardingRoute() {
  const location = useLocation();
  const stepParam = new URLSearchParams(location.search).get("step");
  const missingStep = getFirstMissingStep();
  if (!missingStep && !stepParam) return <Navigate to="/" replace />;
  return <OnboardingPage />;
}

// Rendered inside <BrowserRouter> so useLocation is available.
// Re-applies the saved language on every route change, preventing the i18n
// singleton from drifting back to English after React Router navigates.
function AppContent() {
  const location = useLocation();

  useEffect(() => {
    const savedLang = localStorage.getItem("cr_language");
    if (savedLang && savedLang !== "en") {
      loadLanguagePackageFromCache(savedLang);
    }
  }, [location.pathname]);

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingRoute />} />
        {/* E1: /login is a protected route — onboarding must be complete first. */}
        <Route
          path="/login"
          element={
            <ProtectedRoute>
              <AppLayout><LoginPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout><HomePage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/report"
          element={
            <ProtectedRoute>
              <AppLayout><ReportPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/map"
          element={
            <ProtectedRoute>
              <AppLayout><MapPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <AppLayout><SettingsPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/my-reports"
          element={
            <ProtectedRoute>
              <AppLayout><MyReportsPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <AppLayout><ProfilePage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/safety-tips"
          element={
            <ProtectedRoute>
              <AppLayout><SafetyTipsPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/badges"
          element={
            <ProtectedRoute>
              <AppLayout><BadgesPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/faq"
          element={
            <ProtectedRoute>
              <AppLayout><FAQPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/about"
          element={
            <ProtectedRoute>
              <AppLayout><AboutPage /></AppLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="*"
          element={
            <Navigate
              to={getFirstMissingStep() ? "/onboarding" : "/"}
              replace
            />
          }
        />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
