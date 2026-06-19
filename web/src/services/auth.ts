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

export async function logoutReporter(): Promise<void> {
  try {
    await api.post("/api/reporter/auth/logout");
  } catch {
    // Best-effort — clear local state even if the server call fails
  }
  tokenStorage.clearTokens();
}

// ── Offline anonymous registration queue ──────────────────────────────────────
// When the backend is unreachable during "Skip for now", we persist the
// registration payload so flushPendingAnonRegistration() can retry as soon as
// connectivity is restored (wired in main.tsx to the online event + startup).

const PENDING_REG_KEY = "cr_pending_anon_registration";

export type PendingAnonReg = {
  device_id: string;
  platform: string;
  country_code: string | null;
  language_code: string;
  tc_accepted_at: string;
};

export function queueAnonRegistration(payload: PendingAnonReg): void {
  try {
    localStorage.setItem(PENDING_REG_KEY, JSON.stringify(payload));
  } catch { /* ignore */ }
}

export async function flushPendingAnonRegistration(
  onSuccess: (reporterId: string) => void
): Promise<void> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_REG_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let payload: PendingAnonReg;
  try {
    payload = JSON.parse(raw) as PendingAnonReg;
  } catch {
    try { localStorage.removeItem(PENDING_REG_KEY); } catch { /* ignore */ }
    return;
  }

  try {
    const res = await api.post<{
      reporter_id: string;
      access_token?: string;
      refresh_token?: string;
    }>("/api/reporters/register", payload);
    const { reporter_id, access_token, refresh_token } = res.data;
    if (!reporter_id) return;
    if (access_token) {
      tokenStorage.setTokens(access_token, refresh_token ?? "", reporter_id);
    }
    try { localStorage.setItem("cr_reporter_id", reporter_id); } catch { /* ignore */ }
    try { localStorage.removeItem(PENDING_REG_KEY); } catch { /* ignore */ }
    onSuccess(reporter_id);
  } catch {
    // Still offline or server error — leave queued, retry on next online event.
  }
}
