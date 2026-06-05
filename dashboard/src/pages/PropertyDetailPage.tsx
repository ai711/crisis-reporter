import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useHasAccess } from "../hooks/useHasAccess";
import { useSSE } from "../hooks/useSSE";
import type { PropertyDetail, PropertyComment, VersionHistoryEntry, ReporterRow, SSEEvent } from "../types";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";

// ── Colours ───────────────────────────────────────────────────────────────────

const DAMAGE_COLORS: Record<string, string> = {
  completely_destroyed: "var(--c-flag-red)",
  partially_damaged: "var(--c-flag-orange)",
  minimal_or_no_damage: "var(--c-flag-green)",
  complete: "var(--c-flag-red)",
  partial: "var(--c-flag-orange)",
  minimal: "var(--c-flag-green)",
};

const FLAG_COLORS: Record<string, string> = {
  grey: "var(--c-flag-grey)",
  green: "var(--c-flag-green)",
  orange: "var(--c-flag-amber)",
  red: "var(--c-flag-red)",
  discarded: "var(--c-flag-grey)",
};

// ── Inline SVGs ───────────────────────────────────────────────────────────────

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ marginRight: 4, flexShrink: 0 }} aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function AlertTriangleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
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
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
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
            <div style={{ ...mStyles.charCounter, color: isValid ? "var(--c-flag-green)" : "var(--c-text-subtle)" }}>
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
            <div style={{ ...mStyles.charCounter, color: isValid ? "var(--c-flag-green)" : "var(--c-text-subtle)" }}>
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
  const [hovered, setHovered] = useState(false);

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

  const isUnreviewed = row.flag_status === "grey" || row.flag_status === "red";
  const dmgColor = DAMAGE_COLORS[row.most_recent_damage_level] ?? "#888";
  const flagColor = FLAG_COLORS[row.flag_status] ?? "#888";

  return (
    <>
      <tr
        style={{
          ...s.tr,
          background: isUnreviewed
            ? (hovered ? "rgba(245,166,35,0.09)" : "rgba(245,166,35,0.04)")
            : (hovered ? "var(--c-surface-low)" : "var(--c-surface-lowest)"),
          opacity: isUnreviewed && !showUnreviewed ? 0 : 1,
          display: isUnreviewed && !showUnreviewed ? "none" : undefined,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* Reporter ID */}
        <td style={s.td}>
          <span
            style={s.link}
            onClick={() => window.open("/reporters/" + row.reporter_id, "_blank")}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") window.open("/reporters/" + row.reporter_id, "_blank"); }}
          >
            #{row.reporter_id.slice(0, 10).toUpperCase()}
          </span>
        </td>
        {/* Name */}
        <td style={s.td}>
          {row.reporter_name
            ? <span style={{ color: "var(--c-text-primary)", fontWeight: 500 }}>{row.reporter_name}</span>
            : <span style={s.muted}>Anonymous</span>}
        </td>
        {/* Damage */}
        <td style={s.td}>
          <span style={{ ...s.pill, background: dmgColor }}>
            {formatDamageLevel(row.most_recent_damage_level)}
          </span>
        </td>
        {/* Date */}
        <td style={s.td}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-secondary)" }}>
            {formatDateTime(row.most_recent_submitted_at)}
          </span>
        </td>
        {/* Platform */}
        <td style={s.td}>
          <span style={s.platformBadge}>{row.platform}</span>
        </td>
        {/* Flag */}
        <td style={s.td}>
          <span style={{ ...s.flagChip, background: flagColor }}>
            {row.flag_status.charAt(0).toUpperCase() + row.flag_status.slice(1)}
          </span>
        </td>
        {/* Expand */}
        <td style={{ ...s.td, textAlign: "right" as const }}>
          <button style={s.expandBtn} onClick={handleExpand} aria-label="Toggle version history">
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
        </td>
      </tr>

      {/* Version history expansion */}
      {expanded && (
        <tr style={{ background: "rgba(4,104,177,0.03)" }}>
          <td colSpan={7} style={{ padding: "12px 20px 16px" }}>
            {loadingVersions && (
              <div style={{ color: "var(--c-text-muted)", fontSize: "var(--text-sm)" }}>Loading version history…</div>
            )}
            {!loadingVersions && versions !== null && versions.length <= 1 && (
              <div style={{ color: "var(--c-text-muted)", fontSize: "var(--text-sm)", fontStyle: "italic" }}>
                This is the only submission from this reporter for this property.
              </div>
            )}
            {!loadingVersions && versions !== null && versions.length > 1 && (
              <div>
                <div style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--c-text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>
                  Version History ({versions.length} submissions)
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                  <thead>
                    <tr>
                      {["Ver.", "Report ID", "Submitted At", "Damage Level", "Flag Status", "Change Note"].map((h) => (
                        <th key={h} style={{
                          padding: "6px 10px", textAlign: "left" as const,
                          color: "var(--c-text-muted)", fontWeight: 600,
                          borderBottom: "1px solid var(--c-border-ghost)",
                          fontSize: "var(--text-xs)", textTransform: "uppercase" as const,
                          letterSpacing: "0.06em",
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v, index) => (
                      <tr key={v.report_id}>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{
                            background: "var(--c-surface-high)", borderRadius: "var(--radius-sm)",
                            padding: "2px 7px", fontSize: "var(--text-xs)", fontFamily: "monospace",
                            color: "var(--c-text-muted)",
                          }}>
                            v{versions.length - index}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px" }}>
                          <span
                            style={s.link}
                            onClick={() => window.open("/reports/" + v.report_id, "_blank")}
                            role="link"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === "Enter") window.open("/reports/" + v.report_id, "_blank"); }}
                          >
                            {v.serial_number != null ? `#${v.serial_number}` : `${v.report_id.slice(0, 8)}…`}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px", color: "var(--c-text-secondary)", fontSize: "var(--text-xs)" }}>
                          {formatDateTime(v.submitted_at)}
                        </td>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{ ...s.pill, background: DAMAGE_COLORS[v.damage_level] ?? "var(--c-text-muted)", fontSize: "var(--text-xs)" }}>
                            {formatDamageLevel(v.damage_level)}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px" }}>
                          <span style={{ ...s.flagChip, background: FLAG_COLORS[v.flag_status] ?? "var(--c-text-muted)", fontSize: "var(--text-xs)" }}>
                            {v.flag_status.charAt(0).toUpperCase() + v.flag_status.slice(1)}
                          </span>
                        </td>
                        <td style={{ padding: "6px 10px", color: "var(--c-text-secondary)", fontSize: "var(--text-xs)" }}>
                          {v.change_note ?? <span style={s.muted}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Comments Thread ───────────────────────────────────────────────────────────

function CommentsThread({ propertyId, crisisId }: { propertyId: string; crisisId: string | null | undefined }) {
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
    refetchInterval: 60000,
  });

  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (
        (event.type === "property_comment_added" || event.type === "property_updated") &&
        event.property_id === propertyId
      ) {
        queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
      }
    },
    [propertyId, queryClient]
  );

  useSSE({ crisisId: crisisId ?? null, onEvent: handleSSEEvent, enabled: !!crisisId });

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

  // Initials helper
  const getInitials = (name: string | null) => {
    if (!name) return "?";
    const parts = name.trim().split(" ");
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  };

  return (
    <div style={s.card}>
      <div style={s.cardTitleRow}>
        <div style={s.sectionLabel}>Internal Coordination</div>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)" }}>
          {comments.length} {comments.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div ref={threadRef} style={s.commentsThread}>
        {comments.length === 0 && (
          <div style={{ color: "var(--c-text-muted)", fontSize: "var(--text-sm)", textAlign: "center" as const, padding: "24px 0", fontStyle: "italic" }}>
            No comments yet. Be the first to add a coordination note.
          </div>
        )}
        {comments.map((c) => (
          <div
            key={c.id}
            style={{
              ...s.commentEntry,
              background: c.is_system_generated
                ? "var(--c-surface-low)"
                : "var(--c-surface-lowest)",
              border: c.is_system_generated
                ? "1px dashed var(--c-border)"
                : "1px solid var(--c-border-ghost)",
            }}
          >
            <div style={s.commentHeader}>
              {c.is_system_generated ? (
                <span style={s.systemAvatar}>SYS</span>
              ) : (
                <span style={s.avatarInitials}>{getInitials(c.dashboard_user_name)}</span>
              )}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {c.is_system_generated ? (
                    <span style={s.systemLabel}>System</span>
                  ) : (
                    <span style={s.commentAuthor}>{c.dashboard_user_name ?? "Staff"}</span>
                  )}
                  {c.system_event_type && (
                    <span style={s.eventBadge}>{c.system_event_type.replace(/_/g, " ")}</span>
                  )}
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", marginTop: 1 }}>
                  {formatDateTime(c.created_at)}
                </div>
              </div>
            </div>
            <div style={s.commentText}>{c.comment_text}</div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={s.commentInputWrap}>
        <textarea
          style={s.commentTextarea}
          placeholder="Add a coordination note… (visible to dashboard staff only)"
          value={commentText}
          onChange={(e) => setCommentText(e.target.value.slice(0, 2000))}
          rows={3}
          disabled={posting}
        />
        <div style={s.commentFooter}>
          <span style={{ fontSize: "var(--text-xs)", color: commentText.length >= 1900 ? "var(--c-flag-orange)" : "var(--c-text-subtle)" }}>
            {commentText.length} / 2000
          </span>
          {postError && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--c-flag-red)" }}>{postError}</span>
          )}
          <button
            style={{
              ...s.postBtn,
              opacity: commentText.trim().length > 0 && !posting ? 1 : 0.4,
              cursor: commentText.trim().length > 0 && !posting ? "pointer" : "not-allowed",
            }}
            onClick={handlePost}
            disabled={commentText.trim().length === 0 || posting}
          >
            {posting ? "Posting…" : "Post Note"}
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canEditLocations = useHasAccess("location_page", true);

  // ── Confirmed status
  const [confirmDropOpen, setConfirmDropOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const confirmDropRef = useRef<HTMLDivElement>(null);

  // ── Recovery
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<"recover" | "reinstate">("recover");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);

  // ── Flag for review
  const [flagPanelOpen, setFlagPanelOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [flagSubmitting, setFlagSubmitting] = useState(false);

  // ── Override
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

  // Close confirm dropdown on outside click
  useEffect(() => {
    if (!confirmDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (confirmDropRef.current && !confirmDropRef.current.contains(e.target as Node)) {
        setConfirmDropOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmDropOpen]);

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
      showToast("Override saved successfully.");
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

  if (isLoading) {
    return (
      <div style={s.page}>
        <Header title="Location Detail" subtitle="Loading property…" />
        <div style={{ padding: 60, textAlign: "center" as const, color: "var(--c-text-muted)" }}>
          Loading property details…
        </div>
      </div>
    );
  }

  if (isError || !property) {
    return (
      <div style={s.page}>
        <Header title="Property Detail" />
        <div style={{ padding: 60, textAlign: "center" as const, color: "var(--c-flag-red)" }}>
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

  const displayLat = property.override_lat ?? property.latitude;
  const displayLng = property.override_lng ?? property.longitude;

  const dmgColor = property.current_damage_level
    ? DAMAGE_COLORS[property.current_damage_level] ?? "var(--c-text-muted)"
    : "var(--c-text-muted)";

  const confirmedColor = property.confirmed_status
    ? DAMAGE_COLORS[property.confirmed_status] ?? "#888"
    : null;

  // Static map thumbnail URL
  const mapThumbUrl = MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets/static/${displayLng.toFixed(5)},${displayLat.toFixed(5)},15/360x200.png?key=${MAPTILER_KEY}`
    : null;

  // Unreviewed count
  const unreviewedCount = reporter_rows.filter(
    (r) => r.flag_status === "grey" || r.flag_status === "red"
  ).length;

  return (
    <div style={s.page}>
      <Header title={pageTitle} subtitle="Individual property assessment" />

      <div style={s.body}>

        {/* ── Breadcrumb ── */}
        <nav style={s.breadcrumb}>
          <span
            style={s.bcLink}
            onClick={() => navigate("/locations")}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") navigate("/locations"); }}
          >
            Locations
          </span>
          <span style={s.bcSep}>›</span>
          <span style={s.bcCurrent}>{displayName}</span>
          {property.building_id && (
            <>
              <span style={s.bcSep}>·</span>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", fontFamily: "monospace" }}>
                {property.building_id}
              </span>
            </>
          )}
        </nav>

        {/* ── Two-column grid ── */}
        <div style={s.grid}>

          {/* ══ LEFT COLUMN ══ */}
          <div style={s.leftCol}>

            {/* Property Summary Card */}
            <div style={{ ...s.card, position: "relative" as const, overflow: "hidden" }}>
              {/* Left accent border colored by damage level */}
              <div style={{
                position: "absolute" as const, left: 0, top: 0, bottom: 0, width: 4,
                background: confirmedColor ?? dmgColor,
                borderRadius: "var(--radius-lg) 0 0 var(--radius-lg)",
              }} />
              <div style={{ paddingLeft: 12 }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                  <div>
                    <h2 style={s.propertyName}>{displayName}</h2>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--c-text-muted)", fontSize: "var(--text-sm)" }}>
                      <MapPinIcon />
                      <span>{property.address ?? "Address not recorded"}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 8, flexShrink: 0, marginLeft: 16 }}>
                    {/* Damage pill */}
                    {confirmedColor ? (
                      <span style={{ ...s.pill, background: confirmedColor }}>
                        <LockIcon />
                        {formatDamageLevel(property.confirmed_status!)}
                        <span style={s.confirmedBadge}>Confirmed</span>
                      </span>
                    ) : property.current_damage_level ? (
                      <span style={{ ...s.pill, background: dmgColor }}>
                        {formatDamageLevel(property.current_damage_level)}
                      </span>
                    ) : null}
                    {/* Confirmed/not confirmed label */}
                    <span style={{
                      fontSize: "var(--text-xs)", fontWeight: 600,
                      color: confirmedColor ? "var(--c-text-muted)" : "var(--c-flag-orange)",
                      letterSpacing: "0.04em",
                    }}>
                      {confirmedColor ? `Confirmed by ${property.confirmed_by ?? "staff"}` : "NOT YET CONFIRMED"}
                    </span>
                    {/* Property ID */}
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", fontFamily: "monospace" }}>
                      ID: {property.property_id.slice(0, 16)}…
                    </span>
                  </div>
                </div>

                {/* Stat chips */}
                <div style={s.statsGrid}>
                  <div style={{ ...s.statChip, borderBottom: "2px solid var(--c-primary-container)" }}>
                    <div style={s.statChipLabel}>Total Reports</div>
                    <div style={s.statChipVal}>{property.total_reports}</div>
                  </div>
                  <div style={s.statChip}>
                    <div style={s.statChipLabel}>Active Reporters</div>
                    <div style={s.statChipVal}>{property.total_reporters}</div>
                  </div>
                  <div style={s.statChip}>
                    <div style={s.statChipLabel}>Last Update</div>
                    <div style={{ ...s.statChipVal, fontSize: 12, marginTop: 4 }}>
                      {property.most_recent_report_at
                        ? formatDateTime(property.most_recent_report_at)
                        : "—"}
                    </div>
                  </div>
                  <div style={s.statChip}>
                    <div style={s.statChipLabel}>GPS Coordinates</div>
                    <div style={{ ...s.statChipVal, fontSize: 11, fontFamily: "monospace", marginTop: 4 }}>
                      {displayLat.toFixed(4)}° N<br />{displayLng.toFixed(4)}° E
                    </div>
                  </div>
                </div>

                {/* Damage distribution bar */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={s.sectionLabel}>Damage Assessment Distribution</span>
                    {totalDist === 0 && (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)" }}>No data yet</span>
                    )}
                  </div>
                  <div style={s.distBarOuter}>
                    {destroyedPct > 0 && (
                      <div
                        style={{ ...s.distBarSeg, background: "var(--c-flag-red)", width: `${destroyedPct}%` }}
                        title={`Completely Destroyed: ${dd?.completely_destroyed} reports (${destroyedPct}%)`}
                      >
                        {destroyedPct > 10 && `${destroyedPct}%`}
                      </div>
                    )}
                    {partialPct > 0 && (
                      <div
                        style={{ ...s.distBarSeg, background: "var(--c-flag-orange)", width: `${partialPct}%` }}
                        title={`Partially Damaged: ${dd?.partially_damaged} reports (${partialPct}%)`}
                      >
                        {partialPct > 10 && `${partialPct}%`}
                      </div>
                    )}
                    {minimalPct > 0 && (
                      <div
                        style={{ ...s.distBarSeg, background: "var(--c-flag-green)", width: `${minimalPct}%` }}
                        title={`Minimal/No Damage: ${dd?.minimal_or_no_damage} reports (${minimalPct}%)`}
                      >
                        {minimalPct > 10 && `${minimalPct}%`}
                      </div>
                    )}
                    {totalDist === 0 && (
                      <div style={{ ...s.distBarSeg, background: "var(--c-surface-high)", width: "100%" }} />
                    )}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" as const }}>
                    {(dd?.completely_destroyed ?? 0) > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-xs)", color: "var(--c-text-secondary)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-flag-red)", flexShrink: 0 }} />
                        {dd?.completely_destroyed} Completely Destroyed
                      </div>
                    )}
                    {(dd?.partially_damaged ?? 0) > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-xs)", color: "var(--c-text-secondary)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-flag-orange)", flexShrink: 0 }} />
                        {dd?.partially_damaged} Partially Damaged
                      </div>
                    )}
                    {(dd?.minimal_or_no_damage ?? 0) > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-xs)", color: "var(--c-text-secondary)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-flag-green)", flexShrink: 0 }} />
                        {dd?.minimal_or_no_damage} Minimal or No Damage
                      </div>
                    )}
                  </div>
                </div>

                {/* Project link */}
                {projectId && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--c-border-ghost)" }}>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>Viewing in project scope — </span>
                    <span
                      style={{ fontSize: "var(--text-xs)", color: "var(--c-primary-container)", fontWeight: 600, cursor: "pointer" }}
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
            </div>

            {/* Conflict Warning Banner */}
            {property.has_conflict_warning && !property.confirmed_status && (
              <div style={s.conflictBanner}>
                <AlertTriangleIcon size={20} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: "#92400e" }}>
                    Conflicting Assessments Detected
                  </div>
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--c-text-secondary)", lineHeight: 1.5 }}>
                    {cwd ? (
                      <>
                        Majority assessment: <strong>{formatDamageLevel(cwd.majority_level)}</strong>.{" "}
                        {cwd.minority_count} reporter{cwd.minority_count !== 1 ? "s" : ""} ({cwd.minority_percentage}%) disagree.
                        {" "}Review the reporter rows below and use <strong>Set Confirmed Status</strong> in the panel to the right to resolve.
                      </>
                    ) : (
                      <>
                        Reporters have submitted different damage levels for this property.
                        Review the assessments below and set a Confirmed Status to resolve.
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Reporter Assessments */}
            <div style={s.card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div>
                  <div style={s.cardTitleRow}>
                    <div style={s.sectionLabel}>Reporter Assessments</div>
                  </div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", marginTop: 2 }}>
                    {reporter_rows.filter(r => r.flag_status === "green" || r.flag_status === "orange").length} qualifying reports
                    {unreviewedCount > 0 && ` · ${unreviewedCount} unreviewed`}
                  </div>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <div
                    style={{
                      ...s.toggle,
                      background: showUnreviewed ? "var(--c-primary-container)" : "var(--c-text-subtle)",
                    }}
                    onClick={() => setShowUnreviewed((v) => !v)}
                    role="switch"
                    aria-checked={showUnreviewed}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") setShowUnreviewed((v) => !v);
                    }}
                  >
                    <div style={{
                      ...s.toggleThumb,
                      transform: showUnreviewed ? "translateX(20px)" : "translateX(2px)",
                    }} />
                  </div>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", whiteSpace: "nowrap" as const }}>
                    Show unreviewed
                    {unreviewedCount > 0 && (
                      <span style={{ marginLeft: 4, background: "rgba(245,166,35,0.2)", color: "#92400e", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>
                        {unreviewedCount}
                      </span>
                    )}
                  </span>
                </label>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={s.table}>
                  <thead>
                    <tr style={{ background: "var(--c-surface-low)" }}>
                      {["Reporter ID", "Name", "Damage Level", "Submitted At", "Platform", "Flag", ""].map((h) => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reporter_rows.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: "32px", textAlign: "center" as const, color: "var(--c-text-muted)", fontSize: "var(--text-sm)", fontStyle: "italic" }}>
                          No reporter assessments yet.
                        </td>
                      </tr>
                    ) : (
                      reporter_rows.map((row) => (
                        <ReporterVersionRow
                          key={row.reporter_id}
                          propertyId={propertyId!}
                          row={row}
                          showUnreviewed={showUnreviewed}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Comments Thread */}
            <CommentsThread propertyId={propertyId!} crisisId={property.crisis_id} />

          </div>
          {/* ══ END LEFT COLUMN ══ */}

          {/* ══ RIGHT COLUMN ══ */}
          <div style={s.rightCol}>

            {/* Map Card */}
            <div style={s.rightCard}>
              <div style={s.rightCardHeader}>
                <div style={s.sectionLabel}>Asset Geospatial Context</div>
                <button
                  style={s.iconBtn}
                  onClick={() => window.open(`/map?lat=${displayLat}&lng=${displayLng}&zoom=15`, "_blank")}
                  title="Open in full map"
                >
                  <ExternalLinkIcon />
                </button>
              </div>
              <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", position: "relative" as const }}>
                {mapThumbUrl ? (
                  <img
                    src={mapThumbUrl}
                    alt={`Map showing ${displayName}`}
                    style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div style={{ height: 180, background: "var(--c-surface-low)", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 8 }}>
                    <MapPinIcon />
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>Map preview unavailable</span>
                  </div>
                )}
                {/* Coordinate overlay */}
                <div style={{
                  position: "absolute" as const, bottom: 8, left: 8,
                  background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
                  borderRadius: "var(--radius-sm)", padding: "4px 8px",
                }}>
                  <span style={{ fontSize: 10, color: "#fff", fontFamily: "monospace" }}>
                    {displayLat.toFixed(5)}°, {displayLng.toFixed(5)}°
                  </span>
                </div>
              </div>
              <button
                style={{ ...s.outlineBtn, width: "100%", marginTop: 10, justifyContent: "center" }}
                onClick={() => window.open(`/map?lat=${displayLat}&lng=${displayLng}&zoom=15`, "_blank")}
              >
                <ExternalLinkIcon />
                Open in Map View
              </button>
            </div>

            {/* Confirmed Status Card */}
            <div style={s.rightCard}>
              <div style={s.rightCardHeader}>
                <div style={s.sectionLabel}>Official Status</div>
                {confirmedColor && <LockIcon size={14} />}
              </div>

              {/* Current status display */}
              <div style={{ marginBottom: 14 }}>
                {confirmedColor ? (
                  <>
                    <span style={{ ...s.pill, background: confirmedColor, marginBottom: 6 }}>
                      <LockIcon />
                      {formatDamageLevel(property.confirmed_status!)}
                    </span>
                    {property.confirmed_by && (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", marginTop: 6 }}>
                        Confirmed by {property.confirmed_by}
                        {property.confirmed_at && ` · ${formatDateTime(property.confirmed_at)}`}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)", color: "var(--c-flag-orange)", fontWeight: 600 }}>
                    <AlertTriangleIcon size={14} />
                    Not yet confirmed
                  </div>
                )}
              </div>

              {/* Set/Update button */}
              {canEditLocations && (
                <div style={{ position: "relative" as const }} ref={confirmDropRef}>
                  <button
                    style={{
                      ...s.outlineBtn,
                      width: "100%",
                      justifyContent: "space-between",
                      background: confirmDropOpen ? "var(--c-surface-low)" : "var(--c-surface-lowest)",
                    }}
                    onClick={() => setConfirmDropOpen((o) => !o)}
                  >
                    <span>
                      {property.confirmed_status ? "Update Confirmed Status" : "Set Confirmed Status"}
                    </span>
                    <ChevronDownIcon />
                  </button>
                  {confirmDropOpen && (
                    <div style={s.dropdown}>
                      {CONFIRM_OPTIONS.map((opt) => (
                        <button
                          key={opt.value ?? "clear"}
                          style={{
                            ...s.dropdownItem,
                            color: opt.value === null ? "var(--c-flag-red)"
                              : DAMAGE_COLORS[opt.value] ?? "var(--c-text-primary)",
                          }}
                          onClick={() => {
                            setConfirmTarget(opt.value ?? null);
                            setConfirmDropOpen(false);
                            setConfirmError(null);
                            setConfirmModalOpen(true);
                          }}
                        >
                          {opt.value && (
                            <span style={{
                              width: 8, height: 8, borderRadius: "50%",
                              background: DAMAGE_COLORS[opt.value],
                              flexShrink: 0, marginRight: 8,
                            }} />
                          )}
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Spatial Override Card */}
            <div style={s.rightCard}>
              <div style={s.rightCardHeader}>
                <div style={s.sectionLabel}>Spatial Override</div>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)" }}>
                  {property.override_name ? "Active" : "Not set"}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
                <div>
                  <label style={s.fieldLabel}>Location Alias</label>
                  <input
                    style={s.textInput}
                    type="text"
                    placeholder="Enter official property name…"
                    value={overrideName}
                    onChange={(e) => setOverrideName(e.target.value)}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={s.fieldLabel}>Latitude</label>
                    <input
                      style={s.textInput}
                      type="number"
                      step="0.00001"
                      placeholder="Lat"
                      value={overrideLat}
                      onChange={(e) => setOverrideLat(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={s.fieldLabel}>Longitude</label>
                    <input
                      style={s.textInput}
                      type="number"
                      step="0.00001"
                      placeholder="Lng"
                      value={overrideLng}
                      onChange={(e) => setOverrideLng(e.target.value)}
                    />
                  </div>
                </div>
                <button
                  style={{
                    ...s.primaryBtn,
                    width: "100%",
                    justifyContent: "center",
                    opacity: overrideSubmitting ? 0.5 : 1,
                  }}
                  onClick={handleOverrideSave}
                  disabled={overrideSubmitting}
                >
                  {overrideSubmitting ? "Saving…" : "Save Override"}
                </button>
                {overrideSuccess && (
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--c-flag-green)", textAlign: "center" as const }}>
                    ✓ Override saved successfully
                  </div>
                )}
                <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", lineHeight: 1.5 }}>
                  Override values become the primary name and coordinates for this property on the map, in exports, and in statistics. Original reporter-submitted values are preserved in each report's version history.
                </div>
              </div>
            </div>

            {/* Property Actions Card */}
            {canEditLocations && (
              <div style={s.rightCard}>
                <div style={s.rightCardHeader}>
                  <div style={s.sectionLabel}>Property Actions</div>
                </div>

                {/* Status badge + recovery */}
                <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--c-border-ghost)" }}>
                  <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--c-text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 8 }}>
                    Property Status
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      fontWeight: 700, fontSize: "var(--text-xs)",
                      color: property.property_status === "Active" ? "var(--c-flag-green)" : "var(--c-text-muted)",
                      padding: "4px 12px", borderRadius: "var(--radius-pill)",
                      background: property.property_status === "Active"
                        ? "rgba(56,161,105,0.12)"
                        : "var(--c-surface-high)",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
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
                </div>

                {/* Flag for review */}
                <div>
                  <button
                    style={{
                      ...s.secondaryBtn,
                      width: "100%",
                      justifyContent: "center",
                      borderColor: property.is_flagged_for_review ? "var(--c-flag-orange)" : "var(--c-border)",
                      color: property.is_flagged_for_review ? "var(--c-flag-orange)" : "var(--c-text-secondary)",
                      background: property.is_flagged_for_review ? "rgba(245,166,35,0.05)" : "transparent",
                    }}
                    onClick={() => setFlagPanelOpen((o) => !o)}
                  >
                    <AlertTriangleIcon size={13} />
                    {property.is_flagged_for_review ? "Flagged for Review" : "Flag for Review"}
                  </button>

                  {flagPanelOpen && (
                    <div style={{ marginTop: 10, background: "rgba(245,166,35,0.04)", border: "1px solid rgba(245,166,35,0.25)", borderRadius: "var(--radius-md)", padding: 12 }}>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", marginBottom: 8 }}>
                        Optional note:
                      </div>
                      <textarea
                        style={{ ...s.textInput, width: "100%", resize: "vertical" as const }}
                        placeholder="Describe why this property needs review…"
                        value={flagNote}
                        onChange={(e) => setFlagNote(e.target.value)}
                        rows={3}
                        disabled={flagSubmitting}
                      />
                      <div style={{ display: "flex", justifyContent: "flex-end" as const, gap: 8, marginTop: 8 }}>
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
            )}

          </div>
          {/* ══ END RIGHT COLUMN ══ */}

        </div>
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
      {toast && <div style={s.toast}>{toast}</div>}
    </div>
  );
}

// ── Modal Styles ──────────────────────────────────────────────────────────────

const mStyles: Record<string, React.CSSProperties> = {
  backdrop: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900 },
  overlay: {
    position: "fixed", inset: 0, zIndex: 901,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
  },
  modal: {
    background: "var(--c-surface-lowest)", borderRadius: "var(--radius-xl)", padding: "28px 28px 24px",
    width: "100%", maxWidth: 480, boxShadow: "var(--shadow-float)", border: "1px solid var(--c-border)",
  },
  title: { fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--c-text-primary)", margin: "0 0 8px" },
  subtitle: { fontSize: "var(--text-sm)", color: "var(--c-text-secondary)", margin: "0 0 20px", lineHeight: 1.5 },
  field: { marginBottom: 16 },
  fieldLabel: {
    display: "block", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--c-text-muted)",
    marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: 0.4,
  },
  textarea: {
    width: "100%", padding: "10px 12px", border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", color: "var(--c-text-primary)",
    resize: "vertical" as const, outline: "none", fontFamily: "inherit", lineHeight: 1.5,
    boxSizing: "border-box" as const, background: "var(--c-surface-lowest)",
  },
  charCounter: { fontSize: "var(--text-xs)", marginTop: 5, textAlign: "right" as const, transition: "color 0.15s" },
  errorBox: {
    background: "rgba(229,62,62,0.06)", border: "1px solid var(--c-flag-red)",
    borderRadius: "var(--radius-md)", padding: "10px 14px",
    fontSize: "var(--text-sm)", color: "var(--c-flag-red)", marginBottom: 16,
  },
  actions: { display: "flex", justifyContent: "flex-end" as const, gap: 10, paddingTop: 4 },
  cancelBtn: {
    padding: "9px 20px", background: "var(--c-surface-high)", border: "none",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 500,
    color: "var(--c-text-primary)", cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px", background: "var(--c-primary-container)", border: "none",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 600, color: "#fff",
    cursor: "pointer",
  },
};

// ── Page Styles ───────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: { display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" },
  body: {
    flex: 1, overflowY: "auto", padding: "20px 28px 40px",
    display: "flex", flexDirection: "column", gap: 0,
  },

  // Breadcrumb
  breadcrumb: {
    display: "flex", alignItems: "center", gap: 8,
    marginBottom: 16, fontSize: "var(--text-xs)",
    fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em",
  },
  bcLink: {
    color: "var(--c-text-muted)", cursor: "pointer",
    transition: "color 0.15s",
  },
  bcSep: { color: "var(--c-text-subtle)" },
  bcCurrent: { color: "var(--c-primary-container)" },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 360px",
    gap: 20,
    alignItems: "start",
  },
  leftCol: { display: "flex", flexDirection: "column", gap: 16 },
  rightCol: { display: "flex", flexDirection: "column", gap: 16 },

  // Cards
  card: {
    background: "var(--c-surface-lowest)", border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-lg)", padding: "20px 24px",
    boxShadow: "var(--shadow-card)",
  },
  cardTitleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  rightCard: {
    background: "var(--c-surface-lowest)", border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-lg)", padding: "18px 20px",
    boxShadow: "var(--shadow-card)",
  },
  rightCardHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    marginBottom: 14,
  },

  // Summary
  propertyName: {
    fontSize: "var(--text-xl)", fontWeight: 800, color: "var(--c-text-primary)",
    marginBottom: 6, lineHeight: 1.2,
  },
  statsGrid: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 16, marginBottom: 16,
  },
  statChip: {
    background: "var(--c-surface-low)", borderRadius: "var(--radius-md)", padding: "10px 12px",
  },
  statChipLabel: {
    fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em",
    color: "var(--c-text-muted)", marginBottom: 6,
  },
  statChipVal: {
    fontSize: "var(--text-xl)", fontWeight: 800, color: "var(--c-text-primary)", lineHeight: 1.1,
  },

  // Dist bar
  distBarOuter: {
    display: "flex", height: 8, borderRadius: "var(--radius-sm)", overflow: "hidden",
    background: "var(--c-surface-high)",
  },
  distBarSeg: {
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontSize: 9, fontWeight: 700, transition: "width 0.3s",
  },

  // Conflict banner
  conflictBanner: {
    display: "flex", alignItems: "flex-start", gap: 12,
    background: "rgba(245,166,35,0.08)", border: "1.5px solid rgba(245,166,35,0.35)",
    borderRadius: "var(--radius-lg)", padding: "14px 18px",
    color: "#92400e",
  },

  // Pill
  pill: {
    display: "inline-flex", alignItems: "center", padding: "4px 12px",
    borderRadius: 12, color: "#fff", fontSize: "var(--text-xs)", fontWeight: 700,
    textTransform: "uppercase" as const, letterSpacing: "0.04em",
  },
  flagChip: {
    display: "inline-flex", alignItems: "center", padding: "3px 8px",
    borderRadius: "var(--radius-sm)", color: "#fff", fontSize: 10, fontWeight: 700,
    textTransform: "uppercase" as const, letterSpacing: "0.04em",
  },
  confirmedBadge: {
    marginLeft: 8, fontSize: 10, fontWeight: 500,
    background: "rgba(255,255,255,0.25)", padding: "2px 7px", borderRadius: 10,
  },

  // Table
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "var(--text-sm)" },
  th: {
    padding: "10px 14px", textAlign: "left" as const, fontSize: "var(--text-xs)", fontWeight: 700,
    color: "var(--c-text-muted)", textTransform: "uppercase" as const, letterSpacing: 0.5,
    borderBottom: "2px solid var(--c-border-ghost)", whiteSpace: "nowrap" as const,
    background: "var(--c-surface-low)",
  },
  tr: { borderBottom: "1px solid var(--c-border-ghost)", transition: "background 0.1s" },
  td: { padding: "10px 14px", color: "var(--c-text-primary)", verticalAlign: "middle" as const, whiteSpace: "nowrap" as const },

  // Links, badges
  link: {
    color: "var(--c-primary-container)", fontWeight: 700, cursor: "pointer",
    fontSize: "var(--text-xs)", fontFamily: "monospace", textDecoration: "underline",
    textDecorationColor: "rgba(4,104,177,0.3)",
  },
  muted: { color: "var(--c-text-subtle)", fontStyle: "italic" },
  platformBadge: {
    background: "var(--c-surface-high)", color: "var(--c-text-muted)", padding: "2px 8px",
    borderRadius: "var(--radius-sm)", fontSize: 10, fontWeight: 600,
    textTransform: "uppercase" as const, letterSpacing: "0.05em",
  },
  expandBtn: {
    background: "none", border: "1px solid var(--c-border)", borderRadius: "var(--radius-sm)",
    cursor: "pointer", padding: "3px 8px", display: "inline-flex",
    alignItems: "center" as const, color: "var(--c-text-muted",
  },

  // Toggle
  toggle: {
    width: 40, height: 22, borderRadius: 11, position: "relative",
    cursor: "pointer", transition: "background 0.2s", flexShrink: 0,
  },
  toggleThumb: {
    position: "absolute", top: 2, width: 18, height: 18, borderRadius: "50%",
    background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "transform 0.2s",
  },

  // Buttons
  primaryBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "9px 16px", background: "var(--c-primary-container)", border: "none",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 600,
    color: "#fff", cursor: "pointer", transition: "opacity 0.15s",
  },
  secondaryBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "7px 12px", background: "transparent", border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", fontWeight: 600,
    color: "var(--c-text-secondary)", cursor: "pointer", whiteSpace: "nowrap" as const,
    transition: "border-color 0.15s",
  },
  outlineBtn: {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "8px 14px", background: "var(--c-surface-low)", border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", fontWeight: 600,
    color: "var(--c-text-secondary)", cursor: "pointer", transition: "background 0.15s",
  },
  cancelBtn: {
    padding: "8px 14px", background: "var(--c-surface-high)", border: "none",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 500,
    color: "var(--c-text-primary)", cursor: "pointer",
  },
  iconBtn: {
    background: "none", border: "none", cursor: "pointer",
    color: "var(--c-text-muted)", padding: 4, display: "flex", alignItems: "center",
    borderRadius: "var(--radius-sm)", transition: "color 0.15s",
  },

  // Dropdown
  dropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    background: "var(--c-surface-lowest)", border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", zIndex: 30, overflow: "hidden",
  },
  dropdownItem: {
    display: "flex", width: "100%", padding: "10px 14px",
    background: "none", border: "none", borderBottom: "1px solid var(--c-border-ghost)",
    textAlign: "left" as const, fontSize: "var(--text-sm)", fontWeight: 500, cursor: "pointer",
    alignItems: "center",
    transition: "background 0.1s",
  },

  // Fields
  fieldLabel: {
    fontSize: 10, fontWeight: 700, color: "var(--c-text-muted)",
    textTransform: "uppercase" as const, letterSpacing: 0.6, marginBottom: 5, display: "block",
  },
  textInput: {
    padding: "8px 10px", border: "1.5px solid var(--c-border)", borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)", color: "var(--c-text-primary)", outline: "none",
    background: "var(--c-surface-lowest)", boxSizing: "border-box" as const, width: "100%",
    fontFamily: "inherit",
  },

  // Section label
  sectionLabel: {
    fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--c-text-muted)",
    textTransform: "uppercase" as const, letterSpacing: "0.1em",
  },

  // Comments
  commentsThread: {
    maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column" as const,
    gap: 10, marginBottom: 16,
  },
  commentEntry: { borderRadius: "var(--radius-md)", padding: "12px 14px" },
  commentHeader: {
    display: "flex", alignItems: "flex-start" as const, gap: 10, marginBottom: 8,
  },
  avatarInitials: {
    width: 30, height: 30, borderRadius: "50%", background: "var(--c-primary-container)",
    color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 700, flexShrink: 0,
  },
  systemAvatar: {
    width: 30, height: 30, borderRadius: "var(--radius-sm)",
    background: "var(--c-surface-high)", color: "var(--c-text-muted)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 9, fontWeight: 700, flexShrink: 0, letterSpacing: "0.05em",
  },
  commentAuthor: { fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--c-text-primary)" },
  systemLabel: { fontSize: "var(--text-xs)", fontStyle: "italic", color: "var(--c-text-muted)", fontWeight: 600 },
  eventBadge: {
    background: "var(--c-surface-high)", color: "var(--c-text-muted)", padding: "2px 8px",
    borderRadius: "var(--radius-sm)", fontSize: 10, fontWeight: 600, textTransform: "capitalize" as const,
  },
  commentText: { fontSize: "var(--text-sm)", color: "var(--c-text-secondary)", lineHeight: 1.5 },
  commentInputWrap: { borderTop: "1px solid var(--c-border-ghost)", paddingTop: 14 },
  commentTextarea: {
    width: "100%", padding: "10px 12px", border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", color: "var(--c-text-primary)",
    resize: "vertical" as const, outline: "none", fontFamily: "inherit", lineHeight: 1.5,
    boxSizing: "border-box" as const, background: "var(--c-surface-lowest)",
  },
  commentFooter: {
    display: "flex", alignItems: "center" as const, gap: 12, marginTop: 8,
    justifyContent: "flex-end" as const,
  },
  postBtn: {
    padding: "8px 18px", background: "var(--c-primary-container)", border: "none",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 600, color: "#fff",
    cursor: "pointer", transition: "opacity 0.15s",
  },

  // Toast
  toast: {
    position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)",
    background: "var(--c-text-primary)", color: "#fff", padding: "12px 24px",
    borderRadius: "var(--radius-md)", fontSize: "var(--text-sm)", fontWeight: 500,
    boxShadow: "var(--shadow-float)", zIndex: 999,
  },
};
