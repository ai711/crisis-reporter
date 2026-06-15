import { useState, useEffect } from "react";

interface FlagChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  actionLabel: string;
  fromStatus: string;
  toStatus?: string;
  onConfirm: (comment: string) => void;
  isSubmitting?: boolean;
  error?: string | null;
  // Emergency override only — shows a target status dropdown
  isEmergencyOverride?: boolean;
  onOverrideTargetChange?: (target: "green" | "red") => void;
  overrideTarget?: "green" | "red";
}

export default function FlagChangeModal({
  isOpen,
  onClose,
  actionLabel,
  fromStatus,
  toStatus,
  onConfirm,
  isSubmitting = false,
  error = null,
  isEmergencyOverride = false,
  onOverrideTargetChange,
  overrideTarget = "green",
}: FlagChangeModalProps) {
  const [comment, setComment] = useState("");

  // Reset comment each time modal opens
  useEffect(() => {
    if (isOpen) setComment("");
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmedLen = comment.trim().length;
  const isValid = trimmedLen >= 3;

  const displayTo = isEmergencyOverride
    ? overrideTarget === "green" ? "Force to Green" : "Force to Red"
    : toStatus ?? "";

  return (
    <>
      {/* Backdrop — intentionally not dismissible */}
      <div style={styles.backdrop} />

      <div style={styles.overlay}>
        <div style={styles.modal} role="dialog" aria-modal="true">
          {/* Title */}
          <h2 style={styles.title}>{actionLabel} this report?</h2>

          {/* Subtitle */}
          <p style={styles.subtitle}>
            Flag status will change from{" "}
            <strong style={{ textTransform: "capitalize" }}>{fromStatus}</strong> to{" "}
            <strong style={{ textTransform: "capitalize" }}>{displayTo}</strong>. This
            action is permanent.
          </p>

          {/* Emergency override target selector */}
          {isEmergencyOverride && onOverrideTargetChange && (
            <div style={styles.field}>
              <label style={styles.fieldLabel}>Force to status</label>
              <select
                style={styles.select}
                value={overrideTarget}
                onChange={(e) =>
                  onOverrideTargetChange(e.target.value as "green" | "red")
                }
                disabled={isSubmitting}
              >
                <option value="green">Force to Green</option>
                <option value="red">Force to Red</option>
              </select>
            </div>
          )}

          {/* Comment field */}
          <div style={styles.field}>
            <label style={styles.fieldLabel}>
              Add a comment (required)
            </label>
            <textarea
              style={styles.textarea}
              placeholder="Describe your reason for this decision…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              disabled={isSubmitting}
            />
            <div
              style={{
                ...styles.charCounter,
                color: isValid ? "#4caf50" : "#999",
              }}
            >
              {trimmedLen} / 3 minimum
            </div>
          </div>

          {/* Inline error from API */}
          {error && (
            <div style={styles.errorBox}>{error}</div>
          )}

          {/* Actions */}
          <div style={styles.actions}>
            <button
              style={styles.cancelBtn}
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              style={{
                ...styles.confirmBtn,
                opacity: isValid && !isSubmitting ? 1 : 0.4,
                cursor: isValid && !isSubmitting ? "pointer" : "not-allowed",
              }}
              onClick={() => {
                if (isValid && !isSubmitting) onConfirm(comment.trim());
              }}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Saving…" : actionLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 900,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 901,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modal: {
    background: "var(--c-surface-lowest)",
    borderRadius: 14,
    padding: "28px 28px 24px",
    width: "100%",
    maxWidth: 480,
    boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
    border: "1px solid #e0e8f0",
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--c-navy)",
    margin: "0 0 8px",
  },
  subtitle: {
    fontSize: 13,
    color: "#555",
    margin: "0 0 20px",
    lineHeight: 1.5,
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#555",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--c-navy)",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    padding: "8px 12px",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--c-navy)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    cursor: "pointer",
  },
  charCounter: {
    fontSize: 11,
    marginTop: 5,
    textAlign: "right",
    transition: "color 0.15s",
  },
  errorBox: {
    background: "#fff3f3",
    border: "1px solid #f44336",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 13,
    color: "#c62828",
    marginBottom: 16,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    padding: "9px 20px",
    background: "var(--c-surface-low)",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: "var(--c-text-secondary)",
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px",
    background: "var(--c-primary-container)",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-on-primary)",
    transition: "opacity 0.12s",
  },
};
