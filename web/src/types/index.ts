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
  gps_denied?: boolean | null;
  location_address: string | null;
  location_landmark: string | null;
  location_building_name: string | null;
  building_centroid_lat?: number | null;
  building_centroid_lng?: number | null;
  building_name_osm?: string | null;
  building_name_reporter?: string | null;
  location_note?: string | null;
  location_entry_method?: string | null;
  location_internet_available?: boolean | null;
  building_type?: string | null;
  pin_drop_lat?: number | null;
  pin_drop_lng?: number | null;
}

export interface ReportSubmitRequest {
  crisis_id?: string;
  damage_level: DamageLevel;
  infrastructure_types: string[];      // plural array — matches backend
  infrastructure_other?: string;
  infrastructure_name?: string;
  platform: Platform;
  submitted_at: string;
  location: LocationData;
  local_id?: string;
  reporter_id?: string;
  building_id?: string;
  building_name?: string;
  language_code: string;
  app_version?: string;
  was_queued: boolean;
  queued_at?: string;
  // UNDP question fields
  disaster_type?: string;
  debris_blocking?: string;
  electricity_condition?: string;
  health_services_condition?: string;
  pressing_needs?: string[];
  pressing_needs_other?: string;
  // Anti-spam signals — captured silently client-side
  browser_timezone?: string;
  screen_resolution?: string;
  viewport_dimensions?: string;
}

export interface ReportSubmitResponse {
  report_id: string;
  serial_number?: number | null;
  message: string;
  // flag_status intentionally omitted — internal concept, must not reach reporter clients
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
  // Set once the report is on the server — retries skip POST /api/reports and
  // only upload the photos still in `photos` (uploaded ones are removed).
  existing_report_id?: string;
  // The server rejected the report as invalid (4xx) — not retried automatically
  permanent_error?: boolean;
}

