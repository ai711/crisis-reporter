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

const BLUE = "#0468B1";
const AMBER = "#DD6B20";
const RED = "#E53E3E";
const GREEN = "#38A169";
const PAGE_SIZE = 25;

const FLAG_REASON_LABELS: Record<string, string> = {
  ip_country_mismatch: "IP Country Mismatch",
  same_ip_multiple_devices: "Same IP Multiple Devices",
  duplicate_image: "Duplicate Image",
  coordinated_gps_duplicate: "Coordinated GPS Duplicate",
  high_submission_rate: "High Submission Rate",
  no_photos: "No Photos",
  no_location: "No Location",
  blocked_device: "Blocked Device",
  blocked_ip: "Blocked IP",
  duplicate_submission: "Duplicate Submission",
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
  if (seconds > 86400) return RED;
  if (seconds > 3600) return AMBER;
  return "#4a5568";
}

function timeRemainingColor(seconds: number): string {
  if (seconds < 3600) return RED;
  if (seconds < 86400) return AMBER;
  return GREEN;
}

function flagReasonLabel(r: string): string {
  return (
    FLAG_REASON_LABELS[r] ??
    r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function damagePillColors(level: string | null): { bg: string; color: string } {
  const map: Record<string, { bg: string; color: string }> = {
    complete:              { bg: "#FFF5F5", color: "#C53030" },
    completely_destroyed:  { bg: "#FFF5F5", color: "#C53030" },
    partial:               { bg: "#FFF8F0", color: "#C05621" },
    partially_damaged:     { bg: "#FFF8F0", color: "#C05621" },
    minimal:               { bg: "#F0FFF4", color: "#276749" },
    minimal_or_no_damage:  { bg: "#F0FFF4", color: "#276749" },
  };
  return map[level ?? ""] ?? { bg: "#f7fafc", color: "#4a5568" };
}

// ── Spinner ────────────────────────────────────────────────────────────────────

function Spinner({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: "3px solid #e2e8f0",
        borderTop: `3px solid ${BLUE}`,
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
            <span style={{ color: "#718096", fontWeight: 400 }}>
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
            <span style={{ color: "#718096", fontWeight: 400 }}>
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
          style={s.reviewBtn}
          onClick={() => window.open("/reports/" + row.report_id, "_blank")}
        >
          Review →
        </button>
      );
    }
    if (row.soft_lock.reviewer_name === currentUserName) {
      return (
        <button
          style={s.reviewBtn}
          onClick={() => window.open("/reports/" + row.report_id, "_blank")}
        >
          Resume →
        </button>
      );
    }
    return (
      <button style={s.lockedBtn} disabled>
        Locked
      </button>
    );
  }

  return (
    <div>
      <div style={s.filterBar}>
        <input
          style={s.filterInput}
          placeholder="Search by Report ID or Reporter ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ position: "relative" }}>
          <button
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
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="date"
            style={s.filterInputSm}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span style={{ color: "#718096", fontSize: 12 }}>–</span>
          <input
            type="date"
            style={s.filterInputSm}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {filtersActive > 0 && (
          <>
            <span style={s.filtersBadge}>Filters active: {filtersActive}</span>
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
          <CheckCircle size={56} color={GREEN} />
          <p style={s.emptyText}>
            No reports pending review. All Red-flagged reports have been
            actioned.
          </p>
        </div>
      ) : (
        <>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Report ID</th>
                  <th style={s.th}>Flagged At</th>
                  <th style={s.th}>Country</th>
                  <th style={s.th}>Damage Level</th>
                  <th style={s.th}>Infrastructure</th>
                  <th style={s.th}>Crisis Type</th>
                  <th style={s.th}>Flag Reasons</th>
                  <th style={s.th}>Reporter</th>
                  <th style={s.th}>Time in Queue</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Review</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.report_id} style={s.tr}>
                    <td style={s.td}>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reports/" + row.report_id, "_blank")
                        }
                      >
                        {row.report_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td style={s.td}>{formatDateTime(row.flagged_at)}</td>
                    <td style={s.td}>{row.country ?? "—"}</td>
                    <td style={s.td}>{formatDamageLevel(row.damage_level)}</td>
                    <td style={s.td}>
                      {row.infrastructure_types.join(", ") || "—"}
                    </td>
                    <td style={s.td}>{row.crisis_type ?? "—"}</td>
                    <td style={s.td}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {row.flag_reasons.map((r) => (
                          <span key={r} style={s.amberPill}>
                            {flagReasonLabel(r)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={s.td}>
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
                        ...s.td,
                        color: timeQueueColor(row.time_in_queue),
                        fontWeight: row.time_in_queue > 3600 ? 700 : 400,
                      }}
                    >
                      {formatTimeInQueue(row.time_in_queue)}
                    </td>
                    <td style={s.td}>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td style={s.td}>{getReviewBtn(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div style={s.loadMoreRow}>
              <button
                style={{
                  ...s.loadMoreBtn,
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
          style={s.filterInput}
          placeholder="Search by Property ID or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          style={s.filterSelect}
          value={reviewReason}
          onChange={(e) => setReviewReason(e.target.value)}
        >
          <option value="">All Review Reasons</option>
          <option value="conflict_warning">Conflict Warning only</option>
          <option value="manually_flagged">Manually Flagged only</option>
        </select>
        <input
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
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
            style={s.filterInputSm}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span style={{ color: "#718096", fontSize: 12 }}>–</span>
          <input
            type="date"
            style={s.filterInputSm}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {filtersActive > 0 && (
          <>
            <span style={s.filtersBadge}>Filters active: {filtersActive}</span>
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
          <CheckCircle size={56} color={GREEN} />
          <p style={s.emptyText}>No properties pending review.</p>
        </div>
      ) : (
        <>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Property ID</th>
                  <th style={s.th}>Property Name</th>
                  <th style={s.th}>Country</th>
                  <th style={s.th}>Damage Level</th>
                  <th style={s.th}>Review Reason</th>
                  <th style={s.th}>Conflict Details</th>
                  <th style={s.th}>Time in Queue</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => {
                  const dmg = damagePillColors(row.current_damage_level);
                  return (
                    <tr key={row.property_id} style={s.tr}>
                      <td style={s.td}>
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
                      <td style={s.td}>{row.display_name}</td>
                      <td style={s.td}>{row.country ?? "—"}</td>
                      <td style={s.td}>
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
                      <td style={s.td}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {row.has_conflict_warning && (
                            <span
                              style={{
                                ...s.amberPill,
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
                            <span style={s.bluePill}>Manually Flagged</span>
                          )}
                          {!row.has_conflict_warning &&
                            !row.is_flagged_for_review && (
                              <span style={{ fontSize: 12, color: "#718096" }}>
                                {row.review_reason}
                              </span>
                            )}
                        </div>
                      </td>
                      <td
                        style={{
                          ...s.td,
                          fontSize: 12,
                          color: "#4a5568",
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
                          ...s.td,
                          color: timeQueueColor(row.time_in_queue),
                          fontWeight: row.time_in_queue > 3600 ? 700 : 400,
                        }}
                      >
                        {formatTimeInQueue(row.time_in_queue)}
                      </td>
                      <td style={s.td}>
                        <SoftLockBadge softLock={row.soft_lock} />
                      </td>
                      <td style={s.td}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {!row.soft_lock ||
                          row.soft_lock.reviewer_name === currentUserName ? (
                            <button
                              style={s.reviewBtn}
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
                            <button style={s.lockedBtn} disabled>
                              Locked
                            </button>
                          )}
                          <button
                            style={s.dismissBtn}
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
                style={{
                  ...s.loadMoreBtn,
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
          style={s.filterInput}
          placeholder="Search by Report ID or Reporter ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
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
            <span style={s.filtersBadge}>Filters active: {filtersActive}</span>
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
          <CheckCircle size={56} color={GREEN} />
          <p style={s.emptyText}>
            No stuck reports. Background processing is running normally.
          </p>
        </div>
      ) : (
        <>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Report ID</th>
                  <th style={s.th}>Received At</th>
                  <th style={s.th}>Country</th>
                  <th style={s.th}>Damage Level</th>
                  <th style={s.th}>Platform</th>
                  <th style={s.th}>Reporter</th>
                  <th style={s.th}>Time Stuck</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.report_id} style={s.tr}>
                    <td style={s.td}>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reports/" + row.report_id, "_blank")
                        }
                      >
                        {row.report_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td style={s.td}>{formatDateTime(row.received_at)}</td>
                    <td style={s.td}>{row.country ?? "—"}</td>
                    <td style={s.td}>{formatDamageLevel(row.damage_level)}</td>
                    <td style={s.td}>{row.platform ?? "—"}</td>
                    <td style={s.td}>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reporters/" + row.reporter_id, "_blank")
                        }
                      >
                        {row.reporter_display_id}
                      </button>
                    </td>
                    <td style={{ ...s.td, color: RED, fontWeight: 700 }}>
                      {formatTimeInQueue(row.time_stuck_seconds)}
                    </td>
                    <td style={s.td}>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td style={s.td}>
                      {!row.soft_lock ||
                      row.soft_lock.reviewer_name === currentUserName ? (
                        <button
                          style={s.forceBtn}
                          onClick={() => setForceModal(row)}
                        >
                          Force Resolution
                        </button>
                      ) : (
                        <button style={s.lockedBtn} disabled>
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
                style={{
                  ...s.loadMoreBtn,
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
          style={s.filterInput}
          placeholder="Search by Reporter ID or device ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          style={s.filterInputSm}
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
        <select
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
            <span style={s.filtersBadge}>Filters active: {filtersActive}</span>
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
          <CheckCircle size={56} color={GREEN} />
          <p style={s.emptyText}>No auto-blocked profiles pending review.</p>
        </div>
      ) : (
        <>
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Reporter ID</th>
                  <th style={s.th}>Auto-blocked At</th>
                  <th style={s.th}>Device ID</th>
                  <th style={s.th}>Matched Profile</th>
                  <th style={s.th}>Time Remaining</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.reporter_id} style={s.tr}>
                    <td style={s.td}>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reporters/" + row.reporter_id, "_blank")
                        }
                      >
                        {row.reporter_id.slice(0, 8)}…
                      </button>
                    </td>
                    <td style={s.td}>{formatDateTime(row.auto_blocked_at)}</td>
                    <td
                      style={{
                        ...s.td,
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {row.device_id
                        ? row.device_id.slice(0, 16) +
                          (row.device_id.length > 16 ? "…" : "")
                        : "—"}
                    </td>
                    <td style={s.td}>
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
                        ...s.td,
                        color: timeRemainingColor(row.time_remaining_seconds),
                        fontWeight: 700,
                      }}
                    >
                      {formatCountdown(row.time_remaining_seconds)}
                    </td>
                    <td style={s.td}>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td style={s.td}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          style={s.confirmBlockBtn}
                          onClick={() => setModal({ type: "confirm", row })}
                        >
                          Confirm Block
                        </button>
                        <button
                          style={s.reverseBlockBtn}
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
                style={{
                  ...s.loadMoreBtn,
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
                ...s.tabBtn,
                borderBottom: isActive
                  ? `3px solid ${BLUE}`
                  : "3px solid transparent",
                color: isActive ? BLUE : "#718096",
                fontWeight: isActive ? 700 : 500,
              }}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              <span
                style={{
                  ...s.tabCount,
                  background: isActive ? BLUE : "#e2e8f0",
                  color: isActive ? "#fff" : "#4a5568",
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
    background: "#f4f6f9",
  },
  tabBar: {
    display: "flex",
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    paddingLeft: 28,
    gap: 0,
  },
  tabBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "14px 20px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 14,
    transition: "color 0.12s",
    whiteSpace: "nowrap",
  },
  tabCount: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 10,
    padding: "2px 7px",
    minWidth: 20,
    textAlign: "center",
    lineHeight: 1.4,
  },
  content: {
    flex: 1,
    padding: "20px 28px",
    overflowY: "auto",
  },
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  filterInput: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "7px 12px",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    outline: "none",
    width: 260,
  },
  filterInputSm: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "7px 10px",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    outline: "none",
    width: 130,
  },
  filterSelect: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "7px 10px",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    outline: "none",
    cursor: "pointer",
  },
  filterSelectBtn: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "7px 12px",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  dropdownMenu: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 200,
    background: "#fff",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
    padding: "6px 0",
    minWidth: 220,
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    fontSize: 13,
    color: "#2d3748",
    cursor: "pointer",
  },
  filtersBadge: {
    background: "#EBF5FB",
    color: "#0468B1",
    border: "1px solid #bee3f8",
    borderRadius: 20,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  clearFiltersBtn: {
    background: "none",
    border: "none",
    color: "#718096",
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
    paddingTop: 80,
    gap: 16,
  },
  emptyText: {
    fontSize: 15,
    color: "#718096",
    margin: 0,
    textAlign: "center",
    maxWidth: 480,
  },
  tableWrap: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    marginBottom: 16,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "11px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: {
    padding: "11px 14px",
    fontSize: 13,
    color: "#2d3748",
    verticalAlign: "middle",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    cursor: "pointer",
    padding: 0,
    fontFamily: "monospace",
    textDecoration: "underline",
  },
  reviewBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    border: "none",
    borderRadius: 6,
    background: "#0468B1",
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  lockedBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    border: "none",
    borderRadius: 6,
    background: "#e2e8f0",
    color: "#a0aec0",
    cursor: "not-allowed",
    whiteSpace: "nowrap",
  },
  dismissBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    border: "1.5px solid #DD6B20",
    borderRadius: 6,
    background: "#fff",
    color: "#DD6B20",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  forceBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    border: "1.5px solid #E53E3E",
    borderRadius: 6,
    background: "#fff",
    color: "#E53E3E",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  confirmBlockBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    border: "none",
    borderRadius: 6,
    background: "#38A169",
    color: "#fff",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  reverseBlockBtn: {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    border: "1.5px solid #E53E3E",
    borderRadius: 6,
    background: "#fff",
    color: "#E53E3E",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  amberPill: {
    background: "#FEFCBF",
    color: "#B7791F",
    border: "1px solid #F6E05E",
    borderRadius: 12,
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  bluePill: {
    background: "#EBF5FB",
    color: "#0468B1",
    border: "1px solid #bee3f8",
    borderRadius: 12,
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  damagePill: {
    borderRadius: 12,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  loadMoreRow: {
    display: "flex",
    justifyContent: "center",
    paddingTop: 8,
  },
  loadMoreBtn: {
    padding: "10px 28px",
    background: "#fff",
    border: `1.5px solid ${BLUE}`,
    color: BLUE,
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
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
    background: "#fff",
    borderRadius: 12,
    padding: "28px 32px",
    width: 460,
    maxWidth: "90vw",
    boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  desc: {
    fontSize: 13,
    color: "#4a5568",
    margin: 0,
    lineHeight: 1.5,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#2d3748",
  },
  textarea: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "#2d3748",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
  },
  select: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "#2d3748",
    background: "#fff",
    outline: "none",
    cursor: "pointer",
  },
  charCount: {
    fontSize: 11,
    color: "#a0aec0",
    textAlign: "right",
  },
  error: {
    background: "#FFF5F5",
    border: "1px solid #FC8181",
    borderRadius: 7,
    padding: "8px 12px",
    fontSize: 13,
    color: "#C53030",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    padding: "8px 18px",
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    background: "#fff",
    color: "#4a5568",
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
