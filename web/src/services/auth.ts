import { WEB_SESSION_ID } from "../utils/sessionId";
import api, { tokenStorage } from "./api";
import type { AnonymousSession, AuthTokens } from "../types";

// ── Platform detection ────────────────────────────────────────────────────────

export function detectPlatform(): "pwa" | "web" {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return isStandalone ? "pwa" : "web";
}

// ── Auth API calls ────────────────────────────────────────────────────────────

export async function createAnonymousSession(
  countryCode: string,
  languageCode: string
): Promise<AnonymousSession> {
  const response = await api.post("/api/reporter/auth/anonymous", {
    device_id: WEB_SESSION_ID,
    platform: detectPlatform(),
    country_code: countryCode,
    language_code: languageCode,
  });

  localStorage.setItem("cr_reporter_id", response.data.reporter_id);
  return response.data as AnonymousSession;
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
    device_id: WEB_SESSION_ID,
    platform: detectPlatform(),
    country_code: countryCode,
    language_code: languageCode,
  });

  const tokens = response.data as AuthTokens;
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token, tokens.reporter_id);
  return tokens;
}

export async function loginReporter(
  email: string,
  password: string
): Promise<AuthTokens> {
  const response = await api.post("/api/reporter/auth/login", {
    email,
    password,
    device_id: WEB_SESSION_ID,
    platform: detectPlatform(),
  });

  const tokens = response.data as AuthTokens;
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token, tokens.reporter_id);
  return tokens;
}

export function logoutReporter(): void {
  tokenStorage.clearTokens();
  localStorage.removeItem("cr_reporter_id");
}
