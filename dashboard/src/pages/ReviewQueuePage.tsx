import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, AlertTriangle, Lock } from "lucide-react";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import {
  getReviewQueueCounts,
  getTab1Reports,
  getTab2Properties,
  getTab3StuckReports,
  getTab4AutoBlocked,
  dismissPropertyFromReview,
  confirmAutoBlock,
  reverseAutoBlock,
  forceResolution,
} from "../services/api";
import {
  formatDateTime,
  formatDamageLevel,
  formatTimeInQueue,
  formatCountdown,
} from "../utils/formatters";
import type {
  ReviewQueueCounts,
  Tab1Row,
  Tab2Row,
  Tab3Row,
  Tab4Row,
  ReviewQueueListResponse,
} from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE  = "var(--c-primary-container)";
const AMBER = "var(--c-flag-amber)";
const RED   = "var(--c-flag-red)";
const GREEN = "var(--c-flag-green)";
const PAGE_SIZE = 25;

const FLAG_REASON_LABELS: Record<string, string> = {
  ip_country_mismatch:        "IP Country Mismatch",
  same_ip_multiple_devices:   "Same IP Multiple Devices",
  duplicate_image:            "Duplicate Image",
  coordinated_gps_duplicate:  "Coordinated GPS Duplicate",
  high_submission_rate:       "High Submission Rate",
  no_photos:                  "No Photos",
  no_location:                "No Location",
  blocked_device:             "Blocked Device",
  blocked_ip:                 "Blocked IP",
  duplicate_submission:       "Duplicate Submission",
};

const KNOWN_FLAG_REASONS = [
  "IP Country Mismatch",
  "Same IP Multiple Devices",
  "Duplicate Image",
  "Coordinated GPS Duplicate",
  "High Submission Rate",
  "No Photos",
  "No Location",
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeQueueColor(seconds: number): string {
  if (seconds > 86400) return "var(--c-flag-red)";
  if (seconds > 3600)  return "var(--c-flag-amber)";
  return "var(--c-text-secondary)";
}

function timeRemainingColor(seconds: number): string {
  if (seconds < 3600)  return "var(--c-flag-red)";
  if (seconds < 86400) return "var(--c-flag-amber)";
  return "var(--c-flag-green)";
}

function flagReasonLabel(r: string): string {
  return (
    FLAG_REASON_LABELS[r] ??
    r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function damagePillColors(level: string | null): { bg: string; color: string } {
  const map: Record<string, { bg: string; color: string }> = {
    complete:              { bg: "#FFF5F5", color: "var(--c-flag-red)" },
    completely_destroyed:  { bg: "#FFF5F5", color: "var(--c-flag-red)" },
    partial:               { bg: "#FFF8F0", color: "var(--c-flag-orange)" },
    partially_damaged:     { bg: "#FFF8F0", color: "var(--c-flag-orange)" },
    minimal:               { bg: "#F0FFF4", color: "var(--c-flag-green)" },
    minimal_or_no_damage:  { bg: "#F0FFF4", color: "var(--c-flag-green)" },
  };
  return map[level ?? ""] ?? { bg: "var(--c-surface-low)", color: "var(--c-text-secondary)" };
}

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: "3px solid var(--c-surface-high)",
        borderTop: `3px solid var(--c-primary-container)`,
        borderRadius: "50%",
        animation: "rq-spin 0.8s linear infinite",
      }}
    />
  );
}

// ── SoftLockBadge ──────────────────────────────────────────────────────────────

function SoftLockBadge({
  softLock,
}: {
  softLock: { reviewer_name: string; locked_at: string } | null;
}) {
  if (!softLock) return null;
  return (
    <span
      style={{
        color: AMBER,
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap" as const,
      }}
    >
      <Lock size={12} />
      In review by {softLock.reviewer_name}
    </span>
  );
}

// ── ConfirmActionModal ─────────────────────────────────────────────────────────

interface ConfirmActionModalProps {
  title: string;
  description: string;
  actionLabel: string;
  actionColor: string;
  onConfirm: (comment: string) => Promise<void>;
  onCancel: () => void;
}

function ConfirmActionModal({
  title,
  description,
  actionLabel,
  actionColor,
  onConfirm,
  onCancel,
}: ConfirmActionModalProps) {
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = comment.trim().length >= 10 && !loading;

  async function handleConfirm() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await onConfirm(comment.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Action failed. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={ms.backdrop}>
      <div style={ms.dialog}>
        <h3 style={ms.title}>{title}</h3>
        <p style={ms.desc}>{description}</p>
        <div style={ms.field}>
          <label style={ms.label}>
            Comment{" "}
            <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>
              (required, min 10 chars)
            </span>
          </label>
          <textarea
            style={ms.textarea}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Enter reason or notes…"
          />
          <span style={ms.charCount}>{comment.trim().length} / 10 min</span>
        </div>
        {error && <div style={ms.error}>{error}</div>}
        <div style={ms.actions}>
          <button style={ms.cancelBtn} onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button
            style={{
              ...ms.confirmBtn,
              background: actionColor,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
            onClick={handleConfirm}
            disabled={!canSubmit}
          >
            {loading ? "Processing…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ForceResolutionModal ───────────────────────────────────────────────────────

interface ForceResolutionModalProps {
  reportId: string;
  onClose: () => void;
  onSuccess: () => void;
}

function ForceResolutionModal({
  reportId,
  onClose,
  onSuccess,
}: ForceResolutionModalProps) {
  const [targetStatus, setTargetStatus] = useState<"green" | "red">("green");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = reason.trim().length >= 10 && !loading;

  async function handleConfirm() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await forceResolution(reportId, targetStatus, reason.trim());
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Action failed. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={ms.backdrop}>
      <div style={ms.dialog}>
        <h3 style={ms.title}>Force Resolution</h3>
        <p style={ms.desc}>
          Manually resolve this stuck report to a final status. This cannot be
          undone.
        </p>
        <div style={ms.field}>
          <label style={ms.label}>Target Status</label>
          <select
            style={ms.select}
            value={targetStatus}
            onChange={(e) =>
              setTargetStatus(e.target.value as "green" | "red")
            }
          >
            <option value="green">Green — Verified</option>
            <option value="red">Red — Rejected</option>
          </select>
        </div>
        <div style={ms.field}>
          <label style={ms.label}>
            Reason{" "}
            <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>
              (required, min 10 chars)
            </span>
          </label>
          <textarea
            style={ms.textarea}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Enter reason for force resolution…"
          />
          <span style={ms.charCount}>{reason.trim().length} / 10 min</span>
        </div>
        {error && <div style={ms.error}>{error}</div>}
        <div style={ms.actions}>
          <button style={ms.cancelBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            style={{
              ...ms.confirmBtn,
              background: BLUE,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
            onClick={handleConfirm}
            disabled={!canSubmit}
          >
            {loading ? "Processing…" : "Force Resolve"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab 1: Red-flagged Reports ─────────────────────────────────────────────────

function Tab1({ currentUserName }: { currentUserName: string }) {
  const [search, setSearch] = useState("");
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [country, setCountry] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showReasonDropdown, setShowReasonDropdown] = useState(false);
  const [allItems, setAllItems] = useState<Tab1Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const filterParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search) filterParams.search = search;
  if (selectedReasons.length > 0)
    filterParams.flag_reasons = selectedReasons.join(",");
  if (country) filterParams.country = country;
  if (dateFrom) filterParams.date_from = dateFrom;
  if (dateTo) filterParams.date_to = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue-tab1", filterParams],
    queryFn: async () => {
      const res = await getTab1Reports(filterParams);
      return res.data as ReviewQueueListResponse<Tab1Row>;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!data) return;
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab1Reports({ ...filterParams, cursor: nextCursor });
      const d = res.data as ReviewQueueListResponse<Tab1Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleReason(r: string) {
    setSelectedReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
    );
  }

  const filtersActive =
    [search, country, dateFrom, dateTo].filter(Boolean).length +
    selectedReasons.length;

  function clearFilters() {
    setSearch("");
    setSelectedReasons([]);
    setCountry("");
    setDateFrom("");
    setDateTo("");
  }

  function getReviewBtn(row: Tab1Row) {
    if (!row.soft_lock) {
      return (
        <button
          className="btn btn-primary"
          onClick={() =>
            window.open("/reports/" + row.report_id + "?from=queue", "_blank")
          }
        >
          Review →
        </button>
      );
    }
    if (row.soft_lock.reviewer_name === currentUserName) {
      return (
        <button
          className="btn btn-primary"
          onClick={() =>
            window.open("/reports/" + row.report_id + "?from=queue", "_blank")
          }
        >
          Resume →
        </button>
      );
    }
    return (
      <button
        className="btn btn-secondary"
        style={{ cursor: "not-allowed", opacity: 0.6 }}
        disabled
      >
        Locked
      </button>
    );
  }

  return (
    <div>
      <div style={s.filterBar}>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search by Report ID or Reporter ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ position: "relative" }}>
          <button
            className="input"
            style={s.filterSelectBtn}
            onClick={() => setShowReasonDropdown((v) => !v)}
          >
            Flag Reasons
            {selectedReasons.length > 0 ? ` (${selectedReasons.length})` : ""}{" "}
            ▾
          </button>
          {showReasonDropdown && (
            <div style={s.dropdownMenu}>
              {KNOWN_FLAG_REASONS.map((r) => (
                <label key={r} style={s.dropdownItem}>
                  <input
                    type="checkbox"
                    checked={selectedReasons.includes(r)}
                    onChange={() => toggleReason(r)}
                    style={{ marginRight: 6 }}
                  />
                  {r}
                </label>
              ))}
            </div>
          )}
        </div>
        <input
          className="input"
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="date"
            className="input"
            style={s.filterInputSm}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span style={{ color: "var(--c-text-subtle)", fontSize: 12 }}>–</span>
          <input
            type="date"
            className="input"
            style={s.filterInputSm}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {filtersActive > 0 && (
          <>
            <span className="chip chip-blue">Filters active: {filtersActive}</span>
            <button style={s.clearFiltersBtn} onClick={clearFilters}>
              Clear all
            </button>
          </>
        )}
      </div>

      {isLoading ? (
        <div style={s.centred}>
          <Spinner />
        </div>
      ) : allItems.length === 0 ? (
        <div style={s.emptyState}>
          <CheckCircle size={48} color={GREEN} />
          <p style={s.emptyText}>
            No reports pending review. All Red-flagged reports have been
            actioned.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Report ID</th>
                  <th>Flagged At</th>
                  <th>Country</th>
                  <th>Damage Level</th>
                  <th>Infrastructure</th>
                  <th>Crisis Type</th>
                  <th>Flag Reasons</th>
                  <th>Reporter</th>
                  <th>Time in Queue</th>
                  <th>Status</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.report_id}>
                    <td>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reports/" + row.report_id, "_blank")
                        }
                      >
                        {row.report_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td>{formatDateTime(row.flagged_at)}</td>
                    <td>{row.country ?? "—"}</td>
                    <td>{formatDamageLevel(row.damage_level)}</td>
                    <td>
                      {row.infrastructure_types.join(", ") || "—"}
                    </td>
                    <td>{row.crisis_type ?? "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {row.flag_reasons.map((r) => (
                          <span key={r} className="chip chip-amber">
                            {flagReasonLabel(r)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reporters/" + row.reporter_id, "_blank")
                        }
                      >
                        {row.reporter_display_id}
                      </button>
                    </td>
                    <td
                      style={{
                        color: timeQueueColor(row.time_in_queue),
                        fontWeight: row.time_in_queue > 3600 ? 700 : 400,
                      }}
                    >
                      {formatTimeInQueue(row.time_in_queue)}
                    </td>
                    <td>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td>{getReviewBtn(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div style={s.loadMoreRow}>
              <button
                className="btn btn-secondary"
                style={{
                  padding: "10px 28px",
                  height: "auto",
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Loading…"
                  : `Load More (${total - allItems.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Tab 2: Properties Needing Review ──────────────────────────────────────────

type Tab2Modal = { type: "dismiss"; row: Tab2Row } | null;

function Tab2({ currentUserName }: { currentUserName: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [country, setCountry] = useState("");
  const [damageLevel, setDamageLevel] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [allItems, setAllItems] = useState<Tab2Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [modal, setModal] = useState<Tab2Modal>(null);

  const filterParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search) filterParams.search = search;
  if (reviewReason) filterParams.review_reason = reviewReason;
  if (country) filterParams.country = country;
  if (damageLevel) filterParams.damage_level = damageLevel;
  if (dateFrom) filterParams.date_from = dateFrom;
  if (dateTo) filterParams.date_to = dateTo;

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue-tab2", filterParams],
    queryFn: async () => {
      const res = await getTab2Properties(filterParams);
      return res.data as ReviewQueueListResponse<Tab2Row>;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!data) return;
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab2Properties({
        ...filterParams,
        cursor: nextCursor,
      });
      const d = res.data as ReviewQueueListResponse<Tab2Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDismiss(row: Tab2Row, comment: string) {
    await dismissPropertyFromReview(row.property_id, comment);
    qc.invalidateQueries({ queryKey: ["review-queue-tab2"] });
    qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
    setModal(null);
  }

  const filtersActive = [
    search,
    reviewReason,
    country,
    damageLevel,
    dateFrom,
    dateTo,
  ].filter(Boolean).length;

  function clearFilters() {
    setSearch("");
    setReviewReason("");
    setCountry("");
    setDamageLevel("");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <div>
      <div style={s.filterBar}>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search by Property ID or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input"
          style={s.filterSelect}
          value={reviewReason}
          onChange={(e) => setReviewReason(e.target.value)}
        >
          <option value="">All Review Reasons</option>
          <option value="conflict_warning">Conflict Warning only</option>
          <option value="manually_flagged">Manually Flagged only</option>
        </select>
        <input
          className="input"
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
          className="input"
          style={s.filterSelect}
          value={damageLevel}
          onChange={(e) => setDamageLevel(e.target.value)}
        >
          <option value="">All Damage Levels</option>
          <option value="completely_destroyed">Completely Destroyed</option>
          <option value="partially_damaged">Partially Damaged</option>
          <option value="minimal_or_no_damage">Minimal or No Damage</option>
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="date"
            className="input"
            style={s.filterInputSm}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span style={{ color: "var(--c-text-subtle)", fontSize: 12 }}>–</span>
          <input
            type="date"
            className="input"
            style={s.filterInputSm}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {filtersActive > 0 && (
          <>
            <span className="chip chip-blue">Filters active: {filtersActive}</span>
            <button style={s.clearFiltersBtn} onClick={clearFilters}>
              Clear all
            </button>
          </>
        )}
      </div>

      {isLoading ? (
        <div style={s.centred}>
          <Spinner />
        </div>
      ) : allItems.length === 0 ? (
        <div style={s.emptyState}>
          <CheckCircle size={48} color={GREEN} />
          <p style={s.emptyText}>No properties pending review.</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Property ID</th>
                  <th>Property Name</th>
                  <th>Country</th>
                  <th>Damage Level</th>
                  <th>Review Reason</th>
                  <th>Conflict Details</th>
                  <th>Time in Queue</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => {
                  const dmg = damagePillColors(row.current_damage_level);
                  return (
                    <tr key={row.property_id}>
                      <td>
                        <button
                          style={s.linkBtn}
                          onClick={() =>
                            window.open(
                              "/locations?search=" + row.property_id,
                              "_blank"
                            )
                          }
                        >
                          {row.property_id.slice(0, 8)}…
                        </button>
                      </td>
                      <td>{row.display_name}</td>
                      <td>{row.country ?? "—"}</td>
                      <td>
                        <span
                          style={{
                            ...s.damagePill,
                            background: dmg.bg,
                            color: dmg.color,
                          }}
                        >
                          {formatDamageLevel(row.current_damage_level)}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {row.has_conflict_warning && (
                            <span
                              className="chip chip-amber"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                            >
                              <AlertTriangle size={11} />
                              Conflict Warning
                            </span>
                          )}
                          {row.is_flagged_for_review && (
                            <span className="chip chip-blue">Manually Flagged</span>
                          )}
                          {!row.has_conflict_warning &&
                            !row.is_flagged_for_review && (
                              <span style={{ fontSize: 12, color: "var(--c-text-muted)" }}>
                                {row.review_reason}
                              </span>
                            )}
                        </div>
                      </td>
                      <td
                        style={{
                          fontSize: 12,
                          color: "var(--c-text-secondary)",
                          maxWidth: 200,
                        }}
                      >
                        {row.has_conflict_warning
                          ? row.flagged_for_review_note ??
                            "Conflicting damage reports"
                          : "—"}
                      </td>
                      <td
                        style={{
                          color: timeQueueColor(row.time_in_queue),
                          fontWeight: row.time_in_queue > 3600 ? 700 : 400,
                        }}
                      >
                        {formatTimeInQueue(row.time_in_queue)}
                      </td>
                      <td>
                        <SoftLockBadge softLock={row.soft_lock} />
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {!row.soft_lock ||
                          row.soft_lock.reviewer_name === currentUserName ? (
                            <button
                              className="btn btn-primary"
                              onClick={() =>
                                window.open(
                                  "/locations/" + row.property_id,
                                  "_blank"
                                )
                              }
                            >
                              Review →
                            </button>
                          ) : (
                            <button
                              className="btn btn-secondary"
                              style={{ cursor: "not-allowed", opacity: 0.6 }}
                              disabled
                            >
                              Locked
                            </button>
                          )}
                          <button
                            className="btn btn-secondary"
                            style={{ border: "1.5px solid var(--c-flag-amber)", color: "var(--c-flag-amber)", background: "transparent" }}
                            onClick={() => setModal({ type: "dismiss", row })}
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div style={s.loadMoreRow}>
              <button
                className="btn btn-secondary"
                style={{
                  padding: "10px 28px",
                  height: "auto",
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Loading…"
                  : `Load More (${total - allItems.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}

      {modal?.type === "dismiss" && (
        <ConfirmActionModal
          title="Dismiss Property from Review"
          description={`Remove "${modal.row.display_name}" from the review queue. It will no longer appear here.`}
          actionLabel="Dismiss"
          actionColor={AMBER}
          onConfirm={(comment) => handleDismiss(modal.row, comment)}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Tab 3: Stuck Reports ───────────────────────────────────────────────────────

function Tab3({ currentUserName }: { currentUserName: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("");
  const [platform, setPlatform] = useState("");
  const [minStuck, setMinStuck] = useState("");
  const [allItems, setAllItems] = useState<Tab3Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forceModal, setForceModal] = useState<Tab3Row | null>(null);

  const filterParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search) filterParams.search = search;
  if (country) filterParams.country = country;
  if (platform) filterParams.platform = platform;
  if (minStuck) filterParams.min_stuck = minStuck;

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue-tab3", filterParams],
    queryFn: async () => {
      const res = await getTab3StuckReports(filterParams);
      return res.data as ReviewQueueListResponse<Tab3Row>;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!data) return;
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab3StuckReports({
        ...filterParams,
        cursor: nextCursor,
      });
      const d = res.data as ReviewQueueListResponse<Tab3Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  const filtersActive = [search, country, platform, minStuck].filter(
    Boolean
  ).length;

  function clearFilters() {
    setSearch("");
    setCountry("");
    setPlatform("");
    setMinStuck("");
  }

  return (
    <div>
      <div style={s.filterBar}>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search by Report ID or Reporter ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="input"
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
          className="input"
          style={s.filterSelect}
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">All Platforms</option>
          <option value="mobile">Mobile</option>
          <option value="pwa">PWA</option>
          <option value="web">Web</option>
        </select>
        <select
          className="input"
          style={s.filterSelect}
          value={minStuck}
          onChange={(e) => setMinStuck(e.target.value)}
        >
          <option value="">Any Duration</option>
          <option value="1800">&gt; 30 min</option>
          <option value="3600">&gt; 1 hour</option>
          <option value="21600">&gt; 6 hours</option>
        </select>
        {filtersActive > 0 && (
          <>
            <span className="chip chip-blue">Filters active: {filtersActive}</span>
            <button style={s.clearFiltersBtn} onClick={clearFilters}>
              Clear all
            </button>
          </>
        )}
      </div>

      {isLoading ? (
        <div style={s.centred}>
          <Spinner />
        </div>
      ) : allItems.length === 0 ? (
        <div style={s.emptyState}>
          <CheckCircle size={48} color={GREEN} />
          <p style={s.emptyText}>
            No stuck reports. Background processing is running normally.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Report ID</th>
                  <th>Received At</th>
                  <th>Country</th>
                  <th>Damage Level</th>
                  <th>Platform</th>
                  <th>Reporter</th>
                  <th>Time Stuck</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.report_id}>
                    <td>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reports/" + row.report_id, "_blank")
                        }
                      >
                        {row.report_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td>{formatDateTime(row.received_at)}</td>
                    <td>{row.country ?? "—"}</td>
                    <td>{formatDamageLevel(row.damage_level)}</td>
                    <td>{row.platform ?? "—"}</td>
                    <td>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reporters/" + row.reporter_id, "_blank")
                        }
                      >
                        {row.reporter_display_id}
                      </button>
                    </td>
                    <td style={{ color: "var(--c-flag-red)", fontWeight: 700 }}>
                      {formatTimeInQueue(row.time_stuck_seconds)}
                    </td>
                    <td>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td>
                      {!row.soft_lock ||
                      row.soft_lock.reviewer_name === currentUserName ? (
                        <button
                          className="btn btn-danger"
                          style={{ border: "1.5px solid var(--c-flag-red)", background: "transparent" }}
                          onClick={() => setForceModal(row)}
                        >
                          Force Resolution
                        </button>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          style={{ cursor: "not-allowed", opacity: 0.6 }}
                          disabled
                        >
                          Locked
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div style={s.loadMoreRow}>
              <button
                className="btn btn-secondary"
                style={{
                  padding: "10px 28px",
                  height: "auto",
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Loading…"
                  : `Load More (${total - allItems.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}

      {forceModal && (
        <ForceResolutionModal
          reportId={forceModal.report_id}
          onClose={() => setForceModal(null)}
          onSuccess={() => {
            setForceModal(null);
            qc.invalidateQueries({ queryKey: ["review-queue-tab3"] });
            qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
          }}
        />
      )}
    </div>
  );
}

// ── Tab 4: Auto-blocked Profiles ───────────────────────────────────────────────

type Tab4Modal = { type: "confirm" | "reverse"; row: Tab4Row } | null;

function Tab4({ currentUserName: _currentUserName }: { currentUserName: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("");
  const [timeRemaining, setTimeRemaining] = useState("");
  const [allItems, setAllItems] = useState<Tab4Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [modal, setModal] = useState<Tab4Modal>(null);

  const filterParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search) filterParams.search = search;
  if (country) filterParams.country = country;
  if (timeRemaining) filterParams.max_remaining = timeRemaining;

  const { data, isLoading } = useQuery({
    queryKey: ["review-queue-tab4", filterParams],
    queryFn: async () => {
      const res = await getTab4AutoBlocked(filterParams);
      return res.data as ReviewQueueListResponse<Tab4Row>;
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (!data) return;
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab4AutoBlocked({
        ...filterParams,
        cursor: nextCursor,
      });
      const d = res.data as ReviewQueueListResponse<Tab4Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleConfirmBlock(row: Tab4Row, comment: string) {
    await confirmAutoBlock(row.reporter_id, comment);
    qc.invalidateQueries({ queryKey: ["review-queue-tab4"] });
    qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
    setModal(null);
  }

  async function handleReverseBlock(row: Tab4Row, comment: string) {
    await reverseAutoBlock(row.reporter_id, comment);
    qc.invalidateQueries({ queryKey: ["review-queue-tab4"] });
    qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
    setModal(null);
  }

  const filtersActive = [search, country, timeRemaining].filter(Boolean).length;

  function clearFilters() {
    setSearch("");
    setCountry("");
    setTimeRemaining("");
  }

  return (
    <div>
      <div style={s.filterBar}>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search by Reporter ID or device ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="input"
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
          className="input"
          style={s.filterSelect}
          value={timeRemaining}
          onChange={(e) => setTimeRemaining(e.target.value)}
        >
          <option value="">Any Time Remaining</option>
          <option value="86400">&lt; 24 hours</option>
          <option value="21600">&lt; 6 hours</option>
          <option value="3600">&lt; 1 hour</option>
        </select>
        {filtersActive > 0 && (
          <>
            <span className="chip chip-blue">Filters active: {filtersActive}</span>
            <button style={s.clearFiltersBtn} onClick={clearFilters}>
              Clear all
            </button>
          </>
        )}
      </div>

      {isLoading ? (
        <div style={s.centred}>
          <Spinner />
        </div>
      ) : allItems.length === 0 ? (
        <div style={s.emptyState}>
          <CheckCircle size={48} color={GREEN} />
          <p style={s.emptyText}>No auto-blocked profiles pending review.</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Reporter ID</th>
                  <th>Auto-blocked At</th>
                  <th>Device ID</th>
                  <th>Matched Profile</th>
                  <th>Time Remaining</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.reporter_id}>
                    <td>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reporters/" + row.reporter_id, "_blank")
                        }
                      >
                        {row.reporter_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td>{formatDateTime(row.auto_blocked_at)}</td>
                    <td
                      style={{
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {row.device_id
                        ? row.device_id.slice(0, 16) +
                          (row.device_id.length > 16 ? "…" : "")
                        : "—"}
                    </td>
                    <td>
                      {row.matched_blocked_reporter_id ? (
                        <button
                          style={s.linkBtn}
                          onClick={() =>
                            window.open(
                              "/reporters/" + row.matched_blocked_reporter_id,
                              "_blank"
                            )
                          }
                        >
                          {row.matched_blocked_reporter_id.slice(0, 8)}…
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      style={{
                        color: timeRemainingColor(row.time_remaining_seconds),
                        fontWeight: 700,
                        fontSize: "var(--text-xs)" as string,
                      }}
                    >
                      {formatCountdown(row.time_remaining_seconds)}
                    </td>
                    <td>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className="btn btn-success"
                          onClick={() => setModal({ type: "confirm", row })}
                        >
                          Confirm Block
                        </button>
                        <button
                          className="btn btn-danger"
                          style={{ border: "1.5px solid var(--c-flag-red)", background: "transparent" }}
                          onClick={() => setModal({ type: "reverse", row })}
                        >
                          Reverse Block
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div style={s.loadMoreRow}>
              <button
                className="btn btn-secondary"
                style={{
                  padding: "10px 28px",
                  height: "auto",
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Loading…"
                  : `Load More (${total - allItems.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}

      {modal?.type === "confirm" && (
        <ConfirmActionModal
          title="Confirm Auto-Block"
          description={`Permanently confirm the auto-block for reporter ${modal.row.reporter_id.slice(0, 8)}…. The block will be made permanent.`}
          actionLabel="Confirm Block"
          actionColor={GREEN}
          onConfirm={(comment) => handleConfirmBlock(modal.row, comment)}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === "reverse" && (
        <ConfirmActionModal
          title="Reverse Auto-Block"
          description={`Remove the auto-block for reporter ${modal.row.reporter_id.slice(0, 8)}…. The reporter will be able to submit reports again.`}
          actionLabel="Reverse Block"
          actionColor={RED}
          onConfirm={(comment) => handleReverseBlock(modal.row, comment)}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ReviewQueuePage() {
  const { user } = useAuthStore();
  const currentUserName = user?.full_name ?? "";
  const [activeTab, setActiveTab] = useState(1);

  const { data: countsData } = useQuery<ReviewQueueCounts>({
    queryKey: ["review-queue-counts"],
    queryFn: async () => {
      const res = await getReviewQueueCounts();
      return res.data as ReviewQueueCounts;
    },
    refetchInterval: 20000,
    staleTime: 0,
  });

  const counts: ReviewQueueCounts = countsData ?? {
    tab1_count: 0,
    tab2_count: 0,
    tab3_count: 0,
    tab4_count: 0,
  };

  const TABS = [
    { id: 1, label: "Reports",      count: counts.tab1_count },
    { id: 2, label: "Properties",   count: counts.tab2_count },
    { id: 3, label: "Stuck",        count: counts.tab3_count },
    { id: 4, label: "Auto-blocked", count: counts.tab4_count },
  ];

  return (
    <div style={s.page}>
      <style>{`@keyframes rq-spin { to { transform: rotate(360deg); } }`}</style>

      <Header title="Review Queue" />

      {/* Tab bar */}
      <div style={s.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              style={{
                background: isActive ? "var(--c-primary-container)" : "transparent",
                color: isActive ? "white" : "var(--c-text-muted)",
                fontSize: "var(--text-sm)" as string,
                fontWeight: isActive ? 600 : 500,
                padding: "8px 16px",
                borderRadius: "var(--radius-md)" as string,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap" as const,
                transition: "background 0.15s, color 0.15s",
              }}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              <span
                style={{
                  display: "inline-block",
                  background: "rgba(229,62,62,0.15)",
                  color: "var(--c-flag-red)",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: "var(--radius-pill)" as string,
                  marginLeft: 2,
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={s.content}>
        {activeTab === 1 && <Tab1 currentUserName={currentUserName} />}
        {activeTab === 2 && <Tab2 currentUserName={currentUserName} />}
        {activeTab === 3 && <Tab3 currentUserName={currentUserName} />}
        {activeTab === 4 && <Tab4 currentUserName={currentUserName} />}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--c-surface-low)",
  },
  tabBar: {
    display: "flex",
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)" as string,
    padding: 4,
    gap: 4,
    margin: "16px 32px 0",
    boxShadow: "var(--shadow-sm)" as string,
    alignSelf: "flex-start",
  },
  content: {
    flex: 1,
    padding: "20px 32px",
    overflowY: "auto",
  },
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 20,
    flexWrap: "wrap",
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)" as string,
    padding: "12px 20px",
    boxShadow: "var(--shadow-sm)" as string,
  },
  filterInput: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "7px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 260,
    borderBottom: "1.5px solid var(--c-border)",
  },
  filterInputSm: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "7px 10px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 130,
    borderBottom: "1.5px solid var(--c-border)",
  },
  filterSelect: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "7px 10px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    cursor: "pointer",
    borderBottom: "1.5px solid var(--c-border)",
  },
  filterSelectBtn: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "7px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    borderBottom: "1.5px solid var(--c-border)",
  },
  dropdownMenu: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 200,
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-border)",
    borderRadius: 8,
    boxShadow: "var(--shadow-float)" as string,
    padding: "6px 0",
    minWidth: 220,
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    cursor: "pointer",
  },
  clearFiltersBtn: {
    background: "none",
    border: "none",
    color: "var(--c-text-muted)",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
    padding: 0,
  },
  centred: {
    display: "flex",
    justifyContent: "center",
    paddingTop: 80,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "60px 0",
    gap: 16,
  },
  emptyText: {
    fontSize: "var(--text-sm)" as string,
    color: "var(--c-text-muted)",
    margin: 0,
    textAlign: "center",
    maxWidth: 480,
  },
  damagePill: {
    borderRadius: 12,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: 13,
    cursor: "pointer",
    padding: 0,
    fontFamily: "monospace",
    textDecoration: "underline",
  },
  loadMoreRow: {
    display: "flex",
    justifyContent: "center",
    paddingTop: 8,
    marginBottom: 16,
  },
};

// ── Modal Styles ───────────────────────────────────────────────────────────────

const ms: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: "var(--c-surface-lowest)",
    borderRadius: 12,
    padding: "28px 32px",
    width: 460,
    maxWidth: "90vw",
    boxShadow: "var(--shadow-float)" as string,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  title: {
    fontSize: "var(--text-lg)" as string,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
  },
  desc: {
    fontSize: "var(--text-sm)" as string,
    color: "var(--c-text-secondary)",
    margin: 0,
    lineHeight: 1.5,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: "var(--text-sm)" as string,
    fontWeight: 600,
    color: "var(--c-text-primary)",
  },
  textarea: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
    background: "var(--c-surface-low)",
  },
  select: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    cursor: "pointer",
  },
  charCount: {
    fontSize: 11,
    color: "var(--c-text-subtle)",
    textAlign: "right",
  },
  error: {
    background: "#FFF5F5",
    border: "1px solid var(--c-flag-red)",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--c-flag-red)",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    padding: "8px 18px",
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    background: "var(--c-surface-lowest)",
    color: "var(--c-text-secondary)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "8px 18px",
    border: "none",
    borderRadius: 7,
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
  },
};
