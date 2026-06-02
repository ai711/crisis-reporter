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
import RoleDetailPage from "./pages/RoleDetailPage";
import DashboardSettingsPage from "./pages/DashboardSettingsPage";
import ReportDetailPage from "./pages/ReportDetailPage";
import ReporterDetailPage from "./pages/ReporterDetailPage";
import LocationsPage from "./pages/LocationsPage";
import PropertyDetailPage from "./pages/PropertyDetailPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import UserDetailPage from "./pages/UserDetailPage";
import AccessDeniedPage from "./pages/AccessDeniedPage";
import ContentManagementPage from "./pages/ContentManagementPage";

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
  requiredRole?: "admin" | "superadmin";
  requiredSection?: string;
}

function ProtectedRoute({ children, requiredRole, requiredSection }: ProtectedRouteProps) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { user } = useAuthStore();

  if (requiredRole) {
    const isSuperadmin = user?.role === "superadmin";
    const isAdmin = user?.role === "admin" || isSuperadmin;
    const permitted = requiredRole === "superadmin" ? isSuperadmin : isAdmin;
    if (!permitted) {
      return <Layout><AccessDeniedPage /></Layout>;
    }
  }

  if (requiredSection) {
    const isAdminOrAbove = user?.role === "superadmin" || user?.role === "admin";
    const perms = user?.role_permissions?.[requiredSection];
    const hasAccess = isAdminOrAbove || perms?.view === true;
    if (!hasAccess) {
      return <Layout><AccessDeniedPage /></Layout>;
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

            {/* ── Authenticated routes ──────────────────────────────────── */}

            <Route
              path="/map"
              element={
                <ProtectedRoute requiredSection="main_map_view">
                  <MainMapPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reports"
              element={
                <ProtectedRoute requiredSection="reports_page">
                  <ReportsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reports/:reportId"
              element={
                <ProtectedRoute requiredSection="reports_page">
                  <ReportDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/locations"
              element={
                <ProtectedRoute requiredSection="location_page">
                  <LocationsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/locations/:propertyId"
              element={
                <ProtectedRoute requiredSection="location_page">
                  <PropertyDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/review-queue"
              element={
                <ProtectedRoute requiredSection="review_queue">
                  <ReviewQueuePage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/analytics"
              element={
                <ProtectedRoute requiredSection="analytics_and_statistics">
                  <AnalyticsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reporters"
              element={
                <ProtectedRoute requiredSection="reporter_profiles">
                  <ReportersPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reporters/:reporterId"
              element={
                <ProtectedRoute requiredSection="reporter_profiles">
                  <ReporterDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/export"
              element={
                <ProtectedRoute requiredSection="export">
                  <ExportPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/projects"
              element={
                <ProtectedRoute requiredSection="projects">
                  <ProjectsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/projects/:serialId"
              element={
                <ProtectedRoute requiredSection="projects">
                  <ProjectDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/users"
              element={
                <ProtectedRoute requiredSection="manage_users">
                  <UserManagementPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/users/:userId"
              element={
                <ProtectedRoute requiredSection="manage_users">
                  <UserDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/roles"
              element={
                <ProtectedRoute requiredSection="manage_roles">
                  <ManageRolesPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/roles/:roleId"
              element={
                <ProtectedRoute requiredSection="manage_roles">
                  <RoleDetailPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute requiredSection="app_configuration">
                  <SystemSettingsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/content"
              element={
                <ProtectedRoute requiredSection="app_configuration">
                  <ContentManagementPage />
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
