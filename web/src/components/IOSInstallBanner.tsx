import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

const LS_DISMISSED = "cr_ios_install_dismissed";
const BLUE = "#0468B1";

// ── iOS / standalone detection ────────────────────────────────────────────────

function isIOSDevice(): boolean {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // L4: navigator.platform is deprecated; iPadOS 13+ reports "MacIntel" (or
  // more generically "Macintosh" in some UA strings) but has maxTouchPoints > 1.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function isInStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// ── iOS share arrow SVG ───────────────────────────────────────────────────────

function ShareArrowIcon() {
  return (
    <svg
      width={32}
      height={32}
      viewBox="0 0 24 24"
      fill="none"
      stroke={BLUE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

// ── Step row ──────────────────────────────────────────────────────────────────

function Step({ num, text, sub }: { num: string; text: string; sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: BLUE,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 700,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {num}
      </div>
      <div>
        <p style={{ fontSize: 14, fontWeight: 600, color: "#1A2B4A", margin: "0 0 3px", lineHeight: 1.3 }}>
          {text}
        </p>
        <p style={{ fontSize: 12, color: "#6B7280", margin: 0, lineHeight: 1.4 }}>
          {sub}
        </p>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IOSInstallBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only relevant on iOS and only when not already installed as a PWA.
    if (!isIOSDevice() || isInStandalone()) return;

    const show = () => setVisible(true);

    // On-demand trigger fired by the SideMenu "Install App" button.
    window.addEventListener("cr:show-ios-install", show);

    // Auto-show once after a short delay — suppressed if dismissed before.
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (!localStorage.getItem(LS_DISMISSED)) {
        timer = setTimeout(() => setVisible(true), 4000);
      }
    } catch {
      /* localStorage unavailable (e.g. Safari private mode) — skip auto-show */
    }

    return () => {
      window.removeEventListener("cr:show-ios-install", show);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(LS_DISMISSED, "true");
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  if (!visible) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={dismiss}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          zIndex: 8000,
        }}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("ios_install.title")}
        style={{
          position: "fixed",
          bottom: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: "100%",
          maxWidth: 480,
          background: "#fff",
          borderRadius: "20px 20px 0 0",
          padding: "12px 24px env(safe-area-inset-bottom, 32px)",
          paddingBottom: "max(32px, env(safe-area-inset-bottom, 32px))",
          zIndex: 8001,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          boxShadow: "0 -4px 32px rgba(0,0,0,0.15)",
        }}
      >
        {/* Handle */}
        <div
          style={{
            width: 40,
            height: 4,
            borderRadius: 2,
            background: "#D1D5DB",
            marginBottom: 24,
            flexShrink: 0,
          }}
        />

        {/* Share icon circle */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: "rgba(4,104,177,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 20,
            flexShrink: 0,
          }}
        >
          <ShareArrowIcon />
        </div>

        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#1A2B4A",
            margin: "0 0 10px",
            textAlign: "center",
            lineHeight: 1.3,
          }}
        >
          {t("ios_install.title")}
        </h2>

        <p
          style={{
            fontSize: 14,
            color: "#4A5568",
            lineHeight: 1.6,
            textAlign: "center",
            margin: "0 0 24px",
          }}
        >
          {t("ios_install.body")}
        </p>

        {/* Steps */}
        <div
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <Step
            num="1"
            text={t("ios_install.step1_text")}
            sub={t("ios_install.step1_sub")}
          />
          <Step
            num="2"
            text={t("ios_install.step2_text")}
            sub={t("ios_install.step2_sub")}
          />
          <Step
            num="3"
            text={t("ios_install.step3_text")}
            sub={t("ios_install.step3_sub")}
          />
        </div>

        {/* Dismiss button */}
        <button
          onClick={dismiss}
          style={{
            width: "100%",
            padding: "14px",
            background: "transparent",
            border: "1.5px solid #D1D5DB",
            borderRadius: 12,
            fontSize: 15,
            fontWeight: 600,
            color: "#4A5568",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("ios_install.dismiss")}
        </button>
      </div>
    </>,
    document.body
  );
}
