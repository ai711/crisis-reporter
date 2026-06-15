import AsyncStorage from "@react-native-async-storage/async-storage";

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function milesToKm(miles: number): number {
  return miles * 1.60934;
}

/** Returns [west, south, east, north] bounding box for a circle. */
export function radiusBBox(
  centerLat: number,
  centerLng: number,
  radiusMiles: number
): [number, number, number, number] {
  const km = milesToKm(radiusMiles);
  const latDelta = km / 111.32;
  const lngDelta = km / (111.32 * Math.cos(centerLat * Math.PI / 180));
  return [
    centerLng - lngDelta,
    centerLat - latDelta,
    centerLng + lngDelta,
    centerLat + latDelta,
  ];
}

const CRISIS_META_KEY = "cr_crisis_meta";

export interface CrisisMeta {
  id: string;
  map_center_lat: number | null;
  map_center_lng: number | null;
  map_default_radius_miles: number;
  cached_at: string;
}

export async function saveCrisisMeta(meta: CrisisMeta): Promise<void> {
  try {
    await AsyncStorage.setItem(CRISIS_META_KEY, JSON.stringify(meta));
  } catch { /* storage error — skip */ }
}

export async function loadCrisisMeta(): Promise<CrisisMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(CRISIS_META_KEY);
    return raw ? (JSON.parse(raw) as CrisisMeta) : null;
  } catch {
    return null;
  }
}
