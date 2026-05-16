export function formatDamageLevel(raw: string): string {
  switch (raw?.toLowerCase()) {
    case "complete":
    case "completely_destroyed":
      return "Completely Destroyed";
    case "partial":
    case "partially_damaged":
      return "Partially Damaged";
    case "minimal":
    case "minimal_or_no_damage":
      return "Minimal or No Damage";
    default:
      return raw || "Unknown";
  }
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }) + ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function formatFlagLabel(flag: string): string {
  switch (flag) {
    case "grey":   return "Grey";
    case "green":  return "Green";
    case "orange": return "Orange";
    case "red":    return "Red";
    default:       return flag;
  }
}
