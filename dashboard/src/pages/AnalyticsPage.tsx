import { useQuery } from "@tanstack/react-query";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { DashboardStats } from "../types";

export default function AnalyticsPage() {
  const { activeCrisisId, activeCrisisName } = useAuthStore();

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats", activeCrisisId],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/map/stats", {
        params: { crisis_id: activeCrisisId },
      });
      return response.data;
    },
    enabled: !!activeCrisisId,
  });

  const STAT_CARDS = [
    { label: "Total Reports", value: stats?.total_reports || 0, color: "#1A2B4A" },
    { label: "Verified (Green)", value: stats?.green_count || 0, color: "#4caf50" },
    { label: "Flagged (Orange)", value: stats?.orange_count || 0, color: "#ff9800" },
    { label: "Under Review (Red)", value: stats?.red_count || 0, color: "#f44336" },
    { label: "Processing (Grey)", value: stats?.grey_count || 0, color: "#9e9e9e" },
    { label: "Review Queue", value: stats?.review_queue_count || 0, color: "#9c27b0" },
  ];

  return (
    <div style={styles.container}>
      <Header
        title="Analytics"
        subtitle={activeCrisisName || "Select a crisis"}
      />
      <div style={styles.content}>
        <div style={styles.grid}>
          {STAT_CARDS.map((card) => (
            <div key={card.label} style={styles.card}>
              <div style={{ ...styles.cardNumber, color: card.color }}>
                {card.value.toLocaleString()}
              </div>
              <div style={styles.cardLabel}>{card.label}</div>
            </div>
          ))}
        </div>

        {stats && stats.total_reports > 0 && (
          <div style={styles.breakdown}>
            <h2 style={styles.breakdownTitle}>Flag Distribution</h2>
            <div style={styles.barChart}>
              {[
                { label: "Verified", count: stats.green_count, color: "#4caf50" },
                { label: "Flagged", count: stats.orange_count, color: "#ff9800" },
                { label: "Review", count: stats.red_count, color: "#f44336" },
                { label: "Processing", count: stats.grey_count, color: "#9e9e9e" },
              ].map((item) => (
                <div key={item.label} style={styles.barRow}>
                  <div style={styles.barLabel}>{item.label}</div>
                  <div style={styles.barTrack}>
                    <div style={{
                      ...styles.barFill,
                      width: `${(item.count / stats.total_reports) * 100}%`,
                      background: item.color,
                    }} />
                  </div>
                  <div style={styles.barCount}>{item.count}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", overflow: "auto" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 20,
    marginBottom: 32,
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  cardNumber: {
    fontSize: 40,
    fontWeight: 700,
    lineHeight: 1,
    marginBottom: 8,
  },
  cardLabel: { fontSize: 14, color: "#666" },
  breakdown: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  breakdownTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "#1A2B4A",
    marginBottom: 20,
  },
  barChart: { display: "flex", flexDirection: "column", gap: 16 },
  barRow: { display: "flex", alignItems: "center", gap: 16 },
  barLabel: { width: 80, fontSize: 13, color: "#666" },
  barTrack: {
    flex: 1,
    height: 8,
    background: "#f0f0f0",
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 4, transition: "width 0.3s ease" },
  barCount: { width: 40, fontSize: 13, fontWeight: 600, color: "#1A2B4A", textAlign: "right" },
};