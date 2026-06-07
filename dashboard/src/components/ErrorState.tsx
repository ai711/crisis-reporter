import { AlertCircle } from "lucide-react";

interface ErrorStateProps {
  /** Optional override message. Defaults to a generic "check connection" prompt. */
  message?: string;
}

/**
 * ErrorState — standard error icon + message for failed data loads.
 * Use when useQuery returns `isError: true` or an async operation fails.
 */
export default function ErrorState({
  message = "Failed to load data. Check your connection and try again.",
}: ErrorStateProps) {
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
          background: "rgba(229,62,62,0.07)",
          border: "1.5px solid rgba(229,62,62,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <AlertCircle size={28} color="var(--c-error)" />
      </div>
      <p style={{ fontSize: 15, fontWeight: 600, color: "var(--c-text-primary)", margin: 0 }}>
        Something went wrong
      </p>
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
    </div>
  );
}
