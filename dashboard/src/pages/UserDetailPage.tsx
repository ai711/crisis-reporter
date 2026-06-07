import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import Header from "../components/Header";
import {
  getDashboardUserDetail,
  getDashboardUserProjects,
  updateDashboardUser,
  updateDashboardUserStatus,
  getRolesList,
} from "../services/api";
import type { DashboardUserDetail, UserProjectAssignment } from "../types";
import { formatDateTime, formatProjectStatus, PROJECT_STATUS_COLOURS } from "../utils/formatters";

const BLUE = "var(--c-primary-container)";

// ── Helpers ────────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function getInitials(name: string): string {
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Role option type ───────────────────────────────────────────────────────────

interface RoleOption {
  id: string;
  name: string;
}

// ── Deactivate / Reactivate Confirmation Modal ─────────────────────────────────

interface StatusModalProps {
  user: DashboardUserDetail;
  action: "deactivate" | "reactivate";
  onClose: () => void;
  onSuccess: () => void;
}

function StatusConfirmModal({ user, action, onClose, onSuccess }: StatusModalProps) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isDeactivate = action === "deactivate";

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      await updateDashboardUserStatus(user.id, !isDeactivate);
      onSuccess();
    } catch {
      setError("Failed to update status. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={{ ...ms.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div style={ms.header}>
          <h2 style={ms.title}>{isDeactivate ? "Deactivate Account" : "Reactivate Account"}</h2>
          <button style={ms.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ margin: 0, fontSize: 14, color: "#4a5568" }}>
            {isDeactivate
              ? `This will prevent ${user.full_name} from accessing the dashboard.`
              : `This will restore ${user.full_name}'s access to the dashboard.`}
          </p>

          {isDeactivate && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#4a5568" }}>
                Reason <span style={{ fontWeight: 400, color: "#718096" }}>(optional)</span>
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Provide a reason for deactivating this account…"
                rows={3}
                style={{
                  padding: "10px 12px",
                  borderRadius: 7,
                  border: "1.5px solid #e2e8f0",
                  fontSize: 14,
                  color: "#1A2B4A",
                  resize: "vertical",
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}

          {error && (
            <div style={{ background: "#fff5f5", color: "#c53030", border: "1px solid #fc8181", borderRadius: 7, padding: "10px 14px", fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button style={ms.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              style={{
                padding: "10px 24px",
                background: isDeactivate ? "#C62828" : "#2E7D32",
                color: "#fff",
                border: "none",
                borderRadius: 7,
                fontSize: 14,
                fontWeight: 600,
                cursor: submitting ? "default" : "pointer",
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {submitting ? "Saving…" : isDeactivate ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Edit User Modal ────────────────────────────────────────────────────────────

interface EditUserModalProps {
  user: DashboardUserDetail;
  onClose: () => void;
  onSuccess: () => void;
  currentUserRole: string;
}

function EditUserModal({ user, onClose, onSuccess, currentUserRole }: EditUserModalProps) {
  const [firstName, setFirstName] = useState(user.first_name ?? "");
  const [lastName, setLastName] = useState(user.last_name ?? "");
  const [contactNumber, setContactNumber] = useState(user.contact_number ?? "");
  const [role, setRole] = useState(user.role);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: rolesData } = useQuery({
    queryKey: ["roles-list"],
    queryFn: async () => {
      const res = await getRolesList();
      return res.data as RoleOption[];
    },
  });

  const availableRoles = (rolesData ?? []).filter((r) =>
    currentUserRole === "superadmin" ? true : r.name !== "superadmin"
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        contact_number: contactNumber.trim() || null,
        role,
      };
      if (newPassword.length >= 8) {
        payload.password = newPassword;
      }
      await updateDashboardUser(user.id, payload);
      onSuccess();
    } catch {
      setSubmitError("Failed to save changes. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={ms.modal} onClick={(e) => e.stopPropagation()}>
        <div style={ms.header}>
          <h2 style={ms.title}>Edit Profile</h2>
          <button style={ms.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Email — read-only */}
          <div style={{ background: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 7, padding: "10px 14px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: 0.4 }}>Email address</div>
            <div style={{ fontSize: 14, color: "#2d3748", fontWeight: 500, marginTop: 2 }}>{user.email}</div>
            <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 2 }}>Email address cannot be changed.</div>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <EField label="First Name" required style={{ flex: 1 }}>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                style={ms.input}
              />
            </EField>
            <EField label="Last Name" required style={{ flex: 1 }}>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                style={ms.input}
              />
            </EField>
          </div>

          <EField label="Contact Number">
            <input
              type="text"
              value={contactNumber}
              onChange={(e) => setContactNumber(e.target.value)}
              placeholder="Optional"
              style={ms.input}
            />
          </EField>

          <EField label="Role" required>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={ms.select}
            >
              {availableRoles.map((r) => (
                <option key={r.id} value={r.name}>{capitalize(r.name)}</option>
              ))}
            </select>
          </EField>

          {/* Password Reset section */}
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4a5568", marginBottom: 10 }}>Reset Password</div>
            <EField label="New Password">
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Leave blank to keep current password"
                  style={{ ...ms.input, paddingRight: 40 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} color="#718096" /> : <Eye size={16} color="#718096" />}
                </button>
              </div>
              {newPassword.length > 0 && newPassword.length < 8 && (
                <span style={{ fontSize: 12, color: "#e53e3e" }}>Password must be at least 8 characters</span>
              )}
            </EField>
          </div>

          {submitError && (
            <div style={{ background: "#fff5f5", color: "#c53030", border: "1px solid #fc8181", borderRadius: 7, padding: "10px 14px", fontSize: 13 }}>
              {submitError}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
            <button type="button" style={ms.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              disabled={submitting}
              style={{ ...ms.submitBtn, opacity: submitting ? 0.6 : 1 }}
            >
              {submitting ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EField({
  label,
  required,
  children,
  style,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: "#4a5568" }}>
        {label} {required && <span style={{ color: "#e53e3e" }}>*</span>}
      </label>
      {children}
    </div>
  );
}

// ── User Detail Page ───────────────────────────────────────────────────────────

export default function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuthStore();

  const [showEdit, setShowEdit] = useState(false);
  const [statusAction, setStatusAction] = useState<"deactivate" | "reactivate" | null>(null);
  const [successMsg, setSuccessMsg] = useState("");

  const isAdminOrSuper = currentUser?.role === "admin" || currentUser?.role === "superadmin";

  const { data: user, isLoading, isError } = useQuery<DashboardUserDetail>({
    queryKey: ["dashboard-user-detail", userId],
    queryFn: async () => {
      const res = await getDashboardUserDetail(userId!);
      return res.data;
    },
    enabled: !!userId,
  });

  const { data: projectsData } = useQuery<UserProjectAssignment[]>({
    queryKey: ["dashboard-user-projects", userId],
    queryFn: async () => {
      const res = await getDashboardUserProjects(userId!);
      return res.data;
    },
    enabled: !!userId && !(user?.project_assignments),
  });

  const assignments: UserProjectAssignment[] =
    user?.project_assignments ?? projectsData ?? [];

  function showSuccess(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 4000);
  }

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ fontSize: 15, color: "#718096" }}>Loading user profile…</div>
      </div>
    );
  }

  if (isError || !user) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ background: "#fff", borderRadius: 12, padding: 40, boxShadow: "0 2px 12px rgba(0,0,0,0.1)", textAlign: "center", maxWidth: 400 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#1A2B4A", marginBottom: 8 }}>User Not Found</div>
          <div style={{ fontSize: 14, color: "#718096", marginBottom: 20 }}>This user profile does not exist or you don't have permission to view it.</div>
          <button style={{ padding: "10px 20px", background: BLUE, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" }} onClick={() => navigate("/users")}>
            Back to Users
          </button>
        </div>
      </div>
    );
  }

  const isActive = user.is_active ?? true;
  const isSelf = user.id === currentUser?.id;

  return (
    <div style={d.page}>
      <Header title="User Management" />
      {/* Back nav */}
      <div style={d.backBar}>
        <button style={d.backBtn} onClick={() => navigate("/users")}>← Manage Users</button>
      </div>

      {successMsg && (
        <div style={d.successBanner}>{successMsg}</div>
      )}

      <div style={d.content}>
        {/* Section 1 — Profile Header Card */}
        <div style={d.card}>
          <div style={d.profileHeader}>
            {/* Left: avatar + name */}
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
              {/* Avatar */}
              <div style={d.avatarWrap}>
                {user.profile_photo_url ? (
                  <img src={user.profile_photo_url} alt={user.full_name} style={d.avatarImg} />
                ) : (
                  <div style={d.avatarInitials}>{getInitials(user.full_name)}</div>
                )}
              </div>
              <div>
                <div style={d.profileName}>{user.full_name}</div>
                <div style={d.profileEmail}>{user.email}</div>
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={roleBadgeStyle(user.role)}>{capitalize(user.role)}</span>
                </div>
              </div>
            </div>

            {/* Right: actions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
              {/* Status pill */}
              <span style={{
                display: "inline-block",
                padding: "4px 12px",
                borderRadius: 20,
                fontSize: 13,
                fontWeight: 600,
                background: isActive ? "#E8F5E9" : "#FDECEA",
                color: isActive ? "#2E7D32" : "#C62828",
              }}>
                {isActive ? "Active" : "Inactive"}
              </span>

              {isAdminOrSuper && !isSelf && (
                <>
                  <button style={d.editBtn} onClick={() => setShowEdit(true)}>Edit Profile</button>
                  {isActive ? (
                    <button style={d.deactivateBtn} onClick={() => setStatusAction("deactivate")}>
                      Deactivate Account
                    </button>
                  ) : (
                    <button style={d.reactivateBtn} onClick={() => setStatusAction("reactivate")}>
                      Reactivate Account
                    </button>
                  )}
                </>
              )}
              {isAdminOrSuper && isSelf && (
                <button style={d.editBtn} onClick={() => setShowEdit(true)}>Edit Profile</button>
              )}

              {/* Meta */}
              <div style={{ fontSize: 12, color: "#718096", textAlign: "right" }}>
                <div>Created {formatDateTime(user.created_at ?? null)}</div>
                {user.created_by_name ? (
                  <div>
                    By{" "}
                    <button
                      style={{ background: "transparent", border: "none", color: BLUE, cursor: "pointer", fontSize: 12, padding: 0 }}
                      onClick={() => window.open(`/users/${user.created_by_user_id}`, "_blank")}
                    >
                      {user.created_by_name}
                    </button>
                  </div>
                ) : (
                  <div>Created by —</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Section 2 — Account Details Card */}
        <div style={d.card}>
          <div style={d.cardTitle}>Account Details</div>
          <div style={d.detailGrid}>
            <DetailRow label="First Name" value={user.first_name || "—"} />
            <DetailRow label="Last Name" value={user.last_name || "—"} />
            <DetailRow label="Email Address" value={user.email} />
            <DetailRow label="Contact Number" value={user.contact_number || "—"} />
            <DetailRow label="Role" value={capitalize(user.role)} />
            <DetailRow label="Account Status" value={isActive ? "Active" : "Inactive"} valueColor={isActive ? "#2E7D32" : "#C62828"} />
            <DetailRow label="Date Created" value={formatDateTime(user.created_at ?? null)} />
          </div>
        </div>

        {/* Section 3 — Project Assignments Card */}
        <div style={d.card}>
          <div style={d.cardTitle}>Project Assignments</div>
          {assignments.length === 0 ? (
            <div style={{ padding: "32px 0", textAlign: "center", color: "#718096", fontSize: 14 }}>
              Not assigned to any projects.
            </div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#f7fafc" }}>
                      {["Project ID", "Project Name", "Countries", "Status", "Access Level", "Creator", "Assigned"].map((h) => (
                        <th key={h} style={d.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assignments.map((a) => {
                      const statusColour = PROJECT_STATUS_COLOURS[a.status] ?? { bg: "#f0f4f8", text: "#4a5568" };
                      return (
                        <tr key={a.serial_id} style={{ borderBottom: "1px solid #f0f4f8" }}>
                          <td style={{ ...d.td, fontFamily: "monospace", fontSize: 12 }}>{a.serial_id}</td>
                          <td style={d.td}>
                            <button
                              style={{ background: "transparent", border: "none", color: BLUE, cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0 }}
                              onClick={() => window.open(`/projects/${a.serial_id}`, "_blank")}
                            >
                              {a.project_name}
                            </button>
                          </td>
                          <td style={d.td}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {a.countries.slice(0, 3).map((c) => (
                                <span key={c} style={{ fontSize: 11, background: "#EBF5FB", color: BLUE, borderRadius: 10, padding: "2px 8px", fontWeight: 500 }}>{c}</span>
                              ))}
                              {a.countries.length > 3 && (
                                <span style={{ fontSize: 11, color: "#718096" }}>+{a.countries.length - 3}</span>
                              )}
                            </div>
                          </td>
                          <td style={d.td}>
                            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: statusColour.bg, color: statusColour.text }}>
                              {formatProjectStatus(a.status)}
                            </span>
                          </td>
                          <td style={d.td}>
                            {a.access_level === "view_and_edit" ? "View and Edit" : "View only"}
                          </td>
                          <td style={d.td}>
                            {a.is_creator && (
                              <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: "#FFF8E1", color: "#F57F17" }}>
                                Assigned as Creator
                              </span>
                            )}
                          </td>
                          <td style={{ ...d.td, color: "#718096" }}>{formatDateTime(a.assigned_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 12, color: "#a0aec0", margin: "12px 0 0" }}>
                Project assignments can also be managed from the individual project page.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      {showEdit && (
        <EditUserModal
          user={user}
          currentUserRole={currentUser?.role ?? ""}
          onClose={() => setShowEdit(false)}
          onSuccess={() => {
            setShowEdit(false);
            queryClient.invalidateQueries({ queryKey: ["dashboard-user-detail", userId] });
            showSuccess("Profile updated successfully.");
          }}
        />
      )}

      {statusAction && (
        <StatusConfirmModal
          user={user}
          action={statusAction}
          onClose={() => setStatusAction(null)}
          onSuccess={() => {
            setStatusAction(null);
            queryClient.invalidateQueries({ queryKey: ["dashboard-user-detail", userId] });
            queryClient.invalidateQueries({ queryKey: ["dashboard-users"] });
            showSuccess(statusAction === "deactivate" ? "Account deactivated." : "Account reactivated.");
          }}
        />
      )}
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: valueColor ?? "#1A2B4A", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function roleBadgeStyle(role: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    superadmin: { bg: "#EDE7F6", color: "#4527A0" },
    admin: { bg: "#EBF5FB", color: "var(--c-primary-container)" },
    analyst: { bg: "#f0f4f8", color: "#4a5568" },
  };
  const c = map[role] ?? map.analyst;
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    background: c.bg,
    color: c.color,
  };
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const d: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    background: "#f4f6f9",
  },
  backBar: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "12px 32px",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
  },
  successBanner: {
    background: "#d4edda",
    color: "#155724",
    border: "1px solid #c3e6cb",
    padding: "12px 32px",
    fontSize: 14,
    fontWeight: 500,
  },
  content: {
    flex: 1,
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    maxWidth: 1100,
    width: "100%",
    alignSelf: "flex-start",
    boxSizing: "border-box",
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    width: "100%",
    boxSizing: "border-box",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 18,
  },
  profileHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 20,
    flexWrap: "wrap",
  },
  avatarWrap: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    overflow: "hidden",
    flexShrink: 0,
  },
  avatarImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  avatarInitials: {
    width: "100%",
    height: "100%",
    background: BLUE,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 26,
    fontWeight: 700,
    borderRadius: "50%",
  },
  profileName: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  profileEmail: {
    fontSize: 14,
    color: "#718096",
    marginTop: 2,
  },
  editBtn: {
    padding: "9px 18px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  deactivateBtn: {
    padding: "9px 18px",
    background: "#fff",
    color: "#C62828",
    border: "1.5px solid #EF9A9A",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  reactivateBtn: {
    padding: "9px 18px",
    background: "#fff",
    color: "#2E7D32",
    border: "1.5px solid #A5D6A7",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "20px 40px",
  },
  th: {
    padding: "10px 14px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "12px 14px",
    fontSize: 13,
    color: "#2d3748",
    verticalAlign: "middle",
  },
};

const ms: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    background: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 520,
    maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    borderBottom: "1px solid #e2e8f0",
    position: "sticky",
    top: 0,
    background: "#fff",
    zIndex: 1,
  },
  title: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", margin: 0 },
  closeBtn: {
    background: "transparent",
    border: "none",
    fontSize: 18,
    color: "#718096",
    cursor: "pointer",
    lineHeight: 1,
    padding: 4,
  },
  input: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
    width: "100%",
    boxSizing: "border-box",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    background: "#fff",
    width: "100%",
  },
  cancelBtn: {
    padding: "10px 20px",
    background: "#fff",
    color: "#4a5568",
    border: "1px solid #cbd5e0",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  submitBtn: {
    padding: "10px 24px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
