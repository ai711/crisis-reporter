const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const CACHE_KEY = "cr_country_list";
const FETCH_TIMEOUT_MS = 5000;

export interface CachedCountry {
  code: string;
  name: string;
  is_active: boolean;
}

export interface CountryListResult {
  data: CachedCountry[] | null;
  fromCache: boolean;
}

// Module-level promise — ensures only one fetch fires per page load.
let _promise: Promise<CountryListResult> | null = null;

async function doFetch(): Promise<CountryListResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/api/countries`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CachedCountry[] = await res.json();

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch { /* localStorage unavailable */ }

    // Notify service worker to cache the countries endpoint.
    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "CACHE_COUNTRY_LIST",
          url: "/api/countries",
        });
      }
    } catch { /* ignore */ }

    return { data, fromCache: false };
  } catch {
    clearTimeout(timer);
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        return { data: JSON.parse(cached) as CachedCountry[], fromCache: true };
      }
    } catch { /* ignore */ }
    return { data: null, fromCache: false };
  }
}

/**
 * Starts (or reuses) the country list fetch for this page load.
 * Safe to call multiple times — the promise is memoised.
 */
export function fetchAndCacheCountries(): Promise<CountryListResult> {
  if (!_promise) {
    _promise = doFetch();
  }
  return _promise;
}

/**
 * Returns the result of the fetch already started by fetchAndCacheCountries().
 * OnboardingPage calls this to avoid a second network round-trip.
 */
export function getPreFetchedCountries(): Promise<CountryListResult> {
  return fetchAndCacheCountries();
}
