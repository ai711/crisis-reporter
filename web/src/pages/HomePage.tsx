import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import { getQueueCount, syncQueue } from "../utils/offlineQueue";
import api from "../services/api";
import SideMenu from "../components/SideMenu";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReportsListResponse {
  reports: unknown[];
  total_count: number;
  next_cursor: string | null;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconSettings() {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function IconHamburger() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconHome({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconMapPin({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IconList({ active }: { active: boolean }) {
  const color = active ? "#0468B1" : "#9CA3AF";
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate();
  const { reporterId } = useAuthStore();

  const [queueCount, setQueueCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const refreshQueue = () => getQueueCount().then(setQueueCount);
    refreshQueue();

    const handleOnline = async () => {
      await syncQueue(API_URL);
      await refreshQueue();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const { data: reportsData } = useQuery({
    queryKey: ["homeReportCount", reporterId],
    queryFn: async () => {
      const res = await api.get<ReportsListResponse>("/api/reports", {
        params: { reporter_id: reporterId, limit: 1 },
      });
      return res.data;
    },
    enabled: !!reporterId,
  });

  const reportCount = reportsData?.total_count ?? null;

  return (
    <div style={s.page}>
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* ── Header ── */}
      <header style={s.header}>
        <button
          style={s.settingsBtn}
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
        >
          <IconHamburger />
        </button>
        <span style={s.headerTitle}>Crisis Reporter</span>
        <button
          style={s.settingsBtn}
          onClick={() => navigate("/settings")}
          aria-label="Settings"
        >
          <IconSettings />
        </button>
      </header>

      {/* ── Main content ── */}
      <main style={s.main}>
        {/* Welcome banner */}
        <div style={s.welcomeBanner}>
          <p style={s.welcomeText}>
            You are helping UNDP map crisis damage in real time. Thank you.
          </p>
        </div>

        {/* Primary action */}
        <button style={s.reportBtn} onClick={() => navigate("/report")}>
          Report an Incident
        </button>

        {/* Offline queue — hidden when empty */}
        {queueCount > 0 && (
          <div style={s.queueBanner}>
            <span style={s.queueDot} />
            <span>
              {queueCount} report{queueCount !== 1 ? "s" : ""} waiting to sync
              — connect to internet to send
            </span>
          </div>
        )}

        {/* My Reports preview */}
        <div style={s.reportsCard}>
          {!reporterId ? (
            <p style={s.reportsText}>
              Submit your first report to get started.
            </p>
          ) : reportCount === null ? (
            <p style={s.reportsText}>Loading your reports…</p>
          ) : (
            <div style={s.reportsRow}>
              <p style={s.reportsText}>
                You have submitted{" "}
                <strong style={s.reportsCount}>{reportCount}</strong>{" "}
                report{reportCount !== 1 ? "s" : ""}.
              </p>
              <button
                style={s.viewAllBtn}
                onClick={() => navigate("/my-reports")}
              >
                View all →
              </button>
            </div>
          )}
        </div>
      </main>

      {/* ── Footer navigation ── */}
      <nav style={s.footer}>
        <button style={s.navBtn} onClick={() => navigate("/")}>
          <IconHome active={true} />
          <span style={{ ...s.navLabel, color: "#0468B1", fontWeight: 600 }}>
            Home
          </span>
        </button>
        <button style={s.navBtn} onClick={() => navigate("/map")}>
          <IconMapPin active={false} />
          <span style={s.navLabel}>Map</span>
        </button>
        <button style={s.navBtn} onClick={() => navigate("/my-reports")}>
          <IconList active={false} />
          <span style={s.navLabel}>My Reports</span>
        </button>
      </nav>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    maxWidth: 480,
    margin: "0 auto",
  },
  header: {
    background: "#0468B1",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  settingsBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  main: {
    flex: 1,
    padding: "20px 20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  welcomeBanner: {
    background: "#E3F2FD",
    borderRadius: 10,
    padding: "14px 16px",
  },
  welcomeText: {
    fontSize: 14,
    color: "#1A2B4A",
    lineHeight: 1.55,
    margin: 0,
  },
  reportBtn: {
    width: "100%",
    padding: "20px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer",
    letterSpacing: 0.2,
    boxShadow: "0 4px 16px rgba(4,104,177,0.28)",
  },
  queueBanner: {
    background: "#F57C00",
    color: "#fff",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 500,
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    lineHeight: 1.45,
  },
  queueDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#fff",
    flexShrink: 0,
    marginTop: 3,
  },
  reportsCard: {
    background: "#F7FAFC",
    border: "1px solid #E2E8F0",
    borderRadius: 10,
    padding: "16px",
  },
  reportsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  reportsText: {
    fontSize: 14,
    color: "#2D3748",
    margin: 0,
    lineHeight: 1.5,
  },
  reportsCount: {
    color: "#0468B1",
    fontWeight: 700,
  },
  viewAllBtn: {
    background: "transparent",
    border: "none",
    color: "#0468B1",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  footer: {
    background: "#fff",
    borderTop: "1px solid #E2E8F0",
    display: "flex",
    justifyContent: "space-around",
    padding: "8px 0 12px",
    flexShrink: 0,
  },
  navBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "6px 20px",
    flex: 1,
  },
  navLabel: {
    fontSize: 11,
    color: "#9CA3AF",
    fontWeight: 500,
  },
};
