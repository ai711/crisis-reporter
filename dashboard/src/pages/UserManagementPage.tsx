import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

// ── Types ──────────────────────────────────────────────────────────────────────

type UserRole = "admin" | "analyst";

interface DashboardUserFull {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ── Role badge ─────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: UserRole }) {
  const isAdmin = role === "admin";
  return (
    <span style={{
      display: "inline-block",
      padding: "4px 12px",
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 600,
      background: isAdmin ? "#EBF5FB" : "#f0f4f8",
      color: isAdmin ? BLUE : "#4a5568",
      border: `1px solid ${isAdmin ? "#bee3f8" : "#e2e8f0"}`,
    }}>
      {isAdmin ? "Admin" : "Analyst"}
    </span>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "4px 12px",
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 600,
      background: active ? "#d4edda" : "#e2e8f0",
      color: active ? "#155724" : "#4a5568",
    }}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

// ── Add User Modal ─────────────────────────────────────────────────────────────

interface AddModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

function AddUserModal({ onClose, onSuccess }: AddModalProps) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!fullName.trim()) e.fullName = "Full name is required";
    if (!email.trim()) e.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email address";
    if (!password) e.password = "Password is required";
    else if (password.length < 8) e.password = "Password must be at least 8 characters";
    if (!role) e.role = "Role is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      await api.post("/api/dashboard-users", {
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
      });
      onSuccess();
    } catch {
      setSubmitError("Failed to create user. The email may already be in use.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Add User</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={s.form}>
          <Field label="Full Name" required error={errors.fullName}>
            <input
              type="text"
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); clearErr("fullName"); }}
              placeholder="e.g. Jane Smith"
              style={{ ...s.input, borderColor: errors.fullName ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>

          <Field label="Email" required error={errors.email}>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearErr("email"); }}
              placeholder="jane@undp.org"
              style={{ ...s.input, borderColor: errors.email ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>

          <Field label="Password" required error={errors.password}>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearErr("password"); }}
              placeholder="Min. 8 characters"
              style={{ ...s.input, borderColor: errors.password ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>

          <Field label="Role" required error={errors.role}>
            <select
              value={role}
              onChange={(e) => { setRole(e.target.value as UserRole | ""); clearErr("role"); }}
              style={{ ...s.select, borderColor: errors.role ? "#e53e3e" : "#e2e8f0" }}
            >
              <option value="">Select role…</option>
              <option value="admin">Admin</option>
              <option value="analyst">Analyst</option>
            </select>
          </Field>

          {submitError && <div style={s.submitError}>{submitError}</div>}

          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Creating…" : "Create User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  function clearErr(key: string) {
    setErrors((p) => { const next = { ...p }; delete next[key]; return next; });
  }
}

// ── Edit User Modal ────────────────────────────────────────────────────────────

interface EditModalProps {
  user: DashboardUserFull;
  onClose: () => void;
  onSuccess: () => void;
}

function EditUserModal({ user, onClose, onSuccess }: EditModalProps) {
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState<UserRole>(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!fullName.trim()) e.fullName = "Full name is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      await api.patch(`/api/dashboard-users/${user.id}`, {
        full_name: fullName.trim(),
        role,
        is_active: isActive,
      });
      onSuccess();
    } catch {
      setSubmitError("Failed to update user. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <h2 style={s.modalTitle}>Edit User</h2>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.editEmailNote}>
            <span style={s.editEmailLabel}>Email</span>
            <span style={s.editEmailValue}>{user.email}</span>
          </div>

          <Field label="Full Name" required error={errors.fullName}>
            <input
              type="text"
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                setErrors((p) => { const next = { ...p }; delete next.fullName; return next; });
              }}
              style={{ ...s.input, borderColor: errors.fullName ? "#e53e3e" : "#e2e8f0" }}
            />
          </Field>

          <Field label="Role" required>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              style={s.select}
            >
              <option value="admin">Admin</option>
              <option value="analyst">Analyst</option>
            </select>
          </Field>

          <Field label="Status" required>
            <div style={s.toggleRow}>
              <button
                type="button"
                onClick={() => setIsActive(true)}
                style={{
                  ...s.toggleBtn,
                  background: isActive ? "#d4edda" : "#f0f4f8",
                  color: isActive ? "#155724" : "#4a5568",
                  border: `1.5px solid ${isActive ? "#c3e6cb" : "#e2e8f0"}`,
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => setIsActive(false)}
                style={{
                  ...s.toggleBtn,
                  background: !isActive ? "#e2e8f0" : "#f0f4f8",
                  color: !isActive ? "#2d3748" : "#a0aec0",
                  border: `1.5px solid ${!isActive ? "#cbd5e0" : "#e2e8f0"}`,
                  fontWeight: !isActive ? 700 : 500,
                }}
              >
                Inactive
              </button>
            </div>
          </Field>

          {submitError && <div style={s.submitError}>{submitError}</div>}

          <div style={s.modalFooter}>
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...s.submitBtn, opacity: submitting ? 0.7 : 1 }}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Field wrapper ──────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={s.fieldGroup}>
      <label style={s.label}>
        {label} {required && <span style={s.req}>*</span>}
      </label>
      {children}
      {error && <span style={s.fieldErr}>{error}</span>}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function UserManagementPage() {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editTarget, setEditTarget] = useState<DashboardUserFull | null>(null);
  const [successBanner, setSuccessBanner] = useState("");

  // Admin guard
  if (currentUser?.role !== "admin") {
    return (
      <div style={s.page}>
        <div style={s.accessDenied}>
          <div style={s.accessIcon}>🔒</div>
          <div style={s.accessTitle}>Admin access required</div>
          <div style={s.accessNote}>
            User Management is restricted to Admin accounts. Contact your administrator if you need access.
          </div>
        </div>
      </div>
    );
  }

  // Fetch users
  const { data: users = [], isLoading } = useQuery<DashboardUserFull[]>({
    queryKey: ["dashboard-users"],
    queryFn: async () => {
      const res = await api.get<DashboardUserFull[]>("/api/dashboard-users");
      return res.data;
    },
  });

  // Deactivate mutation
  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.patch(`/api/dashboard-users/${id}`, { is_active: false });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-users"] });
    },
  });

  function handleDeactivate(user: DashboardUserFull) {
    if (!window.confirm(`Are you sure you want to deactivate ${user.full_name}?`)) return;
    deactivateMutation.mutate(user.id);
  }

  function handleSuccess(message: string) {
    setShowAddModal(false);
    setEditTarget(null);
    queryClient.invalidateQueries({ queryKey: ["dashboard-users"] });
    setSuccessBanner(message);
  }

  useEffect(() => {
    if (!successBanner) return;
    const t = setTimeout(() => setSuccessBanner(""), 4000);
    return () => clearTimeout(t);
  }, [successBanner]);

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.headerRow}>
        <div>
          <h1 style={s.pageTitle}>User Management</h1>
          <p style={s.pageSubtitle}>
            {isLoading ? "Loading…" : `${users.length} dashboard user${users.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button style={s.addBtn} onClick={() => setShowAddModal(true)}>
          + Add User
        </button>
      </div>

      {successBanner && <div style={s.successBanner}>{successBanner}</div>}

      <div style={s.content}>
        {isLoading ? (
          <div style={s.loading}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={s.empty}>
            <div style={{ fontSize: 44 }}>👥</div>
            <div style={s.emptyText}>No users yet. Add one to get started.</div>
          </div>
        ) : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>Full Name</th>
                  <th style={s.th}>Email</th>
                  <th style={s.th}>Role</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Last Login</th>
                  <th style={s.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <tr key={u.id} style={s.tr}>
                      <td style={s.td}>
                        <div style={s.nameCell}>
                          <span style={s.nameInitial}>
                            {u.full_name.charAt(0).toUpperCase()}
                          </span>
                          <span style={s.nameFull}>{u.full_name}</span>
                          {isSelf && <span style={s.youPill}>You</span>}
                        </div>
                      </td>
                      <td style={s.td}>
                        <span style={s.emailText}>{u.email}</span>
                      </td>
                      <td style={s.td}>
                        <RoleBadge role={u.role} />
                      </td>
                      <td style={s.td}>
                        <StatusBadge active={u.is_active} />
                      </td>
                      <td style={s.td}>
                        <span style={s.lastLogin}>{timeAgo(u.last_login_at)}</span>
                      </td>
                      <td style={s.td}>
                        <div style={s.actionRow}>
                          <button
                            style={s.editBtn}
                            onClick={() => setEditTarget(u)}
                          >
                            Edit
                          </button>
                          {!isSelf && u.is_active && (
                            <button
                              style={{
                                ...s.deactivateBtn,
                                opacity: deactivateMutation.isPending ? 0.5 : 1,
                                cursor: deactivateMutation.isPending ? "default" : "pointer",
                              }}
                              onClick={() => handleDeactivate(u)}
                              disabled={deactivateMutation.isPending}
                            >
                              Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAddModal && (
        <AddUserModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => handleSuccess("User created successfully")}
        />
      )}

      {editTarget && (
        <EditUserModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => handleSuccess("User updated successfully")}
        />
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
    background: "#f4f6f9",
  },
  // Access denied
  accessDenied: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 60,
  },
  accessIcon: { fontSize: 52 },
  accessTitle: { fontSize: 22, fontWeight: 700, color: "#1A2B4A" },
  accessNote: { fontSize: 14, color: "#718096", maxWidth: 400, textAlign: "center" },
  // Header
  headerRow: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "16px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  pageSubtitle: {
    fontSize: 13,
    color: "#718096",
    marginTop: 4,
    marginBottom: 0,
  },
  addBtn: {
    padding: "10px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  // Banner
  successBanner: {
    background: "#d4edda",
    color: "#155724",
    border: "1px solid #c3e6cb",
    padding: "12px 32px",
    fontSize: 14,
    fontWeight: 500,
  },
  // Content
  content: {
    flex: 1,
    padding: "28px 32px",
    overflowY: "auto",
  },
  loading: {
    padding: 60,
    textAlign: "center",
    color: "#718096",
    fontSize: 15,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 80,
  },
  emptyText: { fontSize: 15, color: "#718096" },
  // Table
  tableWrap: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "12px 16px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "14px 16px", fontSize: 13, color: "#2d3748", verticalAlign: "middle" },
  // Name cell
  nameCell: { display: "flex", alignItems: "center", gap: 10 },
  nameInitial: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: BLUE,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  nameFull: { fontWeight: 600, color: "#1A2B4A", fontSize: 14 },
  youPill: {
    fontSize: 10,
    fontWeight: 700,
    background: "#EBF5FB",
    color: BLUE,
    padding: "2px 7px",
    borderRadius: 10,
    border: `1px solid #bee3f8`,
  },
  emailText: { fontSize: 13, color: "#4a5568" },
  lastLogin: { fontSize: 13, color: "#718096" },
  // Action buttons
  actionRow: { display: "flex", gap: 12, alignItems: "center" },
  editBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
  },
  deactivateBtn: {
    background: "transparent",
    border: "none",
    color: "#e53e3e",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
  },
  // Modal shared
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
    maxWidth: 480,
    maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
  },
  modalHeader: {
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
  modalTitle: { fontSize: 18, fontWeight: 700, color: "#1A2B4A", margin: 0 },
  closeBtn: {
    background: "transparent",
    border: "none",
    fontSize: 18,
    color: "#718096",
    cursor: "pointer",
    lineHeight: 1,
    padding: 4,
  },
  form: {
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  fieldGroup: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: "#4a5568" },
  req: { color: "#e53e3e" },
  input: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid",
    fontSize: 14,
    color: "#1A2B4A",
    outline: "none",
    background: "#fff",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "#1A2B4A",
    background: "#fff",
  },
  fieldErr: { fontSize: 12, color: "#e53e3e", fontWeight: 500 },
  submitError: {
    background: "#fff5f5",
    color: "#c53030",
    border: "1px solid #fc8181",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 500,
  },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
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
  // Edit modal specific
  editEmailNote: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    background: "#f7fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 7,
    padding: "10px 14px",
  },
  editEmailLabel: { fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: 0.4 },
  editEmailValue: { fontSize: 14, color: "#2d3748", fontWeight: 500 },
  toggleRow: { display: "flex", gap: 8 },
  toggleBtn: {
    flex: 1,
    padding: "9px 0",
    borderRadius: 7,
    fontSize: 14,
    cursor: "pointer",
    textAlign: "center" as const,
    transition: "all 0.15s",
  },
};
