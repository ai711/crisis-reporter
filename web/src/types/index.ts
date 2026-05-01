// ── Crisis ────────────────────────────────────────────────────────────────────

export interface Crisis {
  id: string;
  name: string;
  country_code: string;
  description: string | null;
  is_active: boolean;
  map_center_lat: number | null;
  map_center_lng: number | null;
  map_default_radius_miles: number;
  created_at: string;
  updated_at: string;
}

// ── Reporter ──────────────────────────────────────────────────────────────────

export interface AnonymousSession {
  reporter_id: string;
  is_verified: boolean;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  reporter_id: string;
  is_verified: boolean;
}

// ── Report ────────────────────────────────────────────────────────────────────

export type DamageLevel = "minimal" | "partial" | "complete";
export type Platform = "android" | "pwa" | "web";
export type FlagStatus = "grey" | "green" | "orange" | "red";

export interface LocationData {
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_accuracy_meters: number | null;
  gps_available: boolean;
  location_address: string | null;
  location_landmark: string | null;
  location_building_name: string | null;
}

export interface ReportSubmitRequest {
  crisis_id: string;
  damage_level: DamageLevel;
  infrastructure_type: string;
  platform: Platform;
  submitted_at: string;
  location: LocationData;
  local_id?: string;
  reporter_id?: string;
  building_id?: string;
  building_name?: string;
  description?: string;
  language_code: string;
  app_version?: string;
  was_queued: boolean;
  queued_at?: string;
}

export interface ReportSubmitResponse {
  report_id: string;
  flag_status: FlagStatus;
  message: string;
}

// ── Offline Queue ─────────────────────────────────────────────────────────────

export type QueueItemStatus = "pending" | "syncing" | "sent" | "failed";

export interface QueuedPhoto {
  blob: Blob;
  filename: string;
  content_type: string;
  display_order: number;
}

export interface QueuedReport {
  local_id: string;
  report: ReportSubmitRequest;
  photos: QueuedPhoto[];
  status: QueueItemStatus;
  retry_count: number;
  created_at: string;
  last_attempt_at: string | null;
}

// ── Map ───────────────────────────────────────────────────────────────────────

export interface MapPin {
  building_id: string | null;
  latitude: number;
  longitude: number;
  damage_level: DamageLevel;
  report_count: number;
  flag_status: FlagStatus;
}