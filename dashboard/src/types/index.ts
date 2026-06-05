// ── Roles ─────────────────────────────────────────────────────────────────────

export interface Role {
  id: string;
  name: string;
  is_default: boolean;
  description: string | null;
  permissions: Record<string, { view: boolean; edit: boolean }>;
  user_count: number;
  created_at: string;
  created_by_user_id: string | null;
  created_by_name: string | null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface DashboardUser {
  id: string;
  email: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  contact_number: string | null;
  profile_photo_url: string | null;
  role: string;
  role_permissions?: Record<string, { view: boolean; edit: boolean }>;
  // Auth-only fields (present on /me responses)
  last_login_at?: string | null;
  inactivity_timeout_minutes?: number;
  // User management fields (present on /users list and detail responses)
  is_active?: boolean;
  created_at?: string;
  created_by_user_id?: string | null;
  created_by_name?: string | null;
}

export interface DashboardUserDetail extends DashboardUser {
  project_assignments: UserProjectAssignment[];
}

export interface UserProjectAssignment {
  serial_id: string;
  project_name: string;
  countries: string[];
  status: string;
  access_level: 'view_only' | 'view_and_edit';
  is_creator: boolean;
  assigned_at: string;
}

export interface DashboardUsersListResponse {
  items: DashboardUser[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  inactivity_timeout_minutes: number;
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
export type FlagStatus = "grey" | "green" | "orange" | "red" | "discarded";
export type Platform = "android" | "pwa" | "web";

export interface ReportListItem {
  id: string;
  serial_number?: number | null;
  crisis_id: string;
  reporter_id: string | null;
  reporter_display_id: number | null;
  country: string | null;
  building_id: string | null;
  damage_level: string;
  infrastructure_type: string;
  disaster_type: string | null;
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
  created_at: string;
  exif_timestamp?: string | null;
}

export interface FlagEvent {
  id: string;
  flag_from: string | null;
  flag_to: string;
  changed_by: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  dashboard_user_id: string | null;
  dashboard_user_name?: string | null;
  is_emergency_override: boolean;
  created_at: string;
}

export interface ReportProjectRef {
  id: string;
  serial_id: string;
  name: string;
}

export interface VersionHistoryItem {
  id: string;
  serial_number?: number | null;
  submitted_at: string;
  damage_level: string;
  flag_status: string;
  infrastructure_type: string;
}

export interface QuestionAnswer {
  // New structured format (reporter app v2+)
  question_order?: number;
  option_value?: string;
  option_text?: string;
  option_values?: string[];
  option_texts?: string[];
  free_text?: string;
  other_text?: string | null;
  question_text?: string; // additional questions beyond Q8
  // Legacy format (backend-normalised dict → list of {question, answer})
  question?: string;
  answer?: unknown;
}

export interface ReportDetail extends ReportListItem {
  reporter_platform: string | null;
  reporter_country_code: string | null;
  reporter_is_verified: boolean | null;
  reporter_is_blocked: boolean | null;
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
  submission_started_at: string | null;
  submission_submitted_at: string | null;
  question_answers: QuestionAnswer[] | null;
  photos: PhotoSummary[];
  flag_events: FlagEvent[];
  versions: VersionHistoryItem[];
  network_type?: string | null;
  device_model?: string | null;
  app_version?: string | null;
  flow_started_at?: string | null;
  building_centroid_lat?: number | null;
  building_centroid_lng?: number | null;
  question_package_version?: string | null;
  electricity_condition?: string | null;
  health_services_condition?: string | null;
  pressing_needs?: string[] | string | null;
  pressing_needs_other?: string | null;
  photo_metadata?: string | null;
  infrastructure_name?: string | null;
  debris_blocking?: string | null;
  // New fields from audit
  property_id?: string | null;
  projects?: ReportProjectRef[];
  submission_ip?: string | null;
}

export interface ReportListResponse {
  items: ReportListItem[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── Reporters ─────────────────────────────────────────────────────────────────

export type ProfileStatus = 'active' | 'flagged' | 'blocked';
export type ProfileType = 'anonymous_no_reports' | 'anonymous_with_reports' | 'named_profile';

export interface ReporterListRow {
  reporter_id: string;
  profile_type: ProfileType;
  created_at: string;
  country: string | null;
  ip_address: string | null;
  platform: string | null;
  app_version: string | null;
  browser_version: string | null;
  total_reports: number;
  profile_status: ProfileStatus;
  last_active_at: string | null;
}

export interface ReporterDetail extends ReporterListRow {
  device_id: string | null;
  mcc: string | null;
  language_code: string | null;
  green_orange_reports: number;
  red_reports: number;
  discarded_reports: number;
  total_unique_properties: number;
  first_report_at: string | null;
  last_report_at: string | null;
  is_paused: boolean;
  pause_expires_at: string | null;
  pause_reason: string | null;
  device_model?: string | null;
  device_brand?: string | null;
  os_device_id?: string | null;
  network_type?: string | null;
}

export interface ReporterActivityEntry {
  id: number;
  action: string;
  previous_value: string | null;
  new_value: string | null;
  source: string;
  comment: string | null;
  matched_reporter_id: string | null;
  created_at: string;
}

export interface ReporterBadge {
  badge_name: string;
  earned_at: string | null;
}

export interface ReporterBadgesResponse {
  badges_eligible: boolean;
  badges: ReporterBadge[];
}

export interface ReportersListResponse {
  items: ReporterListRow[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// Keep legacy alias so PropertyDetailPage reporter rows still compile
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

// ── Map ───────────────────────────────────────────────────────────────────────

export interface MapPin {
  building_id: string | null;
  latitude: number;
  longitude: number;
  damage_level: DamageLevel;
  report_count: number;
  flag_status: FlagStatus;
  property_id?: string | null;
  property_name?: string | null;
  address?: string | null;
  confirmed_status?: DamageLevel | null;
  reporter_count?: number | null;
  last_report_at?: string | null;
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

// ── Properties ────────────────────────────────────────────────────────────────

export interface Property {
  property_id: string;
  building_id: string | null;
  display_name: string;
  address: string | null;
  country: string | null;
  crisis_id?: string | null;
  current_damage_level: string | null;
  confirmed_status: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  has_conflict_warning: boolean;
  total_reports: number;
  total_reporters: number;
  most_recent_report_at: string | null;
  is_recovered: boolean;
  property_status: "Active" | "Recovered";
  override_name: string | null;
  override_lat: number | null;
  override_lng: number | null;
  is_flagged_for_review: boolean;
  latitude: number;
  longitude: number;
}

export interface PropertyDetail extends Property {
  damage_distribution: {
    completely_destroyed: number;
    partially_damaged: number;
    minimal_or_no_damage: number;
  };
  conflict_warning_details: {
    majority_level: string;
    minority_count: number;
    minority_percentage: number;
  } | null;
  reporter_rows: ReporterRow[];
}

export interface ReporterRow {
  reporter_id: string;
  reporter_name: string | null;
  most_recent_damage_level: string;
  most_recent_submitted_at: string;
  platform: string;
  flag_status: string;
}

export interface PropertyComment {
  id: number;
  comment_text: string;
  is_system_generated: boolean;
  system_event_type: string | null;
  created_at: string;
  dashboard_user_name: string | null;
}

export interface VersionHistoryEntry {
  report_id: string;
  serial_number?: number | null;
  submitted_at: string;
  damage_level: string;
  flag_status: string;
  change_note: string | null;
}

export interface PropertiesListResponse {
  items: Property[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── Review Queue ──────────────────────────────────────────────────────────────

export interface ReviewQueueCounts {
  tab1_count: number;
  tab2_count: number;
  tab3_count: number;
  tab4_count: number;
}

export interface Tab1Row {
  report_id: string;
  serial_number?: number | null;
  flagged_at: string;
  country: string | null;
  damage_level: string | null;
  infrastructure_types: string[];
  crisis_type: string | null;
  flag_reasons: string[];
  reporter_id: string;
  reporter_display_id: string;
  time_in_queue: number; // seconds
  soft_lock: { reviewer_name: string; locked_at: string } | null;
}

export interface Tab2Row {
  property_id: string;
  display_name: string;
  country: string | null;
  current_damage_level: string | null;
  has_conflict_warning: boolean;
  is_flagged_for_review: boolean;
  flagged_for_review_note: string | null;
  review_reason: string;
  time_in_queue: number; // seconds
  soft_lock: { reviewer_name: string; locked_at: string } | null;
}

export interface Tab3Row {
  report_id: string;
  serial_number?: number | null;
  received_at: string;
  country: string | null;
  damage_level: string | null;
  platform: string | null;
  reporter_id: string;
  reporter_display_id: string;
  time_stuck_seconds: number;
  soft_lock: { reviewer_name: string; locked_at: string } | null;
}

export interface Tab4Row {
  reporter_id: string;
  auto_blocked_at: string;
  device_id: string | null;
  matched_blocked_reporter_id: string | null;
  time_remaining_seconds: number;
  soft_lock: { reviewer_name: string; locked_at: string } | null;
}

export interface ReviewQueueListResponse<T> {
  items: T[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

export interface ReviewPanelFlag {
  reason: string;
  label: string;
  detail: string | null;
  checked: boolean;
}

export interface ReviewPanelState {
  flags: ReviewPanelFlag[];
  decision: 'approve' | 'discard' | null;
  comment: string;
  isSubmitting: boolean;
  submitError: string | null;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'closed' | 'archived';

export interface ProjectListRow {
  id: string;
  serial_id: string;
  name: string;
  countries: string[];
  start_date: string;
  end_date: string;
  total_reports: number;
  status: ProjectStatus;
  created_at: string;
  created_by_name: string | null;
  created_by_user_id: string | null;
  import_status: string;
  description: string | null;
}

export interface ProjectDetail extends ProjectListRow {
  map_center_lat: number | null;
  map_center_lng: number | null;
  import_progress: number;
  import_total: number;
}

export interface ProjectUser {
  dashboard_user_id: string;
  full_name: string;
  email: string;
  role: string;
  access_level: 'view_only' | 'view_and_edit';
  is_creator: boolean;
  assigned_at: string;
}

export interface ProjectsListResponse {
  items: ProjectListRow[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── SSE Events ────────────────────────────────────────────────────────────────

export interface SSEEvent {
  type:
    | "connected"
    | "heartbeat"
    | "report_confirmed"
    | "flag_changed"
    | "reporter_status_changed"
    | "review_queue_updated"
    | "property_comment_added"
    | "property_updated"
    | "stuck_report"
    | "error";
  crisis_id?: string;
  report_id?: string;
  property_id?: string;
  flag_status?: FlagStatus;
  flag_from?: FlagStatus;
  flag_to?: FlagStatus;
  latitude?: number;
  longitude?: number;
  damage_level?: DamageLevel;
  platform?: Platform;
  minutes_stuck?: number;
  ts?: string;
  message?: string;
}
