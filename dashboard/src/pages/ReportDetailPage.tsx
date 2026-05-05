import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import Header from "../components/Header";
import api from "../services/api";
import type { ReportDetail, FlagStatus } from "../types";

const API_BASE = "https://crisis-reporter-production.up.railway.app";

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
  red: "Review Required",
};

const DAMAGE_COLORS: Record<string, string> = {
  minimal: "#4caf50",
  partial: "#ff9800",
  complete: "#f44336",
};

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [translating, setTranslating] = useState(false);

  const { data: report, isLoading } = useQuery<ReportDetail>({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const response = await api.get(`/api/dashboard/reports/${reportId}`);
      return response.data;
    },
    enabled: !!reportId,
  });

  const flagMutation = useMutation({
    mutationFn: async (flagStatus: FlagStatus) => {
      await api.patch(`/api/dashboard/reports/${reportId}/flag`, {
        flag_status: flagStatus,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["map-pins"] });
    },
  });

  const handleTranslate = async () => {
    if (!report?.description) return;
    setTranslating(true);
    try {
      await api.post(`/api/dashboard/reports/${reportId}/translate`, {
        target_language: "en",
      });
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
    } catch {
      // Translation service unavailable
    } finally {
      setTranslating(false);
    }
  };

  if (isLoading) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <div style={styles.loading}>Loading report...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <div style={styles.loading}>Report not found</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <Header
        title="Report Detail"
        subtitle={"ID: " + report.id.slice(0, 8) + "..."}
      />
      <div style={styles.content}>
        <button style={styles.backBtn} onClick={() => navigate("/reports")}>
          {"← Back to Reports"}
        </button>

        <div style={styles.grid}>
          {/* Left column */}
          <div style={styles.leftColumn}>

            {/* Photos */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Photos</h2>
              {report.photos.length === 0 ? (
                <p style={styles.emptyText}>No photos attached</p>
              ) : (
                <div style={styles.photoGrid}>
                  {report.photos.map((photo) => {
                    const photoUrl = API_BASE + photo.url;
                    return (
                      <a
                        key={photo.id}
                        href={photoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img
                          src={photoUrl}
                          style={styles.photo}
                          alt="Damage photo"
                        />
                      </a>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Description */}
            {report.description && (
              <div style={styles.card}>
                <div style={styles.cardTitleRow}>
                  <h2 style={styles.cardTitle}>Description</h2>
                  {!report.description_translated && (
                    <button
                      style={styles.translateBtn}
                      onClick={handleTranslate}
                      disabled={translating}
                    >
                      {translating ? "Translating..." : "🌐 Translate"}
                    </button>
                  )}
                </div>
                <p style={styles.description}>{report.description}</p>
                {report.description_translated && (
                  <div style={styles.translatedBox}>
                    <p style={styles.translatedLabel}>English translation:</p>
                    <p style={styles.description}>{report.description_translated}</p>
                  </div>
                )}
              </div>
            )}

            {/* Flag History */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Flag History</h2>
              <div style={styles.flagHistory}>
                {report.flag_events.map((event) => (
                  <div key={event.id} style={styles.flagEvent}>
                    <div style={styles.flagEventLeft}>
                      <span style={{
                        ...styles.flagBadge,
                        background: (FLAG_COLORS[event.flag_to as FlagStatus] || "#999") + "20",
                        color: FLAG_COLORS[event.flag_to as FlagStatus] || "#999",
                      }}>
                        {FLAG_LABELS[event.flag_to as FlagStatus] || event.flag_to}
                      </span>
                      <span style={styles.flagEventMeta}>
                        {event.changed_by === "auto" ? "Auto" : "Manual"}
                        {event.reason ? " — " + event.reason : ""}
                      </span>
                    </div>
                    <span style={styles.flagEventTime}>
                      {new Date(event.created_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div style={styles.rightColumn}>

            {/* Flag control */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Flag Status</h2>
              <div style={{
                ...styles.currentFlag,
                background: (FLAG_COLORS[report.flag_status] || "#999") + "20",
                borderColor: FLAG_COLORS[report.flag_status] || "#999",
              }}>
                <span style={{
                  color: FLAG_COLORS[report.flag_status] || "#999",
                  fontWeight: 700,
                  fontSize: 16,
                }}>
                  {FLAG_LABELS[report.flag_status]}
                </span>
              </div>
              <div style={styles.flagButtons}>
                {(["green", "orange", "red", "grey"] as FlagStatus[]).map((flag) => (
                  <button
                    key={flag}
                    style={{
                      ...styles.flagBtn,
                      background: report.flag_status === flag ? FLAG_COLORS[flag] : "#fff",
                      color: report.flag_status === flag ? "#fff" : FLAG_COLORS[flag],
                      borderColor: FLAG_COLORS[flag],
                    }}
                    onClick={() => flagMutation.mutate(flag)}
                    disabled={report.flag_status === flag}
                  >
                    {FLAG_LABELS[flag]}
                  </button>
                ))}
              </div>
            </div>

            {/* Report details */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Report Details</h2>
              <div style={styles.detailRows}>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Damage Level</span>
                  <span style={{
                    ...styles.detailValue,
                    color: DAMAGE_COLORS[report.damage_level] || "#1A2B4A",
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}>
                    {report.damage_level}
                  </span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Infrastructure</span>
                  <span style={styles.detailValue}>{report.infrastructure_type}</span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Platform</span>
                  <span style={styles.detailValue}>{report.platform}</span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Language</span>
                  <span style={styles.detailValue}>{report.language_code}</span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Was Queued</span>
                  <span style={styles.detailValue}>{report.was_queued ? "Yes" : "No"}</span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Photos</span>
                  <span style={styles.detailValue}>{report.photos.length}</span>
                </div>
                <div style={styles.detailRow}>
                  <span style={styles.detailLabel}>Submitted</span>
                  <span style={styles.detailValue}>
                    {new Date(report.submitted_at).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Location */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Location</h2>
              <div style={styles.detailRows}>
                {report.gps_latitude && report.gps_longitude ? (
                  <>
                    <div style={styles.detailRow}>
                      <span style={styles.detailLabel}>GPS</span>
                      <span style={styles.detailValue}>
                        {report.gps_latitude.toFixed(6) + ", " + report.gps_longitude.toFixed(6)}
                      </span>
                    </div>
                    
                    <a
                      href={"https://www.google.com/maps?q=" + report.gps_latitude + "," + report.gps_longitude}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.mapsLink}
                    >
                      {"📍 Open in Google Maps"}
                    </a>
                  </>
                ) : (
                  <p style={styles.emptyText}>No GPS coordinates</p>
                )}
                {report.location_address && (
                  <div style={styles.detailRow}>
                    <span style={styles.detailLabel}>Address</span>
                    <span style={styles.detailValue}>{report.location_address}</span>
                  </div>
                )}
                {report.location_landmark && (
                  <div style={styles.detailRow}>
                    <span style={styles.detailLabel}>Landmark</span>
                    <span style={styles.detailValue}>{report.location_landmark}</span>
                  </div>
                )}
              </div>
            </div>

            {/* MCC data */}
            {report.mcc && (
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Network Data</h2>
                <div style={styles.detailRows}>
                  <div style={styles.detailRow}>
                    <span style={styles.detailLabel}>MCC</span>
                    <span style={styles.detailValue}>{report.mcc}</span>
                  </div>
                  {report.carrier_name && (
                    <div style={styles.detailRow}>
                      <span style={styles.detailLabel}>Carrier</span>
                      <span style={styles.detailValue}>{report.carrier_name}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", overflow: "auto" },
  loading: { padding: 40, textAlign: "center", color: "#666" },
  backBtn: {
    padding: "8px 16px",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
    color: "#1A2B4A",
    marginBottom: 24,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 380px",
    gap: 24,
    alignItems: "start",
  },
  leftColumn: { display: "flex", flexDirection: "column", gap: 24 },
  rightColumn: { display: "flex", flexDirection: "column", gap: 24 },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  cardTitle: { fontSize: 15, fontWeight: 600, color: "#1A2B4A", marginBottom: 16 },
  cardTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  photoGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 },
  photo: {
    width: "100%",
    aspectRatio: "1",
    objectFit: "cover",
    borderRadius: 8,
    cursor: "pointer",
  },
  emptyText: { fontSize: 14, color: "#999" },
  description: { fontSize: 14, color: "#444", lineHeight: 1.6 },
  translatedBox: { marginTop: 12, padding: 12, background: "#f4f6f9", borderRadius: 8 },
  translatedLabel: { fontSize: 12, color: "#666", marginBottom: 6, fontWeight: 500 },
  translateBtn: {
    padding: "6px 12px",
    background: "#E8F4FD",
    color: "#0468B1",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
  },
  flagHistory: { display: "flex", flexDirection: "column", gap: 10 },
  flagEvent: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 0",
    borderBottom: "1px solid #f0f0f0",
  },
  flagEventLeft: { display: "flex", alignItems: "center", gap: 10 },
  flagBadge: { padding: "3px 8px", borderRadius: 20, fontSize: 12, fontWeight: 600 },
  flagEventMeta: { fontSize: 12, color: "#666" },
  flagEventTime: { fontSize: 12, color: "#999" },
  currentFlag: {
    padding: "12px 16px",
    borderRadius: 8,
    border: "2px solid",
    marginBottom: 16,
    textAlign: "center",
  },
  flagButtons: { display: "flex", flexDirection: "column", gap: 8 },
  flagBtn: {
    padding: "10px",
    borderRadius: 6,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
  detailRows: { display: "flex", flexDirection: "column", gap: 0 },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 0",
    borderBottom: "1px solid #f0f0f0",
  },
  detailLabel: { fontSize: 13, color: "#666" },
  detailValue: {
    fontSize: 13,
    color: "#1A2B4A",
    fontWeight: 500,
    textAlign: "right",
    maxWidth: "60%",
  },
  mapsLink: { display: "block", marginTop: 8, color: "#0468B1", fontSize: 13, textDecoration: "none" },
};