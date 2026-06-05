import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
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

// ── Notification type metadata ────────────────────────────────────────────────

const NOTIF_META: Record<string, { title: string; link: string; icon: React.ReactNode }> = {
  review_queue_threshold: {
    title: "Review Queue Alert",
    link: "/review-queue",
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    ),
  },
  new_red_flagged_report: {
    title: "New Red-Flagged Report",
    link: "/review-queue",
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
      </svg>
    ),
  },
  reporter_auto_paused: {
    title: "Reporter Auto-Paused",
    link: "/reporters",
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>
      </svg>
    ),
  },
  high_volume_processing_delay: {
    title: "Processing Delay",
    link: "/map",
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
      </svg>
    ),
  },
};

function getNotifMeta(type_key: string) {
  return NOTIF_META[type_key] ?? {
    title: type_key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    link: "/map",
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
      </svg>
    ),
  };
}

// ── Bell SVG ──────────────────────────────────────────────────────────────────

function BellIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  onNavigate,
}: {
  notifications: Notification[];
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
  onNavigate: (link: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  function timeAgo(iso: string | null): string {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    return `${days}d ago`;
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Notifications"
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        width: 380,
        maxHeight: 500,
        background: "#ffffff",
        borderRadius: 8,
        boxShadow: "0 4px 20px rgba(8,27,57,0.06), 0 12px 40px rgba(8,27,57,0.10)",
        outline: "1px solid rgba(193,199,210,0.2)",
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* Header */}
      <div style={{ padding: "14px 16px", background: "#f2f4f7", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#191c1e", letterSpacing: "0.04em" }}>NOTIFICATIONS</span>
        {notifications.length > 0 && (
          <button
            onClick={onMarkAllRead}
            style={{ fontSize: 11, fontWeight: 600, color: "#00508a", background: "none", border: "none", cursor: "pointer", padding: 0, letterSpacing: "0.02em" }}
          >
            Mark all as read
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {notifications.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 13, color: "#717782" }}>
            No unread notifications
          </div>
        ) : (
          notifications.map((n) => {
            const meta = getNotifMeta(n.type_key);
            return (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "12px 16px",
                  borderLeft: "3px solid #00508a",
                  background: "rgba(0,80,138,0.03)",
                  marginBottom: 1,
                  cursor: "pointer",
                  transition: "background 0.12s",
                }}
                onClick={() => { onNavigate(meta.link); onClose(); }}
              >
                {/* Type icon */}
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: "rgba(0,80,138,0.08)",
                  color: "#00508a",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {meta.icon}
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#191c1e", marginBottom: 2 }}>{meta.title}</div>
                  <div style={{ fontSize: 12, color: "#414751", lineHeight: 1.5 }}>{n.message}</div>
                  <div style={{ fontSize: 11, color: "#717782", marginTop: 4 }}>{timeAgo(n.triggered_at)}</div>
                </div>

                {/* Mark as read */}
                <button
                  onClick={(e) => { e.stopPropagation(); onMarkRead(n.id); }}
                  title="Mark as read"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "#717782", padding: 4, flexShrink: 0,
                    alignSelf: "flex-start", borderRadius: 4,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "color 0.12s",
                  }}
                  aria-label="Mark as read"
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Footer — View all */}
      <div style={{ padding: "10px 16px", background: "#f2f4f7", textAlign: "center" }}>
        <button
          onClick={() => { onNavigate("/notifications"); onClose(); }}
          style={{ fontSize: 12, fontWeight: 600, color: "#00508a", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          View all notifications →
        </button>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Header({ title, subtitle }: HeaderProps) {
  const { user, activeCrisisId, setActiveCrisis, clearActiveCrisis } =
    useAuthStore();
  const navigate = useNavigate();

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
                  minWidth: 16,
                  height: 16,
                  padding: "0 3px",
                  borderRadius: 999,
                  background: "#ba1a1a",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                  boxSizing: "border-box",
                }}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>
            {notifOpen && (
              <NotificationDropdown
                notifications={notifications}
                onMarkRead={(id) => { markReadMutation.mutate(id); }}
                onMarkAllRead={() => markAllReadMutation.mutate()}
                onClose={() => setNotifOpen(false)}
                onNavigate={(link) => navigate(link)}
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
