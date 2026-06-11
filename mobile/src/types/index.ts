export interface Crisis {
  id: string;
  name: string;
  country_code: string;
  is_active: boolean;
  map_center_lat: number | null;
  map_center_lng: number | null;
  map_default_radius_miles: number;
}

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

export type DamageLevel = "minimal" | "partial" | "complete";
export type Platform = "android" | "pwa" | "web";
export type FlagStatus = "grey" | "green" | "orange" | "red";
export type QueueItemStatus = "pending" | "syncing" | "sent" | "failed";

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
  crisis_id?: string;
  damage_level: DamageLevel;
  infrastructure_types: string[];
  infrastructure_other?: string;
  platform: Platform;
  submitted_at: string;
  location: LocationData;
  local_id?: string;
  reporter_id?: string;
  building_id?: string;
  description?: string;
  language_code: string;
  was_queued: boolean;
  queued_at?: string;
  mcc?: string;
  mnc?: string;
  carrier_name?: string;
  location_note?: string;
  location_method?: 'map_selection' | 'pin_drop' | 'manual';
  internet_available_at_location?: boolean;
  offline_map_pack_used?: boolean;
  building_name_osm?: string;
  building_type?: string;
  gps_accuracy?: number;
}

export interface ReportSubmitResponse {
  report_id: string;
  flag_status: FlagStatus;
  message: string;
}

export interface QueuedPhoto {
  uri: string;
  filename: string;
  content_type: string;
  display_order: number;
  persistent_uri?: string;
}

export type ProcessedPhoto = {
  uri: string;
  originalUri: string;
  mimeType: string;
  originalSize: number;
  finalSize: number;
  compressionApplied: boolean;
  formatConverted: boolean;
  exif: {
    dateTaken: string | null;
    dateDigitised: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    make: string | null;
    model: string | null;
    width: number | null;
    height: number | null;
  };
};

export interface QueuedReport {
  local_id: string;
  report: ReportSubmitRequest;
  photos: QueuedPhoto[];
  status: QueueItemStatus;
  retry_count: number;
  created_at: string;
  last_attempt_at: string | null;
}