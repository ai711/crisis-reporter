import axios from "axios";
import type { AxiosInstance, InternalAxiosRequestConfig } from "axios";

const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// ── Create axios instance ─────────────────────────────────────────────────────

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  withCredentials: true, // send HttpOnly cookies on every request
  headers: {
    "Content-Type": "application/json",
  },
});

// ── Token storage helpers ─────────────────────────────────────────────────────
// Web app uses HttpOnly cookies for access/refresh tokens (XSS-safe).
// localStorage only tracks whether the user is authenticated (reporter ID).
// Mobile (React Native) uses SecureStore + Bearer header — unaffected by this.

const REPORTER_ID_KEY = "cr_reporter_id";

export const tokenStorage = {
  /** Returns a truthy sentinel if the user is authenticated, null otherwise.
   *  The actual token lives in an HttpOnly cookie — JS cannot read it. */
  getAccessToken: (): string | null =>
    localStorage.getItem(REPORTER_ID_KEY) ? "cookie-auth" : null,

  /** Always null — refresh token is in an HttpOnly cookie. */
  getRefreshToken: (): null => null,

  getReporterId: () => localStorage.getItem(REPORTER_ID_KEY),

  /** Only stores the reporter ID; tokens are set as cookies by the server. */
  setTokens: (_accessToken: string, _refreshToken: string, reporterId: string) => {
    localStorage.setItem(REPORTER_ID_KEY, reporterId);
  },

  clearTokens: () => {
    localStorage.removeItem(REPORTER_ID_KEY);
  },
};

// ── Request interceptor — no Bearer header needed (cookie handles auth) ───────

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => config,
  (error) => Promise.reject(error)
);

// ── Response interceptor — silent token refresh ───────────────────────────────
// CRITICAL: Token refresh must NEVER interrupt active form flow or submission.
// This interceptor handles refresh at the HTTP layer — invisible to the UI.
// The refresh call sends the HttpOnly cookie; the server rotates both cookies.

let isRefreshing = false;
let failedQueue: Array<{
  resolve: () => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    // Only attempt refresh on 401 errors that haven't been retried
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    // Don't refresh if this is the refresh endpoint itself
    if (originalRequest.url?.includes("/auth/refresh")) {
      tokenStorage.clearTokens();
      return Promise.reject(error);
    }

    // No reporter ID means the user is not logged in — don't attempt refresh
    if (!tokenStorage.getReporterId()) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Queue this request until refresh completes
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then(() => api(originalRequest));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      // Cookie is sent automatically — no body token needed
      await axios.post(
        `${BASE_URL}/api/reporter/auth/refresh`,
        {},
        { withCredentials: true }
      );

      // Server rotated cookies; retry queued requests (they'll use the new cookie)
      processQueue(null);
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError);
      tokenStorage.clearTokens();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
