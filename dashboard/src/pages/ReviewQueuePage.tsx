import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, AlertTriangle, Lock, ShieldAlert, ClipboardCheck, Building2, AlertOctagon, UserX } from "lucide-react";
import Header from "../components/Header";
import PageSpinner from "../components/PageSpinner";
import EmptyState from "../components/EmptyState";
import { Toast } from "../components/Toast";
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
  acquireReviewLock,
  submitReviewDecision,
} from "../services/api";
import {
  formatDateTime,
  formatDamageLevel,
  formatTimeInQueue,
  formatCountdown,
  toTitleCase,
} from "../utils/formatters";
import { usePageTitle } from "../hooks/usePageTitle";
import type {
  ReviewQueueCounts,
  Tab1Row,
  Tab2Row,
  Tab3Row,
  Tab4Row,
  ReviewQueueListResponse,
  TriggeredRule,
} from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE  = "var(--c-primary-container)";
const AMBER = "var(--c-flag-amber)";
const RED   = "var(--c-flag-red)";
const GREEN = "var(--c-flag-green)";
const PAGE_SIZE = 25;

const FLAG_REASON_LABELS: Record<string, string> = {
  reporter_blocked:           "Blocked Reporter",
  blocked_device:             "Blocked Device",
  blocked_ip:                 "Blocked IP",
  no_photos:                  "No Photos",
  no_location:                "No Location",
  coordinated_gps_duplicate:  "GPS Duplicate",
  high_submission_rate:       "High Submission Rate",
  ip_country_mismatch:        "IP Country Mismatch",
  same_ip_multiple_devices:   "Multi-Device IP",
  duplicate_image:            "Duplicate Image",
  duplicate_submission:       "Duplicate",
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

function damageDotColor(level: string | null): string {
  const map: Record<string, string> = {
    complete:              "#DC2626",
    completely_destroyed:  "#DC2626",
    partial:               "#D97706",
    partially_damaged:     "#D97706",
    minimal:               "#16A34A",
    minimal_or_no_damage:  "#16A34A",
  };
  return map[level ?? ""] ?? "#9CA3AF";
}

// ── DamageDot ─────────────────────────────────────────────────────────────────

function DamageDot({ level }: { level: string | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: damageDotColor(level),
          flexShrink: 0,
          display: "inline-block",
        }}
      />
      <span>{formatDamageLevel(level)}</span>
    </span>
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
        color: "#92400E",
        fontSize: 11,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: "#FEF3C7",
        border: "1px solid #FDE68A",
        borderRadius: 20,
        padding: "2px 8px",
        whiteSpace: "nowrap" as const,
        fontWeight: 500,
      }}
    >
      <Lock size={10} />
      {softLock.reviewer_name}
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
  const canSubmit = comment.trim().length >= 3 && !loading;

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

  const isRed    = actionColor === RED   || actionColor === "var(--c-flag-red)";
  const isGreen  = actionColor === GREEN || actionColor === "var(--c-flag-green)";
  const iconBg   = isRed ? "#FEF2F2" : isGreen ? "#F0FDF4" : "#FEF3C7";
  const iconClr  = isRed ? "#DC2626" : isGreen ? "#16A34A" : "#D97706";
  const ctxBg    = "var(--c-surface-low)";
  const ctxBd    = "var(--c-border)";

  return (
    <div style={ms.backdrop}>
      <div style={ms.dialog}>
        {/* Colored icon header */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, paddingBottom: 2 }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: iconBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: `0 0 0 6px ${iconBg}`,
            border: `1.5px solid ${iconClr}22`,
          }}>
            {isRed ? (
              <AlertTriangle size={24} color={iconClr} />
            ) : isGreen ? (
              <CheckCircle size={24} color={iconClr} />
            ) : (
              <ShieldAlert size={24} color={iconClr} />
            )}
          </div>
          <h3 style={ms.title}>{title}</h3>
        </div>

        {/* Context card */}
        <div style={{
          background: ctxBg,
          border: `1px solid ${ctxBd}`,
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 13,
          color: "var(--c-text-secondary)",
          lineHeight: 1.6,
        }}>
          {description}
        </div>

        {/* Comment field */}
        <div style={ms.field}>
          <label style={ms.label}>
            Review Comment{" "}
            <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>
              (required, min 3 chars)
            </span>
          </label>
          <textarea
            style={ms.textarea}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Enter reason or notes…"
            autoFocus
          />
          <span style={ms.charCount}>{comment.trim().length} / 3 min</span>
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
              opacity: canSubmit ? 1 : 0.45,
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
  const canSubmit = reason.trim().length >= 3 && !loading;

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
        {/* Icon header */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, paddingBottom: 2 }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: "#EFF6FF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1.5px solid rgba(4,104,177,0.15)",
          }}>
            <ShieldAlert size={24} color={BLUE} />
          </div>
          <h3 style={ms.title}>Force Resolution</h3>
        </div>

        {/* Warning context */}
        <div style={{
          background: "#FFFBEB",
          border: "1px solid #FDE68A",
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 13,
          color: "#92400E",
          lineHeight: 1.6,
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
        }}>
          <AlertTriangle size={14} color="#D97706" style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            Manually resolve this stuck report to a final status. This cannot be undone and will be recorded in the audit log.
          </span>
        </div>

        {/* Status selector — card style */}
        <div style={ms.field}>
          <label style={ms.label}>Target Status</label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              border: targetStatus === "green" ? `2px solid #16A34A` : "1.5px solid var(--c-border)",
              borderRadius: 8,
              cursor: "pointer",
              background: targetStatus === "green" ? "#F0FDF4" : "var(--c-surface-lowest)",
              transition: "all 0.12s",
            }}>
              <input
                type="radio"
                name="targetStatus"
                value="green"
                checked={targetStatus === "green"}
                onChange={() => setTargetStatus("green")}
                style={{ accentColor: "#16A34A" }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#16A34A" }}>
                Green — Verified
              </span>
            </label>
            <label style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              border: targetStatus === "red" ? `2px solid #DC2626` : "1.5px solid var(--c-border)",
              borderRadius: 8,
              cursor: "pointer",
              background: targetStatus === "red" ? "#FEF2F2" : "var(--c-surface-lowest)",
              transition: "all 0.12s",
            }}>
              <input
                type="radio"
                name="targetStatus"
                value="red"
                checked={targetStatus === "red"}
                onChange={() => setTargetStatus("red")}
                style={{ accentColor: "#DC2626" }}
              />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#DC2626" }}>
                Red — Rejected
              </span>
            </label>
          </div>
        </div>

        <div style={ms.field}>
          <label style={ms.label}>
            Reason{" "}
            <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>
              (required, min 3 chars)
            </span>
          </label>
          <textarea
            style={ms.textarea}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Enter reason for force resolution…"
            autoFocus
          />
          <span style={ms.charCount}>{reason.trim().length} / 3 min</span>
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
              opacity: canSubmit ? 1 : 0.45,
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

// ── RuleMetadataDetail ────────────────────────────────────────────────────────
// Renders rule-specific contextual data (links to matched reporters/reports)
// inside the Flag Reasons section of the review modal.

function RuleMetadataDetail({ rule }: { rule: TriggeredRule }) {
  const meta = rule.metadata;
  if (!meta) return null;

  const detailStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--c-text-secondary)",
    marginTop: 5,
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  };

  if (rule.rule_id === "1b" && meta.matched_blocked_reporter_id) {
    return (
      <div style={detailStyle}>
        <span>Matched blocked profile:</span>
        <button
          style={s.linkBtn}
          onClick={() => window.open("/reporters/" + String(meta.matched_blocked_reporter_id), "_blank")}
        >
          View profile →
        </button>
      </div>
    );
  }

  if (rule.rule_id === "2" && meta.matched_blocked_reporter_id) {
    return (
      <div style={detailStyle}>
        <span>Submission IP matches blocked profile:</span>
        <button
          style={s.linkBtn}
          onClick={() => window.open("/reporters/" + String(meta.matched_blocked_reporter_id), "_blank")}
        >
          View profile →
        </button>
      </div>
    );
  }

  if (rule.rule_id === "5" && meta.matching_report_serial_number != null) {
    return (
      <div style={detailStyle}>
        <span>Same location as:</span>
        <button
          style={s.linkBtn}
          onClick={() => window.open("/reports/" + String(meta.matching_report_id), "_blank")}
        >
          #{String(meta.matching_report_serial_number)} →
        </button>
      </div>
    );
  }

  if (rule.rule_id === "6" && meta.count_in_window != null) {
    return (
      <div style={detailStyle}>
        <span>
          {Number(meta.count_in_window)} submissions in{" "}
          {Number(meta.window_hours)}h (threshold: {Number(meta.threshold)})
        </span>
      </div>
    );
  }

  if (rule.rule_id === "7" && meta.geolocated_country) {
    return (
      <div style={detailStyle}>
        <span>
          IP geolocated to{" "}
          <strong style={{ color: "var(--c-text-primary)" }}>
            {String(meta.geolocated_country)}
          </strong>
          , reporter registered as{" "}
          <strong style={{ color: "var(--c-text-primary)" }}>
            {String(meta.reporter_selected_country)}
          </strong>
        </span>
      </div>
    );
  }

  if (rule.rule_id === "8" && Array.isArray(meta.other_reporters)) {
    const reporters = meta.other_reporters as Array<{ id: string; display_id: string | null }>;
    return (
      <div style={detailStyle}>
        <span>{Number(meta.device_count)} devices from same IP in 24h:</span>
        {reporters.map((r, i) => (
          <span key={r.id}>
            {i > 0 && <span style={{ color: "var(--c-text-muted)" }}>, </span>}
            <button
              style={s.linkBtn}
              onClick={() => window.open("/reporters/" + r.id, "_blank")}
            >
              #{r.display_id ?? r.id.slice(0, 8)}
            </button>
          </span>
        ))}
      </div>
    );
  }

  if (rule.rule_id === "9" && meta.matching_report_serial_number != null) {
    return (
      <div style={detailStyle}>
        <span>Duplicate image from report:</span>
        <button
          style={s.linkBtn}
          onClick={() => window.open("/reports/" + String(meta.matching_report_id), "_blank")}
        >
          #{String(meta.matching_report_serial_number)} →
        </button>
      </div>
    );
  }

  return null;
}

// ── Tab1ReviewModal ────────────────────────────────────────────────────────────

interface Tab1ReviewModalProps {
  row: Tab1Row;
  onClose: () => void;
  onSuccess: () => void;
}

function Tab1ReviewModal({ row, onClose, onSuccess }: Tab1ReviewModalProps) {
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [flagAssessments, setFlagAssessments] = useState<
    Array<{ rule_id: string; reason: string; dismissed: boolean }>
  >(() => {
    if (row.triggered_rules.length > 0) {
      return row.triggered_rules.map((r) => ({
        rule_id: r.rule_id,
        reason: r.reason,
        dismissed: false,
      }));
    }
    return row.flag_reasons.map((r) => ({ rule_id: "unknown", reason: r, dismissed: false }));
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = comment.trim().length >= 3 && !loading;

  async function handleDecision(decision: "approve" | "discard") {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await acquireReviewLock(row.report_id);
      await submitReviewDecision(row.report_id, decision, flagAssessments, comment.trim());
      qc.invalidateQueries({ queryKey: ["review-queue-tab1"] });
      qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Action failed. Please try again.");
      setLoading(false);
    }
  }

  function toggleDismissed(ruleId: string, reason: string) {
    setFlagAssessments((prev) =>
      prev.map((a) =>
        a.rule_id === ruleId && a.reason === reason
          ? { ...a, dismissed: !a.dismissed }
          : a
      )
    );
  }

  const dmg = damagePillColors(row.damage_level);
  const reportLabel =
    row.serial_number != null
      ? `#${row.serial_number}`
      : row.report_id.slice(0, 8) + "…";

  return (
    <div
      style={rms.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div style={rms.dialog}>
        {/* Header */}
        <div style={rms.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={rms.headerIcon}>
              <ShieldAlert size={20} color="#DC2626" />
            </div>
            <div>
              <h3 style={rms.headerTitle}>Review Report</h3>
              <p style={rms.headerSub}>
                <button
                  style={{ ...s.linkBtn, fontSize: 13 }}
                  onClick={() => window.open("/reports/" + row.report_id, "_blank")}
                >
                  {reportLabel}
                </button>
                {row.country ? ` · ${row.country}` : ""}
              </p>
            </div>
          </div>
          <button style={rms.closeBtn} onClick={onClose} disabled={loading}>
            ×
          </button>
        </div>

        {/* Body */}
        <div style={rms.body}>
          {/* Summary card */}
          <div style={rms.summaryCard}>
            <div style={rms.summaryGrid}>
              <div style={rms.summaryItem}>
                <span style={rms.summaryLabel}>Damage Level</span>
                <span
                  style={{
                    ...rms.damageBadge,
                    background: dmg.bg,
                    color: dmg.color,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: dmg.color,
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  {formatDamageLevel(row.damage_level)}
                </span>
              </div>
              <div style={rms.summaryItem}>
                <span style={rms.summaryLabel}>Infrastructure</span>
                <span style={rms.summaryValue}>
                  {row.infrastructure_types.length > 0
                    ? row.infrastructure_types.map(toTitleCase).join(", ")
                    : "—"}
                </span>
              </div>
              <div style={rms.summaryItem}>
                <span style={rms.summaryLabel}>Time in Queue</span>
                <span
                  style={{
                    ...rms.summaryValue,
                    color: timeQueueColor(row.time_in_queue),
                    fontWeight: 600,
                  }}
                >
                  {formatTimeInQueue(row.time_in_queue)}
                </span>
              </div>
              <div style={rms.summaryItem}>
                <span style={rms.summaryLabel}>Reporter</span>
                <button
                  style={s.linkBtn}
                  onClick={() => window.open("/reporters/" + row.reporter_id, "_blank")}
                >
                  #{row.reporter_display_id}
                </button>
              </div>
            </div>
          </div>

          {/* Flag Reasons */}
          <div style={rms.section}>
            <div style={rms.sectionHeader}>
              <span style={rms.sectionTitle}>
                Flag Reasons
                {flagAssessments.length > 1 && (
                  <span style={{
                    marginLeft: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    background: "var(--c-flag-red)",
                    color: "#fff",
                    borderRadius: 10,
                    padding: "1px 7px",
                  }}>
                    {flagAssessments.length}
                  </span>
                )}
              </span>
              <span style={rms.sectionHint}>
                Check "False positive" next to any reason you believe is incorrect
              </span>
            </div>
            <div style={rms.reasonsList}>
              {flagAssessments.map((a) => {
                const matchedRule = row.triggered_rules.find(
                  (r) => r.rule_id === a.rule_id && r.reason === a.reason
                );
                return (
                  <div
                    key={`${a.rule_id}-${a.reason}`}
                    style={{
                      ...rms.reasonRow,
                      alignItems: "flex-start",
                      cursor: "default",
                      opacity: a.dismissed ? 0.6 : 1,
                      background: a.dismissed
                        ? "var(--c-surface-lowest)"
                        : "var(--c-surface-low)",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={s.flagPill}>
                          <AlertTriangle size={10} />
                          {flagReasonLabel(a.reason)}
                        </span>
                        {a.dismissed && (
                          <span style={rms.dismissedTag}>✓ dismissed</span>
                        )}
                      </div>
                      {matchedRule && <RuleMetadataDetail rule={matchedRule} />}
                    </div>
                    <label style={{ ...rms.dismissToggle, cursor: "pointer", flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={a.dismissed}
                        onChange={() => toggleDismissed(a.rule_id, a.reason)}
                        style={{ accentColor: "#16A34A", cursor: "pointer" }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          color: a.dismissed ? "#16A34A" : "var(--c-text-muted)",
                          fontWeight: a.dismissed ? 600 : 400,
                          userSelect: "none",
                        }}
                      >
                        False positive
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Comment */}
          <div style={rms.section}>
            <div style={rms.sectionHeader}>
              <span style={rms.sectionTitle}>
                Review Comment{" "}
                <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>
                  (required — min 3, max 500 characters)
                </span>
              </span>
            </div>
            <textarea
              style={rms.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              rows={4}
              placeholder="Explain your decision — this will be permanently recorded in the audit log…"
              autoFocus
            />
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "var(--c-text-muted)" }}>
                Your decision and comment are recorded in the immutable audit log.
              </span>
              <span
                style={{
                  fontSize: 11,
                  color:
                    comment.trim().length < 3
                      ? "var(--c-flag-red)"
                      : "var(--c-text-subtle)",
                  fontWeight: comment.trim().length < 10 ? 600 : 400,
                }}
              >
                {comment.length} / 500
              </span>
            </div>
          </div>

          {error && <div style={ms.error}>{error}</div>}
        </div>

        {/* Footer */}
        <div style={rms.footer}>
          <button style={ms.cancelBtn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{
                ...rms.discardBtn,
                opacity: canSubmit ? 1 : 0.45,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
              disabled={!canSubmit}
              onClick={() => handleDecision("discard")}
            >
              {loading ? "Processing…" : "Discard Report"}
            </button>
            <button
              style={{
                ...rms.approveBtn,
                opacity: canSubmit ? 1 : 0.45,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
              disabled={!canSubmit}
              onClick={() => handleDecision("approve")}
            >
              {loading ? "Processing…" : "Approve Report"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab 1: Red-flagged Reports ─────────────────────────────────────────────────

function Tab1({ currentUserName }: { currentUserName: string }) {
  const [pendingSearch, setPendingSearch] = useState("");
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
  const [reviewModal, setReviewModal] = useState<Tab1Row | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

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
    [pendingSearch, country, dateFrom, dateTo].filter(Boolean).length +
    selectedReasons.length;

  function clearFilters() {
    setPendingSearch("");
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
          onClick={() => setReviewModal(row)}
        >
          Review →
        </button>
      );
    }
    if (row.soft_lock.reviewer_name === currentUserName) {
      return (
        <button
          style={{ ...s.reviewBtn, background: "var(--c-primary)" }}
          onClick={() => setReviewModal(row)}
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
      {/* Filter bar */}
      <div style={s.filterBar}>
        <span style={s.filterLabel}>Filters:</span>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search Report # or Reporter ID"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
        />
        <div style={{ position: "relative" }}>
          <button
            style={{
              ...s.filterPill,
              background: selectedReasons.length > 0 ? "rgba(4,104,177,0.08)" : "var(--c-surface-low)",
              borderColor: selectedReasons.length > 0 ? BLUE : "var(--c-border)",
              color: selectedReasons.length > 0 ? BLUE : "var(--c-text-secondary)",
            }}
            onClick={() => setShowReasonDropdown((v) => !v)}
          >
            Flag Reasons
            {selectedReasons.length > 0 && (
              <span style={s.pillBadge}>{selectedReasons.length}</span>
            )}
            {" ▾"}
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
          <span style={{ fontSize: 11, color: "var(--c-text-muted)", whiteSpace: "nowrap" }}>Flagged:</span>
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
          <button style={s.clearFiltersBtn} onClick={clearFilters}>
            ✕ Clear filters ({filtersActive})
          </button>
        )}
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={28} color="#16A34A" />}
          title="All clear — no reports pending review"
          message="Red-flagged reports will appear here as they are submitted."
        />
      ) : (
        <>
          <div style={s.tableWrap}>
            <table className="data-table rq-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 16 }}>Report</th>
                  <th>Flagged At</th>
                  <th>Country</th>
                  <th>Damage</th>
                  <th>Infrastructure</th>
                  <th>Crisis Type</th>
                  <th>Flag Reasons</th>
                  <th>Reporter</th>
                  <th>Time in Queue</th>
                  <th>Lock</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => {
                  const isUrgent = row.time_in_queue > 3600;
                  return (
                    <tr
                      key={row.report_id}
                      className={isUrgent ? "rq-row-urgent" : "rq-row-normal"}
                    >
                      <td style={{ paddingLeft: 16 }}>
                        <button
                          style={s.linkBtn}
                          onClick={() =>
                            window.open("/reports/" + row.report_id, "_blank")
                          }
                        >
                          {row.serial_number != null
                            ? `#${row.serial_number}`
                            : `${row.report_id.slice(0, 8)}…`}
                        </button>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--c-text-secondary)" }}>
                        {formatDateTime(row.flagged_at)}
                      </td>
                      <td>{row.country ?? "—"}</td>
                      <td>
                        <DamageDot level={row.damage_level} />
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {row.infrastructure_types.length > 0 ? row.infrastructure_types.map(toTitleCase).join(", ") : "—"}
                      </td>
                      <td style={{ fontSize: 12 }}>{row.crisis_type ? toTitleCase(row.crisis_type) : "—"}</td>
                      <td style={{ maxWidth: 260, overflow: "hidden" }}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {row.flag_reasons.map((r) => (
                            <span key={r} style={s.flagPill}>
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
                          fontSize: 13,
                        }}
                      >
                        {formatTimeInQueue(row.time_in_queue)}
                      </td>
                      <td>
                        <SoftLockBadge softLock={row.soft_lock} />
                      </td>
                      <td>{getReviewBtn(row)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination / load more */}
          <div style={s.paginationRow}>
            <span style={s.paginationInfo}>
              Showing {allItems.length} of {total} reports
            </span>
            {hasMore && (
              <button
                style={{
                  ...s.loadMoreBtn,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : `Load next ${Math.min(PAGE_SIZE, total - allItems.length)} →`}
              </button>
            )}
          </div>
        </>
      )}

      {reviewModal && (
        <Tab1ReviewModal
          row={reviewModal}
          onClose={() => setReviewModal(null)}
          onSuccess={() => {
            setAllItems((prev) =>
              prev.filter((r) => r.report_id !== reviewModal.report_id)
            );
            setTotal((t) => Math.max(0, t - 1));
            setReviewModal(null);
          }}
        />
      )}
    </div>
  );
}

// ── Tab 2: Properties Needing Review ──────────────────────────────────────────

type Tab2Modal = { type: "dismiss"; row: Tab2Row } | null;

function Tab2({ currentUserName }: { currentUserName: string }) {
  const qc = useQueryClient();
  const [pendingSearch, setPendingSearch] = useState("");
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
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab2Properties({ ...filterParams, cursor: nextCursor });
      const d = res.data as ReviewQueueListResponse<Tab2Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDismiss(row: Tab2Row, comment: string) {
    try {
      await dismissPropertyFromReview(row.property_id, comment);
      qc.invalidateQueries({ queryKey: ["review-queue-tab2"] });
      qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
      setModal(null);
      setToast({ message: "Property dismissed from review queue.", type: "success" });
    } catch {
      setToast({ message: "Failed to dismiss property. Please try again.", type: "error" });
    }
  }

  const filtersActive = [pendingSearch, reviewReason, country, damageLevel, dateFrom, dateTo].filter(Boolean).length;

  function clearFilters() {
    setPendingSearch("");
    setSearch("");
    setReviewReason("");
    setCountry("");
    setDamageLevel("");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <div>
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
      {/* Filter bar */}
      <div style={s.filterBar}>
        <span style={s.filterLabel}>Filters:</span>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search Property ID or name"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
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
          <span style={{ fontSize: 11, color: "var(--c-text-muted)", whiteSpace: "nowrap" }}>In queue:</span>
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
          <button style={s.clearFiltersBtn} onClick={clearFilters}>
            ✕ Clear filters ({filtersActive})
          </button>
        )}
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={<Building2 size={28} color="#16A34A" />}
          title="No properties pending review"
          message="Properties with conflicting reports will appear here."
        />
      ) : (
        <>
          <div style={s.tableWrap}>
            <table className="data-table rq-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 16 }}>Property ID</th>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Damage</th>
                  <th>Review Reason</th>
                  <th>Conflict Details</th>
                  <th>Time in Queue</th>
                  <th>Lock</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => {
                  const dmg = damagePillColors(row.current_damage_level);
                  const isUrgent = row.time_in_queue > 3600;
                  return (
                    <tr
                      key={row.property_id}
                      className={isUrgent ? "rq-row-urgent" : "rq-row-normal"}
                    >
                      <td style={{ paddingLeft: 16 }}>
                        <button
                          style={s.linkBtn}
                          onClick={() =>
                            window.open("/locations?search=" + row.property_id, "_blank")
                          }
                        >
                          {row.property_id.slice(0, 8)}…
                        </button>
                      </td>
                      <td style={{ fontSize: 13 }}>{row.display_name}</td>
                      <td>{row.country ?? "—"}</td>
                      <td>
                        <span
                          style={{
                            ...s.damagePill,
                            background: dmg.bg,
                            color: dmg.color,
                          }}
                        >
                          <span style={{
                            width: 6, height: 6, borderRadius: "50%",
                            background: dmg.color,
                            display: "inline-block", marginRight: 5,
                          }} />
                          {formatDamageLevel(row.current_damage_level)}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {row.has_conflict_warning && (
                            <span style={{ ...s.flagPill, display: "inline-flex", alignItems: "center", gap: 4 }}>
                              <AlertTriangle size={10} />
                              Conflict
                            </span>
                          )}
                          {row.is_flagged_for_review && (
                            <span style={{
                              ...s.flagPill,
                              background: "rgba(4,104,177,0.08)",
                              color: BLUE,
                              borderColor: "rgba(4,104,177,0.2)",
                            }}>
                              Flagged
                            </span>
                          )}
                          {!row.has_conflict_warning && !row.is_flagged_for_review && (
                            <span style={{ fontSize: 12, color: "var(--c-text-muted)" }}>
                              {row.review_reason}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--c-text-secondary)", maxWidth: 180 }}>
                        {row.has_conflict_warning
                          ? row.flagged_for_review_note ?? "Conflicting damage reports"
                          : "—"}
                      </td>
                      <td style={{
                        color: timeQueueColor(row.time_in_queue),
                        fontWeight: row.time_in_queue > 3600 ? 700 : 400,
                        fontSize: 13,
                      }}>
                        {formatTimeInQueue(row.time_in_queue)}
                      </td>
                      <td>
                        <SoftLockBadge softLock={row.soft_lock} />
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {!row.soft_lock || row.soft_lock.reviewer_name === currentUserName ? (
                            <button
                              style={s.reviewBtn}
                              onClick={() =>
                                window.open("/locations/" + row.property_id, "_blank")
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

          <div style={s.paginationRow}>
            <span style={s.paginationInfo}>
              Showing {allItems.length} of {total} properties
            </span>
            {hasMore && (
              <button
                style={{
                  ...s.loadMoreBtn,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : `Load next ${Math.min(PAGE_SIZE, total - allItems.length)} →`}
              </button>
            )}
          </div>
        </>
      )}

      {modal?.type === "dismiss" && (
        <ConfirmActionModal
          title="Dismiss Property from Review"
          description={`Remove "${modal.row.display_name}" from the review queue. It will no longer appear here until it is re-flagged.`}
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
  const [pendingSearch, setPendingSearch] = useState("");
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab3StuckReports({ ...filterParams, cursor: nextCursor });
      const d = res.data as ReviewQueueListResponse<Tab3Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  const filtersActive = [pendingSearch, country, platform, minStuck].filter(Boolean).length;

  function clearFilters() {
    setPendingSearch("");
    setSearch("");
    setCountry("");
    setPlatform("");
    setMinStuck("");
  }

  return (
    <div>
      {/* Filter bar */}
      <div style={s.filterBar}>
        <span style={s.filterLabel}>Filters:</span>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search Report # or Reporter ID"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
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
          <button style={s.clearFiltersBtn} onClick={clearFilters}>
            ✕ Clear filters ({filtersActive})
          </button>
        )}
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={<AlertOctagon size={28} color="#16A34A" />}
          title="No stuck reports"
          message="Background processing is running normally."
        />
      ) : (
        <>
          <div style={s.tableWrap}>
            <table className="data-table rq-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 16 }}>Report</th>
                  <th>Received At</th>
                  <th>Country</th>
                  <th>Damage</th>
                  <th>Platform</th>
                  <th>Reporter</th>
                  <th>Time Stuck</th>
                  <th>Lock</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => (
                  <tr key={row.report_id} className="rq-row-urgent">
                    <td style={{ paddingLeft: 16 }}>
                      <button
                        style={s.linkBtn}
                        onClick={() =>
                          window.open("/reports/" + row.report_id, "_blank")
                        }
                      >
                        {row.serial_number != null
                          ? `#${row.serial_number}`
                          : `${row.report_id.slice(0, 8)}…`}
                      </button>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--c-text-secondary)" }}>
                      {formatDateTime(row.received_at)}
                    </td>
                    <td>{row.country ?? "—"}</td>
                    <td>
                      <DamageDot level={row.damage_level} />
                    </td>
                    <td>
                      <span style={{
                        background: "var(--c-surface-low)",
                        border: "1px solid var(--c-border)",
                        borderRadius: 4,
                        padding: "1px 6px",
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "var(--c-text-secondary)",
                      }}>
                        {row.platform ?? "—"}
                      </span>
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
                    <td style={{ color: "var(--c-flag-red)", fontWeight: 700, fontSize: 13 }}>
                      {formatTimeInQueue(row.time_stuck_seconds)}
                    </td>
                    <td>
                      <SoftLockBadge softLock={row.soft_lock} />
                    </td>
                    <td>
                      {!row.soft_lock ||
                      row.soft_lock.reviewer_name === currentUserName ? (
                        <button
                          style={s.forceBtn}
                          onClick={() => setForceModal(row)}
                        >
                          Force Resolve
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

          <div style={s.paginationRow}>
            <span style={s.paginationInfo}>
              Showing {allItems.length} of {total} stuck reports
            </span>
            {hasMore && (
              <button
                style={{
                  ...s.loadMoreBtn,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : `Load next ${Math.min(PAGE_SIZE, total - allItems.length)} →`}
              </button>
            )}
          </div>
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
  const [pendingSearch, setPendingSearch] = useState("");
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("");
  const [timeRemaining, setTimeRemaining] = useState("");
  const [allItems, setAllItems] = useState<Tab4Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [modal, setModal] = useState<Tab4Modal>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllItems(data.items);
    setTotal(data.total);
    setNextCursor(data.cursor);
    setHasMore(data.has_more);
  }, [data]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(pendingSearch), 400);
    return () => clearTimeout(t);
  }, [pendingSearch]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getTab4AutoBlocked({ ...filterParams, cursor: nextCursor });
      const d = res.data as ReviewQueueListResponse<Tab4Row>;
      setAllItems((prev) => [...prev, ...d.items]);
      setNextCursor(d.cursor);
      setHasMore(d.has_more);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleConfirmBlock(row: Tab4Row, comment: string) {
    try {
      await confirmAutoBlock(row.reporter_id, comment);
      qc.invalidateQueries({ queryKey: ["review-queue-tab4"] });
      qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
      setModal(null);
      setToast({ message: "Reporter block confirmed. They will remain blocked indefinitely.", type: "success" });
    } catch {
      setToast({ message: "Failed to confirm block. Please try again.", type: "error" });
    }
  }

  async function handleReverseBlock(row: Tab4Row, comment: string) {
    try {
      await reverseAutoBlock(row.reporter_id, comment);
      qc.invalidateQueries({ queryKey: ["review-queue-tab4"] });
      qc.invalidateQueries({ queryKey: ["review-queue-counts"] });
      setModal(null);
      setToast({ message: "Auto-block reversed. Reporter can submit reports again.", type: "success" });
    } catch {
      setToast({ message: "Failed to reverse block. Please try again.", type: "error" });
    }
  }

  const filtersActive = [pendingSearch, country, timeRemaining].filter(Boolean).length;

  function clearFilters() {
    setPendingSearch("");
    setSearch("");
    setCountry("");
    setTimeRemaining("");
  }

  return (
    <div>
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
      {/* Filter bar */}
      <div style={s.filterBar}>
        <span style={s.filterLabel}>Filters:</span>
        <input
          className="input"
          style={s.filterInput}
          placeholder="Search Reporter ID or device ID"
          value={pendingSearch}
          onChange={(e) => setPendingSearch(e.target.value)}
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
          <button style={s.clearFiltersBtn} onClick={clearFilters}>
            ✕ Clear filters ({filtersActive})
          </button>
        )}
      </div>

      {isLoading ? (
        <PageSpinner />
      ) : allItems.length === 0 ? (
        <EmptyState
          icon={<UserX size={28} color="#16A34A" />}
          title="No auto-blocked profiles pending review"
          message="Auto-blocked reporter profiles will appear here for confirmation."
        />
      ) : (
        <>
          <div style={s.tableWrap}>
            <table className="data-table rq-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 16 }}>Reporter ID</th>
                  <th>Auto-blocked At</th>
                  <th>Device ID</th>
                  <th>Matched Profile</th>
                  <th>Time Remaining</th>
                  <th>Lock</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allItems.map((row) => {
                  const isExpiringSoon = row.time_remaining_seconds < 86400;
                  return (
                    <tr
                      key={row.reporter_id}
                      className={isExpiringSoon ? "rq-row-urgent" : "rq-row-normal"}
                    >
                      <td style={{ paddingLeft: 16 }}>
                        <button
                          style={s.linkBtn}
                          onClick={() =>
                            window.open("/reporters/" + row.reporter_id, "_blank")
                          }
                        >
                          {row.reporter_id.slice(0, 8)}…
                        </button>
                      </td>
                      <td style={{ fontSize: 12, color: "var(--c-text-secondary)" }}>
                        {formatDateTime(row.auto_blocked_at)}
                      </td>
                      <td style={{ fontFamily: "monospace", fontSize: 12, color: "var(--c-text-secondary)" }}>
                        {row.device_id
                          ? row.device_id.slice(0, 16) + (row.device_id.length > 16 ? "…" : "")
                          : "—"}
                      </td>
                      <td>
                        {row.matched_blocked_reporter_id ? (
                          <button
                            style={s.linkBtn}
                            onClick={() =>
                              window.open("/reporters/" + row.matched_blocked_reporter_id, "_blank")
                            }
                          >
                            {row.matched_blocked_reporter_id.slice(0, 8)}…
                          </button>
                        ) : (
                          <span style={{ color: "var(--c-text-muted)", fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{
                        color: timeRemainingColor(row.time_remaining_seconds),
                        fontWeight: 700,
                        fontSize: 13,
                      }}>
                        {formatCountdown(row.time_remaining_seconds)}
                      </td>
                      <td>
                        <SoftLockBadge softLock={row.soft_lock} />
                      </td>
                      <td>
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
                            Reverse
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={s.paginationRow}>
            <span style={s.paginationInfo}>
              Showing {allItems.length} of {total} blocked profiles
            </span>
            {hasMore && (
              <button
                style={{
                  ...s.loadMoreBtn,
                  opacity: loadingMore ? 0.6 : 1,
                  cursor: loadingMore ? "default" : "pointer",
                }}
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : `Load next ${Math.min(PAGE_SIZE, total - allItems.length)} →`}
              </button>
            )}
          </div>
        </>
      )}

      {modal?.type === "confirm" && (
        <ConfirmActionModal
          title="Confirm Auto-Block"
          description={`Make the auto-block permanent for reporter ${modal.row.reporter_id.slice(0, 8)}…. This reporter will be blocked indefinitely and will not be able to submit reports.`}
          actionLabel="Confirm Block"
          actionColor={GREEN}
          onConfirm={(comment) => handleConfirmBlock(modal.row, comment)}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.type === "reverse" && (
        <ConfirmActionModal
          title="Reverse Auto-Block"
          description={`Remove the auto-block for reporter ${modal.row.reporter_id.slice(0, 8)}…. The reporter will be able to submit reports again immediately.`}
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
  usePageTitle("Review Queue");
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

  const totalPending =
    counts.tab1_count + counts.tab2_count + counts.tab3_count + counts.tab4_count;

  const TABS = [
    { id: 1, label: "Red-flagged Reports", count: counts.tab1_count },
    { id: 2, label: "Properties",          count: counts.tab2_count },
    { id: 3, label: "Stuck Reports",       count: counts.tab3_count },
    { id: 4, label: "Auto-blocked",        count: counts.tab4_count },
  ];

  return (
    <div style={s.page}>
      <style>{`
        .rq-table th { padding: 10px 14px; }
        .rq-table td { padding: 9px 14px; }
        .rq-table tbody tr { transition: background 0.1s; }
        .rq-table tbody tr:hover td { background: rgba(4,104,177,0.025) !important; }
        .rq-row-urgent td:first-child { border-left: 3px solid #D97706; }
        .rq-row-normal td:first-child { border-left: 3px solid transparent; }
      `}</style>

      <Header title="Review Queue" />

      {/* Urgency banner */}
      {totalPending > 0 && (
        <div style={s.urgencyBanner}>
          <AlertTriangle size={16} color="#D97706" />
          <span style={{ fontWeight: 700, fontSize: 14, color: "#92400E" }}>
            {totalPending} item{totalPending !== 1 ? "s" : ""} need attention
          </span>
          <span style={{ fontSize: 13, color: "#B45309" }}>
            — review flagged reports and blocked profiles before they auto-expire.
          </span>
        </div>
      )}

      {/* Tab bar */}
      <div style={s.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const hasItems = tab.count > 0;
          return (
            <button
              key={tab.id}
              style={{
                background: isActive ? "var(--c-primary-container)" : "transparent",
                color: isActive ? "white" : hasItems ? "var(--c-text-primary)" : "var(--c-text-muted)",
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                padding: "7px 16px",
                borderRadius: "var(--radius-md)" as string,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap" as const,
                transition: "background 0.15s, color 0.15s",
              }}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              <span
                style={{
                  display: "inline-block",
                  background: isActive
                    ? "rgba(255,255,255,0.2)"
                    : hasItems
                    ? "rgba(217,119,6,0.12)"
                    : "var(--c-surface-low)",
                  color: isActive ? "white" : hasItems ? "#D97706" : "var(--c-text-muted)",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "1px 7px",
                  borderRadius: 20,
                  minWidth: 20,
                  textAlign: "center",
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

      {/* Footer stats strip */}
      {countsData && (
        <div style={s.footerStrip}>
          <span style={s.footerStat}>
            <span style={{ ...s.footerDot, background: "var(--c-flag-red)" }} />
            {counts.tab1_count} flagged report{counts.tab1_count !== 1 ? "s" : ""}
          </span>
          <span style={s.footerDivider} />
          <span style={s.footerStat}>
            <span style={{ ...s.footerDot, background: "#D97706" }} />
            {counts.tab2_count} propert{counts.tab2_count !== 1 ? "ies" : "y"} in review
          </span>
          <span style={s.footerDivider} />
          <span style={s.footerStat}>
            <span style={{ ...s.footerDot, background: "var(--c-text-muted)" }} />
            {counts.tab3_count} stuck
          </span>
          <span style={s.footerDivider} />
          <span style={s.footerStat}>
            <span style={{ ...s.footerDot, background: "var(--c-primary-container)" }} />
            {counts.tab4_count} auto-blocked
          </span>
        </div>
      )}
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
  urgencyBanner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#FFFBEB",
    borderLeft: "4px solid #D97706",
    padding: "11px 24px",
    margin: "14px 32px 0",
    borderRadius: "0 8px 8px 0",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  tabBar: {
    display: "flex",
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)" as string,
    padding: 4,
    gap: 2,
    margin: "14px 32px 0",
    boxShadow: "var(--shadow-sm)" as string,
    alignSelf: "flex-start",
  },
  content: {
    flex: 1,
    padding: "18px 32px 0",
    overflowY: "auto",
    paddingBottom: 8,
  },
  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)" as string,
    padding: "10px 16px",
    boxShadow: "var(--shadow-sm)" as string,
    border: "1px solid var(--c-border)",
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--c-text-muted)",
    marginRight: 2,
    whiteSpace: "nowrap",
  },
  filterInput: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 250,
  },
  filterInputSm: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "6px 10px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    width: 120,
  },
  filterSelect: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "6px 10px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-low)",
    outline: "none",
    cursor: "pointer",
  },
  filterPill: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 20,
    padding: "5px 12px",
    fontSize: 13,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontWeight: 500,
    transition: "all 0.12s",
    whiteSpace: "nowrap",
  },
  pillBadge: {
    background: "var(--c-primary-container)",
    color: "#fff",
    borderRadius: 10,
    padding: "0 5px",
    fontSize: 10,
    fontWeight: 700,
    lineHeight: "16px",
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
    border: "1px solid var(--c-border)",
    color: "var(--c-text-secondary)",
    fontSize: 12,
    cursor: "pointer",
    borderRadius: 20,
    padding: "4px 10px",
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  tableWrap: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)" as string,
    border: "1px solid var(--c-border)",
    overflow: "hidden",
    boxShadow: "var(--shadow-sm)" as string,
  },
  damagePill: {
    borderRadius: 12,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
  },
  flagPill: {
    background: "#FEF3C7",
    color: "#92400E",
    border: "1px solid #FDE68A",
    borderRadius: 12,
    padding: "2px 8px",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "normal",
    wordBreak: "break-word" as const,
    overflowWrap: "break-word" as const,
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    maxWidth: "100%",
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
  reviewBtn: {
    background: "var(--c-primary-container)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    letterSpacing: 0.2,
  },
  lockedBtn: {
    background: "transparent",
    color: "var(--c-text-muted)",
    border: "1.5px solid var(--c-border)",
    borderRadius: 7,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "not-allowed",
    opacity: 0.6,
    whiteSpace: "nowrap",
  },
  dismissBtn: {
    background: "transparent",
    color: "#D97706",
    border: "1.5px solid #FDE68A",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  forceBtn: {
    background: "transparent",
    color: "var(--c-flag-red)",
    border: "1.5px solid var(--c-flag-red)",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  confirmBlockBtn: {
    background: "#16A34A",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  reverseBlockBtn: {
    background: "transparent",
    color: "var(--c-flag-red)",
    border: "1.5px solid var(--c-flag-red)",
    borderRadius: 7,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  paginationRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 4px",
    marginBottom: 8,
  },
  paginationInfo: {
    fontSize: 12,
    color: "var(--c-text-muted)",
  },
  loadMoreBtn: {
    background: "transparent",
    color: "var(--c-primary-container)",
    border: "1.5px solid var(--c-primary-container)",
    borderRadius: 7,
    padding: "7px 18px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  footerStrip: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    padding: "10px 32px",
    background: "var(--c-surface-lowest)",
    borderTop: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  footerStat: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--c-text-secondary)",
    fontWeight: 500,
  },
  footerDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  footerDivider: {
    width: 1,
    height: 14,
    background: "var(--c-border)",
    margin: "0 16px",
    display: "inline-block",
  },
};

// ── Review Modal Styles (Tab1ReviewModal) ──────────────────────────────────────

const rms: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.52)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  dialog: {
    background: "var(--c-surface-lowest)",
    borderRadius: 16,
    width: 640,
    maxWidth: "96vw",
    maxHeight: "90vh",
    boxShadow: "0 24px 64px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.1)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 24px 18px",
    borderBottom: "1px solid var(--c-border)",
    flexShrink: 0,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    background: "#FEF2F2",
    border: "1.5px solid rgba(220,38,38,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
  },
  headerSub: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    margin: "3px 0 0",
    fontFamily: "monospace",
  },
  closeBtn: {
    background: "none",
    border: "1px solid var(--c-border)",
    fontSize: 20,
    color: "var(--c-text-muted)",
    cursor: "pointer",
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    lineHeight: 1,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  summaryCard: {
    background: "var(--c-surface-low)",
    border: "1px solid var(--c-border)",
    borderRadius: 10,
    padding: "14px 16px",
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 1fr",
    gap: "10px 16px",
  },
  summaryItem: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  summaryLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summaryValue: {
    fontSize: 13,
    color: "var(--c-text-primary)",
    fontWeight: 500,
  },
  damageBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    borderRadius: 12,
    padding: "3px 9px",
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: "nowrap",
    alignSelf: "flex-start",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionHeader: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-text-primary)",
  },
  sectionHint: {
    fontSize: 11,
    color: "var(--c-text-muted)",
  },
  reasonsList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  reasonRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "9px 12px",
    border: "1px solid var(--c-border)",
    borderRadius: 8,
    cursor: "pointer",
    transition: "opacity 0.15s, background 0.15s",
  },
  dismissToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  dismissedTag: {
    fontSize: 11,
    color: "#16A34A",
    fontWeight: 600,
    background: "#F0FDF4",
    border: "1px solid #BBF7D0",
    borderRadius: 10,
    padding: "1px 6px",
  },
  textarea: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
    background: "var(--c-surface-low)",
    lineHeight: 1.5,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 24px",
    borderTop: "1px solid var(--c-border)",
    flexShrink: 0,
    background: "var(--c-surface-low)",
  },
  approveBtn: {
    padding: "9px 20px",
    border: "none",
    borderRadius: 8,
    background: "#16A34A",
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  discardBtn: {
    padding: "9px 20px",
    border: "1.5px solid var(--c-flag-red)",
    borderRadius: 8,
    background: "transparent",
    color: "var(--c-flag-red)",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
};

// ── Modal Styles ───────────────────────────────────────────────────────────────

const ms: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.48)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: "var(--c-surface-lowest)",
    borderRadius: 14,
    padding: "28px 32px",
    width: 520,
    maxWidth: "92vw",
    boxShadow: "0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
    textAlign: "center",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-text-primary)",
  },
  textarea: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 8,
    padding: "9px 12px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
    background: "var(--c-surface-low)",
    lineHeight: 1.5,
  },
  select: {
    border: "1.5px solid var(--c-border)",
    borderRadius: 8,
    padding: "9px 12px",
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
    paddingTop: 4,
    borderTop: "1px solid var(--c-border)",
  },
  cancelBtn: {
    padding: "9px 22px",
    border: "1.5px solid var(--c-border)",
    borderRadius: 8,
    background: "var(--c-surface-lowest)",
    color: "var(--c-text-secondary)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
};
