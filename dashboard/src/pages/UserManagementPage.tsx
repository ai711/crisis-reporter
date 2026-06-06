import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { X, Eye, EyeOff } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import {
  getDashboardUsers,
  createDashboardUser,
  getRolesList,
} from "../services/api";
import api from "../services/api";
import type { DashboardUser, DashboardUsersListResponse } from "../types";
import { formatDateTime } from "../utils/formatters";

const BLUE = "var(--c-primary-container)";
const BLUE_HEX = "#0468B1";
const PAGE_SIZE = 50;

// ── Avatar helpers ─────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  "#0468B1", "#1565C0", "#6A1B9A", "#2E7D32",
  "#BF360C", "#00695C", "#4527A0", "#283593",
];

function getAvatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  const p = name.trim().split(/\s+/);
  if (p.length >= 2) return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// ── Toggle switch ──────────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      title={checked ? "Click to deactivate" : "Click to activate"}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? BLUE_HEX : "#c8c8c8",
        cursor: "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
        border: "none",
        outline: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </div>
  );
}

// ── Role option type ───────────────────────────────────────────────────────────

interface RoleOption {
  id: string;
  name: string;
}

// ── Create User Modal ──────────────────────────────────────────────────────────

interface CreateUserModalProps {
  onClose: () => void;
  onSuccess: (newUserId: string) => void;
  currentUserRole: string;
}

function CreateUserModal({ onClose, onSuccess, currentUserRole }: CreateUserModalProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [contactNumber, setContactNumber] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
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

  const isValid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    role.length > 0;

  function clearErr(key: string) {
    setErrors((p) => { const n = { ...p }; delete n[key]; return n; });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!firstName.trim()) errs.firstName = "First name is required";
    if (!lastName.trim()) errs.lastName = "Last name is required";
    if (!email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Enter a valid email address";
    if (!password) errs.password = "Password is required";
    else if (password.length < 8) errs.password = "Password must be at least 8 characters";
    if (!role) errs.role = "Role is required";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await createDashboardUser({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
        is_active: isActive,
        contact_number: contactNumber.trim() || undefined,
      });
      onSuccess(res.data.id);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        setErrors((p) => ({ ...p, email: "This email address is already in use." }));
      } else {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        setSubmitError(typeof detail === "string" ? detail : "Failed to create user. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={ms.modal} onClick={(e) => e.stopPropagation()}>
        {/* Blue gradient header */}
        <div style={ms.header}>
          <div style={ms.headerLeft}>
            <span className="material-symbols-outlined" style={{ fontSize: 28, color: "#fff", opacity: 0.9 }}>
              person_add
            </span>
            <div>
              <div style={ms.title}>Add New User</div>
              <div style={ms.subtitle}>Configure credentials and platform access permissions.</div>
            </div>
          </div>
          <button style={ms.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} color="rgba(255,255,255,0.8)" />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={ms.form}>
          <div style={{ display: "flex", gap: 12 }}>
            <MField label="First Name" required error={errors.firstName} style={{ flex: 1 }}>
              <input
                type="text"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); clearErr("firstName"); }}
                placeholder="Jane"
                style={{ ...ms.input, borderColor: errors.firstName ? "#e53e3e" : "#e2e8f0" }}
              />
            </MField>
            <MField label="Last Name" required error={errors.lastName} style={{ flex: 1 }}>
              <input
                type="text"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); clearErr("lastName"); }}
                placeholder="Smith"
                style={{ ...ms.input, borderColor: errors.lastName ? "#e53e3e" : "#e2e8f0" }}
              />
            </MField>
          </div>

          <MField label="Email Address" required error={errors.email}>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearErr("email"); }}
              placeholder="jane@undp.org"
              style={{ ...ms.input, borderColor: errors.email ? "#e53e3e" : "#e2e8f0" }}
            />
          </MField>

          <MField label="Password" required error={errors.password}>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearErr("password"); }}
                placeholder="Min. 8 characters"
                style={{ ...ms.input, borderColor: errors.password ? "#e53e3e" : "#e2e8f0", paddingRight: 40, width: "100%", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                style={ms.eyeBtn}
                tabIndex={-1}
              >
                {showPassword
                  ? <EyeOff size={16} color="var(--c-text-muted)" />
                  : <Eye size={16} color="var(--c-text-muted)" />}
              </button>
            </div>
            <span style={{ fontSize: 11, color: password.length >= 8 ? "#2E7D32" : "var(--c-text-muted)", marginTop: 2 }}>
              {password.length} / 8 characters minimum
            </span>
          </MField>

          <MField label="Role" required error={errors.role}>
            <select
              value={role}
              onChange={(e) => { setRole(e.target.value); clearErr("role"); }}
              style={{ ...ms.select, borderColor: errors.role ? "#e53e3e" : "#e2e8f0" }}
            >
              <option value="">Select role…</option>
              {availableRoles.map((r) => (
                <option key={r.id} value={r.name}>{capitalize(r.name)}</option>
              ))}
            </select>
          </MField>

          {/* Account Status — toggle switch */}
          <MField label="Account Status">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ToggleSwitch checked={isActive} onChange={() => setIsActive((v) => !v)} />
              <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? "#2E7D32" : "#718096" }}>
                {isActive ? "Active" : "Inactive"}
              </span>
            </div>
          </MField>

          <MField label="Contact Number">
            <input
              type="text"
              value={contactNumber}
              onChange={(e) => setContactNumber(e.target.value)}
              placeholder="+1 555 000 0000 (optional)"
              style={ms.input}
            />
          </MField>

          {submitError && <div style={ms.submitError}>{submitError}</div>}

          <div style={ms.footer}>
            <button type="button" style={ms.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              style={{ ...ms.submitBtn, opacity: !isValid || submitting ? 0.55 : 1, cursor: !isValid || submitting ? "default" : "pointer" }}
            >
              {submitting ? "Creating…" : "Add User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MField({
  label,
  required,
  error,
  children,
  style,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: "#4a5568" }}>
        {label} {required && <span style={{ color: "#e53e3e" }}>*</span>}
      </label>
      {children}
      {error && <span style={{ fontSize: 12, color: "#e53e3e", fontWeight: 500 }}>{error}</span>}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "active" | "inactive";

export default function UserManagementPage() {
  const { user: currentUser } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const isAdminOrSuper = currentUser?.role === "admin" || currentUser?.role === "superadmin";

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
      setCursors([null]);
      setPageIndex(0);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  // Reset pagination when status filter changes
  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [statusFilter]);

  const queryParams: Record<string, string | number> = { limit: PAGE_SIZE };
  if (search) queryParams.search = search;
  if (statusFilter !== "all") queryParams.is_active = statusFilter === "active" ? "true" : "false";
  const currentCursor = cursors[pageIndex];
  if (currentCursor) queryParams.cursor = currentCursor;

  const { data, isLoading } = useQuery<DashboardUsersListResponse>({
    queryKey: ["dashboard-users", search, statusFilter, pageIndex, currentCursor],
    queryFn: async () => {
      const res = await getDashboardUsers(queryParams);
      return res.data;
    },
  });

  const users: DashboardUser[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasMore = data?.has_more ?? false;

  function handleNext() {
    if (!data?.cursor) return;
    const nextCursors = [...cursors];
    nextCursors[pageIndex + 1] = data.cursor;
    setCursors(nextCursors);
    setPageIndex((p) => p + 1);
  }

  function handlePrev() {
    if (pageIndex === 0) return;
    setPageIndex((p) => p - 1);
  }

  function handleCreateSuccess(newUserId: string) {
    setShowCreate(false);
    queryClient.invalidateQueries({ queryKey: ["dashboard-users"] });
    navigate(`/users/${newUserId}`);
  }

  async function handleToggleStatus(userId: string, currentActive: boolean) {
    if (togglingId) return;
    setTogglingId(userId);
    try {
      await api.patch(`/api/dashboard/users/${userId}/status`, { is_active: !currentActive });
      queryClient.invalidateQueries({ queryKey: ["dashboard-users"] });
    } catch { /* silent */ } finally {
      setTogglingId(null);
    }
  }

  return (
    <div style={s.page}>
      {/* ── Sticky toolbar ── */}
      <div style={s.toolbar}>
        <div style={s.toolbarLeft}>
          {/* Account Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            style={s.filterSelect}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

          {/* Search */}
          <div style={s.searchWrap}>
            <span className="material-symbols-outlined" style={s.searchIcon}>search</span>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, email or role…"
              style={s.searchInput}
            />
            {searchInput && (
              <button style={s.clearBtn} onClick={() => setSearchInput("")} aria-label="Clear search">
                <X size={13} color="#9aa5b4" />
              </button>
            )}
          </div>
        </div>

        <div style={s.toolbarRight}>
          <span style={s.countLabel}>{total.toLocaleString()} user{total !== 1 ? "s" : ""}</span>
          {isAdminOrSuper && (
            <button style={s.addBtn} onClick={() => setShowCreate(true)}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, lineHeight: 1 }}>
                person_add
              </span>
              Add User
            </button>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={s.content}>
        {isLoading ? (
          <div style={s.loading}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={s.empty}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#cbd5e0" }}>
              group
            </span>
            <div style={s.emptyText}>No dashboard users found.</div>
          </div>
        ) : (
          <>
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Name</th>
                    <th style={s.th}>Email Address</th>
                    <th style={s.th}>Account Status</th>
                    <th style={s.th}>Date Created</th>
                    <th style={s.th}>Created By</th>
                    {isAdminOrSuper && <th style={{ ...s.th, textAlign: "center" }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    const active = u.is_active ?? true;
                    const avatarColor = getAvatarColor(u.full_name);
                    const initials = getInitials(u.full_name);
                    return (
                      <tr
                        key={u.id}
                        style={s.tr}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#f8fafc"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ""; }}
                      >
                        {/* Name column: avatar + name + role sublabel */}
                        <td style={s.td}>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: "50%",
                                background: avatarColor,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                color: "#fff",
                                fontSize: 13,
                                fontWeight: 700,
                                flexShrink: 0,
                                letterSpacing: 0.5,
                              }}
                            >
                              {initials}
                            </div>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <button
                                  style={s.nameLink}
                                  onClick={() => navigate(`/users/${u.id}`)}
                                >
                                  {u.full_name}
                                </button>
                                {isSelf && <span style={s.youPill}>You</span>}
                              </div>
                              <div style={s.roleSublabel}>{capitalize(u.role)}</div>
                            </div>
                          </div>
                        </td>

                        <td style={s.td}>{u.email}</td>

                        {/* Status: dot + text */}
                        <td style={s.td}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: active ? "#4caf50" : "#9e9e9e",
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                color: active ? "#2E7D32" : "#718096",
                              }}
                            >
                              {active ? "Active" : "Inactive"}
                            </span>
                          </div>
                        </td>

                        <td style={s.td}>{u.created_at ? formatDateTime(u.created_at) : "—"}</td>
                        <td style={s.td}>{u.created_by_name ?? "—"}</td>

                        {/* Actions column */}
                        {isAdminOrSuper && (
                          <td style={{ ...s.td, textAlign: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                              {/* Edit */}
                              <button
                                style={s.actionBtn}
                                onClick={() => navigate(`/users/${u.id}`)}
                                title="Edit user"
                              >
                                <span
                                  className="material-symbols-outlined"
                                  style={{ fontSize: 17, color: "#4a5568" }}
                                >
                                  edit
                                </span>
                              </button>
                              {/* Toggle active */}
                              {!isSelf && (
                                <button
                                  style={{ ...s.actionBtn, opacity: togglingId === u.id ? 0.5 : 1 }}
                                  onClick={() => handleToggleStatus(u.id, active)}
                                  disabled={togglingId === u.id}
                                  title={active ? "Deactivate account" : "Activate account"}
                                >
                                  <span
                                    className="material-symbols-outlined"
                                    style={{ fontSize: 17, color: active ? "#C62828" : "#2E7D32" }}
                                  >
                                    {active ? "person_off" : "person"}
                                  </span>
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div style={s.paginationBar}>
              <button
                style={{ ...s.pageBtn, opacity: pageIndex === 0 ? 0.4 : 1, cursor: pageIndex === 0 ? "default" : "pointer" }}
                onClick={handlePrev}
                disabled={pageIndex === 0}
              >
                ← Previous
              </button>
              <span style={s.pageLabel}>Page {pageIndex + 1}</span>
              <button
                style={{ ...s.pageBtn, opacity: !hasMore ? 0.4 : 1, cursor: !hasMore ? "default" : "pointer" }}
                onClick={handleNext}
                disabled={!hasMore}
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onSuccess={handleCreateSuccess}
          currentUserRole={currentUser?.role ?? ""}
        />
      )}
    </div>
  );
}

// ── Page styles ────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--c-surface-low)",
    overflow: "hidden",
  },
  toolbar: {
    background: "var(--c-surface-lowest)",
    borderBottom: "1px solid #e0e0e0",
    padding: "12px 28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    position: "sticky",
    top: 0,
    zIndex: 50,
    flexWrap: "wrap",
  },
  toolbarLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  toolbarRight: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexShrink: 0,
  },
  filterSelect: {
    padding: "8px 12px",
    border: "1.5px solid #e2e8f0",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    cursor: "pointer",
    flexShrink: 0,
    outline: "none",
  },
  searchWrap: {
    flex: 1,
    position: "relative",
    display: "flex",
    alignItems: "center",
    minWidth: 0,
  },
  searchIcon: {
    position: "absolute",
    left: 10,
    fontSize: 18,
    color: "#9aa5b4",
    pointerEvents: "none",
    lineHeight: 1,
  },
  searchInput: {
    width: "100%",
    padding: "8px 34px 8px 34px",
    border: "1.5px solid #e2e8f0",
    borderRadius: 8,
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    boxSizing: "border-box",
  },
  clearBtn: {
    position: "absolute",
    right: 10,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: 0,
  },
  countLabel: {
    fontSize: 13,
    color: "var(--c-text-muted)",
    whiteSpace: "nowrap",
  },
  addBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 18px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    padding: "24px 28px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  loading: {
    padding: 60,
    textAlign: "center",
    color: "var(--c-text-muted)",
    fontSize: 15,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 80,
  },
  emptyText: { fontSize: 15, color: "var(--c-text-muted)" },
  tableWrap: {
    background: "var(--c-surface-lowest)",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "var(--shadow-card)",
    border: "1px solid #e8eef4",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "11px 16px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
    whiteSpace: "nowrap",
  },
  tr: {
    borderBottom: "1px solid #f0f4f8",
    transition: "background 0.1s",
  },
  td: {
    padding: "12px 16px",
    fontSize: 13,
    color: "var(--c-text-primary)",
    verticalAlign: "middle",
  },
  nameLink: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
  },
  roleSublabel: {
    fontSize: 11,
    color: "var(--c-text-muted)",
    marginTop: 2,
    fontWeight: 500,
  },
  youPill: {
    fontSize: 10,
    fontWeight: 700,
    background: "#f0f4f8",
    color: "var(--c-text-muted)",
    padding: "2px 7px",
    borderRadius: 10,
    border: "1px solid #e2e8f0",
  },
  actionBtn: {
    background: "none",
    border: "1px solid #e2e8f0",
    borderRadius: 7,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
    transition: "border-color 0.15s, background 0.15s",
  },
  paginationBar: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    padding: "4px 0",
  },
  pageLabel: { fontSize: 13, color: "#4a5568", fontWeight: 500 },
  pageBtn: {
    padding: "7px 16px",
    background: "var(--c-surface-lowest)",
    border: "1px solid #e2e8f0",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 500,
    color: "#4a5568",
    cursor: "pointer",
  },
};

// ── Modal styles ───────────────────────────────────────────────────────────────

const ms: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.50)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    background: "var(--c-surface-lowest)",
    borderRadius: 16,
    width: "100%",
    maxWidth: 520,
    maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: "0 24px 64px rgba(0,0,0,0.28)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "22px 24px",
    background: `linear-gradient(135deg, ${BLUE_HEX} 0%, #00508a 100%)`,
    borderRadius: "16px 16px 0 0",
    position: "sticky",
    top: 0,
    zIndex: 1,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "#fff",
    margin: 0,
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize: 12,
    color: "rgba(255,255,255,0.75)",
    marginTop: 3,
  },
  closeBtn: {
    background: "rgba(255,255,255,0.15)",
    border: "none",
    borderRadius: 8,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  form: {
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  input: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "var(--c-surface-lowest)",
    width: "100%",
    boxSizing: "border-box",
  },
  select: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    width: "100%",
    outline: "none",
  },
  eyeBtn: {
    position: "absolute",
    right: 10,
    top: "50%",
    transform: "translateY(-50%)",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    padding: 0,
  },
  submitError: {
    background: "#fff5f5",
    color: "#c53030",
    border: "1px solid #fc8181",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 500,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    padding: "10px 20px",
    background: "var(--c-surface-lowest)",
    color: "#4a5568",
    border: "1px solid #cbd5e0",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  submitBtn: {
    padding: "10px 24px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
