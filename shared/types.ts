/**
 * Canonical enum values — single source of truth derived from _SEED_KEYS in
 * backend/app/routers/language_packages.py.  Both web and mobile must use
 * these string literals; the backend validates against these same values.
 */

// Q1 — Damage level
export type DamageLevel = "minimal" | "partial" | "complete";

// Q2 — Infrastructure type (multi-select)
export type InfrastructureType =
  | "residential"
  | "commercial"
  | "government"
  | "utility"
  | "transport_comm"      // was: transport_communication
  | "community"
  | "public_spaces"
  | "other";

// Q3 — Area affected
export type AreaAffected =
  | "single_property"
  | "street_block"
  | "neighbourhood"
  | "district"
  | "entire_community";

// Q4 — Immediate risk
export type ImmediateRisk =
  | "no_risk"
  | "localised_risk"
  | "moderate_risk"
  | "severe_risk"
  | "unknown_risk";

// Q5 — Access level
export type AccessLevel =
  | "full_access"
  | "limited_access"
  | "no_access"
  | "unknown_access";

// Q6 — Population affected
export type PopulationAffected =
  | "no_displacement"
  | "some_displaced"
  | "mostly_displaced"
  | "all_displaced"
  | "unknown_displacement";

// Q7 — Health services condition
export type HealthServicesCondition =
  | "fully_functional"      // was: functional
  | "partially_functional"  // was: partial
  | "largely_disrupted"     // was: disrupted
  | "not_functioning"
  | "unknown";

// Q8 — Pressing needs (multi-select)
export type PressingNeed =
  | "food_water"
  | "cash"                  // was: cash_financial
  | "healthcare"
  | "shelter"
  | "livelihoods"
  | "wash"
  | "basic_services"
  | "protection"
  | "psychosocial"
  | "other_needs";

// Flag status — dashboard-only concept, never sent to reporter clients
export type FlagStatus = "grey" | "green" | "orange" | "red" | "discarded";
