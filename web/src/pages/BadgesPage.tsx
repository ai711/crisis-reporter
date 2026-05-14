import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const GOLD = "#F6AD55";
const GREY_BORDER = "#E2E8F0";

const DISASTER_IDS = [
  "earthquake",
  "flood",
  "tsunami",
  "hurricane",
  "wildfire",
  "explosion",
  "chemical",
  "conflict",
  "unrest",
] as const;

const TOTAL_MODULES = 11; // 9 Part A + Part B + Part C

// ── Helpers ────────────────────────────────────────────────────────────────────

function countCompletedModules(): number {
  let count = 0;
  for (const id of DISASTER_IDS) {
    if (localStorage.getItem(`cr_safety_partA_${id}`) === "1") count++;
  }
  if (localStorage.getItem("cr_safety_partB") === "1") count++;
  if (localStorage.getItem("cr_safety_partC") === "1") count++;
  return count;
}

function isSafetyTrainingComplete(): boolean {
  return countCompletedModules() === TOTAL_MODULES;
}

function formatTodayDate(): string {
  return new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function IconBack() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// ── Badge Card ─────────────────────────────────────────────────────────────────

type BadgeStatus = "earned" | "claim" | "locked" | "coming-soon";

interface BadgeCardProps {
  icon: string;
  name: string;
  description: string;
  status: BadgeStatus;
  completedModules?: number;
  earnedDate?: string;
}

function BadgeCard({
  icon,
  name,
  description,
  status,
  completedModules,
  earnedDate,
}: BadgeCardProps) {
  const earned = status === "earned";
  const locked = status === "locked" || status === "coming-soon";

  const borderColor = earned ? GOLD : GREY_BORDER;

  const labelMap: Record<BadgeStatus, { text: string; color: string; bg: string }> = {
    earned: { text: `Earned ✓`, color: "#276749", bg: "#f0fff4" },
    claim: { text: "Add email or phone to claim", color: "#92400e", bg: "#fffbeb" },
    locked: { text: "Locked", color: "#718096", bg: "#f7fafc" },
    "coming-soon": { text: "Coming Soon", color: "#718096", bg: "#f7fafc" },
  };

  const label = labelMap[status];

  return (
    <div
      style={{
        background: "#fff",
        border: `1.5px solid ${borderColor}`,
        borderRadius: 16,
        padding: "24px 20px",
        boxShadow: earned
          ? "0 2px 12px rgba(246,173,85,0.18)"
          : "0 1px 4px rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: locked ? "#e2e8f0" : earned ? "#fef3c7" : "#ebf8ff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 40,
          marginBottom: 16,
          filter: locked ? "grayscale(1)" : "none",
        }}
      >
        {icon}
      </div>

      <h3
        style={{
          margin: "0 0 6px",
          fontSize: 16,
          fontWeight: 700,
          color: locked ? "#a0aec0" : "#1a202c",
          filter: locked ? "grayscale(1)" : "none",
        }}
      >
        {name}
      </h3>

      <p
        style={{
          margin: "0 0 16px",
          fontSize: 13,
          color: locked ? "#a0aec0" : "#718096",
          lineHeight: 1.5,
          maxWidth: 280,
        }}
      >
        {description}
      </p>

      <div
        style={{
          display: "inline-block",
          background: label.bg,
          color: label.color,
          fontSize: 12,
          fontWeight: 700,
          borderRadius: 20,
          padding: "4px 14px",
          marginBottom: status === "earned" || status === "locked" ? 8 : 0,
        }}
      >
        {label.text}
      </div>

      {status === "earned" && earnedDate && (
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#718096" }}>
          {earnedDate}
        </p>
      )}

      {status === "locked" && completedModules !== undefined && (
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "#a0aec0" }}>
          {completedModules} of {TOTAL_MODULES} modules complete
        </p>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function BadgesPage() {
  const navigate = useNavigate();
  const { reporterId } = useAuthStore();
  const [hasContact, setHasContact] = useState(false);

  // D1: Start with localStorage value as fallback; backend result overwrites it.
  const [trainingComplete, setTrainingComplete] = useState(() => isSafetyTrainingComplete());

  // Fetch contact details to determine badge claim status
  useEffect(() => {
    if (!reporterId) return;
    api
      .get<{ email: string | null; phone_number: string | null }>(
        `/api/reporters/${reporterId}`
      )
      .then((res) => {
        const { email, phone_number } = res.data;
        setHasContact(!!(email?.trim() || phone_number?.trim()));
      })
      .catch(() => {
        // Cannot reach API — treat as no contact
      });
  }, [reporterId]);

  // D1: Verify safety training completion against the backend for logged-in reporters.
  useEffect(() => {
    if (!reporterId) return;
    api
      .get<{ parts_completed: string[] }>(`/api/reporters/${reporterId}/safety-progress`)
      .then((res) => {
        const { parts_completed } = res.data;
        setTrainingComplete(
          Array.isArray(parts_completed) &&
          parts_completed.includes("A") &&
          parts_completed.includes("B") &&
          parts_completed.includes("C")
        );
      })
      .catch(() => {
        // Fallback: keep localStorage-derived initial state
      });
  }, [reporterId]);

  const completedModules = countCompletedModules();

  let safetyStatus: BadgeStatus;
  if (trainingComplete && hasContact) {
    safetyStatus = "earned";
  } else if (trainingComplete && !hasContact) {
    safetyStatus = "claim";
  } else {
    safetyStatus = "locked";
  }

  // ── D6: Anonymous reporter gate — shown after all hooks ───────────────────

  if (!reporterId) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
          background: "#f7fafc",
          maxWidth: 480,
          margin: "0 auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            background: BLUE,
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => navigate("/")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center" }}
            aria-label="Back"
          >
            <IconBack />
          </button>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>
            Badges &amp; Certifications
          </span>
        </div>

        {/* Login prompt */}
        <div style={{ textAlign: "center", padding: "40px 24px 24px" }}>
          <p style={{ fontSize: "1.1rem", fontWeight: 700, color: "#1A2B4A", margin: "0 0 8px" }}>
            Badges are available to reporters with a verified account.
          </p>
          <p style={{ color: "#718096", fontSize: "0.875rem", margin: "0 0 24px", lineHeight: 1.5 }}>
            Log in or create a free account to earn and view your badges.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 32 }}>
            <button
              onClick={() => navigate("/login")}
              style={{ background: BLUE, color: "#fff", border: "none", borderRadius: 8, padding: "12px 24px", fontWeight: 700, cursor: "pointer", fontSize: 15 }}
            >
              Log In
            </button>
            <button
              onClick={() => navigate("/login?mode=register")}
              style={{ background: "transparent", color: BLUE, border: `1px solid ${BLUE}`, borderRadius: 8, padding: "12px 24px", fontWeight: 600, cursor: "pointer", fontSize: 15 }}
            >
              Create Account
            </button>
          </div>
        </div>

        {/* Locked badge previews in greyscale */}
        <div style={{ opacity: 0.4, pointerEvents: "none", padding: "0 16px 32px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
            <BadgeCard
              icon="🛡️"
              name="Safety Training Completion"
              description="Complete all safety training modules in Crisis Reporter."
              status="locked"
            />
            <BadgeCard
              icon="🤝"
              name="Community Referral"
              description="Refer a friend who installs Crisis Reporter and completes safety training."
              status="coming-soon"
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Full badge page for logged-in reporters ────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: "#f7fafc",
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: BLUE,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
          }}
          aria-label="Back"
        >
          <IconBack />
        </button>
        <span
          style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}
        >
          Badges &amp; Certifications
        </span>
      </div>

      <p
        style={{
          margin: "14px 20px 4px",
          fontSize: 12,
          color: "#718096",
          lineHeight: 1.5,
        }}
      >
        Badges are awarded to reporters with a verified profile. Complete your
        profile to unlock badges.
      </p>

      {/* D7: Responsive multi-column grid */}
      <div style={{ padding: "12px 16px 32px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 16,
            marginTop: 4,
          }}
        >
          <BadgeCard
            icon="🛡️"
            name="Safety Training Completion"
            description="Awarded for completing all safety training modules in Crisis Reporter."
            status={safetyStatus}
            completedModules={safetyStatus === "locked" ? completedModules : undefined}
            earnedDate={safetyStatus === "earned" ? formatTodayDate() : undefined}
          />

          <BadgeCard
            icon="🤝"
            name="Community Referral"
            description="Refer a friend who installs Crisis Reporter and completes safety training."
            status="coming-soon"
          />
        </div>
      </div>
    </div>
  );
}
