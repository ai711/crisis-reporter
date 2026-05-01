import api, { tokenStorage } from "./api";
import type { AnonymousSession, AuthTokens } from "../types";

// ── Device ID ─────────────────────────────────────────────────────────────────

const DEVICE_ID_KEY = "cr_device_id";

export function getOrCreateDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = `web_${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

// ── Platform detection ────────────────────────────────────────────────────────

export function detectPlatform(): "pwa" | "web" {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true;
  return isStandalone ? "pwa" : "web";
}

// ── Auth API calls ────────────────────────────────────────────────────────────

export async function createAnonymousSession(
  countryCode: string,
  languageCode: string
): Promise<AnonymousSession> {
  const response = await api.post("/api/reporter/auth/anonymous", {
    device_id: getOrCreateDeviceId(),
    platform: detectPlatform(),
    country_code: countryCode,
    language_code: languageCode,
  });
  
  // Store reporter ID for offline queue
  localStorage.setItem("cr_reporter_id", response.data.reporter_id);
  
  return response.data;
}

export async function registerReporter(
  email: string,
  password: string,
  countryCode: string,
  languageCode: string
): Promise<AuthTokens> {
  const response = await api.post("/api/reporter/auth/register", {
    email,
    password,
    device_id: getOrCreateDeviceId(),
    platform: detectPlatform(),
    country_code: countryCode,
    language_code: languageCode,
  });

  const tokens: AuthTokens = response.data;
  tokenStorage.setTokens(
    tokens.access_token,
    tokens.refresh_token,
    tokens.reporter_id
  );

  return tokens;
}

export async function loginReporter(
  email: string,
  password: string
): Promise<AuthTokens> {
  const response = await api.post("/api/reporter/auth/login", {
    email,
    password,
    device_id: getOrCreateDeviceId(),
    platform: detectPlatform(),
  });

  const tokens: AuthTokens = response.data;
  tokenStorage.setTokens(
    tokens.access_token,
    tokens.refresh_token,
    tokens.reporter_id
  );

  return tokens;
}

export function logoutReporter(): void {
  tokenStorage.clearTokens();
  localStorage.removeItem("cr_reporter_id");
}