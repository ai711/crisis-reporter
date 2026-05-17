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

export const formatTimeInQueue = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
};

export const formatCountdown = (seconds: number): string => {
  if (seconds <= 0) return 'Expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h remaining`;
  return `${h}h ${m}m remaining`;
};
