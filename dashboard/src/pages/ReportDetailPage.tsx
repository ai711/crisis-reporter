import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Globe,
  MapPin,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import Header from "../components/Header";
import api from "../services/api";
import type { ReportDetail, FlagStatus, FlagEvent, VersionHistoryItem, QuestionAnswer } from "../types";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";

// ── Flag colour + label maps ──────────────────────────────────────────────────

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#9e9e9e",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
};

const FLAG_LABELS: Record<string, string> = {
  grey: "Grey",
  green: "Green",
  orange: "Orange",
  red: "Red",
};

// ── Authenticated photo hook ──────────────────────────────────────────────────

function useAuthPhoto(reportId: string, photoId: string, photoUrl: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    api
      .get(`/api/dashboard/reports/${reportId}/photos/${photoId}`, {
        responseType: "blob",
      })
      .then((res) => {
        objectUrl = URL.createObjectURL(res.data as Blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        // Fallback: try the raw URL as-is (handles dev local static mount)
        setBlobUrl(photoUrl);
      });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, photoId]);

  return blobUrl;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AuthPhoto({
  reportId,
  photoId,
  photoUrl,
}: {
  reportId: string;
  photoId: string;
  photoUrl: string;
}) {
  const blobUrl = useAuthPhoto(reportId, photoId, photoUrl);
  if (!blobUrl) return <div style={styles.photoPlaceholder}>Loading…</div>;
  return (
    <a href={blobUrl} target="_blank" rel="noopener noreferrer">
      <img src={blobUrl} style={styles.photo} alt="Damage photo" />
    </a>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={styles.detailRow}>
      <span style={styles.detailLabel}>{label}</span>
      <span style={styles.detailValue}>{value ?? <em style={{ color: "#bbb" }}>Not recorded</em>}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.card}>
      <h2 style={styles.cardTitle}>{title}</h2>
      {children}
    </div>
  );
}

function FlagPill({ flag }: { flag: string }) {
  const color = FLAG_COLORS[flag as FlagStatus] ?? "#9e9e9e";
  return (
    <span
      style={{
        ...styles.flagPill,
        background: color + "20",
        color,
        borderColor: color + "60",
      }}
    >
      {FLAG_LABELS[flag] ?? flag}
    </span>
  );
}

function VersionRow({ item }: { item: VersionHistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={styles.versionRow}>
      <div style={styles.versionRowHeader} onClick={() => setExpanded((v) => !v)}>
        <span style={styles.versionDate}>{formatDateTime(item.submitted_at)}</span>
        <FlagPill flag={item.flag_status} />
        <span style={styles.versionDamage}>{formatDamageLevel(item.damage_level)}</span>
        <button
          style={styles.viewReportBtn}
          onClick={(e) => {
            e.stopPropagation();
            window.open(`/reports/${item.id}`, "_blank");
          }}
        >
          View report →
        </button>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {expanded && (
        <div style={styles.versionExpanded}>
          <span style={styles.detailLabel}>Infrastructure:</span>
          <span style={styles.detailValue}>{item.infrastructure_type}</span>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [translating, setTranslating] = useState(false);

  const { data: report, isLoading } = useQuery<ReportDetail>({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const res = await api.get(`/api/dashboard/reports/${reportId}`);
      return res.data;
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
        <div style={styles.loading}>Loading report…</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <div style={styles.loading}>Report not found.</div>
      </div>
    );
  }

  const flagColor = FLAG_COLORS[report.flag_status as FlagStatus] ?? "#9e9e9e";

  // Separate manual flag events for Review Log
  const reviewLogEvents = report.flag_events.filter((e) => e.changed_by === "manual");

  return (
    <div style={styles.container}>
      <Header
        title="Report Detail"
        subtitle={`ID: ${report.id.slice(0, 8).toUpperCase()}`}
      />

      <div style={styles.content}>
        <button style={styles.backBtn} onClick={() => navigate("/reports")}>
          <ArrowLeft size={15} style={{ marginRight: 6 }} />
          Back to Reports
        </button>

        {/* ── Section 1: Report header ────────────────────────────────── */}
        <div style={styles.reportHeader}>
          <div style={styles.reportHeaderLeft}>
            <div style={styles.reportId} title={report.id}>
              Report {report.id.slice(0, 8).toUpperCase()}
            </div>
            <div style={styles.reportSubmitted}>
              Submitted {formatDateTime(report.submitted_at)}
            </div>
          </div>
          <div style={styles.reportHeaderRight}>
            <FlagPill flag={report.flag_status} />
          </div>
        </div>

        {/* Flag status controls (full-width, below header) */}
        <div style={styles.flagControls}>
          <span style={styles.flagControlLabel}>Update flag status:</span>
          <div style={styles.flagBtnRow}>
            {(["green", "orange", "red", "grey"] as FlagStatus[]).map((flag) => (
              <button
                key={flag}
                style={{
                  ...styles.flagBtn,
                  background: report.flag_status === flag ? FLAG_COLORS[flag] : "#fff",
                  color: report.flag_status === flag ? "#fff" : FLAG_COLORS[flag],
                  borderColor: FLAG_COLORS[flag],
                  opacity: flagMutation.isPending ? 0.6 : 1,
                }}
                onClick={() => flagMutation.mutate(flag)}
                disabled={report.flag_status === flag || flagMutation.isPending}
              >
                {FLAG_LABELS[flag]}
              </button>
            ))}
          </div>
        </div>

        {/* Main two-column grid */}
        <div style={styles.grid}>
          {/* ── LEFT column ────────────────────────────────────────────── */}
          <div style={styles.leftColumn}>

            {/* Section 2: Photos */}
            <Card title="Photos">
              {report.photos.length === 0 ? (
                <p style={styles.emptyText}>No photos attached.</p>
              ) : (
                <div style={styles.photoGrid}>
                  {report.photos.map((photo) => (
                    <AuthPhoto
                      key={photo.id}
                      reportId={report.id}
                      photoId={photo.id}
                      photoUrl={photo.url}
                    />
                  ))}
                </div>
              )}
            </Card>

            {/* Section 3: Location */}
            <Card title="Location">
              <div style={styles.detailRows}>
                {report.gps_latitude && report.gps_longitude ? (
                  <>
                    <DetailRow
                      label="GPS Coordinates"
                      value={`${report.gps_latitude.toFixed(6)}, ${report.gps_longitude.toFixed(6)}`}
                    />
                    <div style={{ paddingTop: 8 }}>
                      <a
                        href={`https://www.google.com/maps?q=${report.gps_latitude},${report.gps_longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.mapsLink}
                      >
                        <MapPin size={14} style={{ marginRight: 4, flexShrink: 0 }} />
                        Open in Google Maps
                      </a>
                    </div>
                  </>
                ) : (
                  <p style={styles.emptyText}>No GPS coordinates recorded.</p>
                )}
                {report.location_address && (
                  <DetailRow label="Address" value={report.location_address} />
                )}
                {report.location_landmark && (
                  <DetailRow label="Landmark" value={report.location_landmark} />
                )}
              </div>
            </Card>

            {/* Section 4: Question Answers */}
            <Card title="Responses">
              {report.question_answers && report.question_answers.length > 0 ? (
                <div style={styles.detailRows}>
                  {report.question_answers.map((qa: QuestionAnswer, i: number) => (
                    <DetailRow
                      key={i}
                      label={String(qa.question)}
                      value={
                        Array.isArray(qa.answer)
                          ? (qa.answer as unknown[]).join(", ")
                          : String(qa.answer ?? "—")
                      }
                    />
                  ))}
                </div>
              ) : (
                <p style={styles.emptyText}>No responses recorded.</p>
              )}
            </Card>

            {/* Section 5: Timestamps */}
            <Card title="Timestamps">
              <div style={styles.detailRows}>
                <DetailRow
                  label="Photo first uploaded"
                  value={
                    report.photos.length > 0
                      ? formatDateTime(report.photos[0].created_at)
                      : null
                  }
                />
                <DetailRow
                  label="Submit tapped (client)"
                  value={
                    report.submission_submitted_at
                      ? formatDateTime(report.submission_submitted_at)
                      : null
                  }
                />
                <DetailRow
                  label="Report received by backend"
                  value={formatDateTime(report.created_at)}
                />
              </div>
            </Card>

            {/* Section 9: Version History */}
            <Card title="Version History">
              {report.versions.length === 0 ? (
                <p style={styles.emptyText}>
                  No previous versions — this is the first report for this
                  property from this reporter.
                </p>
              ) : (
                <div style={styles.versionList}>
                  {report.versions.map((v) => (
                    <VersionRow key={v.id} item={v} />
                  ))}
                </div>
              )}
            </Card>

            {/* Section 10: Review Log */}
            <Card title="Review Log">
              {reviewLogEvents.length === 0 ? (
                <p style={styles.emptyText}>No manual review actions recorded.</p>
              ) : (
                <div style={styles.reviewLog}>
                  {reviewLogEvents.map((e: FlagEvent) => (
                    <div key={e.id} style={styles.reviewEntry}>
                      <div style={styles.reviewEntryHeader}>
                        <span style={styles.reviewAction}>
                          {e.flag_from
                            ? `${FLAG_LABELS[e.flag_from] ?? e.flag_from} → ${FLAG_LABELS[e.flag_to] ?? e.flag_to}`
                            : `→ ${FLAG_LABELS[e.flag_to] ?? e.flag_to}`}
                        </span>
                        <span style={styles.reviewTime}>{formatDateTime(e.created_at)}</span>
                      </div>
                      <div style={styles.reviewUser}>
                        {e.dashboard_user_id
                          ? `User ${e.dashboard_user_id.slice(0, 8).toUpperCase()}`
                          : "System"}
                      </div>
                      <div style={styles.reviewComment}>
                        {e.reason ?? (
                          <em style={{ color: "#bbb" }}>No comment recorded</em>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* ── RIGHT column ───────────────────────────────────────────── */}
          <div style={styles.rightColumn}>

            {/* Description + translate */}
            {report.description && (
              <Card title="Description">
                <div style={styles.cardTitleRow}>
                  {!report.description_translated && (
                    <button
                      style={styles.translateBtn}
                      onClick={handleTranslate}
                      disabled={translating}
                    >
                      <Globe size={14} style={{ marginRight: 5, flexShrink: 0 }} />
                      {translating ? "Translating…" : "Translate"}
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
              </Card>
            )}

            {/* Report details */}
            <Card title="Report Details">
              <div style={styles.detailRows}>
                <DetailRow label="Damage Level" value={formatDamageLevel(report.damage_level)} />
                <DetailRow label="Infrastructure Type" value={report.infrastructure_type} />
                <DetailRow label="Crisis Type" value={report.disaster_type} />
                <DetailRow label="Language" value={report.language_code} />
                <DetailRow label="Was Queued" value={report.was_queued ? "Yes" : "No"} />
                <DetailRow label="Photo Count" value={String(report.photos.length)} />
              </div>
            </Card>

            {/* Section 6: Reporter profile summary */}
            <Card title="Reporter">
              {report.reporter_id ? (
                <div style={styles.detailRows}>
                  <DetailRow
                    label="Reporter ID"
                    value={
                      <a
                        href={`/reporters/${report.reporter_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.linkCell}
                        onClick={(e) => {
                          e.preventDefault();
                          window.open(`/reporters/${report.reporter_id}`, "_blank");
                        }}
                      >
                        {report.reporter_display_id != null
                          ? `#${report.reporter_display_id}`
                          : report.reporter_id.slice(0, 8).toUpperCase()}
                      </a>
                    }
                  />
                  <DetailRow label="Platform" value={report.reporter_platform} />
                  <DetailRow label="Country" value={report.reporter_country_code} />
                  <DetailRow
                    label="Status"
                    value={
                      report.reporter_is_blocked
                        ? "Blocked"
                        : report.reporter_is_verified
                        ? "Verified"
                        : "Active"
                    }
                  />
                </div>
              ) : (
                <p style={styles.emptyText}>Anonymous reporter — device ID only.</p>
              )}
            </Card>

            {/* Section 7: Flag reason — only for red */}
            {report.flag_status === "red" && (
              <Card title="Flag Reason">
                <div
                  style={{
                    ...styles.flagReasonBanner,
                    borderColor: flagColor + "40",
                    background: flagColor + "0d",
                  }}
                >
                  {/* Latest auto-flag reason */}
                  {(() => {
                    const autoEvent = [...report.flag_events]
                      .reverse()
                      .find((e) => e.changed_by === "auto" && e.flag_to === "red");
                    if (!autoEvent) return <span style={{ color: "#666", fontSize: 13 }}>No flag reason recorded.</span>;
                    return (
                      <>
                        <div style={styles.flagReasonCode}>{autoEvent.reason}</div>
                        {autoEvent.metadata && (
                          <pre style={styles.flagReasonMeta}>
                            {JSON.stringify(autoEvent.metadata, null, 2)}
                          </pre>
                        )}
                      </>
                    );
                  })()}
                </div>
              </Card>
            )}

            {/* Section 8: Project association */}
            <Card title="Projects">
              <p style={styles.emptyText}>Not linked to any project.</p>
            </Card>

            {/* Network data */}
            {report.mcc && (
              <Card title="Network Data">
                <div style={styles.detailRows}>
                  <DetailRow label="MCC" value={report.mcc} />
                  {report.carrier_name && (
                    <DetailRow label="Carrier" value={report.carrier_name} />
                  )}
                </div>
              </Card>
            )}

            {/* Flag history (all events including auto) */}
            <Card title="Flag History">
              <div style={styles.flagHistoryList}>
                {report.flag_events.map((event: FlagEvent) => (
                  <div key={event.id} style={styles.flagHistoryEvent}>
                    <div style={styles.flagHistoryLeft}>
                      <FlagPill flag={event.flag_to} />
                      <span style={styles.flagHistoryMeta}>
                        {event.changed_by === "auto" ? "Auto" : "Manual"}
                        {event.reason ? " — " + event.reason : ""}
                      </span>
                    </div>
                    <span style={styles.flagHistoryTime}>
                      {formatDateTime(event.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "20px 28px", overflow: "auto" },
  loading: { padding: 40, textAlign: "center", color: "#666" },

  backBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "7px 14px",
    background: "#fff",
    border: "1.5px solid #e0e8f0",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    color: "#1A2B4A",
    fontWeight: 500,
    marginBottom: 20,
  },

  // Section 1: header
  reportHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e8eef4",
    marginBottom: 12,
  },
  reportHeaderLeft: { display: "flex", flexDirection: "column", gap: 4 },
  reportHeaderRight: { display: "flex", alignItems: "center" },
  reportId: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
    fontFamily: "monospace",
  },
  reportSubmitted: { fontSize: 13, color: "#666" },

  flagPill: {
    display: "inline-block",
    padding: "4px 12px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 700,
    border: "1.5px solid",
  },

  // Flag controls
  flagControls: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "#fff",
    borderRadius: 10,
    padding: "12px 20px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
    border: "1px solid #e8eef4",
    marginBottom: 20,
    flexWrap: "wrap",
  },
  flagControlLabel: { fontSize: 13, color: "#666", fontWeight: 500 },
  flagBtnRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  flagBtn: {
    padding: "7px 16px",
    borderRadius: 6,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    transition: "all 0.12s",
  },

  // Grid layout
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 360px",
    gap: 20,
    alignItems: "start",
  },
  leftColumn: { display: "flex", flexDirection: "column", gap: 20 },
  rightColumn: { display: "flex", flexDirection: "column", gap: 20 },

  // Card
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "18px 22px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e8eef4",
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 14,
    paddingBottom: 10,
    borderBottom: "1px solid #f0f4f8",
  },
  cardTitleRow: {
    display: "flex",
    justifyContent: "flex-end",
    marginBottom: 10,
  },

  // Photos
  photoGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
  photo: {
    width: "100%",
    aspectRatio: "1",
    objectFit: "cover",
    borderRadius: 8,
    cursor: "pointer",
    border: "1px solid #e8eef4",
  },
  photoPlaceholder: {
    width: "100%",
    aspectRatio: "1",
    background: "#f4f6f9",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    color: "#aaa",
  },

  // Detail rows
  detailRows: { display: "flex", flexDirection: "column", gap: 0 },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "9px 0",
    borderBottom: "1px solid #f4f6f9",
    gap: 12,
  },
  detailLabel: { fontSize: 12, color: "#888", flexShrink: 0, paddingTop: 1 },
  detailValue: {
    fontSize: 13,
    color: "#1A2B4A",
    fontWeight: 500,
    textAlign: "right",
    wordBreak: "break-word",
  },

  // Links
  linkCell: {
    color: "#0468B1",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    fontFamily: "monospace",
  },
  mapsLink: {
    display: "inline-flex",
    alignItems: "center",
    color: "#0468B1",
    fontSize: 13,
    textDecoration: "none",
    fontWeight: 500,
  },

  // Description
  description: { fontSize: 13, color: "#444", lineHeight: 1.6 },
  translatedBox: { marginTop: 12, padding: 12, background: "#f4f6f9", borderRadius: 8 },
  translatedLabel: { fontSize: 11, color: "#666", marginBottom: 6, fontWeight: 600 },
  translateBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "5px 12px",
    background: "#E8F4FD",
    color: "#0468B1",
    border: "none",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
  },

  // Version history
  versionList: { display: "flex", flexDirection: "column", gap: 0 },
  versionRow: { borderBottom: "1px solid #f4f6f9" },
  versionRowHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 0",
    cursor: "pointer",
    flexWrap: "wrap",
  },
  versionDate: { fontSize: 12, color: "#666", flexShrink: 0 },
  versionDamage: { fontSize: 12, color: "#444", flex: 1 },
  viewReportBtn: {
    background: "none",
    border: "none",
    color: "#0468B1",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
    padding: 0,
  },
  versionExpanded: {
    display: "flex",
    gap: 12,
    padding: "8px 0 12px",
    fontSize: 12,
    color: "#555",
  },

  // Review log
  reviewLog: { display: "flex", flexDirection: "column", gap: 0 },
  reviewEntry: {
    padding: "12px 0",
    borderBottom: "1px solid #f4f6f9",
  },
  reviewEntryHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  reviewAction: { fontSize: 13, fontWeight: 600, color: "#1A2B4A" },
  reviewTime: { fontSize: 12, color: "#999" },
  reviewUser: { fontSize: 12, color: "#666", marginBottom: 4 },
  reviewComment: { fontSize: 13, color: "#444", lineHeight: 1.5 },

  // Flag reason
  flagReasonBanner: {
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid",
  },
  flagReasonCode: { fontSize: 13, fontWeight: 600, color: "#1A2B4A", marginBottom: 8 },
  flagReasonMeta: {
    fontSize: 11,
    color: "#555",
    background: "#f4f6f9",
    borderRadius: 6,
    padding: "8px 10px",
    overflowX: "auto",
    margin: 0,
  },

  // Flag history
  flagHistoryList: { display: "flex", flexDirection: "column", gap: 0 },
  flagHistoryEvent: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 0",
    borderBottom: "1px solid #f4f6f9",
    gap: 8,
    flexWrap: "wrap",
  },
  flagHistoryLeft: { display: "flex", alignItems: "center", gap: 8 },
  flagHistoryMeta: { fontSize: 12, color: "#666" },
  flagHistoryTime: { fontSize: 11, color: "#aaa", flexShrink: 0 },

  // Misc
  emptyText: { fontSize: 13, color: "#999", fontStyle: "italic" },
};
