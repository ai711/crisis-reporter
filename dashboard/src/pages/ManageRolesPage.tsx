import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

// ── Section definitions ────────────────────────────────────────────────────────

type SectionKey =
  | "main_map"
  | "reports"
  | "location"
  | "review_queue"
  | "analytics"
  | "reporter_profiles"
  | "export"
  | "projects"
  | "manage_users"
  | "manage_roles"
  | "app_configuration";

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: "main_map",          label: "Main Map View" },
  { key: "reports",           label: "Reports Page" },
  { key: "location",          label: "Location Page" },
  { key: "review_queue",      label: "Review Queue" },
  { key: "analytics",         label: "Analytics and Statistics" },
  { key: "reporter_profiles", label: "Reporter Profiles" },
  { key: "export",            label: "Export" },
  { key: "projects",          label: "Projects" },
  { key: "manage_users",      label: "Manage Users" },
  { key: "manage_roles",      label: "Manage Roles" },
  { key: "app_configuration", label: "App Configuration" },
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface SectionPerm { view: boolean; edit: boolean; }
type Permissions = Record<SectionKey, SectionPerm>;

interface RoleOut {
  id: string;
  name: string;
  is_default: boolean;
  permissions: Permissions;
  created_at: string;
  user_count: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function emptyPermissions(): Permissions {
  return Object.fromEntries(
    SECTIONS.map((s) => [s.key, { view: false, edit: false }])
  ) as Permissions;
}

function mergePermissions(raw: Partial<Permissions>): Permissions {
  const base = emptyPermissions();
  for (const s of SECTIONS) {
    const p = raw[s.key];
    if (p) base[s.key] = { view: !!p.view, edit: !!p.edit };
  }
  return base;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

// ── Subcomponents ──────────────────────────────────────────────────────────────

function DefaultBadge() {
  return (
    <span style={s.defaultBadge}>Default</span>
  );
}

function LockIcon() {
  return <span style={{ fontSize: 13, color: "#718096" }}>🔒</span>;
}

// Styled checkbox cell
function PermCheck({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-checked={checked}
      role="checkbox"
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        border: `2px solid ${disabled ? "#cbd5e0" : checked ? BLUE : "#cbd5e0"}`,
        background: checked ? (disabled ? "#a0aec0" : BLUE) : "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.12s",
        flexShrink: 0,
      }}
    >
      {checked && (
        <span style={{ color: "#fff", fontSize: 13, lineHeight: 1, fontWeight: 700 }}>✓</span>
      )}
    </button>
  );
}

// ── Permissions table ──────────────────────────────────────────────────────────

function PermissionsTable({
  permissions,
  onChange,
}: {
  permissions: Permissions;
  onChange: (p: Permissions) => void;
}) {
  function handleChange(key: SectionKey, type: "view" | "edit", checked: boolean) {
    const section = permissions[key];
    let next: SectionPerm;
    if (type === "edit") {
      next = { view: checked ? true : section.view, edit: checked };
    } else {
      if (section.edit) return; // view is locked when edit is on
      next = { ...section, view: checked };
    }
    onChange({ ...permissions, [key]: next });
  }

  return (
    <div style={s.permTable}>
      {/* Table header */}
      <div style={s.permHeaderRow}>
        <div style={{ ...s.permCell, flex: 1 }}>Section</div>
        <div style={s.permColHead}>View</div>
        <div style={s.permColHead}>Edit</div>
      </div>

      {SECTIONS.map((sec, i) => {
        const perm = permissions[sec.key];
        return (
          <div
            key={sec.key}
            style={{
              ...s.permRow,
              background: i % 2 === 0 ? "#fff" : "#f9fafb",
            }}
          >
            <div style={{ ...s.permCell, flex: 1, color: "#2d3748", fontWeight: 500 }}>
              {sec.label}
            </div>
            <div style={s.permCheckCell}>
              <PermCheck
                checked={perm.view}
                disabled={perm.edit}
                onChange={(v) => handleChange(sec.key, "view", v)}
              />
            </div>
            <div style={s.permCheckCell}>
              <PermCheck
                checked={perm.edit}
                disabled={false}
                onChange={(v) => handleChange(sec.key, "edit", v)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

type PageView = "list" | "form";

export default function ManageRolesPage() {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";

  const [view, setView] = useState<PageView>("list");
  const [editingRole, setEditingRole] = useState<RoleOut | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formPermissions, setFormPermissions] = useState<Permissions>(emptyPermissions);
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successBanner, setSuccessBanner] = useState("");

  // Admin guard
  if (!isAdmin) {
    return (
      <div style={s.page}>
        <div style={s.accessDenied}>
          <div style={s.accessIcon}>🔒</div>
          <div style={s.accessTitle}>Admin access required</div>
          <div style={s.accessNote}>
            Manage Roles is restricted to Admin accounts. Contact your administrator if you need access.
          </div>
        </div>
      </div>
    );
  }

  // ── Data ──────────────────────────────────────────────────────────────────────

  const { data: roles = [], isLoading } = useQuery<RoleOut[]>({
    queryKey: ["roles"],
    queryFn: async () => {
      const res = await api.get<RoleOut[]>("/api/roles");
      return res.data;
    },
    enabled: view === "list",
  });

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; permissions: Permissions }) => {
      const res = await api.post<RoleOut>("/api/roles", payload);
      return res.data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; name: string; permissions: Permissions }) => {
      const res = await api.patch<RoleOut>(`/api/roles/${payload.id}`, {
        name: payload.name,
        permissions: payload.permissions,
      });
      return res.data;
    },
  });

  useEffect(() => {
    if (!successBanner) return;
    const t = setTimeout(() => setSuccessBanner(""), 4000);
    return () => clearTimeout(t);
  }, [successBanner]);

  // ── Navigation ────────────────────────────────────────────────────────────────

  function openCreate() {
    setEditingRole(null);
    setFormName("");
    setFormPermissions(emptyPermissions());
    setNameError("");
    setSubmitError("");
    setView("form");
  }

  function openEdit(role: RoleOut) {
    setEditingRole(role);
    setFormName(role.name);
    setFormPermissions(mergePermissions(role.permissions));
    setNameError("");
    setSubmitError("");
    setView("form");
  }

  function backToList() {
    setView("list");
    setEditingRole(null);
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    const name = formName.trim();
    if (!name) {
      setNameError("Role name is required");
      return;
    }
    setNameError("");
    setSubmitError("");
    setSubmitting(true);

    try {
      if (editingRole) {
        await updateMutation.mutateAsync({
          id: editingRole.id,
          name,
          permissions: formPermissions,
        });
        setSuccessBanner(`Role "${name}" updated successfully`);
      } else {
        await createMutation.mutateAsync({ name, permissions: formPermissions });
        setSuccessBanner(`Role "${name}" created successfully`);
      }
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      backToList();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "";
      if (msg.toLowerCase().includes("already exists") || msg.toLowerCase().includes("conflict")) {
        setNameError("A role with this name already exists");
      } else if (msg.toLowerCase().includes("reserved")) {
        setNameError(msg);
      } else {
        setSubmitError("Failed to save role. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render: form ──────────────────────────────────────────────────────────────

  if (view === "form") {
    return (
      <div style={s.page}>
        {/* Header */}
        <div style={s.headerRow}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button style={s.backBtn} onClick={backToList}>← Roles</button>
            <h1 style={s.pageTitle}>
              {editingRole ? `Edit Role — ${editingRole.name}` : "Create Role"}
            </h1>
          </div>
        </div>

        <div style={s.formContent}>
          <div style={s.formCard}>
            {/* Role name */}
            <div style={s.fieldGroup}>
              <label style={s.label}>
                Role Name <span style={s.req}>*</span>
              </label>
              <input
                type="text"
                value={formName}
                maxLength={100}
                placeholder="e.g. Field Analyst"
                onChange={(e) => { setFormName(e.target.value); setNameError(""); }}
                style={{
                  ...s.input,
                  borderColor: nameError ? "#e53e3e" : "#e2e8f0",
                  maxWidth: 400,
                }}
              />
              {nameError && <span style={s.fieldErr}>{nameError}</span>}
            </div>

            {/* Permissions table */}
            <div style={s.fieldGroup}>
              <label style={s.label}>Section Permissions</label>
              <p style={s.permHint}>
                Checking <strong>Edit</strong> automatically grants View and locks it.
                Uncheck Edit to allow independent View control.
              </p>
              <PermissionsTable
                permissions={formPermissions}
                onChange={setFormPermissions}
              />
            </div>

            {submitError && <div style={s.submitError}>{submitError}</div>}

            {/* Footer buttons */}
            <div style={s.formFooter}>
              <button style={s.cancelBtn} type="button" onClick={backToList}>
                Cancel
              </button>
              <button
                style={{ ...s.saveBtn, opacity: submitting ? 0.7 : 1 }}
                type="button"
                disabled={submitting}
                onClick={handleSave}
              >
                {submitting ? "Saving…" : editingRole ? "Save Changes" : "Create Role"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: list ──────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.headerRow}>
        <div>
          <h1 style={s.pageTitle}>Manage Roles</h1>
          <p style={s.pageSubtitle}>
            {isLoading ? "Loading…" : `2 default + ${roles.length} custom role${roles.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button style={s.addBtn} onClick={openCreate}>
          + Create Role
        </button>
      </div>

      {successBanner && <div style={s.successBanner}>{successBanner}</div>}

      <div style={s.content}>
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr style={s.thead}>
                <th style={s.th}>Role Name</th>
                <th style={s.th}>Users Assigned</th>
                <th style={s.th}>Created</th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Default protected roles — hardcoded, always at top */}
              <ProtectedRoleRow
                name="Superadmin"
                description="Full access to all sections. Cannot be modified."
              />
              <ProtectedRoleRow
                name="Guest"
                description="View-only access to assigned projects only. Cannot be modified."
              />

              {/* Custom roles */}
              {isLoading ? (
                <tr>
                  <td colSpan={4} style={{ ...s.td, textAlign: "center", color: "#718096", padding: 32 }}>
                    Loading roles…
                  </td>
                </tr>
              ) : roles.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ ...s.td, textAlign: "center", color: "#718096", padding: 32 }}>
                    No custom roles yet. Create one to get started.
                  </td>
                </tr>
              ) : (
                roles.map((role) => (
                  <tr key={role.id} style={s.tr}>
                    <td style={s.td}>
                      <button style={s.roleNameBtn} onClick={() => openEdit(role)}>
                        {role.name}
                      </button>
                    </td>
                    <td style={s.td}>
                      <span style={s.userCount}>{role.user_count}</span>
                    </td>
                    <td style={s.td}>
                      <span style={s.dateText}>{formatDate(role.created_at)}</span>
                    </td>
                    <td style={s.td}>
                      <button style={s.editBtn} onClick={() => openEdit(role)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Protected role row ─────────────────────────────────────────────────────────

function ProtectedRoleRow({ name, description }: { name: string; description: string }) {
  return (
    <tr style={s.tr}>
      <td style={s.td}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <LockIcon />
          <span style={{ fontWeight: 600, color: "#1A2B4A" }}>{name}</span>
          <DefaultBadge />
        </div>
        <div style={s.roleDesc}>{description}</div>
      </td>
      <td style={s.td}>
        <span style={s.userCount}>—</span>
      </td>
      <td style={s.td}>
        <span style={s.dateText}>Built-in</span>
      </td>
      <td style={s.td}>
        {/* No edit button for default roles */}
      </td>
    </tr>
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
  pageTitle: { fontSize: 20, fontWeight: 700, color: "#1A2B4A", margin: 0 },
  pageSubtitle: { fontSize: 13, color: "#718096", marginTop: 4, marginBottom: 0 },
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
  backBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
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
  // List content
  content: {
    flex: 1,
    padding: "28px 32px",
    overflowY: "auto",
  },
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
  roleNameBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  roleDesc: { fontSize: 12, color: "#718096", marginTop: 3 },
  userCount: { fontSize: 13, color: "#4a5568" },
  dateText: { fontSize: 13, color: "#718096" },
  editBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
  },
  defaultBadge: {
    display: "inline-block",
    padding: "2px 9px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    background: "#EBF5FB",
    color: BLUE,
    border: `1px solid #bee3f8`,
    letterSpacing: 0.2,
  },
  // Form
  formContent: {
    flex: 1,
    overflowY: "auto",
    padding: "28px 32px",
  },
  formCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "28px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    display: "flex",
    flexDirection: "column",
    gap: 28,
    maxWidth: 760,
  },
  fieldGroup: { display: "flex", flexDirection: "column", gap: 8 },
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
    width: "100%",
    boxSizing: "border-box" as const,
  },
  fieldErr: { fontSize: 12, color: "#e53e3e", fontWeight: 500 },
  permHint: { fontSize: 13, color: "#718096", margin: "0 0 8px" },
  // Permissions table
  permTable: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    overflow: "hidden",
  },
  permHeaderRow: {
    display: "flex",
    alignItems: "center",
    background: "#f7fafc",
    borderBottom: "1px solid #e2e8f0",
    padding: "10px 16px",
  },
  permRow: {
    display: "flex",
    alignItems: "center",
    padding: "10px 16px",
    borderBottom: "1px solid #f0f4f8",
  },
  permCell: { fontSize: 13, color: "#4a5568" },
  permColHead: {
    width: 80,
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    textAlign: "center" as const,
  },
  permCheckCell: {
    width: 80,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  // Form footer
  formFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
    borderTop: "1px solid #f0f4f8",
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
  saveBtn: {
    padding: "10px 28px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 7,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
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
};
