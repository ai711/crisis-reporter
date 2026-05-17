import { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Header from "../components/Header";
import {
  getPropertyDetail,
  setConfirmedStatus,
  savePropertyOverride,
  getPropertyComments,
  postPropertyComment,
  setRecoveryStatus,
  flagPropertyForReview,
  getReporterVersionHistory,
} from "../services/api";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";
import type { PropertyDetail, PropertyComment, VersionHistoryEntry, ReporterRow } from "../types";

// ── Colours ───────────────────────────────────────────────────────────────────

const DAMAGE_COLORS: Record<string, string> = {
  completely_destroyed: "#f44336",
  partially_damaged: "#ff9800",
  minimal_or_no_damage: "#4caf50",
  complete: "#f44336",
  partial: "#ff9800",
  minimal: "#4caf50",
};

const FLAG_COLORS: Record<string, string> = {
  grey: "#9aa5b4",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
  discarded: "#bbb",
};

// ── Inline SVGs ───────────────────────────────────────────────────────────────

function LockIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ marginRight: 4, flexShrink: 0 }} aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

// ── Confirmed Status Modal ────────────────────────────────────────────────────

interface ConfirmedStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetStatus: string | null;
  onConfirm: (comment: string) => void;
  isSubmitting: boolean;
  error: string | null;
}

function ConfirmedStatusModal({
  isOpen, onClose, targetStatus, onConfirm, isSubmitting, error,
}: ConfirmedStatusModalProps) {
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (isOpen) setComment("");
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmedLen = comment.trim().length;
  const isValid = trimmedLen >= 10;
  const label = targetStatus ? formatDamageLevel(targetStatus) : "Clear Confirmed Status";

  return (
    <>
      <div style={mStyles.backdrop} />
      <div style={mStyles.overlay}>
        <div style={mStyles.modal} role="dialog" aria-modal="true">
          <h2 style={mStyles.title}>Set Confirmed Status</h2>
          <p style={mStyles.subtitle}>
            Confirmed status will be set to{" "}
            <strong>{label}</strong>. This decision will be recorded in the comments thread.
          </p>
          <div style={mStyles.field}>
            <label style={mStyles.fieldLabel}>Comment (required, minimum 10 characters)</label>
            <textarea
              style={mStyles.textarea}
              placeholder="Describe your reason for this decision…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              disabled={isSubmitting}
            />
            <div style={{ ...mStyles.charCounter, color: isValid ? "#4caf50" : "#999" }}>
              {trimmedLen} / 10 minimum
            </div>
          </div>
          {error && <div style={mStyles.errorBox}>{error}</div>}
          <div style={mStyles.actions}>
            <button style={mStyles.cancelBtn} onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              style={{
                ...mStyles.confirmBtn,
                opacity: isValid && !isSubmitting ? 1 : 0.4,
                cursor: isValid && !isSubmitting ? "pointer" : "not-allowed",
              }}
              onClick={() => { if (isValid && !isSubmitting) onConfirm(comment.trim()); }}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Recovery Modal ────────────────────────────────────────────────────────────

interface RecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  action: "recover" | "reinstate";
  onConfirm: (comment: string) => void;
  isSubmitting: boolean;
  error: string | null;
}

function RecoveryModal({ isOpen, onClose, action, onConfirm, isSubmitting, error }: RecoveryModalProps) {
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (isOpen) setComment("");
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmedLen = comment.trim().length;
  const isValid = trimmedLen >= 10;
  const label = action === "recover" ? "Mark as Recovered" : "Reinstate";

  return (
    <>
      <div style={mStyles.backdrop} />
      <div style={mStyles.overlay}>
        <div style={mStyles.modal} role="dialog" aria-modal="true">
          <h2 style={mStyles.title}>{label}</h2>
          <p style={mStyles.subtitle}>
            {action === "recover"
              ? "This property will be marked as Recovered. All future exports will reflect the recovery."
              : "This property will be reinstated as Active."}
          </p>
          <div style={mStyles.field}>
            <label style={mStyles.fieldLabel}>Comment (required, minimum 10 characters)</label>
            <textarea
              style={mStyles.textarea}
              placeholder="Describe your reason…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              disabled={isSubmitting}
            />
            <div style={{ ...mStyles.charCounter, color: isValid ? "#4caf50" : "#999" }}>
              {trimmedLen} / 10 minimum
            </div>
          </div>
          {error && <div style={mStyles.errorBox}>{error}</div>}
          <div style={mStyles.actions}>
            <button style={mStyles.cancelBtn} onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              style={{
                ...mStyles.confirmBtn,
                opacity: isValid && !isSubmitting ? 1 : 0.4,
                cursor: isValid && !isSubmitting ? "pointer" : "not-allowed",
              }}
              onClick={() => { if (isValid && !isSubmitting) onConfirm(comment.trim()); }}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Saving…" : label}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Reporter Version Row ──────────────────────────────────────────────────────

function ReporterVersionRow({
  propertyId,
  row,
  showUnreviewed,
}: {
  propertyId: string;
  row: ReporterRow;
  showUnreviewed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<VersionHistoryEntry[] | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const handleExpand = async () => {
    if (!expanded && versions === null) {
      setLoadingVersions(true);
      try {
        const res = await getReporterVersionHistory(propertyId, row.reporter_id);
        setVersions(res.data);
      } catch {
        setVersions([]);
      } finally {
        setLoadingVersions(false);
      }
    }
    setExpanded((e) => !e);
  };

  const isUnreviewed = showUnreviewed && (row.flag_status === "grey" || row.flag_status === "red");
  const dmgColor = DAMAGE_COLORS[row.most_recent_damage_level] ?? "#888";
  const flagColor = FLAG_COLORS[row.flag_status] ?? "#888";

  return (
    <>
      <tr
        style={{
          ...s.tr,
          background: isUnreviewed ? "#FFF8E1" : "#fff",
        }}
      >
        <td style={s.td}>
          <span
            style={s.link}
            onClick={() => window.open("/reporters/" + row.reporter_id, "_blank")}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") window.open("/reporters/" + row.reporter_id, "_blank"); }}
          >
            {row.reporter_id.slice(0, 8)}…
          </span>
        </td>
        <td style={s.td}>
          {row.reporter_name ?? <span style={s.muted}>Anonymous</span>}
        </td>
        <td style={s.td}>
          <span style={{ ...s.pill, background: dmgColor }}>
            {formatDamageLevel(row.most_recent_damage_level)}
          </span>
        </td>
        <td style={s.td}>{formatDateTime(row.most_recent_submitted_at)}</td>
        <td style={s.td}>
          <span style={s.platformBadge}>{row.platform}</span>
        </td>
        <td style={s.td}>
          <span style={{ ...s.pill, background: flagColor }}>
            {row.flag_status.charAt(0).toUpperCase() + row.flag_status.slice(1)}
          </span>
        </td>
        <td style={s.td}>
          <button style={s.expandBtn} onClick={handleExpand} aria-label="Toggle version history">
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr style={{ background: "#f8fafc" }}>
          <td colSpan={7} style={{ padding: "12px 20px" }}>
            {loadingVersions && (
              <div style={{ color: "#9aa5b4", fontSize: 13 }}>Loading version history…</div>
            )}
            {!loadingVersions && versions !== null && versions.length === 0 && (
              <div style={{ color: "#9aa5b4", fontSize: 13 }}>
                This is the only submission from this reporter for this property.
              </div>
            )}
            {!loadingVersions && versions !== null && versions.length === 1 && (
              <div style={{ color: "#9aa5b4", fontSize: 13 }}>
                This is the only submission from this reporter for this property.
              </div>
            )}
            {!loadingVersions && versions !== null && versions.length > 1 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Report ID", "Submitted At", "Damage Level", "Flag Status", "Change Note"].map((h) => (
                      <th key={h} style={{ padding: "6px 12px", textAlign: "left", color: "#9aa5b4", fontWeight: 600, borderBottom: "1px solid #e8eef4" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.report_id}>
                      <td style={{ padding: "6px 12px" }}>
                        <span
                          style={s.link}
                          onClick={() => window.open("/reports/" + v.report_id, "_blank")}
                          role="link"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === "Enter") window.open("/reports/" + v.report_id, "_blank"); }}
                        >
                          {v.report_id.slice(0, 8)}…
                        </span>
                      </td>
                      <td style={{ padding: "6px 12px" }}>{formatDateTime(v.submitted_at)}</td>
                      <td style={{ padding: "6px 12px" }}>
                        <span style={{ ...s.pill, background: DAMAGE_COLORS[v.damage_level] ?? "#888", fontSize: 11 }}>
                          {formatDamageLevel(v.damage_level)}
                        </span>
                      </td>
                      <td style={{ padding: "6px 12px" }}>
                        <span style={{ ...s.pill, background: FLAG_COLORS[v.flag_status] ?? "#888", fontSize: 11 }}>
                          {v.flag_status.charAt(0).toUpperCase() + v.flag_status.slice(1)}
                        </span>
                      </td>
                      <td style={{ padding: "6px 12px", color: "#5a6878" }}>
                        {v.change_note ?? <span style={s.muted}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Comments Thread ───────────────────────────────────────────────────────────

function CommentsThread({ propertyId }: { propertyId: string }) {
  const queryClient = useQueryClient();
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const { data: comments = [] } = useQuery<PropertyComment[]>({
    queryKey: ["property-comments", propertyId],
    queryFn: async () => {
      const res = await getPropertyComments(propertyId);
      return res.data;
    },
    refetchInterval: 15000,
  });

  // Auto-scroll only when NEW comments arrive
  useEffect(() => {
    if (comments.length > prevCountRef.current && threadRef.current) {
      const el = threadRef.current;
      el.scrollTop = el.scrollHeight;
    }
    prevCountRef.current = comments.length;
  }, [comments.length]);

  const handlePost = async () => {
    if (!commentText.trim()) return;
    setPosting(true);
    setPostError(null);
    try {
      await postPropertyComment(propertyId, commentText.trim());
      await queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
      setCommentText("");
    } catch {
      setPostError("Failed to post comment. Please try again.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div style={s.commentsSection}>
      <div style={s.sectionTitle}>Internal Comments</div>

      <div ref={threadRef} style={s.commentsThread}>
        {comments.length === 0 && (
          <div style={{ color: "#9aa5b4", fontSize: 13, textAlign: "center", padding: "24px 0" }}>
            No comments yet. Be the first to add a note.
          </div>
        )}
        {comments.map((c) => (
          <div
            key={c.id}
            style={{
              ...s.commentEntry,
              background: c.is_system_generated ? "#F5F5F5" : "#fff",
              border: c.is_system_generated ? "1px solid #ebebeb" : "1px solid #f0f4f8",
            }}
          >
            <div style={s.commentHeader}>
              {c.is_system_generated ? (
                <span style={s.systemLabel}>System</span>
              ) : (
                <span style={s.commentAuthor}>{c.dashboard_user_name ?? "Staff"}</span>
              )}
              {c.system_event_type && (
                <span style={s.eventBadge}>{c.system_event_type}</span>
              )}
              <span style={s.commentTime}>{formatDateTime(c.created_at)}</span>
            </div>
            <div style={s.commentText}>{c.comment_text}</div>
          </div>
        ))}
      </div>

      <div style={s.commentInputWrap}>
        <textarea
          style={s.commentTextarea}
          placeholder="Add an internal comment…"
          value={commentText}
          onChange={(e) => setCommentText(e.target.value.slice(0, 2000))}
          rows={3}
          disabled={posting}
        />
        <div style={s.commentFooter}>
          <span style={{ fontSize: 11, color: commentText.length >= 1900 ? "#e65100" : "#9aa5b4" }}>
            {commentText.length}/2000
          </span>
          {postError && <span style={{ fontSize: 12, color: "#c62828" }}>{postError}</span>}
          <button
            style={{
              ...s.postBtn,
              opacity: commentText.trim().length > 0 && !posting ? 1 : 0.4,
              cursor: commentText.trim().length > 0 && !posting ? "pointer" : "not-allowed",
            }}
            onClick={handlePost}
            disabled={commentText.trim().length === 0 || posting}
          >
            {posting ? "Posting…" : "Post Comment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const CONFIRM_OPTIONS = [
  { value: "completely_destroyed", label: "Completely Destroyed" },
  { value: "partially_damaged", label: "Partially Damaged" },
  { value: "minimal_or_no_damage", label: "Minimal or No Damage" },
  { value: null, label: "Clear Confirmed Status" },
] as const;

export default function PropertyDetailPage() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("project_id") ?? undefined;
  const queryClient = useQueryClient();

  // ── Confirmed status state
  const [confirmDropOpen, setConfirmDropOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  // ── Recovery state
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<"recover" | "reinstate">("recover");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);

  // ── Flag for review state
  const [flagPanelOpen, setFlagPanelOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [flagSubmitting, setFlagSubmitting] = useState(false);

  // ── Override state
  const [overrideName, setOverrideName] = useState("");
  const [overrideLat, setOverrideLat] = useState("");
  const [overrideLng, setOverrideLng] = useState("");
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  const [overrideSuccess, setOverrideSuccess] = useState(false);

  // ── Reporter rows
  const [showUnreviewed, setShowUnreviewed] = useState(false);

  // ── Toast
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  // ── Property detail query
  const { data: property, isLoading, isError } = useQuery<PropertyDetail>({
    queryKey: ["property-detail", propertyId, projectId],
    queryFn: async () => {
      const res = await getPropertyDetail(propertyId!, projectId);
      return res.data;
    },
    enabled: !!propertyId,
  });

  // Pre-fill override fields when property loads
  useEffect(() => {
    if (property) {
      setOverrideName(property.override_name ?? "");
      setOverrideLat(property.override_lat?.toString() ?? "");
      setOverrideLng(property.override_lng?.toString() ?? "");
    }
  }, [property?.property_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidateProperty = () => {
    queryClient.invalidateQueries({ queryKey: ["property-detail", propertyId, projectId] });
  };

  // ── Confirmed status submit
  const handleConfirmStatus = async (comment: string) => {
    setConfirmSubmitting(true);
    setConfirmError(null);
    try {
      await setConfirmedStatus(propertyId!, confirmTarget, comment);
      invalidateProperty();
      setConfirmModalOpen(false);
      showToast("Confirmed status updated successfully.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update confirmed status.";
      setConfirmError(msg);
    } finally {
      setConfirmSubmitting(false);
    }
  };

  // ── Recovery submit
  const handleRecovery = async (comment: string) => {
    setRecoverySubmitting(true);
    setRecoveryError(null);
    try {
      await setRecoveryStatus(propertyId!, recoveryAction === "recover", comment);
      invalidateProperty();
      setRecoveryModalOpen(false);
      showToast(recoveryAction === "recover" ? "Property marked as Recovered." : "Property reinstated as Active.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update recovery status.";
      setRecoveryError(msg);
    } finally {
      setRecoverySubmitting(false);
    }
  };

  // ── Flag for review submit
  const handleFlagForReview = async () => {
    setFlagSubmitting(true);
    try {
      await flagPropertyForReview(propertyId!, flagNote.trim() || undefined);
      invalidateProperty();
      setFlagPanelOpen(false);
      setFlagNote("");
      showToast("Property flagged for review.");
    } catch {
      showToast("Failed to flag property.");
    } finally {
      setFlagSubmitting(false);
    }
  };

  // ── Override submit
  const handleOverrideSave = async () => {
    setOverrideSubmitting(true);
    setOverrideSuccess(false);
    try {
      await savePropertyOverride(propertyId!, {
        override_name: overrideName.trim() || null,
        override_lat: overrideLat ? parseFloat(overrideLat) : null,
        override_lng: overrideLng ? parseFloat(overrideLng) : null,
      });
      invalidateProperty();
      setOverrideSuccess(true);
      setTimeout(() => setOverrideSuccess(false), 3000);
    } catch {
      showToast("Failed to save override.");
    } finally {
      setOverrideSubmitting(false);
    }
  };

  // ── Render helpers
  const displayName = property
    ? (property.override_name ?? property.display_name)
    : "Property Detail";

  const pageTitle = isLoading ? "Loading…" : isError ? "Error" : displayName;

  const dmgColor = property?.current_damage_level
    ? DAMAGE_COLORS[property.current_damage_level] ?? "#888"
    : "#888";

  const confirmedColor = property?.confirmed_status
    ? DAMAGE_COLORS[property.confirmed_status] ?? "#888"
    : null;

  if (isLoading) {
    return (
      <div style={s.page}>
        <Header title="Loading…" />
        <div style={{ padding: 60, textAlign: "center", color: "#9aa5b4" }}>
          Loading property details…
        </div>
      </div>
    );
  }

  if (isError || !property) {
    return (
      <div style={s.page}>
        <Header title="Property Detail" />
        <div style={{ padding: 60, textAlign: "center", color: "#c62828" }}>
          Failed to load property. Check the Property ID and try again.
        </div>
      </div>
    );
  }

  const {
    damage_distribution: dd,
    conflict_warning_details: cwd,
    reporter_rows,
  } = property;

  const totalDist = (dd?.completely_destroyed ?? 0) + (dd?.partially_damaged ?? 0) + (dd?.minimal_or_no_damage ?? 0);
  const distPct = (n: number) => totalDist > 0 ? Math.round((n / totalDist) * 100) : 0;
  const destroyedPct = distPct(dd?.completely_destroyed ?? 0);
  const partialPct = distPct(dd?.partially_damaged ?? 0);
  const minimalPct = distPct(dd?.minimal_or_no_damage ?? 0);

  const lat = property.override_lat ?? property.latitude;
  const lng = property.override_lng ?? property.longitude;

  return (
    <div style={s.page}>
      <Header title={pageTitle} subtitle="Individual property assessment" />

      <div style={s.body}>

        {/* ── Section 1: Property Summary Card ── */}
        <div style={s.card}>
          <div style={s.summaryGrid}>
            {/* Left */}
            <div style={s.summaryLeft}>
              <div style={s.propertyName}>{displayName}</div>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>Address</span>
                <span style={s.summaryVal}>
                  {property.address ?? "Address not recorded"}
                </span>
              </div>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>GPS</span>
                <span style={s.summaryVal}>
                  {lat.toFixed(5)}, {lng.toFixed(5)}
                </span>
              </div>
              <div style={s.summaryRow}>
                <span style={s.summaryLabel}>Country</span>
                <span style={s.summaryVal}>{property.country ?? "—"}</span>
              </div>
              {projectId && (
                <div style={s.summaryRow}>
                  <span style={s.summaryLabel}>Project</span>
                  <span
                    style={s.link}
                    onClick={() => window.open("/projects/" + projectId, "_blank")}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") window.open("/projects/" + projectId, "_blank"); }}
                  >
                    View Project ↗
                  </span>
                </div>
              )}
            </div>

            {/* Right */}
            <div style={s.summaryRight}>
              {/* Damage pill */}
              {confirmedColor ? (
                <span style={{ ...s.pill, background: confirmedColor, fontSize: 14, padding: "6px 16px", marginBottom: 12 }}>
                  <LockIcon />
                  {formatDamageLevel(property.confirmed_status!)}
                  <span style={s.confirmedBadge}>Confirmed</span>
                </span>
              ) : (
                property.current_damage_level && (
                  <span style={{ ...s.pill, background: dmgColor, fontSize: 14, padding: "6px 16px", marginBottom: 12 }}>
                    {formatDamageLevel(property.current_damage_level)}
                  </span>
                )
              )}

              {/* Set Confirmed Status dropdown */}
              <div style={{ position: "relative", marginBottom: 10 }}>
                <button
                  style={s.confirmedBtn}
                  onClick={() => setConfirmDropOpen((o) => !o)}
                >
                  {property.confirmed_status
                    ? "Update Confirmed Status ▾"
                    : "NOT YET CONFIRMED ▾"}
                </button>
                {confirmDropOpen && (
                  <div style={s.dropdown}>
                    {CONFIRM_OPTIONS.map((opt) => (
                      <button
                        key={opt.value ?? "clear"}
                        style={s.dropdownItem}
                        onClick={() => {
                          setConfirmTarget(opt.value ?? null);
                          setConfirmDropOpen(false);
                          setConfirmError(null);
                          setConfirmModalOpen(true);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Property status + recovery */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span style={{
                  fontWeight: 700,
                  fontSize: 13,
                  color: property.property_status === "Active" ? "#2e7d32" : "#9aa5b4",
                  padding: "4px 12px",
                  borderRadius: 12,
                  background: property.property_status === "Active" ? "#e8f5e9" : "#f0f4f8",
                }}>
                  {property.property_status}
                </span>
                {property.property_status === "Active" ? (
                  <button
                    style={s.secondaryBtn}
                    onClick={() => { setRecoveryAction("recover"); setRecoveryError(null); setRecoveryModalOpen(true); }}
                  >
                    Mark as Recovered
                  </button>
                ) : (
                  <button
                    style={s.secondaryBtn}
                    onClick={() => { setRecoveryAction("reinstate"); setRecoveryError(null); setRecoveryModalOpen(true); }}
                  >
                    Reinstate
                  </button>
                )}
              </div>

              {/* Flag for review */}
              <button
                style={{ ...s.secondaryBtn, borderColor: "#ff9800", color: "#e65100" }}
                onClick={() => setFlagPanelOpen((o) => !o)}
              >
                {property.is_flagged_for_review ? "Flagged for Review" : "Flag for Review"}
              </button>

              {flagPanelOpen && (
                <div style={s.flagPanel}>
                  <div style={{ fontSize: 13, marginBottom: 8, color: "#444" }}>
                    Optional note:
                  </div>
                  <textarea
                    style={s.flagTextarea}
                    placeholder="Describe why this property needs review…"
                    value={flagNote}
                    onChange={(e) => setFlagNote(e.target.value)}
                    rows={3}
                    disabled={flagSubmitting}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                    <button style={s.cancelBtn} onClick={() => setFlagPanelOpen(false)}>
                      Cancel
                    </button>
                    <button
                      style={{ ...s.primaryBtn, opacity: flagSubmitting ? 0.5 : 1 }}
                      onClick={handleFlagForReview}
                      disabled={flagSubmitting}
                    >
                      {flagSubmitting ? "Flagging…" : "Confirm"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Conflict Warning Banner ── */}
        {property.has_conflict_warning && !property.confirmed_status && (
          <div style={s.conflictBanner}>
            <AlertTriangleIcon />
            <div>
              <strong>Conflicting assessments</strong> — reporters have submitted different damage
              levels for this property.
              {cwd && (
                <span style={{ marginLeft: 6, color: "#5a3a00" }}>
                  Majority: {formatDamageLevel(cwd.majority_level)}.{" "}
                  {cwd.minority_count} reporter{cwd.minority_count !== 1 ? "s" : ""}{" "}
                  ({cwd.minority_percentage}%) disagree.
                </span>
              )}
              {" "}Review the reporter rows below and set a Confirmed Status to resolve.
            </div>
          </div>
        )}

        {/* ── Section 2: Property Override ── */}
        <div style={s.card}>
          <div style={s.cardTitle}>Official Override</div>
          <div style={s.overrideGrid}>
            <div style={s.fieldGroup}>
              <label style={s.fieldLabel}>Official Property Name</label>
              <input
                style={s.textInput}
                type="text"
                placeholder="Enter official name…"
                value={overrideName}
                onChange={(e) => setOverrideName(e.target.value)}
              />
            </div>
            <div style={s.fieldGroup}>
              <label style={s.fieldLabel}>Corrected GPS Coordinates</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{ ...s.textInput, flex: 1 }}
                  type="number"
                  step="0.00001"
                  placeholder="Latitude"
                  value={overrideLat}
                  onChange={(e) => setOverrideLat(e.target.value)}
                />
                <input
                  style={{ ...s.textInput, flex: 1 }}
                  type="number"
                  step="0.00001"
                  placeholder="Longitude"
                  value={overrideLng}
                  onChange={(e) => setOverrideLng(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            <button
              style={{ ...s.primaryBtn, opacity: overrideSubmitting ? 0.5 : 1 }}
              onClick={handleOverrideSave}
              disabled={overrideSubmitting}
            >
              {overrideSubmitting ? "Saving…" : "Save Override"}
            </button>
            {overrideSuccess && (
              <span style={{ color: "#2e7d32", fontSize: 13, fontWeight: 500 }}>
                Override saved successfully.
              </span>
            )}
          </div>
        </div>

        {/* ── Section 3: Stats Row ── */}
        <div style={s.statsRow}>
          <div style={s.statBox}>
            <div style={s.statNum}>{property.total_reports}</div>
            <div style={s.statLbl}>Total Reports</div>
          </div>
          <div style={s.statBox}>
            <div style={s.statNum}>{property.total_reporters}</div>
            <div style={s.statLbl}>Total Reporters</div>
          </div>
          <div style={s.statBox}>
            <div style={{ ...s.statNum, fontSize: 14 }}>
              {formatDateTime(property.most_recent_report_at)}
            </div>
            <div style={s.statLbl}>Most Recent Report</div>
          </div>
          <div style={{ ...s.statBox, flex: 2 }}>
            <div style={s.statLbl}>Damage Distribution</div>
            <div style={s.distBarOuter}>
              {destroyedPct > 0 && (
                <div
                  style={{ ...s.distBarSeg, background: "#f44336", width: `${destroyedPct}%` }}
                  title={`Completely Destroyed: ${destroyedPct}%`}
                >
                  {destroyedPct > 8 && `${destroyedPct}%`}
                </div>
              )}
              {partialPct > 0 && (
                <div
                  style={{ ...s.distBarSeg, background: "#ff9800", width: `${partialPct}%` }}
                  title={`Partially Damaged: ${partialPct}%`}
                >
                  {partialPct > 8 && `${partialPct}%`}
                </div>
              )}
              {minimalPct > 0 && (
                <div
                  style={{ ...s.distBarSeg, background: "#4caf50", width: `${minimalPct}%` }}
                  title={`Minimal or No Damage: ${minimalPct}%`}
                >
                  {minimalPct > 8 && `${minimalPct}%`}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Section 4: Reporter Rows ── */}
        <div style={s.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
            <div style={s.cardTitle}>Reporter Assessments</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginLeft: "auto" }}>
              <div
                style={{
                  ...s.toggle,
                  background: showUnreviewed ? "#0468B1" : "#ccc",
                }}
                onClick={() => setShowUnreviewed((v) => !v)}
                role="switch"
                aria-checked={showUnreviewed}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") setShowUnreviewed((v) => !v); }}
              >
                <div style={{ ...s.toggleThumb, transform: showUnreviewed ? "translateX(20px)" : "translateX(2px)" }} />
              </div>
              <span style={{ fontSize: 12, color: "#5a6878" }}>Show unreviewed reports</span>
            </label>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={s.table}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["Reporter ID", "Name", "Most Recent Damage", "Submitted At", "Platform", "Flag", ""].map((h) => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reporter_rows
                  .filter((r) => {
                    if (!showUnreviewed) return true;
                    return true;
                  })
                  .map((row) => (
                    <ReporterVersionRow
                      key={row.reporter_id}
                      propertyId={propertyId!}
                      row={row}
                      showUnreviewed={showUnreviewed}
                    />
                  ))}
                {reporter_rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: "32px", textAlign: "center", color: "#9aa5b4", fontSize: 13 }}>
                      No reporter assessments yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Section 5: Comments Thread ── */}
        <CommentsThread propertyId={propertyId!} />

      </div>

      {/* ── Modals ── */}
      <ConfirmedStatusModal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        targetStatus={confirmTarget}
        onConfirm={handleConfirmStatus}
        isSubmitting={confirmSubmitting}
        error={confirmError}
      />

      <RecoveryModal
        isOpen={recoveryModalOpen}
        onClose={() => setRecoveryModalOpen(false)}
        action={recoveryAction}
        onConfirm={handleRecovery}
        isSubmitting={recoverySubmitting}
        error={recoveryError}
      />

      {/* ── Toast ── */}
      {toast && (
        <div style={s.toast}>{toast}</div>
      )}
    </div>
  );
}

// ── Modal Styles ──────────────────────────────────────────────────────────────

const mStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900,
  },
  overlay: {
    position: "fixed", inset: 0, zIndex: 901,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
  },
  modal: {
    background: "#fff", borderRadius: 14, padding: "28px 28px 24px",
    width: "100%", maxWidth: 480,
    boxShadow: "0 20px 60px rgba(0,0,0,0.22)", border: "1px solid #e0e8f0",
  },
  title: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", margin: "0 0 8px" },
  subtitle: { fontSize: 13, color: "#555", margin: "0 0 20px", lineHeight: 1.5 },
  field: { marginBottom: 16 },
  fieldLabel: {
    display: "block", fontSize: 12, fontWeight: 600, color: "#555",
    marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4,
  },
  textarea: {
    width: "100%", padding: "10px 12px", border: "1.5px solid #d0dce8",
    borderRadius: 8, fontSize: 13, color: "#1A2B4A", resize: "vertical",
    outline: "none", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box",
  },
  charCounter: { fontSize: 11, marginTop: 5, textAlign: "right", transition: "color 0.15s" },
  errorBox: {
    background: "#fff3f3", border: "1px solid #f44336", borderRadius: 7,
    padding: "10px 14px", fontSize: 13, color: "#c62828", marginBottom: 16,
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 },
  cancelBtn: {
    padding: "9px 20px", background: "#f4f6f9", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 500, color: "#444", cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px", background: "#0468B1", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#fff",
  },
};

// ── Page Styles ───────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
  },
  body: {
    flex: 1, overflowY: "auto", padding: "20px 32px 40px",
    display: "flex", flexDirection: "column", gap: 16,
  },
  card: {
    background: "#fff", border: "1px solid #e8eef4",
    borderRadius: 12, padding: "24px 28px",
  },
  cardTitle: {
    fontSize: 15, fontWeight: 700, color: "#1A2B4A", marginBottom: 16,
  },
  summaryGrid: {
    display: "grid", gridTemplateColumns: "1fr auto", gap: 32, alignItems: "start",
  },
  summaryLeft: { display: "flex", flexDirection: "column", gap: 8 },
  summaryRight: {
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0, minWidth: 260,
  },
  propertyName: {
    fontSize: 22, fontWeight: 800, color: "#1A2B4A", marginBottom: 8, lineHeight: 1.2,
  },
  summaryRow: { display: "flex", gap: 12, alignItems: "baseline" },
  summaryLabel: {
    fontSize: 11, fontWeight: 700, color: "#9aa5b4", textTransform: "uppercase",
    letterSpacing: 0.5, minWidth: 60,
  },
  summaryVal: { fontSize: 13, color: "#1A2B4A" },
  pill: {
    display: "inline-flex", alignItems: "center", padding: "4px 12px",
    borderRadius: 12, color: "#fff", fontSize: 12, fontWeight: 600,
  },
  confirmedBadge: {
    marginLeft: 8, fontSize: 11, fontWeight: 500,
    background: "rgba(255,255,255,0.25)", padding: "2px 7px", borderRadius: 10,
  },
  confirmedBtn: {
    width: "100%", padding: "10px 16px", border: "1.5px solid #d0dce8",
    borderRadius: 8, background: "#f8fafc", color: "#1A2B4A",
    fontSize: 13, fontWeight: 500, textAlign: "left", cursor: "pointer",
  },
  dropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 30, overflow: "hidden",
  },
  dropdownItem: {
    display: "block", width: "100%", padding: "10px 16px",
    background: "none", border: "none", borderBottom: "1px solid #f0f4f8",
    textAlign: "left", fontSize: 13, color: "#1A2B4A", cursor: "pointer",
  },
  secondaryBtn: {
    padding: "7px 14px", background: "transparent", border: "1.5px solid #d0dce8",
    borderRadius: 8, fontSize: 12, fontWeight: 600, color: "#444", cursor: "pointer",
    whiteSpace: "nowrap",
  },
  primaryBtn: {
    padding: "9px 20px", background: "#0468B1", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer",
  },
  cancelBtn: {
    padding: "9px 16px", background: "#f4f6f9", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 500, color: "#444", cursor: "pointer",
  },
  flagPanel: {
    marginTop: 8, background: "#fff8e1", border: "1px solid #ffe082",
    borderRadius: 8, padding: 14, width: "100%",
  },
  flagTextarea: {
    width: "100%", padding: "8px 12px", border: "1.5px solid #ffe082",
    borderRadius: 8, fontSize: 13, color: "#1A2B4A", resize: "vertical",
    boxSizing: "border-box", fontFamily: "inherit",
  },
  conflictBanner: {
    display: "flex", alignItems: "flex-start", gap: 12,
    background: "#fff8e1", border: "1.5px solid #ffcc02",
    borderRadius: 10, padding: "14px 20px", color: "#5a3a00", fontSize: 13, lineHeight: 1.5,
  },
  overrideGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20,
  },
  fieldGroup: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: {
    fontSize: 11, fontWeight: 600, color: "#9aa5b4",
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  textInput: {
    padding: "9px 12px", border: "1.5px solid #d0dce8", borderRadius: 8,
    fontSize: 13, color: "#1A2B4A", outline: "none", background: "#fff",
    boxSizing: "border-box", width: "100%",
  },
  statsRow: {
    display: "flex", gap: 12,
  },
  statBox: {
    flex: 1, background: "#fff", border: "1px solid #e8eef4",
    borderRadius: 10, padding: "16px 20px",
  },
  statNum: {
    fontSize: 22, fontWeight: 800, color: "#1A2B4A", lineHeight: 1.1, marginBottom: 4,
  },
  statLbl: {
    fontSize: 11, fontWeight: 600, color: "#9aa5b4",
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  distBarOuter: {
    display: "flex", height: 20, borderRadius: 6, overflow: "hidden",
    background: "#f0f4f8", marginTop: 8,
  },
  distBarSeg: {
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontSize: 11, fontWeight: 600,
    transition: "width 0.3s",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700,
    color: "#9aa5b4", textTransform: "uppercase", letterSpacing: 0.5,
    borderBottom: "1px solid #e8eef4", whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "10px 14px", color: "#1A2B4A", verticalAlign: "middle", whiteSpace: "nowrap" },
  link: {
    color: "#0468B1", fontWeight: 600, cursor: "pointer",
    fontFamily: "monospace", fontSize: 12,
  },
  muted: { color: "#ccc" },
  platformBadge: {
    background: "#f0f4f8", color: "#5a6878", padding: "2px 8px",
    borderRadius: 6, fontSize: 11, fontWeight: 600,
  },
  expandBtn: {
    background: "none", border: "1px solid #e0e0e0", borderRadius: 6,
    cursor: "pointer", padding: "3px 8px", display: "inline-flex",
    alignItems: "center", color: "#5a6878",
  },
  toggle: {
    width: 40, height: 22, borderRadius: 11, position: "relative",
    cursor: "pointer", transition: "background 0.2s", flexShrink: 0,
  },
  toggleThumb: {
    position: "absolute", top: 2, width: 18, height: 18, borderRadius: "50%",
    background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "transform 0.2s",
  },
  commentsSection: {
    background: "#fff", border: "1px solid #e8eef4", borderRadius: 12, padding: "24px 28px",
  },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: "#1A2B4A", marginBottom: 16 },
  commentsThread: {
    maxHeight: 420, overflowY: "auto", display: "flex", flexDirection: "column",
    gap: 10, marginBottom: 16,
  },
  commentEntry: {
    borderRadius: 8, padding: "10px 14px",
  },
  commentHeader: {
    display: "flex", alignItems: "center", gap: 8, marginBottom: 6,
  },
  commentAuthor: { fontSize: 13, fontWeight: 700, color: "#1A2B4A" },
  systemLabel: { fontSize: 12, fontStyle: "italic", color: "#9aa5b4" },
  eventBadge: {
    background: "#f0f4f8", color: "#5a6878", padding: "2px 8px",
    borderRadius: 6, fontSize: 11, fontWeight: 600,
  },
  commentTime: { fontSize: 11, color: "#9aa5b4", marginLeft: "auto" },
  commentText: { fontSize: 13, color: "#1A2B4A", lineHeight: 1.5 },
  commentInputWrap: { borderTop: "1px solid #f0f4f8", paddingTop: 14 },
  commentTextarea: {
    width: "100%", padding: "10px 12px", border: "1.5px solid #d0dce8",
    borderRadius: 8, fontSize: 13, color: "#1A2B4A", resize: "vertical",
    outline: "none", fontFamily: "inherit", lineHeight: 1.5,
    boxSizing: "border-box",
  },
  commentFooter: {
    display: "flex", alignItems: "center", gap: 12, marginTop: 8,
    justifyContent: "flex-end",
  },
  postBtn: {
    padding: "8px 18px", background: "#0468B1", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#fff",
    transition: "opacity 0.15s",
  },
  toast: {
    position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)",
    background: "#1A2B4A", color: "#fff", padding: "12px 24px",
    borderRadius: 8, fontSize: 13, fontWeight: 500,
    boxShadow: "0 4px 20px rgba(0,0,0,0.22)", zIndex: 999,
  },
};
