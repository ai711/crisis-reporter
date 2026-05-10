// ── Auth ──────────────────────────────────────────────────────────────────────

export interface DashboardUser {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "analyst" | "superadmin";
  last_login_at: string | null;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

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

// ── Reports ───────────────────────────────────────────────────────────────────

export type DamageLevel = "minimal" | "partial" | "complete";
export type FlagStatus = "grey" | "green" | "orange" | "red";
export type Platform = "android" | "pwa" | "web";

export interface ReportListItem {
  id: string;
  crisis_id: string;
  reporter_id: string | null;
  building_id: string | null;
  damage_level: DamageLevel;
  infrastructure_type: string;
  flag_status: FlagStatus;
  platform: Platform;
  gps_latitude: number | null;
  gps_longitude: number | null;
  submitted_at: string;
  created_at: string;
  photo_count: number;
}

export interface PhotoSummary {
  id: string;
  url: string;
  display_order: number;
  was_compressed: boolean;
}

export interface FlagEvent {
  id: string;
  flag_from: string | null;
  flag_to: string;
  changed_by: string;
  reason: string | null;
  created_at: string;
}

export interface ReportDetail extends ReportListItem {
  building_name: string | null;
  description: string | null;
  description_translated: string | null;
  language_code: string;
  gps_available: boolean;
  location_address: string | null;
  location_landmark: string | null;
  was_queued: boolean;
  mcc: string | null;
  carrier_name: string | null;
  photos: PhotoSummary[];
  flag_events: FlagEvent[];
}

export interface ReportListResponse {
  items: ReportListItem[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── Reporters ─────────────────────────────────────────────────────────────────

export interface ReporterListItem {
  id: string;
  platform: Platform;
  country_code: string | null;
  language_code: string;
  is_verified: boolean;
  is_blocked: boolean;
  report_count: number;
  last_active_at: string | null;
  created_at: string;
}

export interface ReporterDetail extends ReporterListItem {
  email: string | null;
  block_reason: string | null;
  blocked_at: string | null;
}

export interface ReporterListResponse {
  items: ReporterListItem[];
  total: number;
  cursor: string | null;
  has_more: boolean;
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

export interface MapPinsResponse {
  pins: MapPin[];
  total: number;
}

export interface DashboardStats {
  total_reports: number;
  green_count: number;
  orange_count: number;
  red_count: number;
  grey_count: number;
  review_queue_count: number;
}

// ── SSE Events ────────────────────────────────────────────────────────────────

export interface SSEEvent {
  type: "connected" | "heartbeat" | "report_confirmed" | "flag_changed" | "reporter_status_changed" | "review_queue_updated" | "error";
  crisis_id?: string;
  report_id?: string;
  flag_status?: FlagStatus;
  flag_from?: FlagStatus;
  flag_to?: FlagStatus;
  latitude?: number;
  longitude?: number;
  damage_level?: DamageLevel;
  platform?: Platform;
  ts?: string;
  message?: string;
}