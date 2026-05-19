import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { Crisis } from "../types";
import ProfilePanel from "./ProfilePanel";

interface HeaderProps {
  title: string;
  subtitle?: string;
}

interface Notification {
  id: number;
  type_key: string;
  message: string;
  triggered_at: string | null;
}

interface NotificationsResponse {
  notifications: Notification[];
  unread_count: number;
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

// ── Notification dropdown ─────────────────────────────────────────────────────

function NotificationDropdown({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onClose,
}: {
  notifications: Notification[];
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  function timeAgo(iso: string | null): string {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        width: 380,
        maxHeight: 480,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1A2B4A" }}>Notifications</div>
        {notifications.length > 0 && (
          <button
            onClick={onMarkAllRead}
            style={{ fontSize: 12, color: "#0468B1", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            Mark all as read
          </button>
        )}
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {notifications.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "#a0aec0" }}>
            No unread notifications
          </div>
        ) : (
          notifications.map((n) => (
            <div key={n.id} style={{ padding: "12px 16px", borderBottom: "1px solid #f0f4f8", display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#2d3748", lineHeight: 1.5 }}>{n.message}</div>
                <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 4 }}>{timeAgo(n.triggered_at)}</div>
              </div>
              <button
                onClick={() => onMarkRead(n.id)}
                style={{ fontSize: 11, color: "#0468B1", background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0, alignSelf: "flex-start" }}
              >
                Dismiss
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Header({ title, subtitle }: HeaderProps) {
  const { user, activeCrisisId, setActiveCrisis, clearActiveCrisis } =
    useAuthStore();

  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: crises = [] } = useQuery<Crisis[]>({
    queryKey: ["crises-header"],
    queryFn: fetchCrises,
    staleTime: 1000 * 60 * 5,
  });

  const { data: notifData } = useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const res = await api.get<NotificationsResponse>("/api/notifications");
      return res.data;
    },
    refetchInterval: 30_000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: number) => api.post(`/api/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.post("/api/notifications/mark-all-read"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      setNotifOpen(false);
    },
  });

  const unreadCount = notifData?.unread_count ?? 0;
  const notifications = notifData?.notifications ?? [];

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
          <div style={{ position: "relative" }}>
            <button
              style={styles.bellBtn}
              aria-label="Notifications"
              onClick={() => setNotifOpen((o) => !o)}
            >
              <BellIcon />
              {unreadCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: "#e53e3e",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <NotificationDropdown
                notifications={notifications}
                onMarkRead={(id) => { markReadMutation.mutate(id); }}
                onMarkAllRead={() => markAllReadMutation.mutate()}
                onClose={() => setNotifOpen(false)}
              />
            )}
          </div>

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
    position: "relative",
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
