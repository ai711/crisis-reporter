import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { User } from "lucide-react";
import Header from "../components/Header";
import {
  getReporterDetail,
  changeReporterStatus,
  removeReporterPause,
  getReporterReports,
  getReporterActivityLog,
  getReporterBadges,
} from "../services/api";
import type {
  ReporterDetail,
  ReporterActivityEntry,
  ReporterBadgesResponse,
  ReportListItem,
} from "../types";
import {
  formatDateTime,
  formatDamageLevel,
  formatProfileType,
  formatProfileStatus,
  PROFILE_STATUS_COLOURS,
} from "../utils/formatters";

// ── Constants ──────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  status_changed: "Profile status changed",
  pause_applied: "Submission pause applied",
  pause_removed: "Submission pause removed",
  auto_blocked: "Automatically blocked by system",
  auto_flagged: "Automatically flagged by system",
  auto_block_confirmed: "Auto-block confirmed by reviewer",
  auto_block_reversed: "Auto-block reversed by reviewer",
  auto_block_expired: "Auto-block confirmed automatically after 72-hour window",
};

const FLAG_COLOURS: Record<string, { bg: string; color: string }> = {
  grey:      { bg: "#F5F5F5",  color: "#757575" },
  green:     { bg: "#E8F5E9",  color: "#2E7D32" },
  orange:    { bg: "#FFF3E0",  color: "#E65100" },
  red:       { bg: "#FDECEA",  color: "#C62828" },
  discarded: { bg: "#ECEFF1",  color: "#546E7A" },
};

const DAMAGE_COLOURS: Record<string, { bg: string; color: string }> = {
  completely_destroyed: { bg: "#FFF5F5", color: "#C53030" },
  complete:             { bg: "#FFF5F5", color: "#C53030" },
  partially_damaged:    { bg: "#FFF8F0", color: "#C05621" },
  partial:              { bg: "#FFF8F0", color: "#C05621" },
  minimal_or_no_damage: { bg: "#F0FFF4", color: "#276749" },
  minimal:              { bg: "#F0FFF4", color: "#276749" },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function flagPillStyle(status: string) {
  const c = FLAG_COLOURS[status] ?? { bg: "#f4f6f9", color: "#666" };
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700 as const,
    background: c.bg,
    color: c.color,
  };
}

function damagePillStyle(level: string | null) {
  const c = DAMAGE_COLOURS[level ?? ""] ?? { bg: "#f4f6f9", color: "#666" };
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700 as const,
    background: c.bg,
    color: c.color,
  };
}

function platformDisplay(reporter: ReporterDetail): string {
  if (!reporter.platform) return "—";
  let s = reporter.platform;
  if (reporter.app_version) s += ` — v${reporter.app_version}`;
  else if (reporter.browser_version) s += ` — ${reporter.browser_version}`;
  return s;
}

// ── Toast ──────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div style={s.toast}>{message}</div>;
}

// ── Card ───────────────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={s.card}>
      <h2 style={s.cardTitle}>{title}</h2>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={s.detailRow}>
      <span style={s.detailLabel}>{label}</span>
      <span style={s.detailValue}>{value ?? <em style={{ color: "#bbb" }}>—</em>}</span>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={s.statBox}>
      <div style={s.statValue}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

// ── StatusChangeModal ──────────────────────────────────────────────────────────

interface StatusChangeModalProps {
  newStatus: string;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  error: string | null;
}

function StatusChangeModal({ newStatus, onConfirm, onCancel, isSubmitting, error }: StatusChangeModalProps) {
  const [comment, setComment] = useState("");
  const trimmedLen = comment.trim().length;
  const isValid = trimmedLen >= 10;

  return (
    <>
      <div style={s.backdrop} />
      <div style={s.modalOverlay}>
        <div style={s.modal}>
          <h3 style={s.modalTitle}>Change status to {newStatus}?</h3>
          {newStatus === "blocked" && (
            <p style={s.modalWarning}>
              Blocked reporters can still submit reports — their submissions will be automatically
              Red-flagged and routed to the Review Queue.
            </p>
          )}
          <div style={{ marginBottom: 16 }}>
            <label style={s.fieldLabel}>Comment (required)</label>
            <textarea
              style={s.textarea}
              rows={4}
              placeholder="Describe the reason for this change…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={isSubmitting}
            />
            <div style={{ ...s.charCounter, color: isValid ? "#4caf50" : "#999" }}>
              {trimmedLen} / 10 minimum
            </div>
          </div>
          {error && <div style={s.errorBox}>{error}</div>}
          <div style={s.modalActions}>
            <button style={s.cancelBtn} onClick={onCancel} disabled={isSubmitting}>Cancel</button>
            <button
              style={{
                ...s.confirmBtn,
                opacity: isValid && !isSubmitting ? 1 : 0.4,
                cursor: isValid && !isSubmitting ? "pointer" : "not-allowed",
              }}
              onClick={() => { if (isValid && !isSubmitting) onConfirm(comment.trim()); }}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── PauseRemovalModal ──────────────────────────────────────────────────────────

function PauseRemovalModal({
  onConfirm,
  onCancel,
  isSubmitting,
  error,
}: {
  onConfirm: (comment: string) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  error: string | null;
}) {
  const [comment, setComment] = useState("");
  const trimmedLen = comment.trim().length;
  const isValid = trimmedLen >= 10;

  return (
    <>
      <div style={s.backdrop} />
      <div style={s.modalOverlay}>
        <div style={s.modal}>
          <h3 style={s.modalTitle}>Remove submission pause?</h3>
          <p style={s.modalWarning}>
            This will immediately allow the reporter to submit reports again.
          </p>
          <div style={{ marginBottom: 16 }}>
            <label style={s.fieldLabel}>Comment (required)</label>
            <textarea
              style={s.textarea}
              rows={4}
              placeholder="Describe the reason for removing the pause…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={isSubmitting}
            />
            <div style={{ ...s.charCounter, color: isValid ? "#4caf50" : "#999" }}>
              {trimmedLen} / 10 minimum
            </div>
          </div>
          {error && <div style={s.errorBox}>{error}</div>}
          <div style={s.modalActions}>
            <button style={s.cancelBtn} onClick={onCancel} disabled={isSubmitting}>Cancel</button>
            <button
              style={{
                ...s.confirmBtnRed,
                opacity: isValid && !isSubmitting ? 1 : 0.4,
                cursor: isValid && !isSubmitting ? "pointer" : "not-allowed",
              }}
              onClick={() => { if (isValid && !isSubmitting) onConfirm(comment.trim()); }}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Removing…" : "Remove Pause"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Section 4: Status control ──────────────────────────────────────────────────

function StatusControlSection({
  reporterId,
  currentStatus,
  onSuccess,
}: {
  reporterId: string;
  currentStatus: string;
  onSuccess: () => void;
}) {
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ status, comment }: { status: string; comment: string }) =>
      changeReporterStatus(reporterId, status, comment),
    onSuccess: () => {
      setPendingStatus(null);
      setError(null);
      onSuccess();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Failed to update status. Please try again.";
      setError(msg);
    },
  });

  const colours = PROFILE_STATUS_COLOURS[currentStatus] ?? { bg: "#f4f6f9", text: "#666" };

  return (
    <Card title="Profile Status">
      <div style={{ marginBottom: 16 }}>
        <span
          style={{
            display: "inline-block",
            padding: "6px 18px",
            borderRadius: 20,
            fontSize: 14,
            fontWeight: 700,
            background: colours.bg,
            color: colours.text,
          }}
        >
          {formatProfileStatus(currentStatus)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(["active", "flagged", "blocked"] as const).map((st) => (
          <button
            key={st}
            style={{
              ...s.statusBtn,
              opacity: st === currentStatus ? 0.4 : 1,
              cursor: st === currentStatus ? "not-allowed" : "pointer",
            }}
            disabled={st === currentStatus || mutation.isPending}
            onClick={() => { setError(null); setPendingStatus(st); }}
          >
            Set {st.charAt(0).toUpperCase() + st.slice(1)}
          </button>
        ))}
      </div>
      {pendingStatus && (
        <StatusChangeModal
          newStatus={pendingStatus}
          onConfirm={(comment) => mutation.mutate({ status: pendingStatus, comment })}
          onCancel={() => { setPendingStatus(null); setError(null); }}
          isSubmitting={mutation.isPending}
          error={error}
        />
      )}
    </Card>
  );
}

// ── Section 5: Pause status ────────────────────────────────────────────────────

function PauseSection({
  reporter,
  onSuccess,
}: {
  reporter: ReporterDetail;
  onSuccess: () => void;
}) {
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (comment: string) => removeReporterPause(reporter.reporter_id, comment),
    onSuccess: () => {
      setShowModal(false);
      setError(null);
      onSuccess();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Failed to remove pause. Please try again.";
      setError(msg);
    },
  });

  return (
    <Card title="Submission Pause">
      {!reporter.is_paused ? (
        <p style={s.mutedText}>No active submission pause.</p>
      ) : (
        <div>
          <div style={s.amberBanner}>
            Submission paused — expires {formatDateTime(reporter.pause_expires_at)} — paused due to
            high submission volume.
          </div>
          <button
            style={s.removePauseBtn}
            onClick={() => { setError(null); setShowModal(true); }}
          >
            Remove Pause
          </button>
        </div>
      )}
      {showModal && (
        <PauseRemovalModal
          onConfirm={(comment) => mutation.mutate(comment)}
          onCancel={() => { setShowModal(false); setError(null); }}
          isSubmitting={mutation.isPending}
          error={error}
        />
      )}
    </Card>
  );
}

// ── Section 6: Reports list ────────────────────────────────────────────────────

function ReportsSection({ reporterId }: { reporterId: string }) {
  const [flagFilter, setFlagFilter] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const params: Record<string, string | number> = { page, page_size: PAGE_SIZE };
  if (flagFilter) params.flag_status = flagFilter;

  const { data, isLoading } = useQuery({
    queryKey: ["reporter-reports", reporterId, params],
    queryFn: async () => {
      const res = await getReporterReports(reporterId, params);
      return res.data as { items: ReportListItem[]; total: number };
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <Card title="Submitted Reports">
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={s.filterSelect}
          value={flagFilter}
          onChange={(e) => { setFlagFilter(e.target.value); setPage(1); }}
        >
          <option value="">All statuses</option>
          <option value="grey">Grey</option>
          <option value="green">Green</option>
          <option value="orange">Orange</option>
          <option value="red">Red</option>
          <option value="discarded">Discarded</option>
        </select>
        <span style={{ fontSize: 12, color: "#888" }}>{total} reports</span>
      </div>

      {isLoading ? (
        <div style={s.subLoading}>Loading reports…</div>
      ) : items.length === 0 ? (
        <p style={s.mutedText}>No reports submitted yet.</p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={s.subTable}>
              <thead>
                <tr style={s.subThead}>
                  <th style={s.subTh}>Report ID</th>
                  <th style={s.subTh}>Date/Time</th>
                  <th style={s.subTh}>Country</th>
                  <th style={s.subTh}>Damage Level</th>
                  <th style={s.subTh}>Infrastructure</th>
                  <th style={s.subTh}>Crisis Type</th>
                  <th style={s.subTh}>Flag Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} style={s.subTr}>
                    <td style={s.subTd}>
                      <button
                        style={s.linkBtn}
                        onClick={() => window.open("/reports/" + r.id, "_blank")}
                      >
                        {r.id.slice(0, 8)}…
                      </button>
                    </td>
                    <td style={s.subTd}>{formatDateTime(r.created_at)}</td>
                    <td style={s.subTd}>{r.country || "—"}</td>
                    <td style={s.subTd}>
                      <span style={damagePillStyle(r.damage_level)}>
                        {formatDamageLevel(r.damage_level)}
                      </span>
                    </td>
                    <td style={s.subTd}>{r.infrastructure_type || "—"}</td>
                    <td style={s.subTd}>{r.disaster_type || "—"}</td>
                    <td style={s.subTd}>
                      <span style={flagPillStyle(r.flag_status)}>
                        {r.flag_status.charAt(0).toUpperCase() + r.flag_status.slice(1)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                style={{ ...s.pageBtn, opacity: page <= 1 ? 0.4 : 1 }}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </button>
              <span style={{ fontSize: 12, color: "#888", alignSelf: "center" }}>
                Page {page} of {totalPages}
              </span>
              <button
                style={{ ...s.pageBtn, opacity: page >= totalPages ? 0.4 : 1 }}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Section 7: Badges ─────────────────────────────────────────────────────────

function BadgesSection({ reporterId }: { reporterId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["reporter-badges", reporterId],
    queryFn: async () => {
      const res = await getReporterBadges(reporterId);
      return res.data as ReporterBadgesResponse;
    },
  });

  return (
    <Card title="Badges">
      {isLoading ? (
        <div style={s.subLoading}>Loading badges…</div>
      ) : !data || !data.badges_eligible ? (
        <p style={s.mutedText}>
          <em>Badges are awarded to reporters with a verified contact detail on their profile.</em>
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data.badges.map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#1A2B4A" }}>{b.badge_name}</span>
              {b.earned_at ? (
                <span style={{ fontSize: 12, color: "#888" }}>{formatDateTime(b.earned_at)}</span>
              ) : (
                <em style={{ fontSize: 12, color: "#bbb" }}>Not yet earned</em>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Section 8: Activity log ────────────────────────────────────────────────────

function ActivityLogSection({ reporterId }: { reporterId: string }) {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["reporter-activity", reporterId, page],
    queryFn: async () => {
      const res = await getReporterActivityLog(reporterId, page);
      return res.data as { items: ReporterActivityEntry[]; total: number; total_pages: number };
    },
  });

  const items = data?.items ?? [];
  const totalPages = data?.total_pages ?? 1;

  return (
    <Card title="Activity Log">
      {isLoading ? (
        <div style={s.subLoading}>Loading activity log…</div>
      ) : items.length === 0 ? (
        <p style={s.mutedText}>No activity recorded yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {items.map((entry) => {
              const isSystem = entry.source === "system";
              return (
                <div
                  key={entry.id}
                  style={{
                    ...s.activityEntry,
                    background: isSystem ? "#F5F5F5" : "#fff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                        {isSystem ? (
                          <em style={{ fontSize: 12, color: "#888" }}>System</em>
                        ) : (
                          <strong style={{ fontSize: 13, color: "#1A2B4A" }}>{entry.source}</strong>
                        )}
                        <span style={{ fontSize: 13, color: "#444" }}>
                          {ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, " ")}
                        </span>
                        {entry.previous_value && entry.new_value && (
                          <span
                            style={{
                              fontSize: 12,
                              color: "#666",
                              background: "#f0f4f8",
                              borderRadius: 4,
                              padding: "1px 6px",
                            }}
                          >
                            {entry.previous_value} → {entry.new_value}
                          </span>
                        )}
                      </div>
                      {entry.comment && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#555",
                            paddingLeft: 16,
                            borderLeft: "2px solid #e0e0e0",
                            marginTop: 4,
                            marginBottom: 4,
                            lineHeight: 1.5,
                          }}
                        >
                          {entry.comment}
                        </div>
                      )}
                      {entry.matched_reporter_id && (
                        <div style={{ marginTop: 4 }}>
                          <span style={{ fontSize: 12, color: "#888" }}>Matched reporter: </span>
                          <button
                            style={s.linkBtn}
                            onClick={() =>
                              window.open("/reporters/" + entry.matched_reporter_id, "_blank")
                            }
                          >
                            {entry.matched_reporter_id}
                          </button>
                        </div>
                      )}
                    </div>
                    <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0, paddingTop: 2 }}>
                      {formatDateTime(entry.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {totalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                style={{ ...s.pageBtn, opacity: page <= 1 ? 0.4 : 1 }}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </button>
              <span style={{ fontSize: 12, color: "#888", alignSelf: "center" }}>
                Page {page} of {totalPages}
              </span>
              <button
                style={{ ...s.pageBtn, opacity: page >= totalPages ? 0.4 : 1 }}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReporterDetailPage() {
  const { reporterId } = useParams<{ reporterId: string }>();
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);

  const { data: reporter, isLoading, isError } = useQuery<ReporterDetail>({
    queryKey: ["reporter-detail", reporterId],
    queryFn: async () => {
      const res = await getReporterDetail(reporterId!);
      return res.data as ReporterDetail;
    },
    enabled: !!reporterId,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["reporter-detail", reporterId] });
  }

  if (isLoading) {
    return (
      <div style={s.container}>
        <Header title="Reporter Profile" />
        <div style={s.fullLoading}>
          <div style={s.spinner} />
          <span style={{ marginTop: 16, fontSize: 14, color: "#888" }}>Loading reporter profile…</span>
        </div>
      </div>
    );
  }

  if (isError || !reporter) {
    return (
      <div style={s.container}>
        <Header title="Reporter Profile" />
        <div style={s.fullLoading}>
          <p style={{ fontSize: 14, color: "#C62828" }}>Failed to load reporter profile. Please refresh the page.</p>
        </div>
      </div>
    );
  }

  const statusColours = PROFILE_STATUS_COLOURS[reporter.profile_status] ?? { bg: "#f4f6f9", text: "#666" };
  const displayName = reporter.reporter_id;

  return (
    <div style={s.container}>
      <Header title="Reporter Profile" subtitle={reporter.reporter_id} />

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <div style={s.content}>

        {/* Section 1: Profile header */}
        <div style={s.profileHeader}>
          <div style={s.avatarCircle}>
            <User size={36} color="#aaa" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={s.profileName}>{displayName}</div>
            <div style={s.profileType}>{formatProfileType(reporter.profile_type)}</div>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "5px 16px",
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: 700,
                  background: statusColours.bg,
                  color: statusColours.text,
                }}
              >
                {formatProfileStatus(reporter.profile_status)}
              </span>
              <span style={s.memberSince}>
                Member since {formatDateTime(reporter.created_at)}
              </span>
            </div>
          </div>
        </div>

        {/* Section 2: Identity & Technical Details */}
        <Card title="Identity & Technical Details">
          <div style={s.twoColGrid}>
            <div>
              <DetailRow label="Reporter ID" value={<span style={{ fontFamily: "monospace" }}>{reporter.reporter_id}</span>} />
              <DetailRow label="Device ID" value={reporter.device_id ? <span style={{ fontFamily: "monospace", fontSize: 12 }}>{reporter.device_id}</span> : "—"} />
              <DetailRow label="IP Address" value={reporter.ip_address ? <span style={{ fontFamily: "monospace" }}>{reporter.ip_address}</span> : "—"} />
              <DetailRow label="Country" value={reporter.country || "—"} />
              <DetailRow label="MCC (cell tower country)" value={reporter.mcc || "—"} />
            </div>
            <div>
              <DetailRow label="Platform" value={platformDisplay(reporter)} />
              <DetailRow label="Language" value={reporter.language_code || "—"} />
              <DetailRow label="First Seen" value={formatDateTime(reporter.created_at)} />
              <DetailRow label="Last Active" value={formatDateTime(reporter.last_active_at)} />
            </div>
          </div>
        </Card>

        {/* Section 3: Submission Statistics */}
        <Card title="Submission Statistics">
          <div style={s.statGrid}>
            <StatBox label="Total Reports Submitted" value={reporter.total_reports} />
            <StatBox label="Confirmed (Green + Orange)" value={reporter.green_orange_reports} />
            <StatBox label="Pending Review (Red)" value={reporter.red_reports} />
            <StatBox label="Discarded" value={reporter.discarded_reports} />
            <StatBox label="Unique Properties Reported" value={reporter.total_unique_properties} />
            <StatBox
              label="Active Since"
              value={reporter.first_report_at ? formatDateTime(reporter.first_report_at) : "—"}
            />
          </div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <DetailRow label="First report" value={formatDateTime(reporter.first_report_at)} />
            <DetailRow label="Most recent report" value={formatDateTime(reporter.last_report_at)} />
          </div>
        </Card>

        {/* Section 4: Profile Status Control */}
        <StatusControlSection
          reporterId={reporter.reporter_id}
          currentStatus={reporter.profile_status}
          onSuccess={() => {
            invalidate();
            setToast("Profile status updated.");
          }}
        />

        {/* Section 5: Pause Status */}
        <PauseSection
          reporter={reporter}
          onSuccess={() => {
            invalidate();
            setToast("Submission pause removed.");
          }}
        />

        {/* Section 6: Reports */}
        <ReportsSection reporterId={reporter.reporter_id} />

        {/* Section 7: Badges */}
        <BadgesSection reporterId={reporter.reporter_id} />

        {/* Section 8: Activity Log */}
        <ActivityLogSection reporterId={reporter.reporter_id} />
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", minHeight: "100vh" },
  content: { flex: 1, padding: "24px 32px", display: "flex", flexDirection: "column", gap: 20, overflow: "auto" },

  fullLoading: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 60,
  },
  spinner: {
    width: 36,
    height: 36,
    border: "3px solid #e2e8f0",
    borderTop: "3px solid #0468B1",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },

  profileHeader: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px 28px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e8eef4",
    display: "flex",
    alignItems: "flex-start",
    gap: 20,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    background: "#f4f6f9",
    border: "2px solid #e0e8f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  profileName: { fontSize: 22, fontWeight: 700, color: "#1A2B4A", fontFamily: "monospace" },
  profileType: { fontSize: 13, color: "#888", marginTop: 4 },
  memberSince: { fontSize: 12, color: "#aaa" },

  card: {
    background: "#fff",
    borderRadius: 12,
    padding: "20px 24px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    border: "1px solid #e8eef4",
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 16,
    paddingBottom: 10,
    borderBottom: "1px solid #f0f4f8",
  },

  twoColGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0 32px",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "8px 0",
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

  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
  },
  statBox: {
    background: "#f8fafc",
    borderRadius: 8,
    padding: "16px",
    border: "1px solid #e8eef4",
    textAlign: "center",
  },
  statValue: { fontSize: 24, fontWeight: 700, color: "#1A2B4A", marginBottom: 4 },
  statLabel: { fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 },

  statusBtn: {
    padding: "8px 18px",
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    background: "#fff",
    color: "#1A2B4A",
    fontSize: 13,
    fontWeight: 600,
  },

  amberBanner: {
    background: "#FFF3E0",
    border: "1px solid #FFB74D",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 13,
    color: "#E65100",
    marginBottom: 12,
    lineHeight: 1.5,
  },
  removePauseBtn: {
    padding: "8px 18px",
    background: "#fff",
    border: "1.5px solid #C62828",
    borderRadius: 7,
    color: "#C62828",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },

  mutedText: { fontSize: 13, color: "#999", fontStyle: "italic" },

  filterSelect: {
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    padding: "6px 10px",
    fontSize: 13,
    color: "#1A2B4A",
    background: "#fff",
    outline: "none",
    cursor: "pointer",
  },

  subLoading: { padding: "24px 0", textAlign: "center", color: "#888", fontSize: 13 },

  subTable: { width: "100%", borderCollapse: "collapse", minWidth: 700 },
  subThead: { background: "#f7fafc" },
  subTh: {
    padding: "9px 12px",
    textAlign: "left",
    fontSize: 11,
    fontWeight: 700,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #e2e8f0",
    whiteSpace: "nowrap",
  },
  subTr: { borderBottom: "1px solid #f0f4f8" },
  subTd: { padding: "10px 12px", fontSize: 13, color: "#2d3748", verticalAlign: "middle" },

  linkBtn: {
    background: "none",
    border: "none",
    color: "#0468B1",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
    fontFamily: "monospace",
  },

  pageBtn: {
    padding: "7px 14px",
    background: "#fff",
    border: "1.5px solid #d0dce8",
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 600,
    color: "#444",
    cursor: "pointer",
  },

  activityEntry: {
    padding: "12px 0",
    borderBottom: "1px solid #f4f6f9",
  },

  // Modal
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 900,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 901,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modal: {
    background: "#fff",
    borderRadius: 14,
    padding: "28px 28px 24px",
    width: "100%",
    maxWidth: 480,
    boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
    border: "1px solid #e0e8f0",
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 12,
  },
  modalWarning: {
    fontSize: 13,
    color: "#666",
    background: "#FFF3E0",
    border: "1px solid #FFB74D",
    borderRadius: 7,
    padding: "10px 12px",
    marginBottom: 16,
    lineHeight: 1.5,
  },
  fieldLabel: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#555",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    border: "1.5px solid #d0dce8",
    borderRadius: 8,
    fontSize: 13,
    color: "#1A2B4A",
    resize: "vertical",
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
    boxSizing: "border-box",
  },
  charCounter: {
    fontSize: 11,
    marginTop: 5,
    textAlign: "right",
    transition: "color 0.15s",
  },
  errorBox: {
    background: "#fff3f3",
    border: "1px solid #f44336",
    borderRadius: 7,
    padding: "10px 14px",
    fontSize: 13,
    color: "#c62828",
    marginBottom: 16,
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    padding: "9px 20px",
    background: "#f4f6f9",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    color: "#444",
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px",
    background: "#0468B1",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    transition: "opacity 0.12s",
  },
  confirmBtnRed: {
    padding: "9px 22px",
    background: "#C62828",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    transition: "opacity 0.12s",
  },

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
};
