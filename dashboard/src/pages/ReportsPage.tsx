import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import type { ReportListItem, FlagStatus } from "../types";

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#9e9e9e",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
};

const FLAG_LABELS: Record<FlagStatus, string> = {
  grey: "Processing",
  green: "Verified",
  orange: "Flagged",
  red: "Review",
};

export default function ReportsPage() {
  const { activeCrisisId } = useAuthStore();
  const queryClient = useQueryClient();
  const [flagFilter, setFlagFilter] = useState<FlagStatus | "">("");
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["reports", activeCrisisId, flagFilter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (activeCrisisId) params.crisis_id = activeCrisisId;
      if (flagFilter) params.flag_status = flagFilter;
      const response = await api.get("/api/dashboard/reports", { params });
      return response.data;
    },
    enabled: !!activeCrisisId,
  });

  const flagMutation = useMutation({
    mutationFn: async ({
      reportId,
      flagStatus,
    }: {
      reportId: string;
      flagStatus: FlagStatus;
    }) => {
      await api.patch(`/api/dashboard/reports/${reportId}/flag`, {
        flag_status: flagStatus,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["map-pins"] });
    },
  });

  return (
    <div style={styles.container}>
      <Header
        title="Reports"
        subtitle={`${data?.total || 0} total reports`}
      />

      <div style={styles.content}>
        {/* Filters */}
        <div style={styles.filters}>
          <span style={styles.filterLabel}>Filter by flag:</span>
          {(["", "grey", "green", "orange", "red"] as const).map((flag) => (
            <button
              key={flag}
              style={{
                ...styles.filterBtn,
                background: flagFilter === flag ? "#0468B1" : "#fff",
                color: flagFilter === flag ? "#fff" : "#1A2B4A",
                borderColor: flagFilter === flag ? "#0468B1" : "#e0e0e0",
              }}
              onClick={() => setFlagFilter(flag)}
            >
              {flag === "" ? "All" : FLAG_LABELS[flag]}
            </button>
          ))}
        </div>

        {/* Table */}
        {isLoading ? (
          <div style={styles.loading}>Loading reports...</div>
        ) : (
          <div style={styles.tableWrapper}>
            <table style={styles.table}>
              <thead>
                <tr style={styles.tableHeader}>
                  <th style={styles.th}>Flag</th>
                  <th style={styles.th}>Damage</th>
                  <th style={styles.th}>Infrastructure</th>
                  <th style={styles.th}>Platform</th>
                  <th style={styles.th}>Photos</th>
                  <th style={styles.th}>Submitted</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.items?.map((report: ReportListItem) => (
                  <tr
                    key={report.id}
                    style={{
                      ...styles.tableRow,
                      background: "#fff",
                    }}
                    onClick={() => navigate(`/reports/${report.id}`)}
                  >
                    <td style={styles.td}>
                      <span style={{
                        ...styles.flagBadge,
                        background: FLAG_COLORS[report.flag_status] + "20",
                        color: FLAG_COLORS[report.flag_status],
                        borderColor: FLAG_COLORS[report.flag_status] + "40",
                      }}>
                        {FLAG_LABELS[report.flag_status]}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span style={{ textTransform: "capitalize" }}>
                        {report.damage_level}
                      </span>
                    </td>
                    <td style={styles.td}>{report.infrastructure_type}</td>
                    <td style={styles.td}>{report.platform}</td>
                    <td style={styles.td}>{report.photo_count}</td>
                    <td style={styles.td}>
                      {new Date(report.submitted_at).toLocaleDateString()}
                    </td>
                    <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                      <select
                        style={styles.flagSelect}
                        value={report.flag_status}
                        onChange={(e) =>
                          flagMutation.mutate({
                            reportId: report.id,
                            flagStatus: e.target.value as FlagStatus,
                          })
                        }
                      >
                        <option value="grey">Processing</option>
                        <option value="green">Verified</option>
                        <option value="orange">Flagged</option>
                        <option value="red">Review</option>
                      </select>
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
  filters: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 20,
    flexWrap: "wrap",
  },
  filterLabel: { fontSize: 14, color: "#666", marginRight: 4 },
  filterBtn: {
    padding: "6px 14px",
    borderRadius: 20,
    border: "1px solid",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    transition: "all 0.15s",
  },
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
  tableRow: {
    borderBottom: "1px solid #f0f0f0",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  td: { padding: "14px 16px", fontSize: 14, color: "#1A2B4A" },
  flagBadge: {
    padding: "4px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid",
  },
  flagSelect: {
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid #e0e0e0",
    fontSize: 13,
    cursor: "pointer",
    background: "#fff",
  },
};