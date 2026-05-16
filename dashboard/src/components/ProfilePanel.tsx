import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { logout } from "../services/auth";
import api from "../services/api";
import type { DashboardUser } from "../types";

interface ProfilePanelProps {
  onClose: () => void;
}

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export default function ProfilePanel({ onClose }: ProfilePanelProps) {
  const navigate = useNavigate();
  const { user, setUser, reset } = useAuthStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Split full_name into first / last if the individual fields are not set
  const initialFirst =
    user?.first_name ??
    (user?.full_name ? user.full_name.split(" ")[0] : "") ?? "";
  const initialLast =
    user?.last_name ??
    (user?.full_name ? user.full_name.split(" ").slice(1).join(" ") : "") ?? "";

  const [firstName, setFirstName] = useState(initialFirst);
  const [lastName, setLastName] = useState(initialLast);
  const [contactNumber, setContactNumber] = useState(user?.contact_number ?? "");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(
    user?.profile_photo_url ?? null
  );

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  // ── Photo selection ─────────────────────────────────────────────────────────

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaveError("");

    if (!ALLOWED_TYPES.includes(file.type)) {
      setSaveError("Profile photo must be JPEG, PNG, or WebP.");
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    setSaveError("");

    try {
      const formData = new FormData();
      formData.append("first_name", firstName.trim());
      formData.append("last_name", lastName.trim());
      formData.append("contact_number", contactNumber.trim());
      if (photoFile) {
        formData.append("profile_photo", photoFile);
      }

      const response = await api.patch<DashboardUser>(
        "/api/dashboard/auth/me",
        formData
        // Axios sets multipart Content-Type with boundary automatically
      );

      setUser(response.data);
      setSaveSuccess(true);
      setPhotoFile(null); // clear pending upload
    } catch {
      setSaveError("Failed to save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── Logout ──────────────────────────────────────────────────────────────────

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      reset();
      navigate("/login");
    }
  };

  // ── Avatar display ──────────────────────────────────────────────────────────

  const avatarLetter = user?.full_name?.charAt(0)?.toUpperCase() ?? "U";

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div style={styles.panel} role="dialog" aria-label="Profile settings">
        {/* Header row */}
        <div style={styles.panelHeader}>
          <span style={styles.panelTitle}>My Profile</span>
          <button
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="Close profile panel"
          >
            ✕
          </button>
        </div>

        {/* Photo area */}
        <div style={styles.photoArea}>
          {photoPreview ? (
            <img
              src={photoPreview}
              alt="Profile"
              style={styles.photoImg}
            />
          ) : (
            <div style={styles.photoPlaceholder}>{avatarLetter}</div>
          )}
          <button
            style={styles.uploadBtn}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            Change Photo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={handlePhotoChange}
          />
          <p style={styles.photoHint}>JPEG, PNG, or WebP accepted.</p>
        </div>

        {/* Form fields */}
        <div style={styles.fields}>
          <div style={styles.row}>
            <div style={styles.fieldGroup}>
              <label style={styles.fieldLabel}>First Name</label>
              <input
                style={styles.fieldInput}
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value);
                  setSaveSuccess(false);
                }}
                placeholder="First name"
              />
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.fieldLabel}>Last Name</label>
              <input
                style={styles.fieldInput}
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  setSaveSuccess(false);
                }}
                placeholder="Last name"
              />
            </div>
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.fieldLabel}>Contact Number</label>
            <input
              style={styles.fieldInput}
              value={contactNumber}
              onChange={(e) => {
                setContactNumber(e.target.value);
                setSaveSuccess(false);
              }}
              placeholder="+1 555 000 0000 (optional)"
              type="tel"
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.fieldLabel}>
              Email Address{" "}
              <span style={styles.readOnlyBadge}>read-only</span>
            </label>
            <input
              style={{ ...styles.fieldInput, ...styles.readOnlyInput }}
              value={user?.email ?? ""}
              readOnly
            />
          </div>
        </div>

        {/* Status messages */}
        {saveSuccess && (
          <div style={styles.successMsg}>
            ✓ Profile updated successfully.
          </div>
        )}
        {saveError && (
          <div style={styles.errorMsg}>
            {saveError}{" "}
            <button style={styles.retryBtn} onClick={handleSave}>
              Retry
            </button>
          </div>
        )}

        {/* Save button */}
        <button
          style={{
            ...styles.saveBtn,
            opacity: saving ? 0.75 : 1,
            cursor: saving ? "not-allowed" : "pointer",
          }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save Changes"}
        </button>

        {/* Divider */}
        <div style={styles.divider} />

        {/* Logout */}
        <button
          style={{
            ...styles.logoutBtn,
            opacity: loggingOut ? 0.75 : 1,
            cursor: loggingOut ? "not-allowed" : "pointer",
          }}
          onClick={handleLogout}
          disabled={loggingOut}
        >
          {loggingOut ? "Signing out…" : "Sign Out"}
        </button>
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    zIndex: 200,
  },
  panel: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 380,
    background: "#fff",
    zIndex: 201,
    display: "flex",
    flexDirection: "column",
    boxShadow: "-4px 0 32px rgba(0,0,0,0.15)",
    overflowY: "auto",
    padding: "24px 28px",
    gap: 0,
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  panelTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: 18,
    cursor: "pointer",
    color: "#666",
    padding: "4px 8px",
    borderRadius: 4,
  },
  photoArea: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    marginBottom: 28,
    paddingBottom: 24,
    borderBottom: "1px solid #f0f0f0",
  },
  photoImg: {
    width: 80,
    height: 80,
    borderRadius: "50%",
    objectFit: "cover",
    border: "3px solid #0468B1",
  },
  photoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: "50%",
    background: "#0468B1",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 30,
    fontWeight: 700,
    border: "3px solid #0468B1",
  },
  uploadBtn: {
    background: "transparent",
    border: "1.5px solid #0468B1",
    color: "#0468B1",
    borderRadius: 6,
    padding: "6px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  photoHint: {
    fontSize: 11,
    color: "#999",
    margin: 0,
  },
  fields: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    marginBottom: 20,
  },
  row: {
    display: "flex",
    gap: 12,
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    flex: 1,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: "#444",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  fieldInput: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e0e0e0",
    fontSize: 14,
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
    background: "#fff",
  },
  readOnlyBadge: {
    fontSize: 11,
    background: "#f0f0f0",
    color: "#777",
    padding: "2px 6px",
    borderRadius: 4,
    fontWeight: 400,
  },
  readOnlyInput: {
    background: "#f9f9f9",
    color: "#777",
    cursor: "not-allowed",
  },
  successMsg: {
    background: "#e8f5e9",
    color: "#2e7d32",
    padding: "10px 14px",
    borderRadius: 7,
    fontSize: 13,
    border: "1px solid #a5d6a7",
    marginBottom: 12,
  },
  errorMsg: {
    background: "#fdecea",
    color: "#d32f2f",
    padding: "10px 14px",
    borderRadius: 7,
    fontSize: 13,
    border: "1px solid #f5c6cb",
    marginBottom: 12,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  retryBtn: {
    background: "none",
    border: "1px solid #d32f2f",
    color: "#d32f2f",
    borderRadius: 4,
    padding: "3px 8px",
    fontSize: 12,
    cursor: "pointer",
    flexShrink: 0,
  },
  saveBtn: {
    padding: "12px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    width: "100%",
    marginBottom: 16,
  },
  divider: {
    borderTop: "1px solid #f0f0f0",
    marginBottom: 16,
  },
  logoutBtn: {
    padding: "11px",
    background: "transparent",
    color: "#d32f2f",
    border: "1.5px solid #d32f2f",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    width: "100%",
    cursor: "pointer",
  },
};
