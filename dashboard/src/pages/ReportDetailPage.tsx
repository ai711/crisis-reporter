import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  Globe,
  MapPin,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  X,
  CheckCircle2,
  User,
} from "lucide-react";
import Header from "../components/Header";
import PageSpinner from "../components/PageSpinner";
import ErrorState from "../components/ErrorState";
import FlagChangeModal from "../components/FlagChangeModal";
import ReviewPanel from "../components/ReviewPanel";
import api from "../services/api";
import { useAuthStore } from "../stores/authStore";
import { useHasAccess } from "../hooks/useHasAccess";
import type { ReportDetail, FlagStatus, FlagEvent, VersionHistoryItem, QuestionAnswer, ReportProjectRef } from "../types";
import { formatDamageLevel, formatDateTime, toTitleCase } from "../utils/formatters";
import { usePageTitle } from "../hooks/usePageTitle";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || "";

// ── Colour maps (design system) ───────────────────────────────────────────────

const FLAG_COLORS: Record<FlagStatus, string> = {
  grey: "#717782",
  green: "#005a2c",
  orange: "#f97316",
  red: "#ba1a1a",
  discarded: "#616161",
};

const FLAG_LABELS: Record<string, string> = {
  grey: "Grey",
  green: "Green",
  orange: "Orange",
  red: "Red",
  discarded: "Discarded",
};

const DAMAGE_LEVEL_COLORS: Record<string, string> = {
  completely_destroyed: "#ba1a1a",
  partially_damaged: "#f97316",
  minimal_or_no_damage: "#005a2c",
  complete: "#ba1a1a",
  partial: "#f97316",
  minimal: "#005a2c",
};

// ── Modal state ───────────────────────────────────────────────────────────────

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

// ── Authenticated photo ───────────────────────────────────────────────────────

function useAuthPhoto(reportId: string, photoId: string) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    setBlobUrl(null);
    api
      .get(`/api/dashboard/reports/${reportId}/photos/${photoId}`, { responseType: "blob" })
      .then((res) => {
        objectUrl = URL.createObjectURL(res.data as Blob);
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        const status = err?.response?.status ?? "network error";
        console.error(`[Photo] Failed to load photo ${photoId} for report ${reportId}: HTTP ${status}`);
        setBlobUrl("error");
      });
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, photoId]);

  return blobUrl;
}

function AuthPhoto({ reportId, photoId }: { reportId: string; photoId: string }) {
  const blobUrl = useAuthPhoto(reportId, photoId);
  if (!blobUrl) {
    return (
      <div style={{ width: "100%", height: "100%", background: "#f2f4f7", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#c1c7d2" strokeWidth={1.5}>
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="m21 15-5-5L5 21"/>
        </svg>
        <span style={{ fontSize: 10, color: "#9ca3af" }}>Loading…</span>
      </div>
    );
  }
  if (blobUrl === "error") {
    return (
      <div style={{ width: "100%", height: "100%", background: "#fef2f2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth={1.5}>
          <circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>
        </svg>
        <span style={{ fontSize: 10, color: "#ef4444" }}>Photo unavailable</span>
      </div>
    );
  }
  return (
    <a href={blobUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block", width: "100%", height: "100%" }}>
      <img src={blobUrl} style={styles.photo} alt="Damage photo" />
    </a>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FlagPill({ flag }: { flag: string }) {
  const color = FLAG_COLORS[flag as FlagStatus] ?? "#717782";
  return (
    <span style={{ ...styles.flagPill, background: color + "18", color, border: "none" }}>
      {FLAG_LABELS[flag] ?? flag}
    </span>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
      <h3 style={styles.sectionTitle}>{children}</h3>
      {aside && <span style={{ fontSize: 10, color: "#717782" }}>{aside}</span>}
    </div>
  );
}

function DamageField({ label, value, accentColor = "#e6e8eb" }: { label: string; value: React.ReactNode; accentColor?: string }) {
  const isColored = accentColor !== "#e6e8eb";
  return (
    <div style={{ borderLeft: `2px solid ${accentColor}`, paddingLeft: 14 }}>
      <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#717782", margin: "0 0 5px" }}>{label}</p>
      <p style={{ fontSize: 13, fontWeight: 700, color: isColored ? accentColor : "#191c1e", margin: 0 }}>{value || "—"}</p>
    </div>
  );
}

function ImpactRow({ icon, title, value, isLast = false }: { icon: string; title: string; value: React.ReactNode; isLast?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 14, paddingBottom: isLast ? 0 : 14, marginBottom: isLast ? 0 : 14, borderBottom: isLast ? "none" : "1px solid rgba(193,199,210,0.2)" }}>
      <span className="material-symbols-outlined" style={{ fontSize: 18, flexShrink: 0, color: "var(--c-primary-container)", fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>{icon}</span>
      <div>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#191c1e", margin: "0 0 3px" }}>{title}</p>
        <p style={{ fontSize: 12, color: "#717782", lineHeight: 1.55, margin: 0 }}>{value || "—"}</p>
      </div>
    </div>
  );
}

function MetaRow({ label, value, mono = false, noBorder = false }: { label: string; value: React.ReactNode; mono?: boolean; noBorder?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: noBorder ? "none" : "1px solid rgba(193,199,210,0.15)", gap: 12 }}>
      <span style={{ fontSize: 12, color: "#717782", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: "#191c1e", fontFamily: mono ? "monospace" : undefined, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
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

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={styles.detailRow}>
      <span style={styles.detailLabel}>{label}</span>
      <span style={styles.detailValue}>{value ?? <em style={{ color: "#9ca3af" }}>Not recorded</em>}</span>
    </div>
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
          onClick={(e) => { e.stopPropagation(); window.open(`/reports/${item.id}`, "_blank"); }}
        >
          View →
        </button>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {expanded && (
        <div style={styles.versionExpanded}>
          <span style={styles.detailLabel}>Infrastructure:</span>
          <span style={styles.detailValue}>{toTitleCase(item.infrastructure_type)}</span>
        </div>
      )}
    </div>
  );
}

// ── Flag Reason contextual detail ─────────────────────────────────────────────

function FlagReasonDetail({ flagEvents, flagColor }: { flagEvents: FlagEvent[]; flagColor: string }) {
  const autoEvent = [...flagEvents].reverse().find((e) => e.changed_by === "auto" && e.flag_to === "red");

  if (!autoEvent) {
    return <span style={{ color: "#717782", fontSize: 13 }}>No flag reason recorded.</span>;
  }

  const meta = autoEvent.metadata as Record<string, unknown> | null;
  const reason = autoEvent.reason ?? "";

  const renderContent = () => {
    if (reason === "ip_country_mismatch") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>IP country mismatch detected</p>
          <div style={styles.flagContextRow}>
            <span style={styles.flagContextLabel}>Submission IP</span>
            <span style={styles.flagContextValue}>{String(meta?.submission_ip ?? "—")}</span>
          </div>
          <div style={styles.flagContextRow}>
            <span style={styles.flagContextLabel}>IP-geolocated country</span>
            <span style={styles.flagContextValue}>{String(meta?.geolocated_country ?? "—")}</span>
          </div>
          <div style={{ ...styles.flagContextRow, borderBottom: "none" }}>
            <span style={styles.flagContextLabel}>Reporter-selected country</span>
            <span style={styles.flagContextValue}>{String(meta?.reporter_selected_country ?? "—")}</span>
          </div>
          <p style={styles.flagContextNote}>VPN usage may cause false positives for this check.</p>
        </div>
      );
    }

    if (reason === "same_ip_multiple_devices") {
      // Backend stores other_reporter_ids as a plain string array
      const otherReporterIds = (meta?.other_reporter_ids as string[]) ?? [];
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>Multiple device IDs from the same IP address.</p>
          <p style={{ fontSize: 12, color: "#717782", margin: "0 0 10px" }}>
            {otherReporterIds.length} other reporter{otherReporterIds.length !== 1 ? "s" : ""} submitted from this IP within 24 hours.
          </p>
          {otherReporterIds.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {otherReporterIds.map((reporterId, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    style={styles.flagContextLink}
                    onClick={() => window.open(`/reporters/${reporterId}`, "_blank")}
                  >
                    {reporterId.slice(0, 8).toUpperCase()} ↗
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (reason === "duplicate_image") {
      const matchingReportId = String(meta?.matching_report_id ?? "");
      const matchingSerialNumber = meta?.matching_report_serial_number;
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>This photo has been submitted before.</p>
          {matchingReportId && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Matching report:{" "}
              <button style={styles.flagContextLink} onClick={() => window.open(`/reports/${matchingReportId}`, "_blank")}>
                {matchingSerialNumber != null ? `#${matchingSerialNumber}` : matchingReportId.slice(0, 8).toUpperCase()}
              </button>
            </p>
          )}
        </div>
      );
    }

    if (reason === "coordinated_gps_duplicate") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>Another reporter submitted from the same location recently.</p>
          {!!meta?.matching_reporter_id && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Reporter:{" "}
              <button style={styles.flagContextLink} onClick={() => window.open(`/reporters/${String(meta.matching_reporter_id)}`, "_blank")}>
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
          <p style={styles.flagContextHeader}>This reporter submitted an unusually high number of reports in a short time window.</p>
        </div>
      );
    }

    if (reason === "no_photos") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>This report has no photos attached. Photo evidence is required for verification.</p>
        </div>
      );
    }

    if (reason === "no_location") {
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>This report has no GPS coordinates or location information recorded.</p>
        </div>
      );
    }

    if (reason === "rule_2_ip_blocked_reporter_match") {
      const matchedReporterId = String(meta?.matched_blocked_reporter_id ?? "");
      return (
        <div style={styles.flagContextCard}>
          <p style={styles.flagContextHeader}>IP address matches a known blocked reporter profile.</p>
          {matchedReporterId && (
            <p style={{ fontSize: 13, margin: "6px 0 0" }}>
              Matched reporter:{" "}
              <button style={styles.flagContextLink} onClick={() => window.open(`/reporters/${matchedReporterId}`, "_blank")}>
                {matchedReporterId}
              </button>
            </p>
          )}
          <p style={styles.flagContextNote}>IP matching may produce false positives in shared networks.</p>
        </div>
      );
    }

    return (
      <div style={styles.flagContextCard}>
        <p style={{ fontSize: 13, color: "#414751", margin: 0 }}>{reason}</p>
        {meta && <pre style={styles.flagReasonMeta}>{JSON.stringify(meta, null, 2)}</pre>}
      </div>
    );
  };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: flagColor, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, fontFamily: "monospace" }}>
        {reason}
      </div>
      {renderContent()}
    </div>
  );
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
  const canEditReports = useHasAccess("reports_page", true);
  const isFromQueue = searchParams.get("from") === "queue";

  const [translating, setTranslating] = useState(false);
  const [modal, setModal] = useState<ModalState>(CLOSED_MODAL);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState<any>({});
  const [editReason, setEditReason] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [reportEdits, setReportEdits] = useState<any[]>([]);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeReason, setMergeReason] = useState('');
  const [mergeSaving, setMergeSaving] = useState(false);
  const [activeHistoryTab, setActiveHistoryTab] = useState<"version" | "review">("version");

  const { data: report, isLoading } = useQuery<ReportDetail>({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const res = await api.get(`/api/dashboard/reports/${reportId}`);
      return res.data;
    },
    enabled: !!reportId,
  });

  usePageTitle(report?.serial_number != null ? `Report #${report.serial_number}` : "Report Detail");

  useEffect(() => {
    if (report?.id) {
      api.get(`/api/reports/${report.id}/edits`)
        .then(r => setReportEdits(r.data))
        .catch(() => {});
    }
  }, [report?.id]);

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
      await api.patch(`/api/dashboard/reports/${reportId}/flag`, { flag_status: flagStatus, reason });
    },
    onSuccess: () => { invalidateAll(); setModal(CLOSED_MODAL); setModalError(null); setToast("Flag status updated."); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "An error occurred.";
      setModalError(msg);
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async ({ targetStatus, reason }: { targetStatus: string; reason: string }) => {
      await api.post(`/api/dashboard/reports/${reportId}/emergency-override`, { target_status: targetStatus, reason });
    },
    onSuccess: () => { invalidateAll(); setModal(CLOSED_MODAL); setModalError(null); setToast("Emergency override applied."); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "An error occurred.";
      setModalError(msg);
    },
  });

  function openActionModal(actionLabel: string, toStatus: string) {
    setModalError(null);
    setModal({ open: true, actionLabel, fromStatus: report?.flag_status ?? "", toStatus, isEmergencyOverride: false, overrideTarget: "green" });
  }

  function openEmergencyModal() {
    setModalError(null);
    setModal({ open: true, actionLabel: "Emergency Override", fromStatus: "grey", toStatus: "", isEmergencyOverride: true, overrideTarget: "green" });
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
      await api.post(`/api/dashboard/reports/${reportId}/translate`, { target_language: "en" });
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
    } catch { /* translation service unavailable */ } finally { setTranslating(false); }
  };

  if (isLoading) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <PageSpinner label="Loading report…" />
      </div>
    );
  }

  if (!report) {
    return (
      <div style={styles.container}>
        <Header title="Report Detail" />
        <ErrorState message="Report not found. It may have been deleted or the ID is incorrect." />
      </div>
    );
  }

  const flagColor = FLAG_COLORS[report.flag_status as FlagStatus] ?? "#717782";
  const damageLevelColor = DAMAGE_LEVEL_COLORS[report.damage_level] ?? "#e6e8eb";
  const isActionPending = flagMutation.isPending || overrideMutation.isPending;
  const reviewLogEvents = report.flag_events.filter((e) => e.changed_by === "manual");

  const autoRedEvents = report.flag_events.filter((e) => e.changed_by === "auto" && e.flag_to === "red");
  const flagReasons: string[] = [...new Set(autoRedEvents.map((e) => e.reason).filter((r): r is string => r !== null))];
  const flagMetadata: Record<string, Record<string, unknown> | null> = {};
  autoRedEvents.forEach((e) => { if (e.reason && !(e.reason in flagMetadata)) flagMetadata[e.reason] = e.metadata as Record<string, unknown> | null; });

  const matchedReportId: string | null = (() => {
    for (const reason of ['duplicate_image', 'coordinated_gps_duplicate']) {
      const meta = flagMetadata[reason];
      if (meta?.matching_report_id) return String(meta.matching_report_id);
    }
    return null;
  })();

  const matchedReportSerialNumber: number | null = (() => {
    for (const reason of ['duplicate_image', 'coordinated_gps_duplicate']) {
      const meta = flagMetadata[reason];
      if (meta?.matching_report_serial_number != null) return meta.matching_report_serial_number as number;
    }
    return null;
  })();

  const reportLabel = `#${report.serial_number ?? report.id.slice(0, 8).toUpperCase()}`;

  // ── Extract Q values from question_answers ─────────────────────────────────
  // The reporter app stores all answers in question_answers (structured format).
  // Top-level DB columns (electricity_condition etc.) are null for new submissions.
  const getQ = (order: number): QuestionAnswer | undefined =>
    (report.question_answers ?? []).find((qa) => qa.question_order === order);

  const q3 = getQ(3);  // Infrastructure name (free_text)
  const q5 = getQ(5);  // Debris blocking (option_text)
  const q6 = getQ(6);  // Electricity condition
  const q7 = getQ(7);  // Health services condition
  const q8 = getQ(8);  // Pressing needs (multi-select)

  const infrastructureNameFromQA = q3?.free_text ?? null;
  const debrisBlockingFromQA = q5?.option_text ?? (q5?.option_value === "yes" ? "Yes" : q5?.option_value === "no" ? "No" : null);
  const electricityValue = q6?.option_text ?? q6?.option_value ?? null;
  const healthValue = q7?.option_text ?? q7?.option_value ?? null;
  const pressingNeedsValue = (() => {
    if (!q8) return null;
    const parts: string[] = [];
    if (q8.option_texts && q8.option_texts.length > 0) parts.push(...q8.option_texts);
    else if (q8.option_values && q8.option_values.length > 0) parts.push(...q8.option_values);
    if (q8.other_text) parts.push(q8.other_text);
    return parts.length > 0 ? parts.join(", ") : null;
  })();

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      <Header title="Reports" subtitle={`Report ${reportLabel}`} />

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

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

        {/* ── Breadcrumb + Action bar ──────────────────────────────────── */}
        <div style={styles.topBar}>
          <nav style={styles.breadcrumb}>
            <button style={styles.breadcrumbLink} onClick={() => navigate("/reports")}>Reports</button>
            <ChevronRight size={14} color="#9ca3af" />
            <span style={styles.breadcrumbCurrent}>{reportLabel}</span>
          </nav>
          <div style={styles.actionBar}>
            {canEditReports && report.flag_status === "red" && (
              <>
                <button
                  style={{ ...styles.discardReportBtn, opacity: isActionPending ? 0.6 : 1 }}
                  disabled={isActionPending}
                  onClick={() => openActionModal("Discard", "discarded")}
                >
                  <X size={16} /> Discard Report
                </button>
                <button
                  style={{ ...styles.approveReportBtn, opacity: isActionPending ? 0.6 : 1 }}
                  disabled={isActionPending}
                  onClick={() => openActionModal("Approve", "orange")}
                >
                  <CheckCircle2 size={16} /> Approve Report
                </button>
              </>
            )}
            {canEditReports && report.flag_status === "grey" && isSuperadmin && (
              <button
                style={{ ...styles.emergencyOverrideBtn, opacity: isActionPending ? 0.6 : 1 }}
                disabled={isActionPending}
                onClick={openEmergencyModal}
              >
                <AlertTriangle size={14} /> Emergency Override
              </button>
            )}
            {canEditReports && report.flag_status === "discarded" && (
              <button
                style={{ ...styles.reinstateBtn, opacity: isActionPending ? 0.6 : 1 }}
                disabled={isActionPending}
                onClick={() => openActionModal("Reinstate", "orange")}
              >
                Reinstate
              </button>
            )}
            {canEditReports && (
              <button style={styles.editBtn} onClick={() => setShowEditModal(true)}>
                ✏ Edit Report
              </button>
            )}
          </div>
        </div>

        {/* Review panel (red reports only) */}
        {report.flag_status === "red" && canEditReports && (
          <ReviewPanel
            reportId={report.id}
            flagReasons={flagReasons}
            flagMetadata={flagMetadata}
            isFromQueue={isFromQueue}
            onDecisionComplete={handleDecisionComplete}
          />
        )}

        {/* ── Two-column grid ─────────────────────────────────────────── */}
        <div style={styles.grid}>

          {/* ── LEFT column ─────────────────────────────────────────────── */}
          <div style={styles.leftColumn}>

            {/* Primary card: accent bar + all main sections */}
            <div style={styles.primaryCard}>
              <div style={{ width: 4, background: flagColor, flexShrink: 0, borderRadius: "0 0 0 0" }} />
              <div style={{ flex: 1, padding: "28px 32px" }}>

                {/* Field Documentation */}
                <section style={styles.primarySection}>
                  <SectionTitle aside={`${report.photos.length} Asset${report.photos.length !== 1 ? "s" : ""} Attached`}>
                    Field Documentation
                  </SectionTitle>
                  {report.photos.length === 0 ? (
                    <p style={styles.emptyText}>No photos attached.</p>
                  ) : (
                    <div style={styles.photoGrid}>
                      {report.photos.map((photo, i) => (
                        <div key={photo.id} style={styles.photoWrapper}>
                          <AuthPhoto reportId={report.id} photoId={photo.id} />
                          <div style={styles.photoOverlay}>
                            <span style={styles.photoLabel}>Photo {i + 1}</span>
                            {photo.exif_timestamp && (
                              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.75)", display: "block", marginTop: 2 }}>
                                📷 {new Date(photo.exif_timestamp).toLocaleString()}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Photo metadata */}
                  {report.photo_metadata && (() => {
                    try {
                      const meta = JSON.parse(report.photo_metadata) as Array<{ original_size_kb?: number; final_size_kb?: number; compression_ratio?: string; mime_type?: string }>;
                      if (!Array.isArray(meta) || meta.length === 0) return null;
                      return (
                        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {meta.map((p, i) => (
                            <span key={i} style={{ fontSize: 10, color: "#717782", background: "#f2f4f7", borderRadius: 4, padding: "3px 7px" }}>
                              Photo {i + 1}: {p.original_size_kb ? `${p.original_size_kb}KB → ${p.final_size_kb}KB` : ""}
                              {p.compression_ratio ? ` (${p.compression_ratio})` : ""}
                              {p.mime_type ? ` · ${p.mime_type}` : ""}
                            </span>
                          ))}
                        </div>
                      );
                    } catch { return null; }
                  })()}
                </section>

                {/* Geospatial Intelligence */}
                <section style={styles.primarySection}>
                  <SectionTitle>Geospatial Intelligence</SectionTitle>
                  <div style={styles.mapArea}>
                    {report.gps_latitude && report.gps_longitude && MAPTILER_KEY ? (
                      <>
                        <img
                          src={`https://api.maptiler.com/maps/streets/static/${report.gps_longitude.toFixed(5)},${report.gps_latitude.toFixed(5)},15/680x220.png?key=${MAPTILER_KEY}`}
                          alt="Location map"
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                        {/* Coordinate overlay card */}
                        <div style={styles.mapOverlayCard}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <MapPin size={16} color="#ba1a1a" style={{ flexShrink: 0, marginTop: 2 }} />
                            <div>
                              {report.infrastructure_name && (
                                <p style={{ fontSize: 12, fontWeight: 700, color: "#191c1e", margin: "0 0 3px" }}>
                                  {report.infrastructure_name}
                                </p>
                              )}
                              {report.location_address && (
                                <p style={{ fontSize: 11, color: "#717782", margin: "0 0 6px", lineHeight: 1.4 }}>
                                  {report.location_address}
                                </p>
                              )}
                              <p style={{ fontSize: 10, fontFamily: "monospace", color: "var(--c-primary)", fontWeight: 700, margin: 0 }}>
                                {report.gps_latitude.toFixed(5)}°, {report.gps_longitude.toFixed(5)}°
                              </p>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div style={styles.mapPlaceholder}>
                        <MapPin size={36} color="#c1c7d2" />
                        <span style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
                          {report.gps_latitude ? "Location recorded" : "No GPS coordinates"}
                        </span>
                      </div>
                    )}
                  </div>
                  {report.gps_latitude && report.gps_longitude ? (
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
                      <a
                        href={`https://www.google.com/maps?q=${report.gps_latitude},${report.gps_longitude}`}
                        target="_blank" rel="noopener noreferrer"
                        style={styles.mapsLink}
                      >
                        <MapPin size={13} style={{ flexShrink: 0 }} /> Open in Google Maps
                      </a>
                      {report.property_id && (
                        <a
                          href={`/locations/${report.property_id}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ ...styles.mapsLink, color: "#005a2c" }}
                          onClick={(e) => { e.preventDefault(); window.open(`/locations/${report.property_id}`, "_blank"); }}
                        >
                          <Globe size={13} style={{ flexShrink: 0 }} /> View Full Location Page
                        </a>
                      )}
                    </div>
                  ) : (
                    <p style={styles.emptyText}>No GPS coordinates recorded.</p>
                  )}
                  {report.building_centroid_lat && report.building_centroid_lng && (
                    <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 6, margin: "6px 0 0", fontFamily: "monospace" }}>
                      Centroid: {report.building_centroid_lat.toFixed(6)}° N, {report.building_centroid_lng.toFixed(6)}° E
                    </p>
                  )}
                  {report.location_landmark && (
                    <p style={{ fontSize: 12, color: "#717782", marginTop: 6 }}>Landmark: {report.location_landmark}</p>
                  )}
                </section>

                {/* Damage Assessment Matrix */}
                <section style={styles.primarySection}>
                  <SectionTitle>Damage Assessment Matrix</SectionTitle>
                  <div style={styles.damageGrid}>
                    <DamageField
                      label="Damage Level"
                      value={formatDamageLevel(report.damage_level)}
                      accentColor={damageLevelColor}
                    />
                    <DamageField label="Infrastructure Type" value={report.infrastructure_type ? toTitleCase(report.infrastructure_type) : undefined} />
                    {(report.infrastructure_name || infrastructureNameFromQA) && (
                      <DamageField label="Entity Name" value={report.infrastructure_name ?? infrastructureNameFromQA} />
                    )}
                    <DamageField label="Disaster Category" value={report.disaster_type ? toTitleCase(report.disaster_type) : undefined} />
                    {(report.debris_blocking || debrisBlockingFromQA) && (
                      <DamageField
                        label="Debris Presence"
                        value={
                          (report.debris_blocking === "yes" || debrisBlockingFromQA === "Yes")
                            ? "Yes (Hazardous)"
                            : "No"
                        }
                      />
                    )}
                    {report.language_code && (
                      <DamageField label="Report Language" value={report.language_code.toUpperCase()} />
                    )}
                  </div>
                </section>

                {/* Community Impact Brief */}
                <section style={{ ...styles.primarySection, marginBottom: 0, paddingBottom: 0, borderBottom: "none" }}>
                  <SectionTitle>Community Impact Brief</SectionTitle>
                  <div style={styles.impactCard}>
                    <ImpactRow icon="bolt" title="Electricity" value={electricityValue} />
                    <ImpactRow icon="local_hospital" title="Health Services" value={healthValue} />
                    <ImpactRow icon="priority_high" title="Priority Needs" value={pressingNeedsValue} isLast />
                  </div>
                </section>

              </div>
            </div>

            {/* Q&A Responses */}
            {report.question_answers && report.question_answers.length > 0 && (
              <Card title="Responses">
                <div style={styles.detailRows}>
                  {report.question_answers.map((qa: QuestionAnswer, i: number) => {
                    // New structured format: question_order + option_text / option_texts / free_text
                    const Q_LABELS: Record<number, string> = {
                      1: "Damage Level",
                      2: "Infrastructure Type",
                      3: "Infrastructure Name",
                      4: "Disaster Type",
                      5: "Debris Blocking Access",
                      6: "Electricity Condition",
                      7: "Health Services Condition",
                      8: "Pressing Needs",
                    };
                    if (qa.question_order !== undefined) {
                      const label = Q_LABELS[qa.question_order] ?? (qa.question_text ?? `Question ${qa.question_order}`);
                      let value: string;
                      if (qa.free_text) {
                        value = qa.free_text;
                      } else if (qa.option_texts && qa.option_texts.length > 0) {
                        value = qa.option_texts.join(", ");
                        if (qa.other_text) value += `, ${qa.other_text}`;
                      } else if (qa.option_text) {
                        value = qa.option_text;
                      } else if (qa.option_values && qa.option_values.length > 0) {
                        value = qa.option_values.join(", ");
                        if (qa.other_text) value += `, ${qa.other_text}`;
                      } else if (qa.option_value) {
                        value = qa.option_value;
                      } else {
                        value = "—";
                      }
                      return <DetailRow key={i} label={label} value={value} />;
                    }
                    // Legacy format: { question, answer }
                    const legacyLabel = qa.question ? String(qa.question) : `Answer ${i + 1}`;
                    const legacyValue = Array.isArray(qa.answer)
                      ? (qa.answer as unknown[]).join(", ")
                      : String(qa.answer ?? "—");
                    return <DetailRow key={i} label={legacyLabel} value={legacyValue} />;
                  })}
                </div>
              </Card>
            )}

            {/* Timestamps */}
            <Card title="Timestamps">
              <div style={styles.detailRows}>
                {report.flow_started_at && (
                  <DetailRow label="Flow started" value={new Date(report.flow_started_at).toLocaleString()} />
                )}
                {report.photos.length > 0 && (
                  <DetailRow label="Photo first uploaded" value={formatDateTime(report.photos[0].created_at)} />
                )}
                {report.submission_submitted_at && (
                  <DetailRow label="Submit tapped (client)" value={formatDateTime(report.submission_submitted_at)} />
                )}
                <DetailRow label="Received by backend" value={formatDateTime(report.created_at)} />
                <DetailRow label="Last updated" value={formatDateTime(report.submitted_at)} />
              </div>
            </Card>

          </div>

          {/* ── RIGHT column ────────────────────────────────────────────── */}
          <div style={styles.rightColumn}>

            {/* Technical Metadata */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Technical Metadata</h2>
              <MetaRow label="Report ID" value={reportLabel} mono />
              <MetaRow
                label="Flag Status"
                value={
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: flagColor, display: "inline-block" }} />
                    <span style={{ color: flagColor }}>{FLAG_LABELS[report.flag_status] ?? report.flag_status}</span>
                  </span>
                }
              />
              <MetaRow label="Received At" value={formatDateTime(report.created_at)} />
              <MetaRow label="Submitted At" value={formatDateTime(report.submitted_at)} />
              <MetaRow
                label="Platform"
                value={report.platform || "—"}
              />
              {report.app_version && (
                <MetaRow label="App Version" value={report.app_version} mono />
              )}
              {report.was_queued && (
                <MetaRow label="Offline Queue" value="Yes — synced from device" />
              )}
              {report.question_package_version && (
                <MetaRow label="Q Package" value={report.question_package_version} mono noBorder />
              )}
            </div>

            {/* Description (if any) */}
            {report.description && (
              <div style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h2 style={{ ...styles.cardTitle, margin: 0 }}>Description</h2>
                  {!report.description_translated && (
                    <button style={styles.translateBtn} onClick={handleTranslate} disabled={translating}>
                      <Globe size={13} style={{ flexShrink: 0 }} />
                      {translating ? "Translating…" : "Translate"}
                    </button>
                  )}
                </div>
                <p style={styles.descriptionText}>{report.description}</p>
                {report.description_translated && (
                  <div style={styles.translatedBox}>
                    <p style={styles.translatedLabel}>English translation:</p>
                    <p style={styles.descriptionText}>{report.description_translated}</p>
                  </div>
                )}
              </div>
            )}

            {/* Reporter Profile */}
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Reporter Profile</h2>
              <div style={styles.reporterAvatarRow}>
                <div style={styles.reporterAvatar}>
                  <User size={24} color="#9ca3af" />
                </div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: "#191c1e", margin: 0 }}>
                    {report.reporter_display_id != null
                      ? `Reporter #${report.reporter_display_id}`
                      : report.reporter_id
                        ? `Reporter ${report.reporter_id.slice(0, 8).toUpperCase()}`
                        : "Unknown Reporter"}
                  </p>
                  <p style={{ fontSize: 10, color: "#717782", textTransform: "uppercase", letterSpacing: 0.5, margin: "3px 0 0" }}>
                    {report.reporter_is_verified ? "Verified profile" : "Anonymous profile"}
                    {report.reporter_id ? ` · ${report.reporter_id.slice(0, 12).toUpperCase()}` : ""}
                  </p>
                </div>
              </div>
              <div style={styles.reporterStatsGrid}>
                <div style={styles.reporterStat}>
                  <p style={styles.reporterStatLabel}>Status</p>
                  <p style={styles.reporterStatValue}>
                    {report.reporter_is_blocked ? "Blocked" : report.reporter_is_verified ? "Verified" : "Active"}
                  </p>
                </div>
                <div style={styles.reporterStat}>
                  <p style={styles.reporterStatLabel}>Platform</p>
                  <p style={styles.reporterStatValue}>{report.reporter_platform || "—"}</p>
                </div>
                {report.device_model && (
                  <div style={styles.reporterStat}>
                    <p style={styles.reporterStatLabel}>Device</p>
                    <p style={styles.reporterStatValue}>{report.device_model}</p>
                  </div>
                )}
                {report.reporter_country_code && (
                  <div style={styles.reporterStat}>
                    <p style={styles.reporterStatLabel}>Country</p>
                    <p style={styles.reporterStatValue}>{report.reporter_country_code}</p>
                  </div>
                )}
              </div>
              {report.submission_ip && (
                <div style={{ padding: "8px 0", borderTop: "1px solid rgba(193,199,210,0.15)", marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#717782" }}>Submission IP</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#414751", fontFamily: "monospace" }}>
                      {report.submission_ip}
                    </span>
                  </div>
                </div>
              )}
              {report.reporter_id ? (
                <a
                  href={`/reporters/${report.reporter_id}`}
                  target="_blank" rel="noopener noreferrer"
                  style={styles.reporterProfileLink}
                  onClick={(e) => { e.preventDefault(); window.open(`/reporters/${report.reporter_id}`, "_blank"); }}
                >
                  VIEW REPORTER PROFILE ↗
                </a>
              ) : (
                <div style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "8px 12px",
                  background: "rgba(113,119,130,0.06)",
                  borderRadius: 7,
                  border: "1px solid rgba(193,199,210,0.3)",
                }}>
                  <AlertTriangle size={13} color="#9ca3af" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.4 }}>
                    No reporter record — legacy test submission
                  </span>
                </div>
              )}
            </div>

            {/* Security Flag Alert (red / discarded only) */}
            {(report.flag_status === "red" || report.flag_status === "discarded") && (
              <div style={styles.flagAlertCard}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <svg width={18} height={18} viewBox="0 0 24 24" fill="#ba1a1a">
                    <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
                  </svg>
                  <h3 style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "#ba1a1a", margin: 0 }}>
                    Security Flag Alert
                  </h3>
                </div>
                <FlagReasonDetail flagEvents={report.flag_events} flagColor="#ba1a1a" />
                {(flagReasons.includes('duplicate_image') || flagReasons.includes('coordinated_gps_duplicate')) && matchedReportId && canEditReports && (
                  <div style={{ marginTop: 16 }}>
                    <button
                      style={styles.mergeDuplicateBtn}
                      onClick={() => setShowMergeModal(true)}
                    >
                      🔗 Merge Duplicate Reports
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* History & Logs (tabbed) */}
            <div style={styles.historyCard}>
              <div style={styles.historyTabs}>
                <button
                  style={{ ...styles.historyTab, ...(activeHistoryTab === "version" ? styles.historyTabActive : {}) }}
                  onClick={() => setActiveHistoryTab("version")}
                >
                  Version History
                </button>
                <button
                  style={{ ...styles.historyTab, ...(activeHistoryTab === "review" ? styles.historyTabActive : {}) }}
                  onClick={() => setActiveHistoryTab("review")}
                >
                  Review Log
                </button>
              </div>
              <div style={{ padding: "20px 24px" }}>
                {activeHistoryTab === "version" ? (
                  report.versions.length === 0 && reportEdits.length === 0 ? (
                    <div style={styles.historyEmpty}>
                      <svg width={40} height={40} viewBox="0 0 24 24" fill="#e6e8eb"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                      <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 10 }}>No further review actions taken yet</p>
                    </div>
                  ) : (
                    <div>
                      <div style={styles.historyTimelineEntry}>
                        <div style={styles.historyDot} />
                        <div>
                          <p style={{ fontSize: 12, fontWeight: 700, color: "#191c1e", margin: 0 }}>V1 — Original Submission</p>
                          <p style={{ fontSize: 11, color: "#717782", margin: "3px 0 0" }}>{formatDateTime(report.submitted_at)}</p>
                        </div>
                      </div>
                      {report.versions.map((v) => <VersionRow key={v.id} item={v} />)}
                      {reportEdits.map((edit) => (
                        <div key={edit.id} style={{ padding: "10px 0", borderBottom: "1px solid rgba(193,199,210,0.15)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 10, background: "#d2e4ff", color: "var(--c-primary)", padding: "2px 7px", borderRadius: 20, fontWeight: 700 }}>EDIT v{edit.version_number}</span>
                            <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(edit.edited_at).toLocaleString()}</span>
                          </div>
                          {edit.edit_reason && <p style={{ fontSize: 11, color: "#717782", fontStyle: "italic", margin: "4px 0" }}>"{edit.edit_reason}"</p>}
                          {Object.entries(edit.fields_changed).map(([field, change]: any) => (
                            <p key={field} style={{ fontSize: 11, color: "#717782", margin: "2px 0" }}>
                              {field}: <span style={{ textDecoration: "line-through" }}>{change.from}</span> → <span style={{ color: "#191c1e", fontWeight: 600 }}>{change.to}</span>
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  reviewLogEvents.length === 0 ? (
                    <p style={styles.emptyText}>No manual review actions recorded.</p>
                  ) : (
                    <div style={styles.reviewLog}>
                      {reviewLogEvents.map((e: FlagEvent) => (
                        <div key={e.id} style={styles.reviewEntry}>
                          <div style={styles.reviewEntryHeader}>
                            <span style={styles.reviewAction}>
                              {e.is_emergency_override && (
                                <span style={styles.emergencyOverrideBadge}><span className="material-symbols-outlined" style={{ fontSize: 12, verticalAlign: "middle", marginRight: 3, fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>warning</span>Emergency Override</span>
                              )}
                              {e.flag_from
                                ? `${FLAG_LABELS[e.flag_from] ?? e.flag_from} → ${FLAG_LABELS[e.flag_to] ?? e.flag_to}`
                                : `→ ${FLAG_LABELS[e.flag_to] ?? e.flag_to}`}
                            </span>
                            <span style={styles.reviewTime}>{formatDateTime(e.created_at)}</span>
                          </div>
                          <div style={styles.reviewUser}>
                            {e.dashboard_user_name
                              ? e.dashboard_user_name
                              : e.dashboard_user_id
                                ? `User #${e.dashboard_user_id.slice(0, 8).toUpperCase()}`
                                : "System"}
                          </div>
                          <div style={styles.reviewComment}>
                            {e.reason ?? <em style={{ color: "#9ca3af" }}>No comment recorded</em>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </div>

            {/* Projects */}
            <Card title="Projects">
              {report.projects && report.projects.length > 0 ? (
                <div style={styles.detailRows}>
                  {(report.projects as ReportProjectRef[]).map((proj) => (
                    <div key={proj.id} style={{ ...styles.detailRow, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "#717782", fontFamily: "monospace", flexShrink: 0 }}>
                        {proj.serial_id}
                      </span>
                      <a
                        href={`/projects/${proj.id}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 12, fontWeight: 600, color: "var(--c-primary)", textDecoration: "none", textAlign: "right" }}
                        onClick={(e) => { e.preventDefault(); window.open(`/projects/${proj.id}`, "_blank"); }}
                      >
                        {proj.name} ↗
                      </a>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={styles.emptyText}>Not linked to any project.</p>
              )}
            </Card>

            {/* Network Data (conditional) */}
            {report.mcc && (
              <Card title="Network Data">
                <div style={styles.detailRows}>
                  <DetailRow label="MCC" value={report.mcc} />
                  {report.carrier_name && <DetailRow label="Carrier" value={report.carrier_name} />}
                  <DetailRow label="Network Type" value={report.network_type || "—"} />
                </div>
              </Card>
            )}

            {/* Flag History (all auto + manual events) */}
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
                    <span style={styles.flagHistoryTime}>{formatDateTime(event.created_at)}</span>
                  </div>
                ))}
              </div>
            </Card>

          </div>
        </div>
      </div>

      {/* ── Merge Duplicate Reports modal ─────────────────────────────── */}
      {showMergeModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card card-padded" style={{ width: 480, borderRadius: "var(--radius-xl)" }}>
            <div style={{ fontSize: "var(--text-xl)", fontWeight: 700, marginBottom: 8, color: "var(--c-flag-red)" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, verticalAlign: "middle", marginRight: 6, fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>warning</span>Merge Duplicate Reports
            </div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--c-text-secondary)", marginBottom: 16 }}>
              This will mark the current report as discarded and transfer its photos to the canonical report. This action cannot be undone.
            </div>
            <div style={{ background: "var(--c-surface-low)", borderRadius: "var(--radius-md)", padding: "10px 14px", marginBottom: 16, fontSize: "var(--text-sm)" }}>
              <div><strong>Duplicate (will be discarded):</strong> Report {reportLabel}</div>
              <div><strong>Canonical (will be kept):</strong> {matchedReportSerialNumber != null ? `#${matchedReportSerialNumber}` : matchedReportId}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="input-label">Merge Reason (optional)</label>
              <textarea className="input" rows={2} style={{ resize: "vertical" }}
                placeholder="Why are these reports being merged?"
                value={mergeReason} onChange={e => setMergeReason(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-secondary btn-lg" style={{ flex: 1 }} onClick={() => setShowMergeModal(false)}>Cancel</button>
              <button className="btn btn-danger btn-lg" style={{ flex: 1 }} disabled={mergeSaving}
                onClick={async () => {
                  setMergeSaving(true);
                  try {
                    await api.post(`/api/reports/${report.id}/merge`, { target_report_id: matchedReportId, merge_reason: mergeReason });
                    setShowMergeModal(false);
                    window.location.reload();
                  } catch (err: any) { alert(err?.response?.data?.detail || "Merge failed"); }
                  finally { setMergeSaving(false); }
                }}>
                {mergeSaving ? "Merging…" : "Confirm Merge"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Report modal ──────────────────────────────────────────── */}
      {showEditModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card card-padded" style={{ width: 520, maxHeight: "80vh", overflowY: "auto", borderRadius: "var(--radius-xl)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>Edit Report</div>
              <button className="btn btn-ghost" onClick={() => setShowEditModal(false)}>✕</button>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="input-label">Damage Level</label>
              <select className="input" value={editForm.damage_level ?? report.damage_level ?? ""}
                onChange={e => setEditForm({ ...editForm, damage_level: e.target.value })}>
                <option value="minimal">Minimal / No Damage</option>
                <option value="partial">Partially Damaged</option>
                <option value="complete">Completely Damaged</option>
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="input-label">Disaster Type</label>
              <select className="input" value={editForm.disaster_type ?? report.disaster_type ?? ""}
                onChange={e => setEditForm({ ...editForm, disaster_type: e.target.value })}>
                <option value="earthquake">Earthquake</option>
                <option value="flood">Flood</option>
                <option value="tsunami">Tsunami</option>
                <option value="hurricane_cyclone">Hurricane or Cyclone</option>
                <option value="wildfire">Wildfire</option>
                <option value="explosion">Explosion</option>
                <option value="chemical_incident">Chemical Incident</option>
                <option value="conflict">Conflict</option>
                <option value="civil_unrest">Civil Unrest</option>
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="input-label">Infrastructure Name</label>
              <input className="input" type="text" value={editForm.infrastructure_name ?? report.infrastructure_name ?? ""}
                onChange={e => setEditForm({ ...editForm, infrastructure_name: e.target.value })} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className="input-label">Debris Present</label>
              <select className="input" value={editForm.debris_blocking ?? report.debris_blocking ?? ""}
                onChange={e => setEditForm({ ...editForm, debris_blocking: e.target.value })}>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label className="input-label">Edit Reason (required)</label>
              <textarea className="input" rows={3} style={{ resize: "vertical", minHeight: 80 }}
                placeholder="Describe why this report is being edited…"
                value={editReason} onChange={e => setEditReason(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-secondary btn-lg" style={{ flex: 1 }} onClick={() => setShowEditModal(false)}>Cancel</button>
              <button className="btn btn-primary btn-lg" style={{ flex: 1 }}
                disabled={!editReason.trim() || editSaving}
                onClick={async () => {
                  if (!editReason.trim()) return;
                  setEditSaving(true);
                  try {
                    await api.patch(`/api/reports/${report.id}`, { ...editForm, edit_reason: editReason });
                    setShowEditModal(false); setEditForm({}); setEditReason("");
                    window.location.reload();
                  } catch (err: any) { alert(err?.response?.data?.detail || "Edit failed"); }
                  finally { setEditSaving(false); }
                }}>
                {editSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "20px 28px 32px", overflow: "auto", background: "#f4f6f9" },

  // Top bar
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
    gap: 16,
    flexWrap: "wrap",
  },
  breadcrumb: { display: "flex", alignItems: "center", gap: 6 },
  breadcrumbLink: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    color: "#717782",
    fontWeight: 500,
    padding: 0,
    transition: "color 0.12s",
  },
  breadcrumbCurrent: { fontSize: 13, fontWeight: 700, color: "#191c1e" },
  actionBar: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },

  discardReportBtn: {
    display: "flex", alignItems: "center", gap: 7,
    padding: "9px 18px",
    background: "#ba1a1a", color: "#fff",
    border: "none", borderRadius: 6,
    cursor: "pointer", fontSize: 13, fontWeight: 700,
    boxShadow: "0 2px 8px rgba(186,26,26,0.2)",
    transition: "opacity 0.1s",
  },
  approveReportBtn: {
    display: "flex", alignItems: "center", gap: 7,
    padding: "9px 18px",
    background: "#005a2c", color: "#fff",
    border: "none", borderRadius: 6,
    cursor: "pointer", fontSize: 13, fontWeight: 700,
    boxShadow: "0 2px 8px rgba(0,90,44,0.2)",
    transition: "opacity 0.1s",
  },
  emergencyOverrideBtn: {
    display: "flex", alignItems: "center", gap: 6,
    padding: "9px 18px",
    background: "rgba(249,115,22,0.08)", color: "#f97316",
    border: "1.5px solid #f97316",
    borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
    transition: "opacity 0.1s",
  },
  reinstateBtn: {
    padding: "9px 18px",
    background: "#fff", color: "#f97316",
    border: "1.5px solid #f97316",
    borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
    transition: "opacity 0.1s",
  },
  editBtn: {
    padding: "9px 16px",
    background: "#fff", color: "#414751",
    border: "none",
    borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500,
    boxShadow: "0 1px 4px rgba(8,27,57,0.08)",
    transition: "box-shadow 0.1s",
  },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "7fr 5fr",
    gap: 24,
    alignItems: "start",
  },
  leftColumn: { display: "flex", flexDirection: "column", gap: 20 },
  rightColumn: { display: "flex", flexDirection: "column", gap: 20 },

  // Primary left card (accent bar + sections)
  primaryCard: {
    display: "flex",
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  primarySection: {
    paddingBottom: 32,
    marginBottom: 32,
    borderBottom: "1px solid rgba(193,199,210,0.15)",
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "#717782",
    margin: 0,
  },

  // Photos
  photoGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 },
  photoWrapper: {
    position: "relative",
    borderRadius: 8,
    overflow: "hidden",
    aspectRatio: "16/9",
    background: "#e6e8eb",
  },
  photo: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  photoOverlay: {
    position: "absolute",
    bottom: 0, left: 0, right: 0,
    padding: "10px 12px",
    background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)",
    color: "#fff",
  },
  photoLabel: { fontSize: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 },

  // Map area
  mapArea: {
    position: "relative",
    borderRadius: 8,
    overflow: "hidden",
    height: 220,
    marginBottom: 10,
  },
  mapPlaceholder: {
    width: "100%",
    height: "100%",
    background: "#e6e8eb",
    backgroundImage: "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)",
    backgroundSize: "24px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  },
  mapOverlayCard: {
    position: "absolute",
    top: 12,
    left: 12,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    padding: "12px 14px",
    borderRadius: 8,
    boxShadow: "0 2px 8px rgba(8,27,57,0.1)",
    maxWidth: "70%",
    border: "1px solid rgba(193,199,210,0.3)",
  },
  mapsLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    color: "var(--c-primary-container)",
    fontSize: 12,
    fontWeight: 500,
    textDecoration: "none",
    marginTop: 4,
  },

  // Damage assessment
  damageGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "20px 20px",
  },

  // Community impact
  impactCard: {
    background: "#f2f4f7",
    borderRadius: 8,
    padding: "18px 20px",
  },

  // Generic card
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "#717782",
    margin: "0 0 16px",
    paddingBottom: 12,
    borderBottom: "1px solid rgba(193,199,210,0.15)",
  },

  // Detail rows (Timestamps etc)
  detailRows: { display: "flex", flexDirection: "column", gap: 0 },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "9px 0",
    borderBottom: "1px solid rgba(193,199,210,0.15)",
    gap: 12,
  },
  detailLabel: { fontSize: 12, color: "#717782", flexShrink: 0, paddingTop: 1 },
  detailValue: { fontSize: 13, color: "#191c1e", fontWeight: 500, textAlign: "right", wordBreak: "break-word" },

  // Reporter profile card
  reporterAvatarRow: {
    display: "flex", alignItems: "center", gap: 14,
    marginBottom: 18,
  },
  reporterAvatar: {
    width: 48, height: 48,
    borderRadius: "50%",
    background: "#f2f4f7",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  reporterStatsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 16,
  },
  reporterStat: {
    background: "#f2f4f7",
    borderRadius: 8,
    padding: "10px 12px",
  },
  reporterStatLabel: {
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#717782",
    margin: "0 0 4px",
  },
  reporterStatValue: { fontSize: 12, fontWeight: 700, color: "#191c1e", margin: 0 },
  reporterProfileLink: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--c-primary)",
    textDecoration: "none",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },

  // Flag alert card
  flagAlertCard: {
    background: "rgba(186,26,26,0.04)",
    border: "1px solid rgba(186,26,26,0.1)",
    borderRadius: 12,
    padding: "20px 24px",
  },
  flagContextCard: { fontSize: 13, color: "#414751" },
  flagContextHeader: { fontSize: 13, fontWeight: 600, color: "#191c1e", margin: "0 0 10px" },
  flagContextRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid rgba(193,199,210,0.15)",
    gap: 8,
  },
  flagContextLabel: { fontSize: 12, color: "#717782", flexShrink: 0 },
  flagContextValue: { fontSize: 12, color: "#191c1e", fontWeight: 600, fontFamily: "monospace" },
  flagContextNote: { fontSize: 11, color: "#9ca3af", fontStyle: "italic", marginTop: 10, marginBottom: 0 },
  flagContextTable: { width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 },
  flagContextTh: { textAlign: "left", padding: "5px 8px", background: "#f2f4f7", fontWeight: 700, color: "#717782", fontSize: 10, textTransform: "uppercase" },
  flagContextTd: { padding: "6px 8px", borderBottom: "1px solid rgba(193,199,210,0.15)", color: "#414751" },
  flagContextLink: { background: "none", border: "none", color: "var(--c-primary-container)", cursor: "pointer", fontFamily: "monospace", fontSize: 12, fontWeight: 600, padding: 0, textDecoration: "underline", textUnderlineOffset: 2 },
  flagReasonMeta: { fontSize: 11, color: "#414751", background: "#f2f4f7", borderRadius: 6, padding: "8px 10px", overflowX: "auto", margin: "8px 0 0" },
  mergeDuplicateBtn: {
    width: "100%",
    padding: "8px",
    background: "rgba(186,26,26,0.06)",
    color: "#ba1a1a",
    border: "1px solid rgba(186,26,26,0.2)",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },

  // History & Logs tabs
  historyCard: {
    background: "#fff",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 4px 20px rgba(8,27,57,0.04)",
  },
  historyTabs: {
    display: "flex",
    borderBottom: "1px solid rgba(193,199,210,0.2)",
  },
  historyTab: {
    flex: 1,
    padding: "13px 16px",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.9,
    color: "#717782",
    background: "none",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    transition: "color 0.12s, border-color 0.12s",
  },
  historyTabActive: {
    color: "var(--c-primary)",
    borderBottom: "2px solid var(--c-primary)",
  },
  historyEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 0",
  },
  historyTimelineEntry: {
    display: "flex",
    gap: 14,
    marginBottom: 16,
    paddingBottom: 16,
    borderBottom: "1px solid rgba(193,199,210,0.15)",
  },
  historyDot: {
    width: 8, height: 8,
    borderRadius: "50%",
    background: "var(--c-primary)",
    boxShadow: "0 0 0 4px rgba(0,80,138,0.1)",
    flexShrink: 0,
    marginTop: 4,
  },

  // Version history
  versionRow: { borderBottom: "1px solid rgba(193,199,210,0.15)" },
  versionRowHeader: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", cursor: "pointer", flexWrap: "wrap" },
  versionDate: { fontSize: 11, color: "#717782", flexShrink: 0 },
  versionDamage: { fontSize: 12, color: "#414751", flex: 1 },
  viewReportBtn: { background: "none", border: "none", color: "var(--c-primary-container)", fontSize: 12, cursor: "pointer", fontWeight: 500, padding: 0 },
  versionExpanded: { display: "flex", gap: 12, padding: "8px 0 12px", fontSize: 12, color: "#414751" },

  // Review log
  reviewLog: { display: "flex", flexDirection: "column", gap: 0 },
  reviewEntry: { padding: "12px 0", borderBottom: "1px solid rgba(193,199,210,0.15)" },
  reviewEntryHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, gap: 8 },
  reviewAction: { fontSize: 13, fontWeight: 600, color: "#191c1e", display: "flex", flexDirection: "column", gap: 3 },
  emergencyOverrideBadge: { fontSize: 10, fontWeight: 700, color: "#ba1a1a", background: "rgba(186,26,26,0.08)", borderRadius: 4, padding: "2px 6px", display: "inline-block" },
  reviewTime: { fontSize: 11, color: "#9ca3af", flexShrink: 0 },
  reviewUser: { fontSize: 12, color: "#717782", marginBottom: 4 },
  reviewComment: { fontSize: 13, color: "#414751", lineHeight: 1.5 },

  // Flag history (all events)
  flagHistoryList: { display: "flex", flexDirection: "column", gap: 0 },
  flagHistoryEvent: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(193,199,210,0.12)", gap: 8, flexWrap: "wrap" },
  flagHistoryLeft: { display: "flex", alignItems: "center", gap: 8 },
  flagHistoryMeta: { fontSize: 11, color: "#717782" },
  flagHistoryTime: { fontSize: 11, color: "#9ca3af", flexShrink: 0 },

  // Flag pill
  flagPill: {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
  },

  // Description
  descriptionText: { fontSize: 13, color: "#414751", lineHeight: 1.65, margin: 0 },
  translatedBox: { marginTop: 12, padding: "12px 14px", background: "#f2f4f7", borderRadius: 8 },
  translatedLabel: { fontSize: 10, color: "#9ca3af", marginBottom: 6, fontWeight: 600, textTransform: "uppercase" },
  translateBtn: {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: "5px 12px",
    background: "rgba(4,104,177,0.07)", color: "var(--c-primary-container)",
    border: "none", borderRadius: 6,
    fontSize: 12, cursor: "pointer", fontWeight: 500,
  },

  // Toast
  toast: {
    position: "fixed",
    bottom: 28, left: "50%",
    transform: "translateX(-50%)",
    background: "var(--c-primary)", color: "#fff",
    padding: "10px 22px",
    borderRadius: 8, fontSize: 13, fontWeight: 500,
    zIndex: 999,
    boxShadow: "0 4px 16px rgba(0,80,138,0.24)",
  },

  // Misc
  emptyText: { fontSize: 13, color: "#9ca3af", fontStyle: "italic", margin: 0 },
};
