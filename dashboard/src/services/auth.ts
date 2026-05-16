import api, { tokenStorage } from "./api";
import type { DashboardUser, AuthTokens } from "../types";

export async function login(
  email: string,
  password: string
): Promise<{ tokens: AuthTokens; user: DashboardUser }> {
  const response = await api.post("/api/dashboard/auth/login", {
    email,
    password,
  });
  const tokens: AuthTokens = response.data;
  tokenStorage.setTokens(tokens.access_token, tokens.refresh_token);

  const userResponse = await api.get("/api/dashboard/auth/me");
  return { tokens, user: userResponse.data };
}

export async function getMe(): Promise<DashboardUser> {
  const response = await api.get("/api/dashboard/auth/me");
  return response.data;
}

/**
 * Logout — calls the backend to record the logout, then always clears local
 * tokens regardless of whether the backend call succeeds.
 */
export async function logout(): Promise<void> {
  try {
    await api.post("/api/dashboard/auth/logout");
  } catch {
    // Network failure or expired token — proceed with local logout anyway
  } finally {
    tokenStorage.clearTokens();
  }
}

export function isAuthenticated(): boolean {
  return !!tokenStorage.getAccessToken();
}
