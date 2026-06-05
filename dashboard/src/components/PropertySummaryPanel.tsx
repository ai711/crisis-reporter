import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MapPin, DamageLevel, PropertyComment } from "../types";
import {
  getPropertyComments,
  postPropertyComment,
  setConfirmedStatus,
  setRecoveryStatus,
} from "../services/api";
import { formatDateTime } from "../utils/formatters";

interface Props {
  pin: MapPin;
  onClose: () => void;
}

const DAMAGE_LABELS: Record<DamageLevel, string> = {
  complete: "Completely Destroyed",
  partial: "Partially Damaged",
  minimal: "Minimal or No Damage",
};

const DAMAGE_COLORS: Record<DamageLevel, string> = {
  complete: "#e53e3e",
  partial: "#f2994a",
  minimal: "#38a169",
};

const CONFIRM_OPTIONS: { value: string | null; label: string; accent?: string }[] = [
  { value: "complete", label: "Completely Destroyed" },
  { value: "partial", label: "Partially Damaged" },
  { value: "minimal", label: "Minimal or No Damage" },
  { value: null, label: "Clear Confirmed Status" },
  { value: "recovered", label: "Mark as Recovered", accent: "#38a169" },
];

// ── Icons ─────────────────────────────────────────────────────────────────────

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

function CloseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PropertySummaryPanel({ pin, onClose }: Props) {
  const queryClient = useQueryClient();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [confirmingStatus, setConfirmingStatus] = useState<string | null | undefined>(undefined);

  // Reset local state when the selected pin changes.
  useEffect(() => {
    setDropdownOpen(false);
    setCommentText("");
    setConfirmingStatus(undefined);
  }, [pin.property_id]);

  // Auto-dismiss toast after 3 s.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const propertyId = pin.property_id ?? null;

  const { data: allComments = [] } = useQuery<PropertyComment[]>({
    queryKey: ["property-comments", propertyId],
    queryFn: async () => {
      const res = await getPropertyComments(propertyId!);
      return res.data;
    },
    enabled: !!propertyId,
    refetchInterval: 60000,
  });

  // Show 5 most recent in panel (newest first).
  const recentComments = [...allComments].reverse().slice(0, 5);

  const handlePostComment = async () => {
    if (!propertyId || !commentText.trim()) return;
    setPosting(true);
    try {
      await postPropertyComment(propertyId, commentText.trim());
      await queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
      setCommentText("");
    } catch {
      setToast("Failed to post comment.");
    } finally {
      setPosting(false);
    }
  };

  const handleConfirmStatus = async (optionValue: string | null) => {
    if (!propertyId) {
      setToast("No property linked to this pin.");
      setDropdownOpen(false);
      return;
    }
    setDropdownOpen(false);
    setConfirmingStatus(optionValue);
    try {
      if (optionValue === "recovered") {
        await setRecoveryStatus(propertyId, true, "Marked as Recovered via map panel.");
        queryClient.invalidateQueries({ queryKey: ["map-pins"] });
        queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
        setToast("Property marked as Recovered.");
      } else {
        await setConfirmedStatus(propertyId, optionValue, "Confirmed status set via map panel.");
        queryClient.invalidateQueries({ queryKey: ["map-pins"] });
        queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
        setToast(
          optionValue
            ? `Confirmed: ${DAMAGE_LABELS[optionValue as DamageLevel] ?? optionValue}`
            : "Confirmed status cleared."
        );
      }
    } catch {
      setToast("Failed to update status.");
    } finally {
      setConfirmingStatus(undefined);
    }
  };

  const damageLevel = pin.damage_level as DamageLevel;
  const damageLabel = DAMAGE_LABELS[damageLevel] ?? pin.damage_level;
  const damageColor = DAMAGE_COLORS[damageLevel] ?? "#666";

  const propertyName =
    pin.property_name ??
    `${pin.latitude.toFixed(4)}, ${pin.longitude.toFixed(4)}`;

  const hasConfirmed = !!pin.confirmed_status;
  const confirmedLabel = hasConfirmed ? DAMAGE_LABELS[pin.confirmed_status as DamageLevel] : null;
  const confirmedColor = hasConfirmed
    ? DAMAGE_COLORS[pin.confirmed_status as DamageLevel]
    : damageColor;
  const activeColor = hasConfirmed ? confirmedColor : damageColor;
  const activeLabel = hasConfirmed ? confirmedLabel : damageLabel;

  return (
    <div style={styles.panel}>
      {/* ── Photo placeholder — tinted by damage level ── */}
      <div
        style={{
          ...styles.photoPlaceholder,
          background: activeColor + "18",
        }}
      >
        <div style={styles.photoGrid} />
        <div style={styles.photoOverlay}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: activeColor + "22",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: activeColor,
            }}
          >
            <MapPinIcon />
          </div>
          <div style={{ fontSize: 12, color: activeColor, fontWeight: 700, marginTop: 6 }}>
            {activeLabel}
          </div>
          <div style={{ fontSize: 11, color: "#9e9e9e", marginTop: 2 }}>
            {pin.report_count} report{pin.report_count !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* ── Header: property name + close ── */}
      <div style={styles.panelHeader}>
        <h2 style={styles.propertyName} title={propertyName}>
          {propertyName}
        </h2>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close panel">
          <CloseIcon />
        </button>
      </div>

      <div style={styles.scrollBody}>
        {/* ── Damage level pill ── */}
        <div style={styles.pillRow}>
          <span
            style={{
              ...styles.damagePill,
              background: activeColor,
            }}
          >
            {hasConfirmed && <LockIcon />}
            {activeLabel}
            {hasConfirmed && <span style={styles.confirmedBadge}>Confirmed</span>}
          </span>
        </div>

        {/* ── Address ── */}
        <div style={styles.sectionAlt}>
          <div style={styles.label}>Address</div>
          <div style={styles.value}>{pin.address ?? "Address not available"}</div>
        </div>

        {/* ── GPS coordinates ── */}
        <div style={styles.section}>
          <div style={styles.label}>GPS Coordinates</div>
          <div style={styles.coordBox}>
            {pin.latitude.toFixed(6)}, {pin.longitude.toFixed(6)}
          </div>
        </div>

        {/* ── Stats row ── */}
        <div style={styles.statsRowAlt}>
          <div style={styles.stat}>
            <div style={styles.statNum}>{pin.report_count}</div>
            <div style={styles.statLbl}>Reports</div>
          </div>
          <div style={styles.statDivider} />
          <div style={styles.stat}>
            <div style={styles.statNum}>{pin.reporter_count ?? "—"}</div>
            <div style={styles.statLbl}>Reporters</div>
          </div>
          <div style={styles.statDivider} />
          <div style={styles.stat}>
            <div style={styles.statNum}>
              {pin.last_report_at ? relativeTime(pin.last_report_at) : "—"}
            </div>
            <div style={styles.statLbl}>Last Report</div>
          </div>
        </div>

        {/* ── Damage distribution bar ── */}
        <div style={styles.section}>
          <div style={styles.label}>Damage Distribution</div>
          <div style={styles.distBarOuter}>
            <div
              style={{
                ...styles.distBarFill,
                background: damageColor,
                width: "100%",
              }}
              title={`${damageLabel} — full breakdown on Location Page`}
            />
          </div>
          <div style={styles.distLegend}>
            <span style={styles.distLegendItem}>
              <span style={{ ...styles.distDot, background: damageColor }} />
              {damageLabel}
            </span>
          </div>
        </div>

        {/* ── View Full Location Page ── */}
        <div style={styles.sectionAlt}>
          <button
            style={{
              ...styles.locationBtn,
              opacity: propertyId ? 1 : 0.5,
              cursor: propertyId ? "pointer" : "not-allowed",
            }}
            onClick={() => {
              if (propertyId) window.open("/locations/" + propertyId, "_blank");
            }}
            title={!propertyId ? "No property ID available" : undefined}
          >
            View Full Location Page ↗
          </button>
        </div>

        {/* ── Set Confirmed Status ── */}
        <div style={styles.section}>
          <div style={styles.label}>Confirmed Status</div>
          <div style={{ position: "relative" }}>
            <button
              style={styles.confirmedBtn}
              onClick={() => setDropdownOpen((d) => !d)}
              disabled={confirmingStatus !== undefined}
            >
              {confirmingStatus !== undefined ? "Saving…" : "Set Confirmed Status ▾"}
            </button>
            {dropdownOpen && (
              <div style={styles.dropdown}>
                {CONFIRM_OPTIONS.map((opt) => (
                  <button
                    key={opt.value ?? "clear"}
                    style={{
                      ...styles.dropdownItem,
                      color: opt.accent ?? (opt.value === null ? "#9e9e9e" : "#191c1e"),
                      fontWeight: opt.accent ? 600 : 400,
                    }}
                    onClick={() => handleConfirmStatus(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Internal Comments ── */}
        <div style={styles.sectionAlt}>
          <div style={styles.label}>Internal Comments</div>

          {!propertyId && (
            <div style={styles.commentsPlaceholder}>
              Comments available once this pin is linked to a property.
            </div>
          )}

          {propertyId && (
            <>
              {recentComments.length === 0 && (
                <div style={styles.commentsPlaceholder}>No comments yet.</div>
              )}
              {recentComments.map((c) => (
                <div
                  key={c.id}
                  style={{
                    ...styles.commentEntry,
                    background: c.is_system_generated
                      ? "rgba(0,80,138,0.04)"
                      : "#fff",
                  }}
                >
                  <div style={styles.commentMeta}>
                    <span
                      style={
                        c.is_system_generated ? styles.systemLbl : styles.authorLbl
                      }
                    >
                      {c.is_system_generated
                        ? "System"
                        : (c.dashboard_user_name ?? "Staff")}
                    </span>
                    <span style={styles.commentTime}>{formatDateTime(c.created_at)}</span>
                  </div>
                  <div style={styles.commentText}>{c.comment_text}</div>
                </div>
              ))}

              {allComments.length > 5 && (
                <button
                  style={styles.viewAllBtn}
                  onClick={() => {
                    if (propertyId) window.open("/locations/" + propertyId, "_blank");
                  }}
                >
                  View all {allComments.length} comments →
                </button>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  style={styles.commentInput}
                  placeholder="Add a comment…"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handlePostComment();
                    }
                  }}
                  disabled={posting}
                />
                <button
                  style={{
                    ...styles.postBtn,
                    opacity: commentText.trim() && !posting ? 1 : 0.4,
                    cursor: commentText.trim() && !posting ? "pointer" : "not-allowed",
                  }}
                  onClick={handlePostComment}
                  disabled={!commentText.trim() || posting}
                >
                  {posting ? "…" : "Post"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  // Panel is now a flex child (side-by-side with the map), not absolute-positioned.
  panel: {
    width: 380,
    height: "100%",
    flexShrink: 0,
    background: "var(--c-surface-lowest)",
    boxShadow: "-8px 0 30px rgba(8,27,57,0.04), -2px 0 8px rgba(8,27,57,0.03)",
    display: "flex",
    flexDirection: "column",
    zIndex: 5,
    overflow: "hidden",
  },
  photoPlaceholder: {
    height: 140,
    position: "relative",
    flexShrink: 0,
    overflow: "hidden",
  },
  photoGrid: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(0,80,138,0.06) 19px, rgba(0,80,138,0.06) 20px), " +
      "repeating-linear-gradient(90deg, transparent, transparent 19px, rgba(0,80,138,0.06) 19px, rgba(0,80,138,0.06) 20px)",
  },
  photoOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  panelHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "14px 18px 12px",
    background: "var(--c-surface-lowest)",
    gap: 8,
    flexShrink: 0,
  },
  propertyName: {
    fontSize: 15,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
    lineHeight: 1.3,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  closeBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--c-text-subtle)",
    padding: 4,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  scrollBody: {
    flex: 1,
    overflowY: "auto",
    paddingBottom: 24,
  },
  pillRow: {
    padding: "12px 18px 10px",
    background: "var(--c-surface-lowest)",
  },
  damagePill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "5px 14px",
    borderRadius: 20,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
  },
  confirmedBadge: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 500,
    background: "rgba(255,255,255,0.25)",
    padding: "2px 7px",
    borderRadius: 10,
  },
  // White section
  section: {
    padding: "12px 18px",
    background: "var(--c-surface-lowest)",
  },
  // Alternating light-grey section
  sectionAlt: {
    padding: "12px 18px",
    background: "var(--c-surface-low)",
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--c-text-subtle)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  value: {
    fontSize: 14,
    color: "var(--c-text-primary)",
    lineHeight: 1.5,
  },
  coordBox: {
    background: "var(--c-surface-low)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    color: "var(--c-text-muted)",
    fontFamily: "monospace",
    display: "inline-block",
  },
  // Stats row — alt background
  statsRowAlt: {
    display: "flex",
    alignItems: "center",
    padding: "14px 18px",
    background: "var(--c-surface-low)",
    gap: 0,
  },
  stat: {
    flex: 1,
    textAlign: "center",
  },
  statDivider: {
    width: 1,
    height: 32,
    background: "rgba(0,0,0,0.07)",
    flexShrink: 0,
  },
  statNum: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    lineHeight: 1.1,
  },
  statLbl: {
    fontSize: 11,
    color: "var(--c-text-subtle)",
    marginTop: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  distBarOuter: {
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    background: "var(--c-surface-low)",
    marginBottom: 6,
  },
  distBarFill: {
    height: "100%",
    borderRadius: 5,
    transition: "width 0.3s",
  },
  distLegend: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  distLegendItem: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    color: "var(--c-text-muted)",
  },
  distDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  locationBtn: {
    display: "block",
    width: "100%",
    padding: "10px 16px",
    background: "rgba(0,80,138,0.08)",
    border: "none",
    borderRadius: 8,
    color: "var(--c-primary-container)",
    fontSize: 14,
    fontWeight: 600,
    textAlign: "center",
    cursor: "pointer",
  },
  confirmedBtn: {
    width: "100%",
    padding: "10px 14px",
    background: "var(--c-surface-low)",
    border: "none",
    borderRadius: 8,
    color: "var(--c-text-primary)",
    fontSize: 13,
    fontWeight: 500,
    textAlign: "left",
    cursor: "pointer",
  },
  dropdown: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    background: "var(--c-surface-lowest)",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(8,27,57,0.12)",
    zIndex: 30,
    overflow: "hidden",
  },
  dropdownItem: {
    display: "block",
    width: "100%",
    padding: "10px 14px",
    background: "none",
    border: "none",
    textAlign: "left",
    fontSize: 13,
    cursor: "pointer",
  },
  commentsPlaceholder: {
    fontSize: 13,
    color: "var(--c-text-subtle)",
    fontStyle: "italic",
    marginBottom: 10,
    lineHeight: 1.5,
  },
  commentEntry: {
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 6,
  },
  commentMeta: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  authorLbl: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  systemLbl: {
    fontSize: 12,
    fontStyle: "italic",
    color: "var(--c-text-subtle)",
  },
  commentTime: {
    fontSize: 11,
    color: "var(--c-text-subtle)",
    marginLeft: "auto",
  },
  commentText: {
    fontSize: 12,
    color: "var(--c-text-primary)",
    lineHeight: 1.5,
  },
  commentInput: {
    flex: 1,
    padding: "7px 10px",
    border: "none",
    borderRadius: 7,
    fontSize: 12,
    color: "var(--c-text-primary)",
    background: "#fff",
    outline: "none",
    boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.08)",
  },
  postBtn: {
    padding: "7px 12px",
    background: "var(--c-primary-container)",
    border: "none",
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    color: "#fff",
    flexShrink: 0,
    transition: "opacity 0.15s",
  },
  viewAllBtn: {
    display: "block",
    width: "100%",
    padding: "7px 0",
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    marginTop: 8,
  },
  toast: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    background: "var(--c-primary)",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    boxShadow: "0 4px 16px rgba(0,80,138,0.25)",
    zIndex: 40,
    textAlign: "center",
  },
};
