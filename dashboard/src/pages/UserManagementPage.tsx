import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Users, X, Eye, EyeOff } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import {
  getDashboardUsers,
  createDashboardUser,
  getRolesList,
} from "../services/api";
import type { DashboardUser, DashboardUsersListResponse } from "../types";
import { formatDateTime } from "../utils/formatters";

const BLUE = "var(--c-primary-container)";
const PAGE_SIZE = 50;

// ── Role display ───────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// ── Status pill ────────────────────────────────────────────────────────────────

function StatusPill({ active }: { active: boolean }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 600,
      background: active ? "#E8F5E9" : "#FDECEA",
      color: active ? "#2E7D32" : "#C62828",
    }}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

// ── Create User Modal ──────────────────────────────────────────────────────────

interface RoleOption {
  id: string;
  name: string;
}

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
        setSubmitError("Failed to create user. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={ms.overlay} onClick={onClose}>
      <div style={ms.modal} onClick={(e) => e.stopPropagation()}>
        <div style={ms.header}>
          <h2 style={ms.title}>Create User</h2>
          <button style={ms.closeBtn} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} style={ms.form}>
          <div style={{ display: "flex", gap: 12 }}>
            <MField label="First Name" required error={errors.firstName} style={{ flex: 1 }}>
              <input
                type="text"
                value={firstName}
                onChange={(e) => { setFirstName(e.target.value); clearErr("firstName"); }}
                placeholder="Jane"
                style={{ ...ms.input, borderColor: errors.firstName ? "#e53e3e" : "var(--c-surface-high)" }}
              />
            </MField>
            <MField label="Last Name" required error={errors.lastName} style={{ flex: 1 }}>
              <input
                type="text"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); clearErr("lastName"); }}
                placeholder="Smith"
                style={{ ...ms.input, borderColor: errors.lastName ? "#e53e3e" : "var(--c-surface-high)" }}
              />
            </MField>
          </div>

          <MField label="Email Address" required error={errors.email}>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearErr("email"); }}
              placeholder="jane@undp.org"
              style={{ ...ms.input, borderColor: errors.email ? "#e53e3e" : "var(--c-surface-high)" }}
            />
          </MField>

          <MField label="Password" required error={errors.password}>
            <div style={{ position: "relative" }}>
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearErr("password"); }}
                placeholder="Min. 8 characters"
                style={{ ...ms.input, borderColor: errors.password ? "#e53e3e" : "var(--c-surface-high)", paddingRight: 40, width: "100%", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                style={ms.eyeBtn}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} color="var(--c-text-muted)" /> : <Eye size={16} color="var(--c-text-muted)" />}
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
              style={{ ...ms.select, borderColor: errors.role ? "#e53e3e" : "var(--c-surface-high)" }}
            >
              <option value="">Select role…</option>
              {availableRoles.map((r) => (
                <option key={r.id} value={r.name}>{capitalize(r.name)}</option>
              ))}
            </select>
          </MField>

          <MField label="Account Status">
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setIsActive(true)}
                style={{ ...ms.toggleBtn, background: isActive ? "#E8F5E9" : "#f0f4f8", color: isActive ? "#2E7D32" : "var(--c-text-muted)", border: `1.5px solid ${isActive ? "#A5D6A7" : "var(--c-surface-high)"}`, fontWeight: isActive ? 700 : 500 }}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => setIsActive(false)}
                style={{ ...ms.toggleBtn, background: !isActive ? "#FDECEA" : "#f0f4f8", color: !isActive ? "#C62828" : "var(--c-text-muted)", border: `1.5px solid ${!isActive ? "#EF9A9A" : "var(--c-surface-high)"}`, fontWeight: !isActive ? 700 : 500 }}
              >
                Inactive
              </button>
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
              style={{ ...ms.submitBtn, opacity: !isValid || submitting ? 0.5 : 1, cursor: !isValid || submitting ? "default" : "pointer" }}
            >
              {submitting ? "Creating…" : "Create User"}
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

export default function UserManagementPage() {
  const { user: currentUser } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const [showCreate, setShowCreate] = useState(false);

  const isAdminOrSuper = currentUser?.role === "admin" || currentUser?.role === "superadmin";

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(searchInput);
      // Reset pagination on new search
      setCursors([null]);
      setPageIndex(0);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  const queryParams: Record<string, string | number> = {
    limit: PAGE_SIZE,
  };
  if (search) queryParams.search = search;
  const currentCursor = cursors[pageIndex];
  if (currentCursor) queryParams.cursor = currentCursor;

  const { data, isLoading } = useQuery<DashboardUsersListResponse>({
    queryKey: ["dashboard-users", search, pageIndex, currentCursor],
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

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.headerRow}>
        <h1 style={s.pageTitle}>Manage Users</h1>
        <div style={s.topBar}>
          {/* Search */}
          <div style={s.searchWrap}>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, email, role, or status"
              style={s.searchInput}
            />
            {searchInput && (
              <button
                style={s.clearBtn}
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
              >
                <X size={14} color="var(--c-text-muted)" />
              </button>
            )}
          </div>
          {/* Create User — Admin/Superadmin only */}
          {isAdminOrSuper && (
            <button style={s.createBtn} onClick={() => setShowCreate(true)}>
              + Create User
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={s.content}>
        {isLoading ? (
          <div style={s.loading}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={s.empty}>
            <Users size={44} color="#cbd5e0" />
            <div style={s.emptyText}>No dashboard users found.</div>
          </div>
        ) : (
          <>
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr style={s.thead}>
                    <th style={s.th}>Full Name</th>
                    <th style={s.th}>Email Address</th>
                    <th style={s.th}>Role</th>
                    <th style={s.th}>Account Status</th>
                    <th style={s.th}>Date Created</th>
                    <th style={s.th}>Created By</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    return (
                      <tr key={u.id} style={s.tr}>
                        <td style={s.td}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <button
                              style={s.nameLink}
                              onClick={() => navigate(`/users/${u.id}`)}
                            >
                              {u.full_name}
                            </button>
                            {isSelf && (
                              <span style={s.youPill}>You</span>
                            )}
                          </div>
                        </td>
                        <td style={s.td}>{u.email}</td>
                        <td style={s.td}>{capitalize(u.role)}</td>
                        <td style={s.td}>
                          <StatusPill active={u.is_active ?? true} />
                        </td>
                        <td style={s.td}>{u.created_at ? formatDateTime(u.created_at) : "—"}</td>
                        <td style={s.td}>{u.created_by_name ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination bar */}
            <div style={s.paginationBar}>
              <span style={s.totalCount}>{total.toLocaleString()} user{total !== 1 ? "s" : ""}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--c-surface-low)",
    overflow: "hidden",
  },
  headerRow: {
    background: "var(--c-surface-lowest)",
    borderBottom: "1px solid #e0e0e0",
    padding: "16px 32px",
    position: "sticky",
    top: 0,
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: "var(--c-text-primary)",
    margin: 0,
  },
  topBar: {
    display: "flex",
    gap: 12,
    alignItems: "center",
  },
  searchWrap: {
    flex: 1,
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  searchInput: {
    width: "100%",
    padding: "9px 36px 9px 12px",
    border: "1.5px solid #e2e8f0",
    borderRadius: 8,
    fontSize: 14,
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
  createBtn: {
    padding: "9px 20px",
    background: BLUE,
    color: "var(--c-surface-lowest)",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  content: {
    flex: 1,
    padding: "24px 32px",
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
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { background: "#f7fafc" },
  th: {
    padding: "12px 16px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
  },
  tr: { borderBottom: "1px solid #f0f4f8" },
  td: { padding: "14px 16px", fontSize: 13, color: "var(--c-text-primary)", verticalAlign: "middle" },
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
  youPill: {
    fontSize: 10,
    fontWeight: 700,
    background: "#f0f4f8",
    color: "var(--c-text-muted)",
    padding: "2px 7px",
    borderRadius: 10,
    border: "1px solid #e2e8f0",
  },
  paginationBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 0",
  },
  totalCount: { fontSize: 13, color: "var(--c-text-muted)" },
  pageLabel: { fontSize: 13, color: "#4a5568", fontWeight: 500 },
  pageBtn: {
    padding: "7px 16px",
    background: "var(--c-surface-lowest)",
    border: "1px solid #e2e8f0",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 500,
    color: "#4a5568",
  },
};

// ── Modal styles ───────────────────────────────────────────────────────────────

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
    background: "var(--c-surface-lowest)",
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
    background: "var(--c-surface-lowest)",
    zIndex: 1,
  },
  title: { fontSize: 18, fontWeight: 700, color: "var(--c-text-primary)", margin: 0 },
  closeBtn: {
    background: "transparent",
    border: "none",
    fontSize: 18,
    color: "var(--c-text-muted)",
    cursor: "pointer",
    lineHeight: 1,
    padding: 4,
  },
  form: {
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  input: {
    padding: "10px 12px",
    borderRadius: 7,
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
    borderRadius: 7,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    width: "100%",
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
  toggleBtn: {
    flex: 1,
    padding: "9px 0",
    borderRadius: 7,
    fontSize: 14,
    cursor: "pointer",
    textAlign: "center",
    border: "1.5px solid #e2e8f0",
    background: "#f0f4f8",
    color: "var(--c-text-muted)",
  },
  submitError: {
    background: "#fff5f5",
    color: "#c53030",
    border: "1px solid #fc8181",
    borderRadius: 7,
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
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  submitBtn: {
    padding: "10px 24px",
    background: BLUE,
    color: "var(--c-surface-lowest)",
    border: "none",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
