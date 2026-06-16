import { useState, useEffect, useRef } from "react";
import {
  Square,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Lock,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import {
  acquireReviewLock,
  submitReviewDecision,
  releaseSoftLock,
  API_BASE,
  tokenStorage,
} from "../services/api";

// ── Flag reason metadata ───────────────────────────────────────────────────────

const FLAG_REASON_LABELS: Record<string, string> = {
  ip_country_mismatch: "IP Country Mismatch",
  same_ip_multiple_devices: "Same IP — Multiple Devices",
  duplicate_image: "Duplicate Image Hash",
  coordinated_gps_duplicate: "Coordinated GPS Duplicate",
  high_submission_rate: "High Submission Rate",
  no_photos: "No Photos Attached",
  no_location: "No Location Data",
  blocked_device: "Blocked Device",
  blocked_ip: "Blocked IP Address",
  duplicate_submission: "Duplicate Submission",
};

function getContextDetail(
  reason: string,
  meta: Record<string, unknown> | null | undefined
): string | null {
  if (!meta) return null;
  if (reason === "ip_country_mismatch") {
    return `IP geolocated: ${meta.geolocated_country ?? "?"}, reporter selected: ${meta.reporter_selected_country ?? "?"}`;
  }
  if (reason === "same_ip_multiple_devices") {
    const count = Array.isArray(meta.matching_reporters)
      ? meta.matching_reporters.length
      : 0;
    return `${count} matching device${count !== 1 ? "s" : ""} from same IP`;
  }
  if (reason === "duplicate_image") {
    if (!meta.matching_report_id) return null;
    const sn = meta.matching_report_serial_number;
    return sn != null
      ? `Matched report #${sn}`
      : `Matched report ${String(meta.matching_report_id).slice(0, 8).toUpperCase()}`;
  }
  if (reason === "coordinated_gps_duplicate") {
    return meta.matching_reporter_id
      ? `Matched reporter ${String(meta.matching_reporter_id).slice(0, 8).toUpperCase()}`
      : null;
  }
  return null;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReviewPanelProps {
  reportId: string;
  flagReasons: string[];
  flagMetadata: Record<string, Record<string, unknown> | null>;
  isFromQueue: boolean;
  onDecisionComplete: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReviewPanel({
  reportId,
  flagReasons,
  flagMetadata,
  isFromQueue,
  onDecisionComplete,
}: ReviewPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dismissedReasons, setDismissedReasons] = useState<Set<string>>(
    new Set()
  );
  const [decision, setDecision] = useState<"approve" | "discard" | null>(null);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  const lockHeldRef = useRef(false);

  // Acquire soft lock on mount if navigated from queue
  useEffect(() => {
    if (!isFromQueue) return;

    acquireReviewLock(reportId)
      .then(() => {
        lockHeldRef.current = true;
      })
      .catch((err: unknown) => {
        const detail = (
          err as {
            response?: {
              data?: { detail?: { locked_by?: string } | string };
            };
          }
        )?.response?.data?.detail;
        const lockedBy =
          typeof detail === "object" && detail !== null
            ? detail.locked_by
            : null;
        setLockError(
          lockedBy
            ? `This report is currently being reviewed by ${lockedBy}.`
            : "Could not acquire review lock. Reload the page to try again."
        );
      });

    function handleBeforeUnload() {
      if (!lockHeldRef.current) return;
      const token = tokenStorage.getAccessToken();
      fetch(`${API_BASE}/api/review-queue/release-lock`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ item_type: "report", item_id: reportId }),
        keepalive: true,
      });
    }

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (lockHeldRef.current) {
        lockHeldRef.current = false;
        releaseSoftLock("report", reportId).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, isFromQueue]);

  function toggleDismissed(reason: string) {
    setDismissedReasons((prev) => {
      const next = new Set(prev);
      if (next.has(reason)) next.delete(reason);
      else next.add(reason);
      return next;
    });
  }

  const commentValid = comment.trim().length >= 3;

  async function handleSubmitWithDecision(d: "approve" | "discard") {
    if (!commentValid || isSubmitting) return;
    setDecision(d);
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const flagAssessments = flagReasons.map((r) => ({
        reason: r,
        dismissed: dismissedReasons.has(r),
      }));
      await submitReviewDecision(reportId, d, flagAssessments, comment.trim());
      setSubmitSuccess(true);
      lockHeldRef.current = false;
      onDecisionComplete();
    } catch (e: unknown) {
      const detail = (
        e as { response?: { data?: { detail?: string | { message?: string } } } }
      )?.response?.data?.detail;
      const msg =
        typeof detail === "object" && detail !== null
          ? (detail.message ?? "Submission failed. Please try again.")
          : (detail ?? "Submission failed. Please try again.");
      setSubmitError(msg);
      setIsSubmitting(false);
    }
  }

  if (submitSuccess) {
    return (
      <div style={styles.successBanner}>
        <CheckCircle size={16} color="#276749" />
        <span>
          Decision submitted. Report has been moved out of the review queue.
        </span>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {/* Panel header / collapse toggle */}
      <button
        style={styles.panelHeader}
        onClick={() => setIsCollapsed((v) => !v)}
      >
        <div style={styles.panelHeaderLeft}>
          {isFromQueue && (
            <Lock size={14} color="#DD6B20" style={{ flexShrink: 0 }} />
          )}
          <span style={styles.panelTitle}>Review Panel</span>
          {isFromQueue && (
            <span style={styles.fromQueueBadge}>From Queue</span>
          )}
        </div>
        {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      {!isCollapsed && (
        <div style={styles.panelBody}>
          {/* Lock error */}
          {lockError && (
            <div style={styles.lockErrorBanner}>
              <Lock size={14} style={{ flexShrink: 0 }} />
              <span>{lockError}</span>
            </div>
          )}

          {/* Flag reason checkboxes */}
          {flagReasons.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Flag Reasons</div>
              <div style={styles.instructionNote}>
                Check off any reasons you have reviewed and determined to be
                acceptable or a false positive.
              </div>
              {flagReasons.map((reason) => {
                const isDismissed = dismissedReasons.has(reason);
                const label =
                  FLAG_REASON_LABELS[reason] ??
                  reason
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                const detail = getContextDetail(reason, flagMetadata[reason]);
                return (
                  <div
                    key={reason}
                    style={{
                      ...styles.flagRow,
                      opacity: isDismissed ? 0.65 : 1,
                    }}
                    onClick={() => toggleDismissed(reason)}
                  >
                    {isDismissed ? (
                      <CheckSquare
                        size={16}
                        color="#38A169"
                        style={{ flexShrink: 0, marginTop: 1 }}
                      />
                    ) : (
                      <Square
                        size={16}
                        color="#718096"
                        style={{ flexShrink: 0, marginTop: 1 }}
                      />
                    )}
                    <div style={styles.flagRowContent}>
                      <span
                        style={{
                          ...styles.flagLabel,
                          textDecoration: isDismissed ? "line-through" : "none",
                          color: isDismissed ? "#718096" : "#2d3748",
                        }}
                      >
                        {label}
                      </span>
                      {detail && (
                        <span style={styles.flagDetail}>{detail}</span>
                      )}
                    </div>
                    {isDismissed && (
                      <span style={styles.dismissedBadge}>Dismissed</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Instruction banner */}
          <div style={styles.instructionBanner}>
            <AlertTriangle
              size={14}
              color="#DD6B20"
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <span>
              Review all flag reasons above before making a decision.{" "}
              <strong>Approve</strong> moves the report to Orange (passed with
              notes). <strong>Discard</strong> removes it from active reporting.
            </span>
          </div>

          {/* Decision radio buttons */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>Decision</div>
            <label style={styles.radioRow}>
              <input
                type="radio"
                name={`decision-${reportId}`}
                value="approve"
                checked={decision === "approve"}
                onChange={() => setDecision("approve")}
                style={{ marginRight: 8 }}
              />
              <span>Approve — move to Orange (passed with notes)</span>
            </label>
            <label style={styles.radioRow}>
              <input
                type="radio"
                name={`decision-${reportId}`}
                value="discard"
                checked={decision === "discard"}
                onChange={() => setDecision("discard")}
                style={{ marginRight: 8 }}
              />
              <span>Discard — remove from active reporting</span>
            </label>
          </div>

          {/* Comment */}
          <div style={styles.section}>
            <div style={styles.sectionLabel}>
              Review Comment{" "}
              <span style={{ fontWeight: 400, color: "#718096" }}>
                (required, min 3 chars)
              </span>
            </div>
            <textarea
              style={styles.textarea}
              rows={3}
              placeholder="Describe your reasoning…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div style={styles.charCount}>{comment.trim().length} / 3 min</div>
          </div>

          {/* Submit error */}
          {submitError && (
            <div style={styles.submitError}>{submitError}</div>
          )}

          {/* Approve / Discard buttons */}
          <div style={styles.actionRow}>
            <button
              style={{
                ...styles.approveBtn,
                opacity:
                  commentValid && !isSubmitting && decision === "approve"
                    ? 1
                    : 0.4,
                cursor:
                  commentValid && !isSubmitting && decision === "approve"
                    ? "pointer"
                    : "not-allowed",
              }}
              disabled={!commentValid || isSubmitting || decision !== "approve"}
              onClick={() => handleSubmitWithDecision("approve")}
            >
              {isSubmitting && decision === "approve"
                ? "Submitting…"
                : "Approve"}
            </button>
            <button
              style={{
                ...styles.discardBtn,
                opacity:
                  commentValid && !isSubmitting && decision === "discard"
                    ? 1
                    : 0.4,
                cursor:
                  commentValid && !isSubmitting && decision === "discard"
                    ? "pointer"
                    : "not-allowed",
              }}
              disabled={!commentValid || isSubmitting || decision !== "discard"}
              onClick={() => handleSubmitWithDecision("discard")}
            >
              {isSubmitting && decision === "discard"
                ? "Submitting…"
                : "Discard"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  panel: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    marginBottom: 20,
    overflow: "hidden",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    background: "#fffaf0",
    borderBottom: "1px solid #fbd38d",
    cursor: "pointer",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    outline: "none",
  },
  panelHeaderLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  panelTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: "#2d3748",
  },
  fromQueueBadge: {
    background: "#DD6B20",
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 10,
  },
  panelBody: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  lockErrorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    background: "#fffbeb",
    border: "1px solid #fbbf24",
    borderRadius: 6,
    fontSize: 13,
    color: "#92400e",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  sectionLabel: {
    fontWeight: 600,
    fontSize: 13,
    color: "#2d3748",
  },
  instructionNote: {
    fontSize: 12,
    color: "#718096",
    margin: 0,
  },
  flagRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid #e2e8f0",
    background: "#f7fafc",
    userSelect: "none" as const,
  },
  flagRowContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  flagLabel: {
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.4,
  },
  flagDetail: {
    fontSize: 12,
    color: "#718096",
  },
  dismissedBadge: {
    background: "#C6F6D5",
    color: "#276749",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: 10,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  instructionBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "10px 14px",
    background: "#fffaf0",
    borderLeft: "3px solid #DD6B20",
    borderRadius: "0 4px 4px 0",
    fontSize: 13,
    color: "#744210",
    lineHeight: 1.5,
  },
  radioRow: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "#2d3748",
    cursor: "pointer",
    padding: "4px 0",
  },
  textarea: {
    width: "100%",
    padding: "8px 10px",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    fontSize: 13,
    resize: "vertical" as const,
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
    outline: "none",
  },
  charCount: {
    fontSize: 11,
    color: "#a0aec0",
    textAlign: "right" as const,
  },
  submitError: {
    padding: "8px 12px",
    background: "#fff5f5",
    border: "1px solid #feb2b2",
    borderRadius: 6,
    fontSize: 13,
    color: "#c53030",
  },
  actionRow: {
    display: "flex",
    gap: 10,
  },
  approveBtn: {
    padding: "9px 22px",
    background: "#38A169",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
  },
  discardBtn: {
    padding: "9px 22px",
    background: "#E53E3E",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
  },
  successBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "14px 16px",
    background: "#f0fff4",
    border: "1px solid #9ae6b4",
    borderRadius: 8,
    fontSize: 13,
    color: "#276749",
    marginBottom: 20,
  },
};
