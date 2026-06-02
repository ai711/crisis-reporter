import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const GREEN = "#38A169";
const BG = "#F6F3F2";
const CARD_BG = "#FFFFFF";

// All Part A disaster IDs — must match SafetyTipsPage
const PART_A_IDS = [
  "earthquake", "flood", "tsunami", "hurricane",
  "wildfire", "explosion", "chemical", "conflict", "unrest",
] as const;

const TOTAL_MODULES = 11; // 9 Part A + B + C

// ── Helpers ────────────────────────────────────────────────────────────────────

function countCompletedModules(): number {
  let count = 0;
  for (const id of PART_A_IDS) {
    if (localStorage.getItem(`cr_safety_partA_${id}`) === "1") count++;
  }
  if (localStorage.getItem("cr_safety_partB") === "1") count++;
  if (localStorage.getItem("cr_safety_partC") === "1") count++;
  return count;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatDisplayId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
  if (clean.length < 4) return clean;
  return clean.slice(0, 3) + "-" + clean.slice(3);
}

// ── Material Symbol component ─────────────────────────────────────────────────

function MatIcon({
  name,
  size = 24,
  fill = false,
  color = "currentColor",
  style: extraStyle,
}: {
  name: string;
  size?: number;
  fill?: boolean;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: "'Material Symbols Outlined'",
        fontWeight: 400,
        fontStyle: "normal",
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "normal",
        textTransform: "none",
        display: "inline-block",
        whiteSpace: "nowrap",
        wordWrap: "normal",
        direction: "ltr",
        WebkitFontSmoothing: "antialiased",
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
        color,
        userSelect: "none",
        ...extraStyle,
      }}
    >
      {name}
    </span>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function BadgesPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { reporterId } = useAuthStore();

  const [hasContact, setHasContact] = useState(false);
  const [reporterName, setReporterName] = useState("Reporter");
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [earnedDate, setEarnedDate] = useState(() => formatDate(new Date()));
  const [loadingProfile, setLoadingProfile] = useState(!!reporterId);

  // Part A from localStorage for progress bar in locked state
  const completedModules = countCompletedModules();
  const completedPartA = PART_A_IDS.filter(
    (id) => localStorage.getItem(`cr_safety_partA_${id}`) === "1"
  ).length;
  const partBDone = localStorage.getItem("cr_safety_partB") === "1";

  // Inject Material Symbols font if not loaded
  useEffect(() => {
    const id = "material-symbols-stylesheet";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // Fetch reporter profile + safety progress
  useEffect(() => {
    if (!reporterId) { setLoadingProfile(false); return; }

    Promise.all([
      api.get<{ email: string | null; phone_number: string | null; first_name: string | null; last_name: string | null; created_at?: string }>(`/api/reporters/${reporterId}`),
      api.get<{ parts_completed: string[] }>(`/api/reporters/${reporterId}/safety-progress`),
    ])
      .then(([profileRes, progressRes]) => {
        const { email, phone_number, first_name, last_name } = profileRes.data;
        setHasContact(!!(email?.trim() || phone_number?.trim()));
        const name = [first_name, last_name].filter(Boolean).join(" ").trim();
        setReporterName(name || "Reporter");

        const { parts_completed } = progressRes.data;
        if (Array.isArray(parts_completed)) {
          // Fix: check each Part A disaster individually — backend stores "A_earthquake" etc.
          const partAComplete = PART_A_IDS.every((id) =>
            parts_completed.includes(`A_${id}`)
          );
          const allComplete =
            partAComplete &&
            parts_completed.includes("B") &&
            parts_completed.includes("C");
          setTrainingComplete(allComplete);

          // Estimate earned date from when Part C was completed (or today)
          const created = profileRes.data.created_at;
          if (created) {
            setEarnedDate(formatDate(new Date(created)));
          }
        }
      })
      .catch(() => {
        // Fallback: use localStorage-derived values
        const localComplete =
          PART_A_IDS.every((id) => localStorage.getItem(`cr_safety_partA_${id}`) === "1") &&
          localStorage.getItem("cr_safety_partB") === "1" &&
          localStorage.getItem("cr_safety_partC") === "1";
        setTrainingComplete(localComplete);
      })
      .finally(() => setLoadingProfile(false));
  }, [reporterId]);

  // ── Locked gate (anonymous OR logged-in without contact) ─────────────────────

  const isLocked = !reporterId || (reporterId && !hasContact);

  if (!loadingProfile && isLocked) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG, minHeight: "100vh" }}>
        {/* Header */}
        <header className="page-header" style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}>
          <button className="page-header-back" onClick={() => navigate("/")} aria-label="Back">
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="page-header-title">{t('badges.title')}</span>
          <div className="page-header-spacer" />
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 40px" }}>
          {/* Locked banner */}
          <div style={{
            background: "#FFDDB4",
            border: "1px solid rgba(108,69,0,0.15)",
            borderRadius: 16,
            padding: 20,
            display: "flex",
            gap: 14,
            alignItems: "flex-start",
            marginBottom: 28,
          }}>
            <MatIcon name="lock" size={24} color="#6C4500" fill style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700, color: "#291800" }}>
                Badges are locked
              </h2>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6C4500", lineHeight: 1.5 }}>
                Add your email or phone number to your profile to unlock badges and certifications
              </p>
              <button
                onClick={() => navigate("/profile")}
                style={{ background: "none", border: "none", color: BLUE, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
              >
                Go to Profile
                <MatIcon name="arrow_forward" size={14} color={BLUE} />
              </button>
            </div>
          </div>

          {/* Section label */}
          <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
            Available Badges
          </p>

          {/* Safety Training Badge — locked */}
          <div style={{
            background: CARD_BG,
            borderRadius: 16,
            marginBottom: 16,
            boxShadow: "0 4px 24px rgba(0,0,0,0.05)",
            overflow: "hidden",
          }}>
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
                {/* Greyscale icon + lock overlay */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F0EDED", display: "flex", alignItems: "center", justifyContent: "center", filter: "grayscale(1)", opacity: 0.6 }}>
                    <MatIcon name="verified_user" size={36} color="#9CA3AF" fill />
                  </div>
                  <div style={{ position: "absolute", bottom: -2, right: -2, background: CARD_BG, padding: 3, borderRadius: "50%", border: "1px solid #F0EDED" }}>
                    <MatIcon name="lock" size={14} color="#9CA3AF" fill />
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <h4 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 700, color: "#717782" }}>
                    Safety Training Badge
                  </h4>
                  <p style={{ margin: 0, fontSize: 13, color: "#9CA3AF", lineHeight: 1.5 }}>
                    Complete both Part A and Part B of Safety Tips to earn this badge
                  </p>
                </div>
              </div>

              {/* Progress */}
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "#717782" }}>
                  Part A: {completedPartA}/9 completed · Part B: {partBDone ? "Completed" : "Not started"}
                </span>
              </div>
              <div style={{ height: 8, background: "#F0EDED", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
                <div style={{ height: "100%", width: `${(completedModules / TOTAL_MODULES) * 100}%`, background: "#C1C7D2", borderRadius: 4 }} />
              </div>

              <button
                onClick={() => navigate("/safety-tips")}
                style={{
                  width: "100%",
                  height: 48,
                  borderRadius: 12,
                  background: "transparent",
                  color: BLUE,
                  border: `1.5px solid ${BLUE}`,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                Continue Safety Tips
                <MatIcon name="arrow_forward" size={16} color={BLUE} />
              </button>
            </div>
          </div>

          {/* Referral Badge — coming soon */}
          <div style={{
            background: CARD_BG,
            borderRadius: 16,
            marginBottom: 28,
            boxShadow: "0 4px 24px rgba(0,0,0,0.05)",
            opacity: 0.75,
          }}>
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F0EDED", display: "flex", alignItems: "center", justifyContent: "center", filter: "grayscale(1)", opacity: 0.6 }}>
                    <MatIcon name="group" size={36} color="#9CA3AF" />
                  </div>
                  <div style={{ position: "absolute", bottom: -2, right: -2, background: CARD_BG, padding: 3, borderRadius: "50%", border: "1px solid #F0EDED" }}>
                    <MatIcon name="lock" size={14} color="#9CA3AF" fill />
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <h4 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 700, color: "#717782" }}>
                    Referral Badge
                  </h4>
                  <p style={{ margin: "0 0 12px", fontSize: 13, color: "#9CA3AF", lineHeight: 1.5 }}>
                    Refer a friend who installs the app and completes safety training
                  </p>
                  <div style={{ background: "#F0EDED", borderRadius: 8, padding: "6px 12px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "#717782" }}>
                      Status: Coming soon — referral program launching later
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom note */}
          <p style={{ fontSize: 12, color: "#717782", textAlign: "center", lineHeight: 1.6, padding: "0 16px" }}>
            Badges are only visible inside the app at this stage. Shareable certificates coming soon.
          </p>
        </div>
      </div>
    );
  }

  // ── Logged-in full badges page ─────────────────────────────────────────────

  if (loadingProfile) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: BG }}>
        <div style={{ width: 32, height: 32, border: `3px solid ${BLUE}`, borderTop: "3px solid transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      </div>
    );
  }

  const displayId = formatDisplayId(reporterId || "");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG, minHeight: "100vh" }}>
      {/* Header */}
      <header className="page-header" style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}>
        <button className="page-header-back" onClick={() => navigate("/")} aria-label="Back">
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="page-header-title">{t('badges.title')}</span>
        <div className="page-header-spacer" />
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 40px" }}>
        {/* Profile summary row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 8, paddingBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#E4E2E1", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <MatIcon name="person" size={28} color={BLUE} fill />
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: "#1B1C1C" }}>{reporterName}</p>
              <p style={{ margin: 0, fontSize: 12, color: "#717782" }}>User ID: {displayId}</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", background: "rgba(0,109,55,0.1)", borderRadius: 99 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: GREEN }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#006D37" }}>Profile Active</span>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "#E4E2E1", marginBottom: 20 }} />

        {/* Section label */}
        <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 20 }}>
          Your Badges
        </p>

        {/* ── Safety Training Badge ── */}
        {trainingComplete ? (
          // EARNED state
          <div style={{ background: CARD_BG, borderRadius: 16, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.06)", overflow: "hidden" }}>
            {/* Blue top accent */}
            <div style={{ height: 8, background: BLUE }} />
            <div style={{ padding: 24, background: "rgba(4,104,177,0.03)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
                {/* Shield icon with sparkle */}
                <div style={{ position: "relative", width: 80, height: 80, borderRadius: 20, background: "#D2E4FF", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <MatIcon name="shield" size={48} color={BLUE} fill />
                  <MatIcon name="auto_awesome" size={18} color="#FFD700" fill style={{ position: "absolute", top: 2, right: 2 }} />
                </div>
                {/* EARNED chip */}
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", background: GREEN, borderRadius: 99 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", letterSpacing: 0.5 }}>EARNED ✓</span>
                </div>
              </div>

              <h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800, color: "#1B1C1C" }}>
                Safety Training Badge
              </h3>
              <p style={{ margin: "0 0 20px", fontSize: 14, color: "#414751", lineHeight: 1.6 }}>
                You completed both Part A and Part B of the Crisis Response Safety Protocol. This certification validates your field readiness.
              </p>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: 0.5 }}>Earned on</p>
                  <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#1B1C1C" }}>{earnedDate}</p>
                </div>
                <button
                  disabled
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "10px 18px",
                    borderRadius: 99,
                    border: "1px solid #C1C7D2",
                    background: "transparent",
                    color: "#717782",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: "not-allowed",
                  }}
                >
                  <MatIcon name="share" size={14} color="#717782" />
                  Share Badge
                </button>
              </div>
            </div>
          </div>
        ) : (
          // LOCKED / IN PROGRESS state
          <div style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#F0EDED", display: "flex", alignItems: "center", justifyContent: "center", filter: "grayscale(1)", opacity: 0.6 }}>
                  <MatIcon name="verified_user" size={36} color="#9CA3AF" fill />
                </div>
                <div style={{ position: "absolute", bottom: -2, right: -2, background: CARD_BG, padding: 3, borderRadius: "50%", border: "1px solid #F0EDED" }}>
                  <MatIcon name="lock" size={14} color="#9CA3AF" fill />
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <h4 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 700, color: "#717782" }}>Safety Training Badge</h4>
                <p style={{ margin: 0, fontSize: 13, color: "#9CA3AF", lineHeight: 1.5 }}>
                  Complete both Part A and Part B of Safety Tips to earn this badge
                </p>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#717782" }}>
                Part A: {completedPartA}/9 completed · Part B: {partBDone ? "Completed" : "Not started"}
              </span>
            </div>
            <div style={{ height: 8, background: "#F0EDED", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ height: "100%", width: `${(completedModules / TOTAL_MODULES) * 100}%`, background: "#C1C7D2", borderRadius: 4 }} />
            </div>
            <button
              onClick={() => navigate("/safety-tips")}
              style={{ width: "100%", height: 48, borderRadius: 12, background: "transparent", color: BLUE, border: `1.5px solid ${BLUE}`, fontWeight: 700, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              Continue Safety Tips
              <MatIcon name="arrow_forward" size={16} color={BLUE} />
            </button>
          </div>
        )}

        {/* ── Referral Badge ── */}
        <div style={{ background: "#F0EDED", borderRadius: 16, padding: 24, marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: "#E4E2E1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <MatIcon name="share" size={28} color="#717782" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1B1C1C" }}>Referral Badge</h4>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#C1C7D2", textTransform: "uppercase", letterSpacing: 0.5 }}>LOCKED</span>
              </div>
              <p style={{ margin: "0 0 16px", fontSize: 13, color: "#717782" }}>0 successful referrals</p>
              <button
                style={{
                  width: "100%",
                  height: 44,
                  borderRadius: 99,
                  background: "transparent",
                  color: BLUE,
                  border: `2px solid ${BLUE}`,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                Refer a Friend
              </button>
            </div>
          </div>
        </div>

        {/* Bottom info note */}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#EAE7E7", borderRadius: 12, padding: "12px 14px" }}>
          <MatIcon name="info" size={16} color="#717782" style={{ marginTop: 1, flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 11, color: "#717782", lineHeight: 1.6 }}>
            Badges are only visible inside the app and linked to your verified ID. Sharing capabilities are currently restricted for security compliance.
          </p>
        </div>
      </div>
    </div>
  );
}
