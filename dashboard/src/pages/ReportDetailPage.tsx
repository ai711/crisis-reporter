import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Header from "../components/Header";
import api from "../services/api";
import type { ReportDetail, FlagStatus, FlagEvent, PhotoSummary } from "../types";

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

const FLAG_DESCRIPTIONS: Record<FlagStatus, string> = {
  grey: "Auto-checks in progress — excluded from exports",
  green: "Passed all checks — included in exports",
  orange: "Minor anomaly noted — included in exports",
  red: "Requires human review — excluded from exports",
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
  const [showTranslated, setShowTranslated] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null);

  const { data: report, isLoading, isError } = useQuery<ReportDetail>({
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

  const translateMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/api/dashboard/reports/${reportId}/translate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      setShowTranslated(true);
    },
  });

  if (isLoading) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <div style={styles.loading}>Loading report...</div>
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <div style={styles.errorState}>
          <p style={styles.errorText}>Failed to load report.</p>
          <button style={styles.backBtn} onClick={() => navigate("/reports")}>
            Back to Reports
          </button>
        </div>
      </div>
    );
  }

  const mapsUrl =
    report.gps_latitude != null && report.gps_longitude != null
      ? `https://www.google.com/maps?q=${report.gps_latitude},${report.gps_longitude}`
      : null;

  const sortedPhotos = [...report.photos].sort(
    (a: PhotoSummary, b: PhotoSummary) => a.display_order - b.display_order
  );

  const sortedFlagEvents = [...report.flag_events].sort(
    (a: FlagEvent, b: FlagEvent) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div style={styles.container}>
      <Header
        title="Report Detail"
        subtitle={`ID: ${report.id.slice(0, 8)}…`}
      />

      {/* Back bar */}
      <div style={styles.backBar}>
        <button style={styles.backBtn} onClick={() => navigate("/reports")}>
          ← Back to Reports
        </button>
        <div style={styles.flagPill}>
          <span
            style={{
              ...styles.flagDot,
              background: FLAG_COLORS[report.flag_status],
            }}
          />
          <span
            style={{
              ...styles.flagPillLabel,
              color: FLAG_COLORS[report.flag_status],
            }}
          >
            {FLAG_LABELS[report.flag_status]}
          </span>
        </div>
      </div>

      <div style={styles.content}>
        {/* Left column */}
        <div style={styles.leftCol}>
          {/* Photos grid */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>
              Photos{" "}
              <span style={styles.cardCount}>{sortedPhotos.length}</span>
            </h2>
            {sortedPhotos.length === 0 ? (
              <p style={styles.emptyText}>No photos attached to this report.</p>
            ) : (
              <div style={styles.photoGrid}>
                {sortedPhotos.map((photo: PhotoSummary) => (
                  <div
                    key={photo.id}
                    style={styles.photoCell}
                    onClick={() => setLightboxPhoto(photo.url)}
                  >
                    <img
                      src={photo.url}
                      alt="Report photo"
                      style={styles.photoImg}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src =
                          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='%23f0f0f0'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999' font-size='12'%3ENo image%3C/text%3E%3C/svg%3E";
                      }}
                    />
                    {photo.was_compressed && (
                      <span style={styles.compressedBadge}>Compressed</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Description */}
          <div style={styles.card}>
            <div style={styles.cardTitleRow}>
              <h2 style={styles.cardTitle}>Description</h2>
              {report.description && (
                <div style={styles.translateControls}>
                  {report.description_translated && (
                    <button
                      style={styles.toggleBtn}
                      onClick={() => setShowTranslated((v) => !v)}
                    >
                      {showTranslated ? "Show original" : "Show translation"}
                    </button>
                  )}
                  {!report.description_translated && (
                    <button
                      style={{
                        ...styles.translateBtn,
                        opacity: translateMutation.isPending ? 0.6 : 1,
                        cursor: translateMutation.isPending
                          ? "not-allowed"
                          : "pointer",
                      }}
                      disabled={translateMutation.isPending}
                      onClick={() => translateMutation.mutate()}
                    >
                      {translateMutation.isPending
                        ? "Translating…"
                        : "Translate to English"}
                    </button>
                  )}
                </div>
              )}
            </div>
            {report.description ? (
              <>
                <p style={styles.descText}>
                  {showTranslated && report.description_translated
                    ? report.description_translated
                    : report.description}
                </p>
                <p style={styles.langTag}>
                  Language: <strong>{report.language_code.toUpperCase()}</strong>
                  {showTranslated && report.description_translated && (
                    <span style={styles.translatedTag}> · Translated</span>
                  )}
                </p>
              </>
            ) : (
              <p style={styles.emptyText}>No description provided.</p>
            )}
          </div>

          {/* Flag history timeline */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Flag History</h2>
            {sortedFlagEvents.length === 0 ? (
              <p style={styles.emptyText}>No flag changes recorded.</p>
            ) : (
              <div style={styles.timeline}>
                {sortedFlagEvents.map((event: FlagEvent, idx: number) => (
                  <div key={event.id} style={styles.timelineItem}>
                    <div style={styles.timelineLine}>
                      <div
                        style={{
                          ...styles.timelineDot,
                          background:
                            FLAG_COLORS[event.flag_to as FlagStatus] || "#9e9e9e",
                        }}
                      />
                      {idx < sortedFlagEvents.length - 1 && (
                        <div style={styles.timelineConnector} />
                      )}
                    </div>
                    <div style={styles.timelineBody}>
                      <div style={styles.timelineHeader}>
                        <span style={styles.timelineChange}>
                          {event.flag_from ? (
                            <>
                              <span
                                style={{
                                  color:
                                    FLAG_COLORS[event.flag_from as FlagStatus] ||
                                    "#9e9e9e",
                                  fontWeight: 600,
                                }}
                              >
                                {FLAG_LABELS[event.flag_from as FlagStatus] ||
                                  event.flag_from}
                              </span>
                              {" → "}
                            </>
                          ) : (
                            "Set to "
                          )}
                          <span
                            style={{
                              color:
                                FLAG_COLORS[event.flag_to as FlagStatus] ||
                                "#9e9e9e",
                              fontWeight: 600,
                            }}
                          >
                            {FLAG_LABELS[event.flag_to as FlagStatus] ||
                              event.flag_to}
                          </span>
                        </span>
                        <span style={styles.timelineTime}>
                          {new Date(event.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p style={styles.timelineBy}>By: {event.changed_by}</p>
                      {event.reason && (
                        <p style={styles.timelineReason}>"{event.reason}"</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div style={styles.rightCol}>
          {/* Flag control */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Flag Status</h2>
            <div
              style={{
                ...styles.currentFlagBox,
                background: FLAG_COLORS[report.flag_status] + "12",
                borderColor: FLAG_COLORS[report.flag_status] + "40",
              }}
            >
              <span
                style={{
                  ...styles.currentFlagLabel,
                  color: FLAG_COLORS[report.flag_status],
                }}
              >
                {FLAG_LABELS[report.flag_status]}
              </span>
              <p style={styles.currentFlagDesc}>
                {FLAG_DESCRIPTIONS[report.flag_status]}
              </p>
            </div>
            <p style={styles.flagControlLabel}>Change flag to:</p>
            <div style={styles.flagButtons}>
              {(["green", "orange", "red", "grey"] as FlagStatus[]).map(
                (flag) => (
                  <button
                    key={flag}
                    disabled={
                      report.flag_status === flag || flagMutation.isPending
                    }
                    style={{
                      ...styles.flagBtn,
                      background:
                        report.flag_status === flag
                          ? FLAG_COLORS[flag] + "20"
                          : "#fff",
                      color: FLAG_COLORS[flag],
                      borderColor:
                        report.flag_status === flag
                          ? FLAG_COLORS[flag]
                          : FLAG_COLORS[flag] + "60",
                      opacity:
                        report.flag_status === flag || flagMutation.isPending
                          ? 0.6
                          : 1,
                      cursor:
                        report.flag_status === flag || flagMutation.isPending
                          ? "not-allowed"
                          : "pointer",
                    }}
                    onClick={() => flagMutation.mutate(flag)}
                  >
                    {FLAG_LABELS[flag]}
                  </button>
                )
              )}
            </div>
            {flagMutation.isPending && (
              <p style={styles.mutatingText}>Updating flag…</p>
            )}
          </div>

          {/* Report metadata */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Report Details</h2>
            <dl style={styles.metaList}>
              <MetaRow
                label="Damage Level"
                value={
                  <span
                    style={{
                      ...styles.damageBadge,
                      background:
                        (DAMAGE_COLORS[report.damage_level] || "#9e9e9e") +
                        "20",
                      color:
                        DAMAGE_COLORS[report.damage_level] || "#9e9e9e",
                      borderColor:
                        (DAMAGE_COLORS[report.damage_level] || "#9e9e9e") +
                        "60",
                    }}
                  >
                    {report.damage_level.charAt(0).toUpperCase() +
                      report.damage_level.slice(1)}
                  </span>
                }
              />
              <MetaRow
                label="Infrastructure"
                value={report.infrastructure_type}
              />
              <MetaRow label="Platform" value={report.platform} />
              <MetaRow
                label="Submitted"
                value={new Date(report.submitted_at).toLocaleString()}
              />
              <MetaRow
                label="Created"
                value={new Date(report.created_at).toLocaleString()}
              />
              {report.building_name && (
                <MetaRow label="Building" value={report.building_name} />
              )}
              {report.location_landmark && (
                <MetaRow label="Landmark" value={report.location_landmark} />
              )}
              {report.location_address && (
                <MetaRow label="Address" value={report.location_address} />
              )}
              {report.carrier_name && (
                <MetaRow label="Carrier" value={report.carrier_name} />
              )}
              {report.mcc && <MetaRow label="MCC" value={report.mcc} />}
              <MetaRow
                label="Offline queued"
                value={report.was_queued ? "Yes" : "No"}
              />
              <MetaRow label="Photos" value={String(report.photo_count)} />
            </dl>
          </div>

          {/* GPS location */}
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>GPS Location</h2>
            {report.gps_available &&
            report.gps_latitude != null &&
            report.gps_longitude != null ? (
              <>
                <div style={styles.coordRow}>
                  <div style={styles.coordBox}>
                    <span style={styles.coordLabel}>Latitude</span>
                    <span style={styles.coordValue}>
                      {report.gps_latitude.toFixed(6)}
                    </span>
                  </div>
                  <div style={styles.coordBox}>
                    <span style={styles.coordLabel}>Longitude</span>
                    <span style={styles.coordValue}>
                      {report.gps_longitude.toFixed(6)}
                    </span>
                  </div>
                </div>
                {mapsUrl && (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.mapsLink}
                  >
                    Open in Google Maps ↗
                  </a>
                )}
              </>
            ) : (
              <p style={styles.emptyText}>No GPS coordinates available.</p>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightboxPhoto && (
        <div style={styles.lightboxOverlay} onClick={() => setLightboxPhoto(null)}>
          <img
            src={lightboxPhoto}
            alt="Full size"
            style={styles.lightboxImg}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            style={styles.lightboxClose}
            onClick={() => setLightboxPhoto(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div style={styles.metaRow}>
      <dt style={styles.metaDt}>{label}</dt>
      <dd style={styles.metaDd}>{value}</dd>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  loading: { padding: 40, textAlign: "center", color: "#666", fontSize: 15 },
  errorState: {
    padding: 40,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
  },
  errorText: { fontSize: 15, color: "#d32f2f" },
  backBar: {
    padding: "12px 32px",
    borderBottom: "1px solid #e0e0e0",
    background: "#f4f6f9",
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  backBtn: {
    padding: "7px 16px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    background: "#fff",
    color: "#1A2B4A",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  flagPill: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 12px",
    borderRadius: 20,
    background: "#fff",
    border: "1px solid #e0e0e0",
  },
  flagDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
  },
  flagPillLabel: { fontSize: 13, fontWeight: 600 },
  content: {
    flex: 1,
    display: "flex",
    gap: 24,
    padding: "24px 32px",
    overflow: "auto",
    alignItems: "flex-start",
  },
  leftCol: { flex: 1, display: "flex", flexDirection: "column", gap: 20, minWidth: 0 },
  rightCol: { width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: 20 },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 16,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  cardCount: {
    fontSize: 12,
    fontWeight: 500,
    color: "#fff",
    background: "#0468B1",
    borderRadius: 20,
    padding: "2px 8px",
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
    gap: 8,
  },
  emptyText: { fontSize: 14, color: "#999", fontStyle: "italic" },
  // Photos
  photoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 10,
  },
  photoCell: {
    position: "relative",
    borderRadius: 8,
    overflow: "hidden",
    cursor: "pointer",
    aspectRatio: "4/3",
    background: "#f4f6f9",
    border: "1px solid #e0e0e0",
  },
  photoImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    transition: "transform 0.15s",
  },
  compressedBadge: {
    position: "absolute",
    bottom: 6,
    right: 6,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: 4,
  },
  // Description
  translateControls: { display: "flex", alignItems: "center", gap: 8 },
  translateBtn: {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid #0468B1",
    background: "#E8F4FD",
    color: "#0468B1",
    fontSize: 12,
    fontWeight: 600,
  },
  toggleBtn: {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid #e0e0e0",
    background: "#fff",
    color: "#555",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  descText: { fontSize: 14, color: "#1A2B4A", lineHeight: 1.6 },
  langTag: { fontSize: 12, color: "#999", marginTop: 10 },
  translatedTag: { color: "#0468B1", fontWeight: 600 },
  // Flag history
  timeline: { display: "flex", flexDirection: "column", gap: 0 },
  timelineItem: { display: "flex", gap: 12 },
  timelineLine: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: 20,
    flexShrink: 0,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    flexShrink: 0,
    marginTop: 4,
  },
  timelineConnector: {
    width: 2,
    flex: 1,
    background: "#e0e0e0",
    minHeight: 24,
    margin: "4px 0",
  },
  timelineBody: { flex: 1, paddingBottom: 20 },
  timelineHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  timelineChange: { fontSize: 14, color: "#1A2B4A" },
  timelineTime: { fontSize: 12, color: "#999", whiteSpace: "nowrap" },
  timelineBy: { fontSize: 12, color: "#777", marginTop: 4 },
  timelineReason: {
    fontSize: 13,
    color: "#555",
    fontStyle: "italic",
    marginTop: 4,
    padding: "6px 10px",
    background: "#f9f9f9",
    borderRadius: 6,
    borderLeft: "3px solid #e0e0e0",
  },
  // Flag control
  currentFlagBox: {
    borderRadius: 10,
    border: "1px solid",
    padding: "14px 16px",
    marginBottom: 16,
  },
  currentFlagLabel: { fontSize: 16, fontWeight: 700 },
  currentFlagDesc: { fontSize: 12, color: "#666", marginTop: 4 },
  flagControlLabel: { fontSize: 12, color: "#666", marginBottom: 8, fontWeight: 500 },
  flagButtons: { display: "flex", flexDirection: "column", gap: 8 },
  flagBtn: {
    padding: "9px 14px",
    borderRadius: 8,
    border: "1px solid",
    fontSize: 13,
    fontWeight: 600,
    textAlign: "left",
  },
  mutatingText: { fontSize: 12, color: "#999", marginTop: 10, textAlign: "center" },
  // Metadata
  metaList: { display: "flex", flexDirection: "column", gap: 0 },
  metaRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "9px 0",
    borderBottom: "1px solid #f0f0f0",
    gap: 8,
  },
  metaDt: { fontSize: 12, color: "#888", fontWeight: 500, flexShrink: 0 },
  metaDd: { fontSize: 13, color: "#1A2B4A", fontWeight: 500, textAlign: "right" },
  damageBadge: {
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid",
    display: "inline-block",
  },
  // GPS
  coordRow: { display: "flex", gap: 12, marginBottom: 14 },
  coordBox: {
    flex: 1,
    background: "#f4f6f9",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  coordLabel: { fontSize: 11, color: "#888", fontWeight: 600, textTransform: "uppercase" },
  coordValue: { fontSize: 14, color: "#1A2B4A", fontWeight: 600, fontFamily: "monospace" },
  mapsLink: {
    display: "inline-block",
    color: "#0468B1",
    fontSize: 13,
    fontWeight: 600,
    textDecoration: "none",
    padding: "8px 14px",
    borderRadius: 8,
    background: "#E8F4FD",
    border: "1px solid #b3d4ef",
    width: "100%",
    boxSizing: "border-box",
    textAlign: "center",
  },
  // Lightbox
  lightboxOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.85)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  lightboxImg: {
    maxWidth: "90vw",
    maxHeight: "90vh",
    borderRadius: 8,
    objectFit: "contain",
  },
  lightboxClose: {
    position: "fixed",
    top: 20,
    right: 28,
    background: "rgba(255,255,255,0.15)",
    border: "none",
    color: "#fff",
    fontSize: 32,
    width: 44,
    height: 44,
    borderRadius: "50%",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
};
