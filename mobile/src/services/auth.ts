import api, { tokenStorage } from "./api";
import type { AnonymousSession, AuthTokens } from "../types";
import * as SecureStore from "expo-secure-store";
import * as Application from "expo-application";
import { Platform } from "react-native";
import { useAuthStore } from "../stores/authStore";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Device ID ─────────────────────────────────────────────────────────────────

// Shared promise so initDeviceId (called at app launch) and getOrCreateDeviceId
// (called at registration/submit) never race on first install. Whichever runs
// first sets this; subsequent callers await the same resolved promise.
let _deviceIdPromise: Promise<string> | null = null;

async function _resolveDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync("cr_device_id");
  if (existing) return existing;

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
  return deviceId;
}

/**
 * Called once at app launch. Generates a CR-DEV-prefixed device ID on first
 * install and reads the OS-level Android ID. Both are written to SecureStore
 * and reflected into the auth store. Idempotent — no-op if already generated.
 */
export async function initDeviceId(): Promise<void> {
  if (!_deviceIdPromise) _deviceIdPromise = _resolveDeviceId();
  const deviceId = await _deviceIdPromise;
  useAuthStore.getState().setDeviceId(deviceId);
  const osId = await SecureStore.getItemAsync("cr_os_device_id");
  if (osId) useAuthStore.getState().setOsDeviceId(osId);
}

export async function getOrCreateDeviceId(): Promise<string> {
  if (!_deviceIdPromise) _deviceIdPromise = _resolveDeviceId();
  return _deviceIdPromise;
}

// ── Auth API calls ────────────────────────────────────────────────────────────

export async function createAnonymousSession(
  countryCode: string,
  languageCode: string
): Promise<AnonymousSession> {
  const deviceId = await getOrCreateDeviceId();

  const response = await api.post("/api/reporter/auth/anonymous", {
    device_id: deviceId,
    platform: Platform.OS,
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
    platform: Platform.OS,
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
    platform: Platform.OS,
  });

  const tokens: AuthTokens = response.data;
  await tokenStorage.setTokens(
    tokens.access_token,
    tokens.refresh_token,
    tokens.reporter_id
  );

  // Merge any anonymous session reports to the verified account
  try {
    const storedDeviceId = await SecureStore.getItemAsync("cr_device_id");
    if (storedDeviceId) {
      await api.post("/api/reporters/merge-anonymous", {
        anonymous_device_id: storedDeviceId,
      });
    }
  } catch (e) {
    // Silent fail — merge is best-effort, login must not fail if merge fails
    console.warn("Anonymous merge failed silently:", e);
  }

  return tokens;
}

export async function logoutReporter(): Promise<void> {
  await tokenStorage.clearTokens();
  await SecureStore.deleteItemAsync("cr_reporter_id");
}

// ── Anonymous registration with offline queue fallback ────────────────────────

export async function registerAnonymously(): Promise<string> {
  // Use the shared promise so we never race against initDeviceId() writing to
  // SecureStore for the first time. Direct getItemAsync("cr_device_id") can
  // return null if initDeviceId() hasn't flushed the write yet.
  const deviceId = await getOrCreateDeviceId();
  const osDeviceId = await SecureStore.getItemAsync("cr_os_device_id");
  const tAndCAcceptedAt = await AsyncStorage.getItem("cr_tandc_accepted_at");
  const countryCode = await AsyncStorage.getItem("cr_country_code");
  const languageCode = await AsyncStorage.getItem("cr_language");

  const payload = {
    device_id: deviceId,
    os_device_id: osDeviceId,
    platform: "android",
    country_code: countryCode,
    language_code: languageCode,
    t_and_c_accepted_at: tAndCAcceptedAt,
  };

  try {
    const response = await api.post("/api/reporter/auth/anonymous", payload);
    const reporterId: string = response.data.reporter_id;
    await SecureStore.setItemAsync("cr_reporter_id", reporterId);
    useAuthStore.getState().setReporterId(reporterId);
    return reporterId;
  } catch {
    const existing = await AsyncStorage.getItem("cr_registration_queue");
    if (!existing) {
      await AsyncStorage.setItem("cr_registration_queue", JSON.stringify(payload));
    }
    const suffix = (deviceId ?? "unknown").substring(7, 15);
    const tempId = `CR-PENDING-${suffix}`;
    await SecureStore.setItemAsync("cr_reporter_id", tempId);
    useAuthStore.getState().setReporterId(tempId);
    return tempId;
  }
}

export async function syncRegistrationQueue(): Promise<void> {
  const queued = await AsyncStorage.getItem("cr_registration_queue");
  if (!queued) return;

  const currentId = await SecureStore.getItemAsync("cr_reporter_id");
  if (currentId && !currentId.startsWith("CR-PENDING-")) return;

  try {
    const payload = JSON.parse(queued);
    const response = await api.post("/api/reporter/auth/anonymous", payload);
    const reporterId: string = response.data.reporter_id;
    await SecureStore.setItemAsync("cr_reporter_id", reporterId);
    useAuthStore.getState().setReporterId(reporterId);
    await AsyncStorage.removeItem("cr_registration_queue");
  } catch {
    // Still offline — leave queue in place, retry next time
  }
}