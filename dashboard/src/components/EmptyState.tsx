import { type ReactNode } from "react";

interface EmptyStateProps {
  /** Lucide icon element or any React node rendered inside the icon circle */
  icon: ReactNode;
  /** Bold headline — keep short, e.g. "No reports found" */
  title: string;
  /** Optional secondary line with context or next-step hint */
  message?: string;
  /** Optional CTA rendered below the message */
  action?: ReactNode;
}

/**
 * EmptyState — standard icon + title + message pattern for empty list/table pages.
 * Use whenever a data list or table has zero rows.
 */
export default function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "64px 0",
        gap: 12,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: "var(--c-surface-low)",
          border: "1.5px solid var(--c-surface-high)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <p style={{ fontSize: 15, fontWeight: 600, color: "var(--c-text-primary)", margin: 0 }}>
        {title}
      </p>
      {message && (
        <p
          style={{
            fontSize: 13,
            color: "var(--c-text-muted)",
            margin: 0,
            textAlign: "center",
            maxWidth: 420,
            lineHeight: 1.6,
          }}
        >
          {message}
        </p>
      )}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}
