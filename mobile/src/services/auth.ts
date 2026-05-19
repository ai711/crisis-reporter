import api, { tokenStorage } from "./api";
import type { AnonymousSession, AuthTokens } from "../types";
import * as SecureStore from "expo-secure-store";
import * as Application from "expo-application";
import { Platform } from "react-native";
import { useAuthStore } from "../stores/authStore";

// ── Device ID ─────────────────────────────────────────────────────────────────

/**
 * Called once at app launch. Generates a CR-DEV-prefixed device ID on first
 * install and reads the OS-level Android ID. Both are written to SecureStore
 * and reflected into the auth store. Idempotent — no-op if already generated.
 */
export async function initDeviceId(): Promise<void> {
  const existing = await SecureStore.getItemAsync("cr_device_id");
  if (existing) {
    useAuthStore.getState().setDeviceId(existing);
    const osId = await SecureStore.getItemAsync("cr_os_device_id");
    if (osId) useAuthStore.getState().setOsDeviceId(osId);
    return;
  }

  const rand = Math.random().toString(36).substring(2, 10) +
               Math.random().toString(36).substring(2, 10);
  const deviceId = `CR-DEV-${rand}`;

  let osDeviceId: string | null = null;
  try {
    if (Platform.OS === "android") {
      osDeviceId = Application.getAndroidId();
    }
  } catch {
    osDeviceId = null;
  }

  await SecureStore.setItemAsync("cr_device_id", deviceId);
  if (osDeviceId) {
    await SecureStore.setItemAsync("cr_os_device_id", osDeviceId);
  }

  useAuthStore.getState().setDeviceId(deviceId);
  useAuthStore.getState().setOsDeviceId(osDeviceId);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const stored = await SecureStore.getItemAsync("cr_device_id");
  if (stored) return stored;

  let deviceId: string;

  if (Platform.OS === "android") {
    deviceId = Application.getAndroidId() || `android_${Math.random().toString(36).slice(2)}`;
  } else {
    deviceId = `mobile_${Math.random().toString(36).slice(2)}`;
  }

  await SecureStore.setItemAsync("cr_device_id", deviceId);
  return deviceId;
}

// ── Auth API calls ────────────────────────────────────────────────────────────

export async function createAnonymousSession(
  countryCode: string,
  languageCode: string
): Promise<AnonymousSession> {
  const deviceId = await getOrCreateDeviceId();

  const response = await api.post("/api/reporter/auth/anonymous", {
    device_id: deviceId,
    platform: "android",
    country_code: countryCode,
    language_code: languageCode,
  });

  await SecureStore.setItemAsync("cr_reporter_id", response.data.reporter_id);
  return response.data;
}

export async function registerReporter(
  email: string,
  password: string,
  countryCode: string,
  languageCode: string
): Promise<AuthTokens> {
  const deviceId = await getOrCreateDeviceId();

  const response = await api.post("/api/reporter/auth/register", {
    email,
    password,
    device_id: deviceId,
    platform: "android",
    country_code: countryCode,
    language_code: languageCode,
  });

  const tokens: AuthTokens = response.data;
  await tokenStorage.setTokens(
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
  const deviceId = await getOrCreateDeviceId();

  const response = await api.post("/api/reporter/auth/login", {
    email,
    password,
    device_id: deviceId,
    platform: "android",
  });

  const tokens: AuthTokens = response.data;
  await tokenStorage.setTokens(
    tokens.access_token,
    tokens.refresh_token,
    tokens.reporter_id
  );
  return tokens;
}

export async function logoutReporter(): Promise<void> {
  await tokenStorage.clearTokens();
  await SecureStore.deleteItemAsync("cr_reporter_id");
}