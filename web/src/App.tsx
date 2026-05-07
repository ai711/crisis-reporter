import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Suspense, lazy } from "react";

const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const MyReportsPage = lazy(() => import("./pages/MyReportsPage"));

function LoadingSpinner() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#f4f6f9",
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

// Returns the first incomplete onboarding step, or null if fully onboarded.
function getFirstMissingStep(): "country" | "language" | "terms" | null {
  if (!localStorage.getItem("cr_country")) return "country";
  if (!localStorage.getItem("cr_language")) return "language";
  if (!localStorage.getItem("cr_tc_accepted")) return "terms";
  return null;
}

// Redirects to the first incomplete onboarding step, storing the intended URL.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const missingStep = getFirstMissingStep();
  if (missingStep) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <Navigate
        to={`/onboarding?step=${missingStep}&next=${next}`}
        replace
      />
    );
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

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingRoute />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HomePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/report"
            element={
              <ProtectedRoute>
                <ReportPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/map"
            element={
              <ProtectedRoute>
                <MapPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/my-reports"
            element={
              <ProtectedRoute>
                <MyReportsPage />
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
    </BrowserRouter>
  );
}
