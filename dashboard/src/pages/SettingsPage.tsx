import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";

export default function SettingsPage() {
  const { user } = useAuthStore();

  return (
    <div style={styles.container}>
      <Header title="Settings" subtitle="System configuration" />
      <div style={styles.content}>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Account</h2>
          <div style={styles.row}>
            <span style={styles.label}>Name</span>
            <span style={styles.value}>{user?.full_name}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Email</span>
            <span style={styles.value}>{user?.email}</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Role</span>
            <span style={{
              ...styles.value,
              background: "#E8F4FD",
              color: "var(--c-primary-container)",
              padding: "4px 12px",
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 600,
              textTransform: "capitalize",
            }}>
              {user?.role}
            </span>
          </div>
        </div>

        <div style={styles.card}>
          <h2 style={styles.cardTitle}>System Information</h2>
          <div style={styles.row}>
            <span style={styles.label}>Version</span>
            <span style={styles.value}>Crisis Reporter 1.0.0</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Backend</span>
            <span style={styles.value}>FastAPI + PostgreSQL + PostGIS</span>
          </div>
          <div style={styles.row}>
            <span style={styles.label}>Storage</span>
            <span style={styles.value}>Local filesystem (development)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    maxWidth: 600,
  },
  cardTitle: { fontSize: 16, fontWeight: 600, color: "#1A2B4A", marginBottom: 16 },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 0",
    borderBottom: "1px solid #f0f0f0",
  },
  label: { fontSize: 14, color: "#666" },
  value: { fontSize: 14, fontWeight: 500, color: "#1A2B4A" },
};