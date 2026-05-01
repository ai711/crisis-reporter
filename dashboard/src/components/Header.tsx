import { useAuthStore } from "../stores/authStore";

interface HeaderProps {
  title: string;
  subtitle?: string;
}

export default function Header({ title, subtitle }: HeaderProps) {
  const { activeCrisisName, user } = useAuthStore();

  return (
    <div style={styles.header}>
      <div>
        <h1 style={styles.title}>{title}</h1>
        {subtitle && <p style={styles.subtitle}>{subtitle}</p>}
      </div>
      <div style={styles.right}>
        {activeCrisisName && (
          <div style={styles.crisisBadge}>
            🚨 {activeCrisisName}
          </div>
        )}
        <div style={styles.userBadge}>
          {user?.role === "admin" && (
            <span style={styles.adminBadge}>Admin</span>
          )}
          <span style={styles.userInitial}>
            {user?.full_name?.charAt(0) || "U"}
          </span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "16px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  subtitle: {
    fontSize: 13,
    color: "#666",
    marginTop: 2,
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  crisisBadge: {
    background: "#fff3e0",
    color: "#e65100",
    padding: "6px 14px",
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid #ffcc02",
  },
  userBadge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  adminBadge: {
    background: "#E8F4FD",
    color: "#0468B1",
    padding: "4px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
  },
  userInitial: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "#0468B1",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
    fontWeight: 700,
  },
};