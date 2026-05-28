import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const LS_ACCEPTED = "cr_push_accepted";
const LS_DECLINED = "cr_push_declined";
const LS_TC = "cr_tc_accepted";

// ── Helpers ───────────────────────────────────────────────────────────────────

function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function shouldShow(): boolean {
  if (!("Notification" in window)) return false;
  try {
    if (localStorage.getItem(LS_ACCEPTED)) return false;
    if (localStorage.getItem(LS_DECLINED)) return false;
    if (!localStorage.getItem(LS_TC)) return false;
  } catch {
    return false;
  }
  return true;
}

// ── Bell icon ─────────────────────────────────────────────────────────────────

function BellIcon() {
  return (
    <svg
      width={52}
      height={52}
      viewBox="0 0 24 24"
      fill="none"
      stroke={BLUE}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message }: { message: string }) {
  return (
    <div style={ts.toast}>
      <span>{message}</span>
    </div>
  );
}

const ts: Record<string, React.CSSProperties> = {
  toast: {
    position: "fixed",
    bottom: 88,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1A2B4A",
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    padding: "10px 20px",
    borderRadius: 24,
    zIndex: 9000,
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

interface PushNotificationSheetProps {
  reporterId: string | null;
}

export default function PushNotificationSheet({
  reporterId,
}: PushNotificationSheetProps) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldShow()) return;
    const t = window.setTimeout(() => setVisible(true), 3000);
    return () => window.clearTimeout(t);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const decline = useCallback(() => {
    try { localStorage.setItem(LS_DECLINED, "true"); } catch { /* ignore */ }
    setVisible(false);
  }, []);

  const accept = useCallback(async () => {
    if (busy) return;
    setBusy(true);

    // Non-secure contexts (not HTTPS and not localhost) cannot use PushManager.
    // Mark accepted so the prompt doesn't re-appear; subscription will be
    // attempted on the next load from an HTTPS origin.
    const { protocol, hostname } = window.location;
    const isSecure =
      protocol === "https:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".localhost");

    if (!isSecure) {
      localStorage.setItem(LS_ACCEPTED, "true");
      setVisible(false);
      setBusy(false);
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        localStorage.setItem(LS_DECLINED, "true");
        setVisible(false);
        return;
      }

      // navigator.serviceWorker.ready never rejects — race it against a
      // timeout so a missing service worker doesn't freeze the modal.
      const swTimeout = new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error("sw-timeout")), 8000)
      );
      const reg = await Promise.race([navigator.serviceWorker.ready, swTimeout]);

      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vapidKey) as Uint8Array<ArrayBuffer>,
      });

      const json = sub.toJSON();
      const endpoint = json.endpoint ?? "";
      const p256dh = (json.keys as Record<string, string> | undefined)?.p256dh ?? "";
      const authKey = (json.keys as Record<string, string> | undefined)?.auth ?? "";

      if (reporterId) {
        await api.post("/api/push-tokens", {
          reporter_id: reporterId,
          endpoint,
          p256dh,
          auth_key: authKey,
        });
      }

      localStorage.setItem(LS_ACCEPTED, "true");
      setVisible(false);
      showToast("Notifications enabled");
    } catch {
      // Permission denied, subscription failed, SW timeout, or API error —
      // close silently without showing the reporter any error message.
      try { localStorage.setItem(LS_DECLINED, "true"); } catch { /* ignore */ }
      setVisible(false);
    } finally {
      setBusy(false);
    }
  }, [busy, reporterId, showToast]);

  if (!visible && !toast) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      {visible && <div style={s.backdrop} onClick={decline} />}

      {/* Sheet */}
      {visible && (
        <div style={s.sheet} role="dialog" aria-modal="true">
          <div style={s.handle} />

          <div style={s.bellWrap}>
            <BellIcon />
          </div>

          <h2 style={s.title}>Stay informed during crises</h2>

          <p style={s.body}>
            Allow Crisis Reporter to notify you when a new crisis is activated
            in your area, when your reports are reviewed, and when important
            updates are available.
          </p>

          <button
            style={{ ...s.allowBtn, opacity: busy ? 0.7 : 1 }}
            onClick={accept}
            disabled={busy}
          >
            {busy ? "Enabling…" : "Allow Notifications"}
          </button>

          <button style={s.declineBtn} onClick={decline} disabled={busy}>
            Not now
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast message={toast} />}
    </>,
    document.body
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 8000,
  },
  sheet: {
    position: "fixed",
    bottom: 0,
    left: "50%",
    transform: "translateX(-50%)",
    width: "100%",
    maxWidth: 480,
    background: "#fff",
    borderRadius: "20px 20px 0 0",
    padding: "12px 24px 40px",
    zIndex: 8001,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    boxShadow: "0 -4px 32px rgba(0,0,0,0.15)",
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    background: "#D1D5DB",
    marginBottom: 24,
    flexShrink: 0,
  },
  bellWrap: {
    width: 80,
    height: 80,
    borderRadius: "50%",
    background: "#E3F2FD",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    flexShrink: 0,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: "0 0 12px",
    textAlign: "center",
    lineHeight: 1.3,
  },
  body: {
    fontSize: 14,
    color: "#4A5568",
    lineHeight: 1.6,
    textAlign: "center",
    margin: "0 0 28px",
  },
  allowBtn: {
    width: "100%",
    padding: "16px",
    background: BLUE,
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    marginBottom: 12,
    transition: "opacity 0.15s",
  },
  declineBtn: {
    background: "transparent",
    border: "none",
    color: "#9CA3AF",
    fontSize: 15,
    fontWeight: 500,
    cursor: "pointer",
    padding: "8px 0",
  },
};
