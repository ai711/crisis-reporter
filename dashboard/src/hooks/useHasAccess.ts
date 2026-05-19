import { useAuthStore } from "../stores/authStore";

/**
 * Returns true if the current user has access to a given section.
 * Superadmin and Admin always have full access.
 * Custom roles are checked against role_permissions from the auth store.
 */
export function useHasAccess(section: string, requireEdit = false): boolean {
  const { user } = useAuthStore();
  if (!user) return false;

  if (user.role === "superadmin" || user.role === "admin") return true;

  const sectionPerms = user.role_permissions?.[section];
  if (!sectionPerms) return false;

  if (requireEdit) return sectionPerms.edit === true;
  return sectionPerms.view === true;
}
