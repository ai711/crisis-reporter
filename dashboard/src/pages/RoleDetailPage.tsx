import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { usePageTitle } from "../hooks/usePageTitle";
import Header from "../components/Header";
import api from "../services/api";
import type { Role } from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "var(--c-primary-container)";

// ── Section definitions — must match ManageRolesPage keys ─────────────────────

type SectionKey =
  | "main_map_view"
  | "reports_page"
  | "location_page"
  | "review_queue"
  | "analytics_and_statistics"
  | "reporter_profiles"
  | "export"
  | "projects"
  | "manage_users"
  | "manage_roles"
  | "app_configuration";

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: "main_map_view",            label: "Main Map View" },
  { key: "reports_page",             label: "Reports Page" },
  { key: "location_page",            label: "Location Page" },
  { key: "review_queue",             label: "Review Queue" },
  { key: "analytics_and_statistics", label: "Analytics and Statistics" },
  { key: "reporter_profiles",        label: "Reporter Profiles" },
  { key: "export",                   label: "Export" },
  { key: "projects",                 label: "Projects" },
  { key: "manage_users",             label: "Manage Users" },
  { key: "manage_roles",             label: "Manage Roles" },
  { key: "app_configuration",        label: "App Configuration" },
];

interface SectionPerm { view: boolean; edit: boolean; }
type Permissions = Record<SectionKey, SectionPerm>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function emptyPermissions(): Permissions {
  return Object.fromEntries(
    SECTIONS.map((s) => [s.key, { view: false, edit: false }])
  ) as Permissions;
}

function mergePermissions(raw: Record<string, { view: boolean; edit: boolean }>): Permissions {
  const base = emptyPermissions();
  for (const s of SECTIONS) {
    const p = raw[s.key];
    if (p) base[s.key] = { view: !!p.view, edit: !!p.edit };
  }
  return base;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Read-only permissions table ────────────────────────────────────────────────

function ReadOnlyPermissionsTable({ permissions }: { permissions: Permissions }) {
  return (
    <div style={s.permTable}>
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
            style={{ ...s.permRow, background: i % 2 === 0 ? "#fff" : "#f9fafb" }}
          >
            <div style={{ ...s.permCell, flex: 1, color: "#2d3748", fontWeight: 500 }}>
              {sec.label}
            </div>
            <div style={s.permCheckCell}>
              <PermIndicator active={perm.view} />
            </div>
            <div style={s.permCheckCell}>
              <PermIndicator active={perm.edit} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PermIndicator({ active }: { active: boolean }) {
  return (
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        border: `2px solid ${active ? BLUE : "#e2e8f0"}`,
        background: active ? BLUE : "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {active && (
        <span style={{ color: "#fff", fontSize: 13, lineHeight: 1, fontWeight: 700 }}>✓</span>
      )}
    </div>
  );
}

// ── Edit permissions table ─────────────────────────────────────────────────────

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

function EditPermissionsTable({
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
      if (section.edit) return;
      next = { ...section, view: checked };
    }
    onChange({ ...permissions, [key]: next });
  }

  return (
    <div style={s.permTable}>
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
            style={{ ...s.permRow, background: i % 2 === 0 ? "#fff" : "#f9fafb" }}
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

// ── Main Component ─────────────────────────────────────────────────────────────

export default function RoleDetailPage() {
  usePageTitle("Manage Roles");
  const { roleId } = useParams<{ roleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "superadmin";

  const [editing, setEditing] = useState(false);
  const [formName, setFormName] = useState("");
  const [formPermissions, setFormPermissions] = useState<Permissions>(emptyPermissions);
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: role, isLoading, isError } = useQuery<Role>({
    queryKey: ["roles", roleId],
    queryFn: async () => {
      const res = await api.get<Role>(`/api/roles/${roleId}`);
      return res.data;
    },
    enabled: !!roleId,
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { name: string; permissions: Permissions }) => {
      const res = await api.patch<Role>(`/api/roles/${roleId}`, payload);
      return res.data;
    },
  });

  function startEdit() {
    if (!role) return;
    setFormName(role.name);
    setFormPermissions(mergePermissions(role.permissions));
    setNameError("");
    setSubmitError("");
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setNameError("");
    setSubmitError("");
  }

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
      await updateMutation.mutateAsync({ name, permissions: formPermissions });
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      queryClient.invalidateQueries({ queryKey: ["roles", roleId] });
      setEditing(false);
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

  // ── Loading / error states ────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div style={s.page}>
        <Header title="Manage Roles" />
        <div style={s.loading}>Loading…</div>
      </div>
    );
  }

  if (isError || !role) {
    return (
      <div style={s.page}>
        <Header title="Manage Roles" />
        <div style={s.loading}>Role not found.</div>
      </div>
    );
  }

  const mergedPermissions = mergePermissions(role.permissions);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      <Header title="Manage Roles" />
      {/* Header */}
      <div style={s.headerRow}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={s.backBtn} onClick={() => navigate("/roles")}>← Roles</button>
          <h1 style={s.pageTitle}>{editing ? `Edit Role — ${role.name}` : role.name}</h1>
          {role.is_default && !editing && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Lock size={14} color="#718096" />
              <span style={s.defaultBadge}>Default</span>
            </div>
          )}
        </div>
        {!editing && isAdmin && !role.is_default && (
          <button style={s.editBtn} onClick={startEdit}>
            Edit Role
          </button>
        )}
      </div>

      <div style={s.content}>
        <div style={s.card}>
          {/* Meta section */}
          {!editing && (
            <>
              {role.description && (
                <div style={s.section}>
                  <p style={s.description}>{role.description}</p>
                </div>
              )}

              <div style={s.metaGrid}>
                <div style={s.metaItem}>
                  <span style={s.metaLabel}>Users assigned</span>
                  <span style={s.metaValue}>{role.user_count}</span>
                </div>
                <div style={s.metaItem}>
                  <span style={s.metaLabel}>Created</span>
                  <span style={s.metaValue}>{formatDateTime(role.created_at)}</span>
                </div>
                <div style={s.metaItem}>
                  <span style={s.metaLabel}>Created by</span>
                  {role.created_by_user_id ? (
                    <button
                      style={s.creatorLink}
                      onClick={() => window.open(`/users/${role.created_by_user_id}`, "_blank")}
                    >
                      {role.created_by_name ?? "—"}
                    </button>
                  ) : (
                    <span style={s.metaValue}>{role.created_by_name ?? "System"}</span>
                  )}
                </div>
              </div>

              <div style={s.section}>
                <div style={s.sectionLabel}>Section Permissions</div>
                <ReadOnlyPermissionsTable permissions={mergedPermissions} />
              </div>
            </>
          )}

          {/* Edit form */}
          {editing && (
            <>
              <div style={s.fieldGroup}>
                <label style={s.label}>
                  Role Name <span style={s.req}>*</span>
                </label>
                <input
                  type="text"
                  value={formName}
                  maxLength={100}
                  onChange={(e) => { setFormName(e.target.value); setNameError(""); }}
                  style={{ ...s.input, borderColor: nameError ? "#e53e3e" : "#e2e8f0", maxWidth: 400 }}
                />
                {nameError && <span style={s.fieldErr}>{nameError}</span>}
              </div>

              <div style={s.fieldGroup}>
                <label style={s.label}>Section Permissions</label>
                <p style={s.permHint}>
                  Checking <strong>Edit</strong> automatically grants View and locks it.
                  Uncheck Edit to allow independent View control.
                </p>
                <EditPermissionsTable
                  permissions={formPermissions}
                  onChange={setFormPermissions}
                />
              </div>

              {submitError && <div style={s.submitError}>{submitError}</div>}

              <div style={s.formFooter}>
                <button style={s.cancelBtn} type="button" onClick={cancelEdit}>
                  Cancel
                </button>
                <button
                  style={{ ...s.saveBtn, opacity: submitting ? 0.7 : 1 }}
                  type="button"
                  disabled={submitting}
                  onClick={handleSave}
                >
                  {submitting ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
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
  loading: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    color: "#718096",
    padding: 60,
  },
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
  backBtn: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: "4px 0",
  },
  editBtn: {
    padding: "10px 20px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
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
  content: { flex: 1, padding: "28px 32px", overflowY: "auto" },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "28px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    maxWidth: 800,
    display: "flex",
    flexDirection: "column",
    gap: 28,
  },
  section: { display: "flex", flexDirection: "column", gap: 10 },
  sectionLabel: { fontSize: 13, fontWeight: 700, color: "#4a5568", textTransform: "uppercase", letterSpacing: 0.5 },
  description: { fontSize: 14, color: "#4a5568", margin: 0 },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 20,
    background: "#f7fafc",
    borderRadius: 8,
    padding: "16px 20px",
    border: "1px solid #e2e8f0",
  },
  metaItem: { display: "flex", flexDirection: "column", gap: 4 },
  metaLabel: { fontSize: 11, fontWeight: 700, color: "#718096", textTransform: "uppercase", letterSpacing: 0.5 },
  metaValue: { fontSize: 14, color: "#2d3748", fontWeight: 500 },
  creatorLink: {
    background: "transparent",
    border: "none",
    color: BLUE,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
    textAlign: "left" as const,
  },
  // Form styles
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
  submitError: {
    background: "#fff5f5",
    color: "#c53030",
    border: "1px solid #fc8181",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 500,
  },
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
  // Permissions table
  permTable: { border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" },
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
  permCheckCell: { width: 80, display: "flex", justifyContent: "center", alignItems: "center" },
};
