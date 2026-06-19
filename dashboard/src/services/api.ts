import axios from "axios";
import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "../stores/authStore";

const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true, // send HttpOnly cookies on every request
  headers: { "Content-Type": "application/json" },
});

// ── Token storage helpers ─────────────────────────────────────────────────────
// Dashboard uses HttpOnly cookies for access/refresh tokens (XSS-safe).
// Auth state lives in the Zustand auth store (persisted via zustand/persist).
// tokenStorage interface is kept for backward-compat with callers (isAuthenticated, etc).

export const tokenStorage = {
  /** Returns a truthy sentinel when the user is logged in; null otherwise. */
  getAccessToken: (): string | null =>
    useAuthStore.getState().user ? "cookie-auth" : null,

  /** Always null — refresh token is in an HttpOnly cookie. */
  getRefreshToken: (): null => null,

  /** No-op: cookies are set by the server on login/refresh. */
  setTokens: (_access: string, _refresh: string) => { /* cookies set server-side */ },

  /** Reset local auth state; cookies are cleared by the logout endpoint. */
  clearTokens: () => {
    useAuthStore.getState().reset();
  },
};

// ── Request interceptor — no Bearer header needed (cookie handles auth) ───────

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => config,
  (error) => Promise.reject(error)
);

// ── Response interceptor — silent token refresh ───────────────────────────────
// CRITICAL: Refresh must never interrupt active dashboard operations.
// The refresh call sends the HttpOnly cookie; the server rotates both cookies.

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: unknown) => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve();
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (originalRequest.url?.includes("/auth/refresh")) {
      tokenStorage.clearTokens();
      useAuthStore.getState().reset();
      window.location.href = "/login?reason=session_expired";
      return Promise.reject(error);
    }

    // No user in auth store means not logged in — don't attempt refresh
    if (!useAuthStore.getState().user) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then(() => api(originalRequest));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      // Cookie is sent automatically — no body token needed
      await axios.post(
        `${BASE_URL}/api/dashboard/auth/refresh`,
        {},
        { withCredentials: true }
      );

      // Server rotated cookies; retry queued requests (they'll use the new cookie)
      processQueue(null);
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError);
      tokenStorage.clearTokens();
      useAuthStore.getState().reset();
      window.location.href = "/login?reason=session_expired";
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

// ── Properties ────────────────────────────────────────────────────────────────

export const getProperties = (params: Record<string, string | number | boolean>) =>
  api.get('/api/properties', { params });

export const getPropertyStats = () =>
  api.get('/api/properties/stats');

export const getPropertyDetail = (propertyId: string, projectId?: string) =>
  api.get(`/api/properties/${propertyId}`, {
    params: projectId ? { project_id: projectId } : {}
  });

export const setConfirmedStatus = (propertyId: string, confirmedStatus: string | null, comment: string) =>
  api.patch(`/api/properties/${propertyId}/confirmed-status`, {
    confirmed_status: confirmedStatus,
    comment
  });

export const savePropertyOverride = (propertyId: string, data: { override_name?: string | null; override_lat?: number | null; override_lng?: number | null }) =>
  api.patch(`/api/properties/${propertyId}/override`, data);

export const getPropertyComments = (propertyId: string) =>
  api.get(`/api/properties/${propertyId}/comments`);

export const postPropertyComment = (propertyId: string, commentText: string) =>
  api.post(`/api/properties/${propertyId}/comments`, { comment_text: commentText });

export const setRecoveryStatus = (propertyId: string, isRecovered: boolean, comment: string) =>
  api.patch(`/api/properties/${propertyId}/recovery-status`, { is_recovered: isRecovered, comment });

export const flagPropertyForReview = (propertyId: string, note?: string) =>
  api.post(`/api/properties/${propertyId}/flag-for-review`, { note: note || null });

export const getReporterVersionHistory = (propertyId: string, reporterId: string) =>
  api.get(`/api/properties/${propertyId}/reporters/${reporterId}/versions`);

// ── Review Queue ──────────────────────────────────────────────────────────────

export const getReviewQueueCounts = () =>
  api.get('/api/review-queue/counts');

export const getTab1Reports = (params: Record<string, string | number>) =>
  api.get('/api/review-queue/tab1', { params });

export const getTab2Properties = (params: Record<string, string | number>) =>
  api.get('/api/review-queue/tab2', { params });

export const getTab3StuckReports = (params: Record<string, string | number>) =>
  api.get('/api/review-queue/tab3', { params });

export const getTab4AutoBlocked = (params: Record<string, string | number>) =>
  api.get('/api/review-queue/tab4', { params });

export const acquireReviewLock = (reportId: string) =>
  api.post(`/api/review-queue/tab1/${reportId}/review`);

export const forceResolution = (reportId: string, targetStatus: 'green' | 'red', reason: string) =>
  api.post(`/api/review-queue/tab3/${reportId}/force-resolution`, { target_status: targetStatus, reason });

export const dismissPropertyFromReview = (propertyId: string, comment: string) =>
  api.post(`/api/review-queue/tab2/${propertyId}/dismiss`, { comment });

export const confirmAutoBlock = (reporterId: string, comment: string) =>
  api.post(`/api/review-queue/tab4/${reporterId}/confirm`, { comment });

export const reverseAutoBlock = (reporterId: string, comment: string) =>
  api.post(`/api/review-queue/tab4/${reporterId}/reverse`, { comment });

export const releaseSoftLock = (itemType: string, itemId: string) =>
  api.post('/api/review-queue/release-lock', { item_type: itemType, item_id: itemId });

export const submitReviewDecision = (
  reportId: string,
  decision: 'approve' | 'discard',
  flagAssessments: Array<{ reason: string; dismissed: boolean }>,
  comment: string
) =>
  api.post(`/api/review-queue/tab1/${reportId}/submit`, {
    decision,
    flag_assessments: flagAssessments,
    comment,
  });

// ── Reporters ─────────────────────────────────────────────────────────────────

export const getReporters = (params: Record<string, string | number>) =>
  api.get('/api/dashboard/reporters', { params });

export const getReporterDetail = (reporterId: string) =>
  api.get(`/api/dashboard/reporters/${reporterId}`);

export const changeReporterStatus = (reporterId: string, profileStatus: string, comment: string) =>
  api.patch(`/api/dashboard/reporters/${reporterId}/status`, {
    profile_status: profileStatus,
    comment,
  });

export const removeReporterPause = (reporterId: string, comment: string) =>
  api.post(`/api/dashboard/reporters/${reporterId}/remove-pause`, { comment });

export const getReporterReports = (reporterId: string, params: Record<string, string | number>) =>
  api.get(`/api/dashboard/reporters/${reporterId}/reports`, { params });

export const getReporterActivityLog = (reporterId: string, page: number = 1) =>
  api.get(`/api/dashboard/reporters/${reporterId}/activity-log`, {
    params: { page, page_size: 20 },
  });

export const getReporterBadges = (reporterId: string) =>
  api.get(`/api/dashboard/reporters/${reporterId}/badges`);

// ── Projects ──────────────────────────────────────────────────────────────────

export const getDashboardProjects = (params: Record<string, string | number>) =>
  api.get('/api/dashboard/projects', { params });

export const getProjectDetail = (serialId: string) =>
  api.get(`/api/dashboard/projects/${serialId}`);

export const createProject = (data: {
  name: string;
  countries: string[];
  start_date: string;
  end_date: string;
  description?: string;
}) => api.post('/api/dashboard/projects', data);

export const updateProject = (serialId: string, data: Record<string, unknown>) =>
  api.patch(`/api/dashboard/projects/${serialId}`, data);

export const getProjectImportStatus = (serialId: string) =>
  api.get(`/api/dashboard/projects/${serialId}/import-status`);

export const getProjectReports = (serialId: string, params: Record<string, string | number>) =>
  api.get(`/api/dashboard/projects/${serialId}/reports`, { params });

export const getProjectProperties = (serialId: string, params: Record<string, string | number>) =>
  api.get(`/api/dashboard/projects/${serialId}/properties`, { params });

export const getProjectStats = (serialId: string, params: Record<string, string | number>) =>
  api.get(`/api/dashboard/projects/${serialId}/stats`, { params });

export const getProjectUsers = (serialId: string) =>
  api.get(`/api/dashboard/projects/${serialId}/users`);

export const addProjectUser = (serialId: string, userId: string, accessLevel: string) =>
  api.post(`/api/dashboard/projects/${serialId}/users`, {
    dashboard_user_id: userId,
    access_level: accessLevel,
  });

export const removeProjectUser = (serialId: string, userId: string) =>
  api.delete(`/api/dashboard/projects/${serialId}/users/${userId}`);

export const updateProjectUserAccess = (serialId: string, userId: string, accessLevel: string) =>
  api.patch(`/api/dashboard/projects/${serialId}/users/${userId}`, {
    access_level: accessLevel,
  });

// ── Dashboard Users ───────────────────────────────────────────────────────────

export const getDashboardUsers = (params: Record<string, string | number>) =>
  api.get('/api/dashboard/users', { params });

export const createDashboardUser = (data: {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
  role: string;
  is_active: boolean;
  contact_number?: string;
}) => api.post('/api/dashboard/users', data);

export const getDashboardUserDetail = (userId: string) =>
  api.get(`/api/dashboard/users/${userId}`);

export const updateDashboardUser = (userId: string, data: Record<string, unknown>) =>
  api.patch(`/api/dashboard/users/${userId}`, data);

export const updateDashboardUserStatus = (userId: string, isActive: boolean) =>
  api.patch(`/api/dashboard/users/${userId}/status`, { is_active: isActive });

export const getDashboardUserProjects = (userId: string) =>
  api.get(`/api/dashboard/users/${userId}/projects`);

export const getRolesList = () =>
  api.get('/api/roles');

// ── Auth ──────────────────────────────────────────────────────────────────────

export const resetExpiredPassword = (
  email: string,
  currentPassword: string,
  newPassword: string
) => api.post('/api/dashboard/auth/reset-expired-password', {
  email,
  current_password: currentPassword,
  new_password: newPassword,
});

export const API_BASE = BASE_URL;
export default api;
