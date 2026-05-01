import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Header from "../components/Header";
import api from "../services/api";
import type { ReporterListItem } from "../types";

export default function ReportersPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["reporters"],
    queryFn: async () => {
      const response = await api.get("/api/dashboard/reporters");
      return response.data;
    },
  });

  const blockMutation = useMutation({
    mutationFn: async ({
      reporterId,
      action,
    }: {
      reporterId: string;
      action: "block" | "unblock";
    }) => {
      await api.post(`/api/dashboard/reporters/${reporterId}/${action}`, {
        reason: action === "block" ? "Blocked by dashboard admin" : undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reporters"] });
    },
  });

  return (
    <div style={styles.container}>
      <Header
        title="Reporters"
        subtitle={`${data?.total || 0} total reporters`}
      />
      <div style={styles.content}>
        {isLoading ? (
          <div style={styles.loading}>Loading reporters...</div>
        ) : (
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <th style={styles.th}>Platform</th>
                  <th style={styles.th}>Country</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Reports</th>
                  <th style={styles.th}>Last Active</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.items?.map((reporter: ReporterListItem) => (
                  <tr key={reporter.id} style={styles.tableRow}>
                    <td style={styles.td}>{reporter.platform}</td>
                    <td style={styles.td}>{reporter.country_code || "—"}</td>
                    <td style={styles.td}>
                      <span style={{
                        padding: "4px 10px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        background: reporter.is_blocked ? "#fdecea" : "#e8f5e9",
                        color: reporter.is_blocked ? "#d32f2f" : "#2e7d32",
                      }}>
                        {reporter.is_blocked ? "Blocked" : reporter.is_verified ? "Verified" : "Anonymous"}
                      </span>
                    </td>
                    <td style={styles.td}>{reporter.report_count}</td>
                    <td style={styles.td}>
                      {reporter.last_active_at
                        ? new Date(reporter.last_active_at).toLocaleDateString()
                        : "—"}
                    </td>
                    <td style={styles.td}>
                      <button
                        style={{
                          ...styles.actionBtn,
                          background: reporter.is_blocked ? "#e8f5e9" : "#fdecea",
                          color: reporter.is_blocked ? "#2e7d32" : "#d32f2f",
                          borderColor: reporter.is_blocked ? "#c8e6c9" : "#f5c6cb",
                        }}
                        onClick={() =>
                          blockMutation.mutate({
                            reporterId: reporter.id,
                            action: reporter.is_blocked ? "unblock" : "block",
                          })
                        }
                      >
                        {reporter.is_blocked ? "Unblock" : "Block"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", overflow: "auto" },
  loading: { padding: 40, textAlign: "center", color: "#666" },
  tableWrapper: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  tableHeader: { background: "#f4f6f9" },
  th: {
    padding: "12px 16px",
    textAlign: "left",
    fontSize: 12,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e0e0e0",
  },
  tableRow: { borderBottom: "1px solid #f0f0f0" },
  td: { padding: "14px 16px", fontSize: 14, color: "#1A2B4A" },
  actionBtn: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
};