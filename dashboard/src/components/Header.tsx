import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { Crisis } from "../types";
import ProfilePanel from "./ProfilePanel";

interface HeaderProps {
  title: string;
  subtitle?: string;
}

// ── Bell SVG ──────────────────────────────────────────────────────────────────

function BellIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// ── Crises fetcher ────────────────────────────────────────────────────────────

async function fetchCrises(): Promise<Crisis[]> {
  const response = await api.get<Crisis[]>("/api/crises");
  return response.data;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Header({ title, subtitle }: HeaderProps) {
  const { user, activeCrisisId, setActiveCrisis, clearActiveCrisis } =
    useAuthStore();

  const [profileOpen, setProfileOpen] = useState(false);

  const { data: crises = [] } = useQuery<Crisis[]>({
    queryKey: ["crises-header"],
    queryFn: fetchCrises,
    staleTime: 1000 * 60 * 5,
  });

  const handleCrisisChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) {
      clearActiveCrisis();
    } else {
      const crisis = crises.find((c) => c.id === val);
      if (crisis) setActiveCrisis(crisis.id, crisis.name);
    }
  };

  const avatarLetter = user?.full_name?.charAt(0)?.toUpperCase() ?? "U";

  return (
    <>
      <div style={styles.header}>
        {/* Left: page title */}
        <div style={styles.left}>
          <h1 style={styles.title}>{title}</h1>
          {subtitle && <p style={styles.subtitle}>{subtitle}</p>}
        </div>

        {/* Centre-right: project / crisis dropdown */}
        <div style={styles.centre}>
          <select
            style={styles.crisisDropdown}
            value={activeCrisisId ?? ""}
            onChange={handleCrisisChange}
            aria-label="Select active project"
          >
            <option value="">All Projects</option>
            {crises.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Right: bell + full name + avatar */}
        <div style={styles.right}>
          {/* Notification bell */}
          <button style={styles.bellBtn} aria-label="Notifications">
            <BellIcon />
          </button>

          {/* User name + avatar — clicking opens profile panel */}
          <button
            style={styles.userBtn}
            onClick={() => setProfileOpen(true)}
            aria-label="Open profile settings"
          >
            <span style={styles.userName}>{user?.full_name ?? ""}</span>
            {user?.profile_photo_url ? (
              <img
                src={user.profile_photo_url}
                alt="Profile"
                style={styles.avatarImg}
              />
            ) : (
              <span style={styles.avatarInitial}>{avatarLetter}</span>
            )}
          </button>
        </div>
      </div>

      {/* Profile slide-out panel */}
      {profileOpen && (
        <ProfilePanel onClose={() => setProfileOpen(false)} />
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  header: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "0 32px",
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 50,
    gap: 16,
  },
  left: {
    flex: "0 0 auto",
    minWidth: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize: 12,
    color: "#666",
    margin: "2px 0 0",
  },
  centre: {
    flex: "1 1 auto",
    display: "flex",
    justifyContent: "flex-end",
    paddingRight: 8,
  },
  crisisDropdown: {
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    padding: "6px 32px 6px 12px",
    fontSize: 13,
    fontWeight: 500,
    color: "#1A2B4A",
    background: "#f4f8fc",
    cursor: "pointer",
    outline: "none",
    maxWidth: 260,
    appearance: "auto" as React.CSSProperties["appearance"],
  },
  right: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  bellBtn: {
    background: "none",
    border: "none",
    color: "#6b7280",
    cursor: "pointer",
    padding: "6px 8px",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  userBtn: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "none",
    border: "1.5px solid #e8eef4",
    borderRadius: 24,
    padding: "5px 12px 5px 10px",
    cursor: "pointer",
    color: "#1A2B4A",
    fontSize: 13,
    fontWeight: 600,
    transition: "background 0.15s",
  },
  userName: {
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as React.CSSProperties["whiteSpace"],
  },
  avatarImg: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    objectFit: "cover",
    border: "2px solid #0468B1",
    flexShrink: 0,
  },
  avatarInitial: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "#0468B1",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
};
