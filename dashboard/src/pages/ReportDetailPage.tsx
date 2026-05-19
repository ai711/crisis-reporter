import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Globe,
  MapPin,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import Header from "../components/Header";
import FlagChangeModal from "../components/FlagChangeModal";
import ReviewPanel from "../components/ReviewPanel";
import api from "../services/api";
import { useAuthStore } from "../stores/authStore";
import type { ReportDetail, FlagStatus, FlagEvent, VersionHistoryItem, QuestionAnswer } from "../types";
import { formatDamageLevel, formatDateTime } from "../utils/formatters";

// ── Flag colour + label maps ──────────────────────────────────────────────────

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#9e9e9e",
  green: "#4caf50",
  orange: "#ff9800",
  red: "#f44336",
  discarded: "#616161",
};

const FLAG_LABELS: Record<string, string> = {
  grey: "Grey",
  green: "Green",
  orange: "Orange",
  red: "Red",
  discarded: "Discarded",
};

// ── Modal state shape ─────────────────────────────────────────────────────────

interface ModalState {
  open: boolean;
  actionLabel: string;
  fromStatus: string;
  toStatus: string;
  isEmergencyOverride: boolean;
  overrideTarget: "green" | "red";
}

const CLOSED_MODAL: ModalState = {
  open: false,
  actionLabel: "",
  fromStatus: "",
  toStatus: "",
  isEmergencyOverride: false,
  overrideTarget: "green",
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

// ── Flag Reason contextual detail (FIX 7) ─────────────────────────────────────

function FlagReasonDetail({
  flagEvents,
  flagColor,
}: {
  flagEvents: FlagEvent[];
  flagColor: string;
}) {
  const autoEvent = [...flagEvents]
    .reverse()
    .find((e) => e.changed_by === "auto" && e.flag_to === "red");

  if (!autoEvent) {
    return (
      <div style={{ ...styles.flagReasonBanner, borderColor: flagColor + "40", background: flagColor + "0d" }}>
        <span style={{ color: "#666", fontSize: 13 }}>No flag reason recorded.</span>
      </div>
    );
  }

  const meta = autoEvent.metadata as Record<string, unknown> | null;
  const reason = autoEvent.reason ?? "";

  const renderContent = () => {
    if (reason === "ip_country_mismatch") {
      return (
        <div style={styles.flagContextCard}>
          <div style={styles.flagContextRow}>
            <span style={styles.flagContextLabel}>Submission IP address</span>
            <span style={styles.flagContextValue}>{String(meta?.submission_ip ?? "—")}</span>
          </div>
          <div style={styles.flagContextRow}>
            <span style={styles.flagContextLabel}>IP geolocated country</span>
            <span style={styles.flagContextValue}>{String(meta?.geolocated_country ?? "—")}</span>
          </div>
          <div style={styles.flagContextRow}>
            <span style={styles.flagContextLabel}>Reporter-selected country</span>
            <span style={styles.flagContextValue}>{String(meta?.reporter_selected_country ?? "—")}</span>
          </div>
          <p style={styles.flagContextNote}>
            VPN usage may cause false positives for this check.
          </p>
        </div>
      );
    }

    if (reason === "same_ip_multiple_devices") {
      const matchingReporters = (meta?.matching_reporters as Array<{ reporter_id: string; device_id: string }>) ?? [];
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>Multiple device IDs from the same IP address.</p>
          {matchingReporters.length > 0 && (
            <table style={styles.flagContextTable}>
              <thead>
                <tr>
                  <th style={styles.flagContextTh}>Reporter ID</th>
                  <th style={styles.flagContextTh}>Device ID</th>
                </tr>
              </thead>
              <tbody>
                {matchingReporters.map((r, i) => (
                  <tr key={i}>
                    <td style={styles.flagContextTd}>
                      <button
                        style={styles.flagContextLink}
                        onClick={() => window.open(`/reporters/${r.reporter_id}`, "_blank")}
                      >
                        {r.reporter_id.slice(0, 8).toUpperCase()}
                      </button>
                    </td>
                    <td style={styles.flagContextTd}>{r.device_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      );
    }

    if (reason === "duplicate_image") {
      const matchingReportId = String(meta?.matching_report_id ?? "");
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>This photo has been submitted before.</p>
          {matchingReportId && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Matching report:{" "}
              <button
                style={styles.flagContextLink}
                onClick={() => window.open(`/reports/${matchingReportId}`, "_blank")}
              >
                {matchingReportId.slice(0, 8).toUpperCase()}
              </button>
            </p>
          )}
        </div>
      );
    }

    if (reason === "coordinated_gps_duplicate") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>
            Another reporter submitted from the same location recently.
          </p>
          {meta?.matching_reporter_id && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Reporter:{" "}
              <button
                style={styles.flagContextLink}
                onClick={() => window.open(`/reporters/${String(meta.matching_reporter_id)}`, "_blank")}
              >
                {String(meta.matching_reporter_id).slice(0, 8).toUpperCase()}
              </button>
            </p>
          )}
        </div>
      );
    }

    if (reason === "high_submission_rate") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>
            This reporter submitted an unusually high number of reports in a short time window.
          </p>
        </div>
      );
    }

    if (reason === "no_photos") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>
            This report has no photos attached. Photo evidence is required for verification.
          </p>
        </div>
      );
    }

    if (reason === "no_location") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>
            This report has no GPS coordinates or location information recorded.
          </p>
        </div>
      );
    }

    if (reason === "rule_2_ip_blocked_reporter_match") {
      const matchedReporterId = String(meta?.matched_blocked_reporter_id ?? "");
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>
            IP address matches a known blocked reporter profile.
          </p>
          {matchedReporterId && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Matched blocked reporter:{" "}
              <button
                style={styles.flagContextLink}
                onClick={() => window.open(`/reporters/${matchedReporterId}`, "_blank")}
              >
                {matchedReporterId}
              </button>
            </p>
          )}
          <p style={styles.flagContextNote}>
            Note: IP address matching may produce false positives in shared network
            environments (offices, hotels, cafes). Review the reporter profile before
            confirming the block.
          </p>
        </div>
      );
    }

    // Fallback — show raw reason
    return (
      <div style={styles.flagContextCard}>
        <p style={{ fontSize: 13, color: "#444", margin: 0 }}>{reason}</p>
        {meta && (
          <pre style={styles.flagReasonMeta}>
            {JSON.stringify(meta, null, 2)}
          </pre>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        ...styles.flagReasonBanner,
        borderColor: flagColor + "40",
        background: flagColor + "0d",
      }}
    >
      <div style={styles.flagReasonCode}>{reason}</div>
      {renderContent()}
    </div>
  );
}

// ── Flag action buttons (FIX 4) ───────────────────────────────────────────────

function FlagActionButtons({
  flagStatus,
  isSuperadmin,
  onAction,
  onEmergencyOverride,
  isPending,
}: {
  flagStatus: string;
  isSuperadmin: boolean;
  onAction: (actionLabel: string, toStatus: string) => void;
  onEmergencyOverride: () => void;
  isPending: boolean;
}) {
  if (flagStatus === "grey") {
    if (!isSuperadmin) return null;
    return (
      <button
        style={{ ...styles.emergencyBtn, opacity: isPending ? 0.6 : 1 }}
        onClick={onEmergencyOverride}
        disabled={isPending}
      >
        <AlertTriangle size={14} style={{ marginRight: 6, flexShrink: 0 }} />
        Emergency Override
      </button>
    );
  }

  if (flagStatus === "green") {
    return (
      <span style={styles.noActionLabel}>
        No actions available — report has passed all checks.
      </span>
    );
  }

  if (flagStatus === "red") {
    return (
      <div style={styles.actionBtnRow}>
        <button
          style={{ ...styles.approveBtn, opacity: isPending ? 0.6 : 1 }}
          onClick={() => onAction("Approve", "orange")}
          disabled={isPending}
        >
          Approve
        </button>
        <button
          style={{ ...styles.discardBtn, opacity: isPending ? 0.6 : 1 }}
          onClick={() => onAction("Discard", "discarded")}
          disabled={isPending}
        >
          Discard
        </button>
      </div>
    );
  }

  if (flagStatus === "orange") {
    return (
      <span style={styles.noActionLabel}>
        No actions available — report is approved.
      </span>
    );
  }

  if (flagStatus === "discarded") {
    return (
      <button
        style={{ ...styles.reinstateBtn, opacity: isPending ? 0.6 : 1 }}
        onClick={() => onAction("Reinstate", "orange")}
        disabled={isPending}
      >
        Reinstate
      </button>
    );
  }

  return null;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);

  return <div style={styles.toast}>{message}</div>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const isSuperadmin = user?.role === "superadmin";
  const isFromQueue = searchParams.get("from") === "queue";

  const [translating, setTranslating] = useState(false);
  const [modal, setModal] = useState<ModalState>(CLOSED_MODAL);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { data: report, isLoading } = useQuery<ReportDetail>({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const res = await api.get(`/api/dashboard/reports/${reportId}`);
      return res.data;
    },
    enabled: !!reportId,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["report", reportId] });
    queryClient.invalidateQueries({ queryKey: ["reports"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    queryClient.invalidateQueries({ queryKey: ["map-pins"] });
  }

  function handleDecisionComplete() {
    queryClient.invalidateQueries({ queryKey: ["review-queue-counts"] });
    queryClient.invalidateQueries({ queryKey: ["review-queue-tab1"] });
    invalidateAll();
    setToast("Review decision submitted.");
  }

  const flagMutation = useMutation({
    mutationFn: async ({ flagStatus, reason }: { flagStatus: string; reason: string }) => {
      await api.patch(`/api/dashboard/reports/${reportId}/flag`, {
        flag_status: flagStatus,
        reason,
      });
    },
    onSuccess: () => {
      invalidateAll();
      setModal(CLOSED_MODAL);
      setModalError(null);
      setToast("Flag status updated.");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "An error occurred. Please try again.";
      setModalError(msg);
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async ({
      targetStatus,
      reason,
    }: {
      targetStatus: string;
      reason: string;
    }) => {
      await api.post(`/api/dashboard/reports/${reportId}/emergency-override`, {
        target_status: targetStatus,
        reason,
      });
    },
    onSuccess: () => {
      invalidateAll();
      setModal(CLOSED_MODAL);
      setModalError(null);
      setToast("Emergency override applied.");
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "An error occurred. Please try again.";
      setModalError(msg);
    },
  });

  function openActionModal(actionLabel: string, toStatus: string) {
    setModalError(null);
    setModal({
      open: true,
      actionLabel,
      fromStatus: report?.flag_status ?? "",
      toStatus,
      isEmergencyOverride: false,
      overrideTarget: "green",
    });
  }

  function openEmergencyModal() {
    setModalError(null);
    setModal({
      open: true,
      actionLabel: "Emergency Override",
      fromStatus: "grey",
      toStatus: "",
      isEmergencyOverride: true,
      overrideTarget: "green",
    });
  }

  function handleModalConfirm(comment: string) {
    if (modal.isEmergencyOverride) {
      overrideMutation.mutate({ targetStatus: modal.overrideTarget, reason: comment });
    } else {
      flagMutation.mutate({ flagStatus: modal.toStatus, reason: comment });
    }
  }

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
  const isActionPending = flagMutation.isPending || overrideMutation.isPending;

  // Review log: manual events only
  const reviewLogEvents = report.flag_events.filter((e) => e.changed_by === "manual");

  // Extract flag reasons and metadata from auto red-flag events for ReviewPanel
  const autoRedEvents = report.flag_events.filter(
    (e) => e.changed_by === "auto" && e.flag_to === "red"
  );
  const flagReasons: string[] = [
    ...new Set(
      autoRedEvents.map((e) => e.reason).filter((r): r is string => r !== null)
    ),
  ];
  const flagMetadata: Record<string, Record<string, unknown> | null> = {};
  autoRedEvents.forEach((e) => {
    if (e.reason && !(e.reason in flagMetadata)) {
      flagMetadata[e.reason] = e.metadata as Record<string, unknown> | null;
    }
  });

  return (
    <div style={styles.container}>
      <Header
        title="Report Detail"
        subtitle={`ID: ${report.id.slice(0, 8).toUpperCase()}`}
      />

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* Flag change modal */}
      <FlagChangeModal
        isOpen={modal.open}
        onClose={() => { setModal(CLOSED_MODAL); setModalError(null); }}
        actionLabel={modal.actionLabel}
        fromStatus={modal.fromStatus}
        toStatus={modal.toStatus}
        onConfirm={handleModalConfirm}
        isSubmitting={isActionPending}
        error={modalError}
        isEmergencyOverride={modal.isEmergencyOverride}
        overrideTarget={modal.overrideTarget}
        onOverrideTargetChange={(t) => setModal((m) => ({ ...m, overrideTarget: t }))}
      />

      <div style={styles.content}>
        <button style={styles.backBtn} onClick={() => navigate("/reports")}>
          <ArrowLeft size={15} style={{ marginRight: 6 }} />
          Back to Reports
        </button>

        {/* Review panel — shown for all Red-flagged reports */}
        {report.flag_status === "red" && (
          <ReviewPanel
            reportId={report.id}
            flagReasons={flagReasons}
            flagMetadata={flagMetadata}
            isFromQueue={isFromQueue}
            onDecisionComplete={handleDecisionComplete}
          />
        )}

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

        {/* Flag action controls (FIX 4) */}
        <div style={styles.flagControls}>
          <span style={styles.flagControlLabel}>Actions:</span>
          <FlagActionButtons
            flagStatus={report.flag_status}
            isSuperadmin={isSuperadmin}
            onAction={openActionModal}
            onEmergencyOverride={openEmergencyModal}
            isPending={isActionPending}
          />
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
                          {e.is_emergency_override && (
                            <span style={styles.emergencyOverrideBadge}>
                              ⚠ Superadmin Emergency Override
                            </span>
                          )}
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

            {/* Section 7: Flag reason contextual detail (FIX 7) */}
            {(report.flag_status === "red" || report.flag_status === "discarded") && (
              <Card title="Flag Reason">
                <FlagReasonDetail flagEvents={report.flag_events} flagColor={flagColor} />
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
                        {event.is_emergency_override ? " (Override)" : ""}
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

  // Flag action controls
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
    minHeight: 52,
  },
  flagControlLabel: { fontSize: 13, color: "#666", fontWeight: 500 },
  actionBtnRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  noActionLabel: { fontSize: 13, color: "#999", fontStyle: "italic" },

  approveBtn: {
    padding: "7px 18px",
    background: "#fff",
    color: "#4caf50",
    border: "1.5px solid #4caf50",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    transition: "all 0.12s",
  },
  discardBtn: {
    padding: "7px 18px",
    background: "#fff",
    color: "#f44336",
    border: "1.5px solid #f44336",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    transition: "all 0.12s",
  },
  reinstateBtn: {
    padding: "7px 18px",
    background: "#fff",
    color: "#ff9800",
    border: "1.5px solid #ff9800",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    transition: "all 0.12s",
  },
  emergencyBtn: {
    display: "inline-flex",
    alignItems: "center",
    padding: "7px 18px",
    background: "#fff3e0",
    color: "#FF9800",
    border: "1.5px solid #FF9800",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
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
    alignItems: "flex-start",
    marginBottom: 4,
    gap: 8,
  },
  reviewAction: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A2B4A",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  emergencyOverrideBadge: {
    fontSize: 11,
    fontWeight: 700,
    color: "#b71c1c",
    background: "#ffebee",
    borderRadius: 4,
    padding: "2px 6px",
    display: "inline-block",
    marginBottom: 2,
  },
  reviewTime: { fontSize: 12, color: "#999", flexShrink: 0 },
  reviewUser: { fontSize: 12, color: "#666", marginBottom: 4 },
  reviewComment: { fontSize: 13, color: "#444", lineHeight: 1.5 },

  // Flag reason
  flagReasonBanner: {
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid",
  },
  flagReasonCode: {
    fontSize: 12,
    fontWeight: 700,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  flagReasonMeta: {
    fontSize: 11,
    color: "#555",
    background: "#f4f6f9",
    borderRadius: 6,
    padding: "8px 10px",
    overflowX: "auto",
    margin: 0,
  },

  // Flag reason contextual cards
  flagContextCard: {
    fontSize: 13,
    color: "#333",
  },
  flagContextRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid #f0f0f0",
    gap: 8,
  },
  flagContextLabel: { fontSize: 12, color: "#888", flexShrink: 0 },
  flagContextValue: { fontSize: 13, color: "#1A2B4A", fontWeight: 500, fontFamily: "monospace" },
  flagContextNote: {
    fontSize: 11,
    color: "#888",
    fontStyle: "italic",
    marginTop: 8,
    marginBottom: 0,
  },
  flagContextHeader: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A2B4A",
    margin: "0 0 8px",
  },
  flagContextTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
    marginTop: 4,
  },
  flagContextTh: {
    textAlign: "left",
    padding: "5px 8px",
    background: "#f4f6f9",
    fontWeight: 700,
    color: "#666",
    fontSize: 11,
    textTransform: "uppercase",
  },
  flagContextTd: {
    padding: "6px 8px",
    borderBottom: "1px solid #f0f0f0",
    color: "#333",
  },
  flagContextLink: {
    background: "none",
    border: "none",
    color: "#0468B1",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: 600,
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
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

  // Toast
  toast: {
    position: "fixed",
    bottom: 28,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1A2B4A",
    color: "#fff",
    padding: "10px 22px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    zIndex: 999,
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
  },

  // Misc
  emptyText: { fontSize: 13, color: "#999", fontStyle: "italic" },
};
