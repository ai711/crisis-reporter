import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { isAuthenticated } from "./services/auth";
import { useAuthStore } from "./stores/authStore";
import Layout from "./components/Layout";

// Pages
import LoginPage from "./pages/LoginPage";
import MainMapPage from "./pages/MainMapPage";
import ReportsPage from "./pages/ReportsPage";
import ReportersPage from "./pages/ReportersPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import ExportPage from "./pages/ExportPage";
import SystemSettingsPage from "./pages/SystemSettingsPage";
import ReportQueuePage from "./pages/ReportQueuePage";
import ReviewQueuePage from "./pages/ReviewQueuePage";
import CrisisManagementPage from "./pages/CrisisManagementPage";
import UserManagementPage from "./pages/UserManagementPage";
import ManageRolesPage from "./pages/ManageRolesPage";
import DashboardSettingsPage from "./pages/DashboardSettingsPage";
import ReportDetailPage from "./pages/ReportDetailPage";
import LocationsPage from "./pages/LocationsPage";
import ProjectsPage from "./pages/ProjectsPage";
import AccessDeniedPage from "./pages/AccessDeniedPage";

// ── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// ── Role-aware ProtectedRoute ─────────────────────────────────────────────────

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** When set, the user must have this role (or higher) to view the page. */
  requiredRole?: "admin" | "superadmin";
}

function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  // Not logged in → send to login
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  // Role check — read user from Zustand store
  // We read it here rather than inside the hook so ProtectedRoute can be called
  // at render time without hooks-ordering issues.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { user } = useAuthStore();

  if (requiredRole) {
    const isSuperadmin = user?.role === "superadmin";
    const isAdmin = user?.role === "admin" || isSuperadmin;

    const permitted =
      requiredRole === "superadmin" ? isSuperadmin : isAdmin;

    if (!permitted) {
      // Authenticated but not authorised — show access denied inside the shell
      return (
        <Layout>
          <AccessDeniedPage />
        </Layout>
      );
    }
  }

  return <Layout>{children}</Layout>;
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense
          fallback={
            <div style={{ padding: 40, textAlign: "center" }}>Loading…</div>
          }
        >
          <Routes>
            {/* Public */}
            <Route path="/login" element={<LoginPage />} />

            {/* Root redirect — / always goes to /map */}
            <Route
              path="/"
              element={<Navigate to="/map" replace />}
            />

            {/* ── Authenticated routes (all roles) ─────────────────────── */}

            <Route
              path="/map"
              element={
                <ProtectedRoute>
                  <MainMapPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reports"
              element={
                <ProtectedRoute>
                  <ReportsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reports/:reportId"
              element={
                <ProtectedRoute>
                  <ReportDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/locations"
              element={
                <ProtectedRoute>
                  <LocationsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/review-queue"
              element={
                <ProtectedRoute>
                  <ReviewQueuePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/analytics"
              element={
                <ProtectedRoute>
                  <AnalyticsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reporters"
              element={
                <ProtectedRoute>
                  <ReportersPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/export"
              element={
                <ProtectedRoute>
                  <ExportPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/projects"
              element={
                <ProtectedRoute>
                  <ProjectsPage />
                </ProtectedRoute>
              }
            />

            {/* Legacy routes kept for internal navigation consistency */}
            <Route
              path="/report-queue"
              element={
                <ProtectedRoute>
                  <ReportQueuePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/crises"
              element={
                <ProtectedRoute>
                  <CrisisManagementPage />
                </ProtectedRoute>
              }
            />

            {/* ── Admin-only routes ─────────────────────────────────────── */}

            <Route
              path="/users"
              element={
                <ProtectedRoute requiredRole="admin">
                  <UserManagementPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/roles"
              element={
                <ProtectedRoute requiredRole="admin">
                  <ManageRolesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute requiredRole="admin">
                  <SystemSettingsPage />
                </ProtectedRoute>
              }
            />

            {/* ── Superadmin-only routes ────────────────────────────────── */}

            <Route
              path="/dashboard-settings"
              element={
                <ProtectedRoute requiredRole="superadmin">
                  <DashboardSettingsPage />
                </ProtectedRoute>
              }
            />

            {/* Catch-all → map */}
            <Route path="*" element={<Navigate to="/map" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
