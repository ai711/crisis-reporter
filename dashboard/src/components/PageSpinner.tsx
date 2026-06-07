/**
 * PageSpinner — centered loading indicator, shared across all dashboard pages.
 * Uses the `cr-spin` keyframe defined in global.css.
 */
export default function PageSpinner({ label }: { label?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "64px 0",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          border: "3px solid var(--c-surface-high)",
          borderTop: "3px solid var(--c-primary-container)",
          borderRadius: "50%",
          animation: "cr-spin 0.8s linear infinite",
          flexShrink: 0,
        }}
      />
      {label && (
        <p style={{ fontSize: "var(--text-sm)", color: "var(--c-text-muted)", margin: 0 }}>
          {label}
        </p>
      )}
    </div>
  );
}
