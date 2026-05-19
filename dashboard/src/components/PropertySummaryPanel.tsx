import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MapPin, DamageLevel, PropertyComment } from "../types";
import {
  getPropertyComments,
  postPropertyComment,
  setConfirmedStatus,
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
  complete: "#f44336",
  partial: "#ff9800",
  minimal: "#4caf50",
};

const CONFIRM_OPTIONS: { value: string | null; label: string }[] = [
  { value: "complete", label: "Completely Destroyed" },
  { value: "partial", label: "Partially Damaged" },
  { value: "minimal", label: "Minimal or No Damage" },
  { value: null, label: "Clear Confirmed Status" },
];

// ── Lock icon SVG ─────────────────────────────────────────────────────────────
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

// ── Close icon SVG ────────────────────────────────────────────────────────────
function CloseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PropertySummaryPanel({ pin, onClose }: Props) {
  const queryClient = useQueryClient();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [confirmingStatus, setConfirmingStatus] = useState<string | null | undefined>(undefined);

  // Close dropdown when pin changes
  useEffect(() => {
    setDropdownOpen(false);
    setCommentText("");
    setConfirmingStatus(undefined);
  }, [pin.property_id]);

  // Auto-dismiss toast after 3 s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  // Fetch comments when panel opens and property_id is known
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

  // Show 5 most recent in panel (newest first)
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
      await setConfirmedStatus(propertyId, optionValue, "Confirmed status set via map panel.");
      // Invalidate map pins so pin colour updates
      queryClient.invalidateQueries({ queryKey: ["map-pins"] });
      queryClient.invalidateQueries({ queryKey: ["property-comments", propertyId] });
      setToast(optionValue ? `Confirmed: ${DAMAGE_LABELS[optionValue as DamageLevel] ?? optionValue}` : "Confirmed status cleared.");
    } catch {
      setToast("Failed to update confirmed status.");
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
  const confirmedLabel = hasConfirmed
    ? DAMAGE_LABELS[pin.confirmed_status as DamageLevel]
    : null;
  const confirmedColor = hasConfirmed
    ? DAMAGE_COLORS[pin.confirmed_status as DamageLevel]
    : damageColor;

  return (
    <div style={styles.panel}>
      {/* ── Header ── */}
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
          <span style={{ ...styles.damagePill, background: hasConfirmed ? confirmedColor : damageColor }}>
            {hasConfirmed && <LockIcon />}
            {hasConfirmed ? confirmedLabel : damageLabel}
            {hasConfirmed && <span style={styles.confirmedBadge}>Confirmed</span>}
          </span>
        </div>

        {/* ── Address ── */}
        <div style={styles.section}>
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
        <div style={styles.statsRow}>
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
              {pin.last_report_at
                ? new Date(pin.last_report_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
                : "—"}
            </div>
            <div style={styles.statLbl}>Last Report</div>
          </div>
        </div>

        {/* ── Damage distribution bar ── */}
        <div style={styles.section}>
          <div style={styles.label}>Damage Distribution</div>
          <div style={styles.distBarOuter}>
            <div
              style={{ ...styles.distBarFill, background: damageColor, width: "100%" }}
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
        <button
          style={{
            ...styles.locationBtn,
            opacity: propertyId ? 1 : 0.5,
            cursor: propertyId ? "pointer" : "not-allowed",
          }}
          onClick={() => { if (propertyId) window.open("/locations/" + propertyId, "_blank"); }}
          title={!propertyId ? "No property ID available" : undefined}
        >
          View Full Location Page ↗
        </button>

        {/* ── Set Confirmed Status ── */}
        <div style={styles.section}>
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
                    style={styles.dropdownItem}
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
        <div style={styles.section}>
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
                    background: c.is_system_generated ? "#F5F5F5" : "#fff",
                  }}
                >
                  <div style={styles.commentMeta}>
                    <span style={c.is_system_generated ? styles.systemLbl : styles.authorLbl}>
                      {c.is_system_generated ? "System" : (c.dashboard_user_name ?? "Staff")}
                    </span>
                    <span style={styles.commentTime}>{formatDateTime(c.created_at)}</span>
                  </div>
                  <div style={styles.commentText}>{c.comment_text}</div>
                </div>
              ))}

              {allComments.length > 5 && (
                <button
                  style={styles.viewAllBtn}
                  onClick={() => { if (propertyId) window.open("/locations/" + propertyId, "_blank"); }}
                >
                  View all comments ({allComments.length}) →
                </button>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  style={styles.commentInput}
                  placeholder="Add a comment…"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handlePostComment(); } }}
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

              <button
                style={styles.viewAllBtn}
                onClick={() => { if (propertyId) window.open("/locations/" + propertyId, "_blank"); }}
              >
                View all comments →
              </button>
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
  panel: {
    position: "absolute", top: 0, right: 0, width: 380, height: "100%",
    background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.18)",
    zIndex: 20, display: "flex", flexDirection: "column",
    borderLeft: "1px solid #e8eef4",
  },
  panelHeader: {
    display: "flex", alignItems: "flex-start", justifyContent: "space-between",
    padding: "20px 20px 12px", borderBottom: "1px solid #f0f4f8",
    gap: 8, flexShrink: 0,
  },
  propertyName: {
    fontSize: 16, fontWeight: 700, color: "#1A2B4A", margin: 0, lineHeight: 1.3,
    flex: 1, overflow: "hidden", textOverflow: "ellipsis",
    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
  },
  closeBtn: {
    background: "none", border: "none", cursor: "pointer", color: "#9aa5b4",
    padding: 4, borderRadius: 6, display: "flex", alignItems: "center",
    justifyContent: "center", flexShrink: 0, transition: "color 0.15s",
  },
  scrollBody: { flex: 1, overflowY: "auto", padding: "0 0 24px" },
  pillRow: { padding: "14px 20px 10px" },
  damagePill: {
    display: "inline-flex", alignItems: "center", padding: "5px 14px",
    borderRadius: 20, color: "#fff", fontSize: 13, fontWeight: 600,
  },
  confirmedBadge: {
    marginLeft: 8, fontSize: 11, fontWeight: 500,
    background: "rgba(255,255,255,0.25)", padding: "2px 7px", borderRadius: 10,
  },
  section: { padding: "10px 20px", borderTop: "1px solid #f0f4f8" },
  label: {
    fontSize: 11, fontWeight: 600, color: "#9aa5b4",
    textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5,
  },
  value: { fontSize: 14, color: "#1A2B4A", lineHeight: 1.5 },
  coordBox: {
    background: "#f0f4f8", borderRadius: 6, padding: "6px 10px",
    fontSize: 12, color: "#5a6878", fontFamily: "monospace",
    display: "inline-block",
  },
  statsRow: {
    display: "flex", alignItems: "center", padding: "14px 20px",
    borderTop: "1px solid #f0f4f8", gap: 0,
  },
  stat: { flex: 1, textAlign: "center" },
  statDivider: { width: 1, height: 32, background: "#e8eef4", flexShrink: 0 },
  statNum: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", lineHeight: 1.1 },
  statLbl: { fontSize: 11, color: "#9aa5b4", marginTop: 3, textTransform: "uppercase", letterSpacing: 0.5 },
  distBarOuter: {
    height: 12, borderRadius: 6, overflow: "hidden", background: "#f0f4f8", marginBottom: 6,
  },
  distBarFill: { height: "100%", borderRadius: 6, transition: "width 0.3s" },
  distLegend: { display: "flex", gap: 12, flexWrap: "wrap" },
  distLegendItem: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#5a6878" },
  distDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  locationBtn: {
    display: "block", width: "calc(100% - 40px)", margin: "12px 20px 0",
    padding: "10px 16px", border: "1.5px solid #0468B1", borderRadius: 8,
    background: "transparent", color: "#0468B1", fontSize: 14, fontWeight: 600,
    textAlign: "center", transition: "background 0.15s",
  },
  confirmedBtn: {
    width: "100%", padding: "10px 16px", border: "1.5px solid #e0e0e0",
    borderRadius: 8, background: "#f8fafc", color: "#1A2B4A",
    fontSize: 13, fontWeight: 500, textAlign: "left", cursor: "pointer",
  },
  dropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 30, overflow: "hidden",
  },
  dropdownItem: {
    display: "block", width: "100%", padding: "10px 16px", background: "none",
    border: "none", borderBottom: "1px solid #f0f4f8", textAlign: "left",
    fontSize: 13, color: "#1A2B4A", cursor: "pointer",
  },
  commentsPlaceholder: {
    fontSize: 13, color: "#9aa5b4", fontStyle: "italic", marginBottom: 10, lineHeight: 1.5,
  },
  commentEntry: {
    border: "1px solid #f0f4f8", borderRadius: 7, padding: "8px 10px", marginBottom: 6,
  },
  commentMeta: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  authorLbl: { fontSize: 12, fontWeight: 700, color: "#1A2B4A" },
  systemLbl: { fontSize: 12, fontStyle: "italic", color: "#9aa5b4" },
  commentTime: { fontSize: 11, color: "#9aa5b4", marginLeft: "auto" },
  commentText: { fontSize: 12, color: "#1A2B4A", lineHeight: 1.5 },
  commentInput: {
    flex: 1, padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 7,
    fontSize: 12, color: "#1A2B4A", background: "#f8fafc", outline: "none",
  },
  postBtn: {
    padding: "7px 12px", background: "#0468B1", border: "none",
    borderRadius: 7, fontSize: 12, fontWeight: 600, color: "#fff",
    flexShrink: 0, transition: "opacity 0.15s",
  },
  viewAllBtn: {
    display: "block", width: "100%", padding: "7px 0", background: "none",
    border: "none", borderTop: "1px solid #f0f4f8", color: "#0468B1",
    fontSize: 12, fontWeight: 600, cursor: "pointer", textAlign: "center",
    marginTop: 8,
  },
  toast: {
    position: "absolute", bottom: 24, left: 20, right: 20,
    background: "#1A2B4A", color: "#fff", padding: "10px 16px",
    borderRadius: 8, fontSize: 13, fontWeight: 500,
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)", zIndex: 40, textAlign: "center",
  },
};
