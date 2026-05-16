import { useEffect, useState } from "react";
import type { MapPin, DamageLevel } from "../types";

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

const CONFIRM_OPTIONS: { value: string; label: string }[] = [
  { value: "complete", label: "Completely Destroyed" },
  { value: "partial", label: "Partially Damaged" },
  { value: "minimal", label: "Minimal or No Damage" },
  { value: "clear", label: "Clear Confirmed Status" },
];

// ── Lock icon SVG ─────────────────────────────────────────────────────────────
function LockIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginRight: 4, flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ── Close icon SVG ────────────────────────────────────────────────────────────
function CloseIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PropertySummaryPanel({ pin, onClose }: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Close dropdown when pin changes
  useEffect(() => {
    setDropdownOpen(false);
  }, [pin]);

  // Auto-dismiss toast after 3 s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

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
        <button
          style={styles.closeBtn}
          onClick={onClose}
          aria-label="Close panel"
        >
          <CloseIcon />
        </button>
      </div>

      <div style={styles.scrollBody}>
        {/* ── Damage level pill ── */}
        <div style={styles.pillRow}>
          <span
            style={{
              ...styles.damagePill,
              background: hasConfirmed ? confirmedColor : damageColor,
            }}
          >
            {hasConfirmed && <LockIcon />}
            {hasConfirmed ? confirmedLabel : damageLabel}
            {hasConfirmed && (
              <span style={styles.confirmedBadge}>Confirmed</span>
            )}
          </span>
        </div>

        {/* ── Address ── */}
        <div style={styles.section}>
          <div style={styles.label}>Address</div>
          <div style={styles.value}>
            {pin.address ?? "Address not available"}
          </div>
        </div>

        {/* ── GPS coordinates ── */}
        <div style={styles.section}>
          <div style={styles.label}>GPS Coordinates</div>
          <div style={styles.value}>
            {pin.latitude.toFixed(6)}, {pin.longitude.toFixed(6)}
          </div>
        </div>

        {/* ── Map thumbnail ── */}
        <div style={styles.mapThumb}>
          <div style={styles.mapThumbPin}>📍</div>
          <div style={styles.mapThumbCoords}>
            {pin.latitude.toFixed(4)}, {pin.longitude.toFixed(4)}
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
                ? new Date(pin.last_report_at).toLocaleDateString()
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
              style={{
                ...styles.distBarFill,
                background: damageColor,
                width: "100%",
              }}
              title={`${damageLabel} — 100% (full breakdown in Chapter 4)`}
            />
          </div>
          <div style={styles.distLegend}>
            <span style={styles.distLegendItem}>
              <span
                style={{ ...styles.distDot, background: damageColor }}
              />
              {damageLabel}
            </span>
          </div>
        </div>

        {/* ── View Full Location Page ── */}
        <button
          style={{
            ...styles.locationBtn,
            opacity: pin.property_id ? 1 : 0.5,
            cursor: pin.property_id ? "pointer" : "not-allowed",
          }}
          onClick={() => {
            if (pin.property_id) {
              window.open("/locations/" + pin.property_id, "_blank");
            }
          }}
          title={!pin.property_id ? "Coming in Chapter 4" : undefined}
        >
          View Full Location Page ↗
        </button>

        {/* ── Set Confirmed Status ── */}
        <div style={styles.section}>
          <div style={{ position: "relative" }}>
            <button
              style={styles.confirmedBtn}
              onClick={() => setDropdownOpen((d) => !d)}
            >
              Set Confirmed Status ▾
            </button>
            {dropdownOpen && (
              <div style={styles.dropdown}>
                {CONFIRM_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    style={styles.dropdownItem}
                    onClick={() => {
                      setDropdownOpen(false);
                      setToast(
                        "Confirmed Status — wiring to backend in Chapter 4"
                      );
                    }}
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
          <div style={styles.commentsPlaceholder}>
            Comments thread — wiring to backend in Chapter 4.
          </div>
          <input
            style={styles.commentInput}
            placeholder="Add a comment…"
            disabled
          />
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
    position: "absolute",
    top: 0,
    right: 0,
    width: 380,
    height: "100%",
    background: "#fff",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.18)",
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid #e8eef4",
  },
  panelHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    padding: "20px 20px 12px",
    borderBottom: "1px solid #f0f4f8",
    gap: 8,
    flexShrink: 0,
  },
  propertyName: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1A2B4A",
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
    color: "#9aa5b4",
    padding: 4,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "color 0.15s",
  },
  scrollBody: {
    flex: 1,
    overflowY: "auto",
    padding: "0 0 24px",
  },
  pillRow: {
    padding: "14px 20px 10px",
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
  section: {
    padding: "10px 20px",
    borderTop: "1px solid #f0f4f8",
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: "#9aa5b4",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 5,
  },
  value: {
    fontSize: 14,
    color: "#1A2B4A",
    lineHeight: 1.5,
  },
  mapThumb: {
    margin: "0 20px 0",
    borderRadius: 8,
    background: "#e8f0fb",
    height: 120,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid #d0dce8",
    gap: 6,
  },
  mapThumbPin: {
    fontSize: 28,
  },
  mapThumbCoords: {
    fontSize: 12,
    color: "#5a6878",
    fontFamily: "monospace",
  },
  statsRow: {
    display: "flex",
    alignItems: "center",
    padding: "14px 20px",
    borderTop: "1px solid #f0f4f8",
    gap: 0,
  },
  stat: {
    flex: 1,
    textAlign: "center",
  },
  statDivider: {
    width: 1,
    height: 32,
    background: "#e8eef4",
    flexShrink: 0,
  },
  statNum: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1A2B4A",
    lineHeight: 1.1,
  },
  statLbl: {
    fontSize: 11,
    color: "#9aa5b4",
    marginTop: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  distBarOuter: {
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
    background: "#f0f4f8",
    marginBottom: 6,
  },
  distBarFill: {
    height: "100%",
    borderRadius: 6,
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
    color: "#5a6878",
  },
  distDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  locationBtn: {
    display: "block",
    width: "calc(100% - 40px)",
    margin: "12px 20px 0",
    padding: "10px 16px",
    border: "1.5px solid #0468B1",
    borderRadius: 8,
    background: "transparent",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    textAlign: "center",
    transition: "background 0.15s",
  },
  confirmedBtn: {
    width: "100%",
    padding: "10px 16px",
    border: "1.5px solid #e0e0e0",
    borderRadius: 8,
    background: "#f8fafc",
    color: "#1A2B4A",
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
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    zIndex: 30,
    overflow: "hidden",
  },
  dropdownItem: {
    display: "block",
    width: "100%",
    padding: "10px 16px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #f0f4f8",
    textAlign: "left",
    fontSize: 13,
    color: "#1A2B4A",
    cursor: "pointer",
  },
  commentsPlaceholder: {
    fontSize: 13,
    color: "#9aa5b4",
    fontStyle: "italic",
    marginBottom: 10,
    lineHeight: 1.5,
  },
  commentInput: {
    width: "100%",
    padding: "8px 12px",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    fontSize: 13,
    color: "#1A2B4A",
    background: "#f8fafc",
    boxSizing: "border-box",
    cursor: "not-allowed",
  },
  toast: {
    position: "absolute",
    bottom: 24,
    left: 20,
    right: 20,
    background: "#1A2B4A",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    zIndex: 40,
    textAlign: "center",
  },
};
