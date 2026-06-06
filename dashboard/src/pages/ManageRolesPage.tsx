import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { Role } from "../types";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "var(--c-primary-container)";
const BLUE_HEX = "#0468B1";

// ── Section definitions ────────────────────────────────────────────────────────

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

// ── Types ──────────────────────────────────────────────────────────────────────

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

const ROLE_DOT_COLORS = [
  "#0468B1", "#1565C0", "#6A1B9A", "#2E7D32",
  "#BF360C", "#00695C", "#4527A0", "#C62828",
];

function getRoleDotColor(name: string): string {
  // Fixed colors for default roles
  if (name === "superadmin") return "#0468B1";
  if (name === "guest") return "#718096";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return ROLE_DOT_COLORS[Math.abs(h) % ROLE_DOT_COLORS.length];
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

// ── PermCheck ──────────────────────────────────────────────────────────────────

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
        width: 20,
        height: 20,
        borderRadius: 5,
        border: `2px solid ${disabled ? "#cbd5e0" : checked ? BLUE_HEX : "#cbd5e0"}`,
        background: checked ? (disabled ? "#a0aec0" : BLUE_HEX) : "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.12s",
        flexShrink: 0,
      }}
    >
      {checked && (
        <span style={{ color: "#fff", fontSize: 12, lineHeight: 1, fontWeight: 700 }}>✓</span>
      )}
    </button>
  );
}

// ── Editable Permissions Table ─────────────────────────────────────────────────

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
      if (section.edit) return;
      next = { ...section, view: checked };
    }
    onChange({ ...permissions, [key]: next });
  }

  return (
    <div style={s.permTable}>
      <div style={s.permHeaderRow}>
        <div style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--c-text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Section</div>
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
            <div style={{ flex: 1, fontSize: 13, color: "var(--c-text-primary)", fontWeight: 500 }}>
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

// ── Read-only Permissions View ─────────────────────────────────────────────────

function ReadOnlyPermissions({ permissions }: { permissions: Permissions }) {
  return (
    <div style={s.permTable}>
      <div style={s.permHeaderRow}>
        <div style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--c-text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>Section</div>
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
            <div style={{ flex: 1, fontSize: 13, color: "var(--c-text-primary)", fontWeight: 500 }}>
              {sec.label}
            </div>
            <div style={s.permCheckCell}>
              <span style={{ fontSize: 16, color: perm.view ? "#2E7D32" : "#ccc" }}>
                {perm.view ? "✓" : "—"}
              </span>
            </div>
            <div style={s.permCheckCell}>
              <span style={{ fontSize: 16, color: perm.edit ? "#2E7D32" : "#ccc" }}>
                {perm.edit ? "✓" : "—"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ManageRolesPage() {
  const { user: currentUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "superadmin";
  const canView = isAdmin || (currentUser?.role_permissions?.["manage_roles"]?.view ?? false);
  const canEdit = isAdmin || (currentUser?.role_permissions?.["manage_roles"]?.edit ?? false);

  // ── Panel state ────────────────────────────────────────────────────────────
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // ── Search ─────────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [formName, setFormName] = useState("");
  const [formPermissions, setFormPermissions] = useState<Permissions>(emptyPermissions);
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Access guard ───────────────────────────────────────────────────────────
  if (!canView) {
    return (
      <div style={s.page}>
        <div style={s.accessDenied}>
          <ShieldOff size={52} color="var(--c-text-muted)" />
          <div style={s.accessTitle}>Access restricted</div>
          <div style={s.accessNote}>
            You don't have permission to view Manage Roles. Contact your administrator.
          </div>
        </div>
      </div>
    );
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: allRoles = [], isLoading } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: async () => {
      const res = await api.get<Role[]>("/api/roles");
      return res.data;
    },
  });

  const defaultRoles = allRoles.filter((r) => r.is_default);
  const customRoles = allRoles.filter((r) => !r.is_default);
  const filteredCustomRoles = searchTerm
    ? customRoles.filter((r) => r.name.toLowerCase().includes(searchTerm))
    : customRoles;

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; permissions: Permissions }) => {
      const res = await api.post<Role>("/api/roles", payload);
      return res.data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; name: string; permissions: Permissions }) => {
      const res = await api.patch<Role>(`/api/roles/${payload.id}`, {
        name: payload.name,
        permissions: payload.permissions,
      });
      return res.data;
    },
  });

  // ── Panel actions ──────────────────────────────────────────────────────────

  function openCreate() {
    setIsCreating(true);
    setSelectedRole(null);
    setFormName("");
    setFormPermissions(emptyPermissions());
    setNameError("");
    setSubmitError("");
  }

  function openRole(role: Role) {
    setIsCreating(false);
    setSelectedRole(role);
    setFormName(role.name);
    setFormPermissions(mergePermissions(role.permissions));
    setNameError("");
    setSubmitError("");
  }

  function closePanel() {
    setIsCreating(false);
    setSelectedRole(null);
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    const name = formName.trim();
    if (!name) { setNameError("Role name is required"); return; }
    setNameError("");
    setSubmitError("");
    setSubmitting(true);
    try {
      if (selectedRole && !selectedRole.is_default) {
        await updateMutation.mutateAsync({ id: selectedRole.id, name, permissions: formPermissions });
        setSuccessMsg(`Role "${name}" updated successfully.`);
        queryClient.invalidateQueries({ queryKey: ["roles"] });
        closePanel();
      } else if (isCreating) {
        await createMutation.mutateAsync({ name, permissions: formPermissions });
        setSuccessMsg(`Role "${name}" created successfully.`);
        queryClient.invalidateQueries({ queryKey: ["roles"] });
        closePanel();
      }
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

  // ── Right panel content ────────────────────────────────────────────────────

  const showRightPanel = selectedRole !== null || isCreating;
  const rightPanelIsReadOnly = selectedRole?.is_default || !canEdit;
  const rightPanelIsEditing = !rightPanelIsReadOnly;

  const rightPanelMergedPermissions = selectedRole
    ? mergePermissions(selectedRole.permissions)
    : formPermissions;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      {/* ── Left panel ── */}
      <div style={s.leftPanel}>
        {/* Left header */}
        <div style={s.leftHeader}>
          <div>
            <div style={s.leftTitle}>Roles</div>
            <div style={s.leftSubtitle}>
              {isLoading
                ? "Loading…"
                : `${defaultRoles.length} default · ${customRoles.length} custom`}
            </div>
          </div>
          {canEdit && (
            <button
              style={s.newRoleBtn}
              onClick={openCreate}
              title="Create new role"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16, lineHeight: 1 }}>
                add
              </span>
              New Role
            </button>
          )}
        </div>

        {/* Search */}
        <div style={s.leftSearch}>
          <span className="material-symbols-outlined" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#9aa5b4", pointerEvents: "none" }}>
            search
          </span>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search roles…"
            style={s.leftSearchInput}
          />
        </div>

        {/* Success banner */}
        {successMsg && (
          <div style={s.successBanner}>
            <span className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: "middle", marginRight: 6 }}>
              check_circle
            </span>
            {successMsg}
          </div>
        )}

        {/* Roles list */}
        <div style={s.rolesList}>
          {/* Default roles */}
          {defaultRoles.length > 0 && (
            <>
              <div style={s.rolesGroupLabel}>Default Roles</div>
              {defaultRoles.map((role) => {
                const isSelected = selectedRole?.id === role.id;
                return (
                  <button
                    key={role.id}
                    style={{
                      ...s.roleItem,
                      ...(isSelected ? s.roleItemSelected : {}),
                    }}
                    onClick={() => openRole(role)}
                  >
                    <div style={s.roleItemLeft}>
                      <div
                        style={{
                          ...s.roleDot,
                          background: getRoleDotColor(role.name),
                          opacity: 0.5,
                        }}
                      />
                      <div>
                        <div style={{ ...s.roleItemName, color: isSelected ? BLUE_HEX : "#4a5568" }}>
                          {capitalize(role.name)}
                        </div>
                        <div style={s.roleItemMeta}>
                          {role.user_count} user{role.user_count !== 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 15, color: "#9aa5b4", flexShrink: 0 }}
                      title="Default — cannot be modified"
                    >
                      lock
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {/* Custom roles */}
          <div style={s.rolesGroupLabel}>
            Custom Roles
            {filteredCustomRoles.length > 0 && (
              <span style={s.rolesGroupCount}>{filteredCustomRoles.length}</span>
            )}
          </div>

          {isLoading ? (
            <div style={s.rolesListEmpty}>Loading…</div>
          ) : filteredCustomRoles.length === 0 ? (
            <div style={s.rolesListEmpty}>
              {searchTerm ? "No roles match your search." : "No custom roles yet."}
            </div>
          ) : (
            filteredCustomRoles.map((role) => {
              const isSelected = selectedRole?.id === role.id;
              return (
                <button
                  key={role.id}
                  style={{
                    ...s.roleItem,
                    ...(isSelected ? s.roleItemSelected : {}),
                  }}
                  onClick={() => openRole(role)}
                >
                  <div style={s.roleItemLeft}>
                    <div style={{ ...s.roleDot, background: getRoleDotColor(role.name) }} />
                    <div>
                      <div style={{ ...s.roleItemName, color: isSelected ? BLUE_HEX : "var(--c-text-primary)" }}>
                        {capitalize(role.name)}
                      </div>
                      <div style={s.roleItemMeta}>
                        {role.user_count} user{role.user_count !== 1 ? "s" : ""}
                        {role.created_at && ` · ${formatDate(role.created_at)}`}
                      </div>
                    </div>
                  </div>
                  {canEdit && (
                    <span className="material-symbols-outlined" style={{ fontSize: 15, color: isSelected ? BLUE_HEX : "#c8d0db", flexShrink: 0 }}>
                      chevron_right
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={s.rightPanel}>
        {!showRightPanel ? (
          /* Empty state */
          <div style={s.rightEmpty}>
            <span className="material-symbols-outlined" style={{ fontSize: 52, color: "#dde3ea", marginBottom: 14 }}>
              shield_person
            </span>
            <div style={s.rightEmptyTitle}>Select a role</div>
            <div style={s.rightEmptyNote}>
              Choose a role from the list to view its permissions
              {canEdit ? ", or click New Role to create one." : "."}
            </div>
          </div>
        ) : (
          <div style={s.rightContent}>
            {/* Right panel header */}
            <div style={s.rightHeader}>
              <div style={s.rightHeaderLeft}>
                {isCreating ? (
                  <>
                    <div
                      style={{
                        ...s.roleDot,
                        background: formName ? getRoleDotColor(formName) : "#cbd5e0",
                        width: 14,
                        height: 14,
                      }}
                    />
                    <div>
                      <div style={s.rightTitle}>New Role</div>
                      <div style={s.rightSubtitle}>Define a name and set section permissions.</div>
                    </div>
                  </>
                ) : selectedRole ? (
                  <>
                    <div
                      style={{
                        ...s.roleDot,
                        background: getRoleDotColor(selectedRole.name),
                        width: 14,
                        height: 14,
                        opacity: selectedRole.is_default ? 0.5 : 1,
                      }}
                    />
                    <div>
                      <div style={s.rightTitle}>{capitalize(selectedRole.name)}</div>
                      <div style={s.rightSubtitle}>
                        {selectedRole.is_default
                          ? "Default role — permissions cannot be modified."
                          : `${selectedRole.user_count} user${selectedRole.user_count !== 1 ? "s" : ""} assigned · Created ${formatDate(selectedRole.created_at)}`}
                      </div>
                    </div>
                  </>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {selectedRole && !selectedRole.is_default && canEdit && (
                  <button
                    style={s.viewDetailBtn}
                    onClick={() => navigate(`/roles/${selectedRole.id}`)}
                  >
                    View Detail
                  </button>
                )}
                <button style={s.closeRightBtn} onClick={closePanel} title="Close panel">
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
            </div>

            <div style={s.rightBody}>
              {/* Role name field (editable only for custom/create) */}
              {rightPanelIsEditing && (
                <div style={s.fieldGroup}>
                  <label style={s.label}>
                    Role Name <span style={{ color: "#e53e3e" }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={formName}
                    maxLength={100}
                    placeholder="e.g. Field Analyst"
                    onChange={(e) => { setFormName(e.target.value); setNameError(""); }}
                    style={{ ...s.input, borderColor: nameError ? "#e53e3e" : "#e2e8f0" }}
                  />
                  {nameError && <span style={s.fieldErr}>{nameError}</span>}
                </div>
              )}

              {/* Permissions */}
              <div style={s.fieldGroup}>
                <label style={s.label}>Section Permissions</label>
                {rightPanelIsEditing && (
                  <p style={s.permHint}>
                    Checking <strong>Edit</strong> automatically grants View and locks it.
                    Uncheck Edit to allow independent View control.
                  </p>
                )}
                {rightPanelIsEditing ? (
                  <PermissionsTable permissions={formPermissions} onChange={setFormPermissions} />
                ) : (
                  <ReadOnlyPermissions permissions={rightPanelMergedPermissions} />
                )}
              </div>

              {submitError && (
                <div style={s.submitError}>{submitError}</div>
              )}

              {/* Footer — only for editable */}
              {rightPanelIsEditing && (
                <div style={s.formFooter}>
                  <button style={s.cancelBtn} type="button" onClick={closePanel}>
                    Cancel
                  </button>
                  <button
                    style={{ ...s.saveBtn, opacity: submitting ? 0.7 : 1 }}
                    type="button"
                    disabled={submitting}
                    onClick={handleSave}
                  >
                    {submitting
                      ? "Saving…"
                      : isCreating
                      ? "Create Role"
                      : "Save Changes"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    height: "100vh",
    background: "var(--c-surface-low)",
    overflow: "hidden",
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
  accessTitle: { fontSize: 22, fontWeight: 700, color: "var(--c-text-primary)" },
  accessNote: { fontSize: 14, color: "var(--c-text-muted)", maxWidth: 400, textAlign: "center" },

  // Left panel
  leftPanel: {
    width: 310,
    minWidth: 260,
    flexShrink: 0,
    background: "var(--c-surface-lowest)",
    borderRight: "1px solid #e0e8f0",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  leftHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 18px 12px",
    borderBottom: "1px solid #f0f4f8",
    flexShrink: 0,
  },
  leftTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  leftSubtitle: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    marginTop: 2,
  },
  newRoleBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "7px 12px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  leftSearch: {
    padding: "10px 12px",
    borderBottom: "1px solid #f0f4f8",
    position: "relative",
    flexShrink: 0,
  },
  leftSearchInput: {
    width: "100%",
    padding: "7px 10px 7px 30px",
    border: "1.5px solid #e2e8f0",
    borderRadius: 7,
    fontSize: 13,
    color: "var(--c-text-primary)",
    background: "#f8fafc",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  successBanner: {
    padding: "10px 14px",
    background: "#d4edda",
    color: "#155724",
    fontSize: 13,
    fontWeight: 500,
    borderBottom: "1px solid #c3e6cb",
    flexShrink: 0,
  },
  rolesList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 0",
  },
  rolesGroupLabel: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "10px 18px 4px",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  rolesGroupCount: {
    background: "#e8f0fe",
    color: BLUE_HEX,
    fontSize: 11,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: 10,
  },
  rolesListEmpty: {
    padding: "12px 18px",
    fontSize: 13,
    color: "var(--c-text-muted)",
    fontStyle: "italic",
  },
  roleItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "10px 16px",
    background: "transparent",
    border: "none",
    borderLeft: "3px solid transparent",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "background 0.12s, border-color 0.12s",
    gap: 8,
  },
  roleItemSelected: {
    background: "#EBF5FB",
    borderLeftColor: BLUE_HEX,
  },
  roleItemLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  roleDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  roleItemName: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--c-text-primary)",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  roleItemMeta: {
    fontSize: 11,
    color: "var(--c-text-muted)",
    marginTop: 2,
  },

  // Right panel
  rightPanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--c-surface-low)",
  },
  rightEmpty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 60,
    textAlign: "center" as const,
  },
  rightEmptyTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#b0bcc8",
    marginBottom: 8,
  },
  rightEmptyNote: {
    fontSize: 14,
    color: "#c8d0da",
    maxWidth: 320,
    lineHeight: 1.6,
  },
  rightContent: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    overflow: "hidden",
  },
  rightHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 28px",
    background: "var(--c-surface-lowest)",
    borderBottom: "1px solid #e0e8f0",
    flexShrink: 0,
    gap: 12,
  },
  rightHeaderLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flex: 1,
    minWidth: 0,
  },
  rightTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--c-text-primary)",
  },
  rightSubtitle: {
    fontSize: 12,
    color: "var(--c-text-muted)",
    marginTop: 3,
  },
  viewDetailBtn: {
    padding: "7px 14px",
    background: "transparent",
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    fontSize: 13,
    fontWeight: 600,
    color: BLUE_HEX,
    cursor: "pointer",
  },
  closeRightBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    borderRadius: 7,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "var(--c-text-muted)",
    flexShrink: 0,
  },
  rightBody: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 28px",
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },

  // Shared form elements
  fieldGroup: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: "#4a5568" },
  input: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    color: "var(--c-text-primary)",
    outline: "none",
    background: "#fff",
    width: "100%",
    maxWidth: 400,
    boxSizing: "border-box" as const,
  },
  fieldErr: { fontSize: 12, color: "#e53e3e", fontWeight: 500 },
  permHint: {
    fontSize: 13,
    color: "var(--c-text-muted)",
    margin: "0 0 8px",
    lineHeight: 1.5,
  },
  permTable: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    overflow: "hidden",
    background: "#fff",
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
  permColHead: {
    width: 70,
    fontSize: 11,
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "center" as const,
  },
  permCheckCell: {
    width: 70,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
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
  formFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 8,
    borderTop: "1px solid #f0f4f8",
    marginTop: 4,
  },
  cancelBtn: {
    padding: "10px 20px",
    background: "#fff",
    color: "#4a5568",
    border: "1px solid #cbd5e0",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  saveBtn: {
    padding: "10px 28px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
