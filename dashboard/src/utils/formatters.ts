export const formatDamageLevel = (raw: string | null): string => {
  if (!raw) return "—";
  const map: Record<string, string> = {
    completely_destroyed: "Completely Destroyed",
    partially_damaged: "Partially Damaged",
    minimal_or_no_damage: "Minimal or No Damage",
    complete: "Completely Destroyed",
    partial: "Partially Damaged",
    minimal: "Minimal or No Damage",
  };
  return map[raw.toLowerCase()] ?? raw;
};

export const formatDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const formatFlagLabel = (status: string | null): string => {
  if (!status) return "—";
  return status.charAt(0).toUpperCase() + status.slice(1);
};
