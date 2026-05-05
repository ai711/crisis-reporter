import axios from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import * as SecureStore from "expo-secure-store";

const BASE_URL = "https://crisis-reporter-production.up.railway.app";

export const API_BASE = BASE_URL;

const api = axios.create({
  baseURL: BASE_URL,
  headers: { "Content-Type": "application/json" },
});

// ── Token storage — SecureStore for native security ───────────────────────────

const TOKEN_KEY = "cr_access_token";
const REFRESH_KEY = "cr_refresh_token";
const REPORTER_ID_KEY = "cr_reporter_id";

export const tokenStorage = {
  getAccessToken: async () => SecureStore.getItemAsync(TOKEN_KEY),
  getRefreshToken: async () => SecureStore.getItemAsync(REFRESH_KEY),
  getReporterId: async () => SecureStore.getItemAsync(REPORTER_ID_KEY),

  setTokens: async (access: string, refresh: string, reporterId: string) => {
    await SecureStore.setItemAsync(TOKEN_KEY, access);
    await SecureStore.setItemAsync(REFRESH_KEY, refresh);
    await SecureStore.setItemAsync(REPORTER_ID_KEY, reporterId);
  },

  clearTokens: async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
    await SecureStore.deleteItemAsync(REPORTER_ID_KEY);
  },
};

// ── Request interceptor ───────────────────────────────────────────────────────

api.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const token = await tokenStorage.getAccessToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor — silent token refresh ───────────────────────────────
// CRITICAL: Token refresh must NEVER interrupt active form flow or submission.

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else if (token) resolve(token);
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
      await tokenStorage.clearTokens();
      return Promise.reject(error);
    }

    const refreshToken = await tokenStorage.getRefreshToken();
    if (!refreshToken) {
      await tokenStorage.clearTokens();
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((token) => {
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return api(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const response = await axios.post(
        `${BASE_URL}/api/reporter/auth/refresh`,
        { refresh_token: refreshToken }
      );
      const { access_token, refresh_token, reporter_id } = response.data;
      await tokenStorage.setTokens(access_token, refresh_token, reporter_id);
      processQueue(null, access_token);
      originalRequest.headers.Authorization = `Bearer ${access_token}`;
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await tokenStorage.clearTokens();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;