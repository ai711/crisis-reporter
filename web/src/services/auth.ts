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

  const tokens: AuthTokens = { ...response.data, reporter_id: String(response.data.reporter_id) };
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token, tokens.reporter_id);

  // Merge any anonymous session reports to the verified account (best-effort).
  try {
    await api.post("/api/reporters/merge-anonymous", {
      anonymous_device_id: WEB_SESSION_ID,
    });
  } catch {
    // Silent fail — merge is best-effort; registration must not fail if merge fails.
  }

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

  const tokens: AuthTokens = { ...response.data, reporter_id: String(response.data.reporter_id) };
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token, tokens.reporter_id);

  // Merge any anonymous session reports to the verified account (best-effort).
  try {
    await api.post("/api/reporters/merge-anonymous", {
      anonymous_device_id: WEB_SESSION_ID,
    });
  } catch {
    // Silent fail — merge is best-effort; login must not fail if merge fails.
  }

  return tokens;
}

export function logoutReporter(): void {
  tokenStorage.clearTokens();
  localStorage.removeItem("cr_reporter_id");
}
