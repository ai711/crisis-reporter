import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { User } from "lucide-react";
import Header from "../components/Header";
import { usePageTitle } from "../hooks/usePageTitle";
import PageSpinner from "../components/PageSpinner";
import ErrorState from "../components/ErrorState";
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
} from "../types";
import {
  formatDateTime,
  formatDamageLevel,
  formatProfileType,
  formatProfileStatus,
} from "../utils/formatters";

// ── Chip class helpers ─────────────────────────────────────────────────────────

function flagChipClass(status: string): string {
  switch (status) {
    case "green": return "chip chip-green";
    case "orange": return "chip chip-amber";
    case "red": return "chip chip-red";
    case "discarded": return "chip chip-grey";
    default: return "chip chip-grey";
  }
}

function damageChipClass(level: string | null): string {
  switch (level) {
    case "completely_destroyed":
    case "complete": return "chip chip-red";
    case "partially_damaged":
    case "partial": return "chip chip-amber";
    case "minimal_or_no_damage":
    case "minimal": return "chip chip-green";
    default: return "chip chip-grey";
  }
}

function statusChipClass(status: string): string {
  return status === "active" ? "chip chip-green"
    : status === "flagged" ? "chip chip-amber"
    : status === "blocked" ? "chip chip-red"
    : "chip chip-grey";
}

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
  anonymous_merge_received: "Anonymous merge received",
  anonymous_merge_completed: "Anonymous session merged",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

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
    <div className="card card-padded">
      <h2 className="section-label" style={{ marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid var(--c-border-ghost)", display: "block" }}>{title}</h2>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={s.detailRow}>
      <span style={s.detailLabel}>{label}</span>
      <span style={s.detailValue}>{value ?? <em style={{ color: "var(--c-text-subtle)" }}>—</em>}</span>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric-card">
      <div className="metric-value" style={{ fontSize: "var(--text-xl)", marginBottom: 4 }}>{value}</div>
      <div className="metric-label">{label}</div>
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
              Red-flagged and discarded without entering the Review Queue. The reporter has no
              indication their reports are being discarded.
            </p>
          )}
          {newStatus === "flagged" && (
            <p style={{ ...s.modalWarning, background: "#FFF8E1", borderColor: "#FFB74D", color: "#7B4F00" }}>
              All future reports from this reporter will be automatically Red-flagged and routed
              to the Review Queue for human review. Individual reports can still be approved.
              The reporter has no indication their profile has been Flagged.
            </p>
          )}
          {newStatus === "active" && (
            <p style={{ ...s.modalWarning, background: "#F1F8E9", borderColor: "#AED581", color: "#33691E" }}>
              The reporter will return to normal submission — reports go through the standard
              automatic flag checks. Record the reason for reinstating this profile.
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
            <div style={{ ...s.charCounter, color: isValid ? "var(--c-flag-green)" : "var(--c-text-subtle)" }}>
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
            <div style={{ ...s.charCounter, color: isValid ? "var(--c-flag-green)" : "var(--c-text-subtle)" }}>
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

  return (
    <Card title="Profile Status">
      <div style={{ marginBottom: 16 }}>
        <span className={statusChipClass(currentStatus)} style={{ padding: "6px 18px", fontSize: "var(--text-base)" }}>
          {formatProfileStatus(currentStatus)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(["active", "flagged", "blocked"] as const).map((st) => (
          <button
            key={st}
            className={st === "blocked" ? "btn btn-danger" : st === "flagged" ? "btn btn-danger" : "btn btn-secondary"}
            style={{
              opacity: st === currentStatus ? 0.4 : 1,
              cursor: st === currentStatus ? "not-allowed" : "pointer",
              background: st === "blocked" ? "rgba(229,62,62,0.2)" : undefined,
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
            className="btn btn-secondary"
            style={{ border: "1.5px solid var(--c-flag-red)", color: "var(--c-flag-red)" }}
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

// ── Reporter report row shape (what the backend actually returns) ──────────────

interface ReporterReportRow {
  id: string;
  serial_number: number | null;
  created_at: string;
  country: string | null;
  damage_level: string;
  infrastructure_type: string | null;
  disaster_type: string | null;
  flag_status: string;
}

interface ReporterReportsResponse {
  items: ReporterReportRow[];
  total: number;
  cursor: string | null;
  has_more: boolean;
}

// ── Section 6: Reports list ────────────────────────────────────────────────────

function ReportsSection({ reporterId }: { reporterId: string }) {
  const [flagFilter, setFlagFilter] = useState("");
  // Cursor-based pagination — stack of previous cursors for ← Previous support
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [pageDisplay, setPageDisplay] = useState(1);
  const PAGE_SIZE = 50;

  const params: Record<string, string | number> = { limit: PAGE_SIZE };
  if (flagFilter) params.flag_status = flagFilter;
  if (cursor) params.cursor = cursor;

  const { data, isLoading } = useQuery({
    queryKey: ["reporter-reports", reporterId, params],
    queryFn: async () => {
      const res = await getReporterReports(reporterId, params);
      return res.data as ReporterReportsResponse;
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasMore = data?.has_more ?? false;
  const nextCursor = data?.cursor ?? null;
  const hasPrev = cursorStack.length > 0;

  function handleFilterChange(v: string) {
    setFlagFilter(v);
    setCursor(null);
    setCursorStack([]);
    setPageDisplay(1);
  }

  function handleNext() {
    setCursorStack((prev) => [...prev, cursor]);
    setCursor(nextCursor);
    setPageDisplay((p) => p + 1);
  }

  function handlePrev() {
    const stack = [...cursorStack];
    const prevCursor = stack.pop() ?? null;
    setCursorStack(stack);
    setCursor(prevCursor);
    setPageDisplay((p) => p - 1);
  }

  return (
    <Card title="Submitted Reports">
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={s.filterSelect}
          value={flagFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="grey">Grey</option>
          <option value="green">Green</option>
          <option value="orange">Orange</option>
          <option value="red">Red</option>
          <option value="discarded">Discarded</option>
        </select>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>
          {total} report{total !== 1 ? "s" : ""} total
        </span>
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
                        {r.serial_number != null
                          ? `#${r.serial_number}`
                          : `${r.id.slice(0, 8)}…`}
                      </button>
                    </td>
                    <td style={s.subTd}>{formatDateTime(r.created_at)}</td>
                    <td style={s.subTd}>{r.country || "—"}</td>
                    <td style={s.subTd}>
                      <span className={damageChipClass(r.damage_level)}>
                        {formatDamageLevel(r.damage_level)}
                      </span>
                    </td>
                    <td style={s.subTd}>{r.infrastructure_type || "—"}</td>
                    <td style={s.subTd}>{r.disaster_type || "—"}</td>
                    <td style={s.subTd}>
                      <span className={flagChipClass(r.flag_status)}>
                        {r.flag_status.charAt(0).toUpperCase() + r.flag_status.slice(1)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(hasPrev || hasMore) && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>
                Page {pageDisplay} · showing {items.length} of {total}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{ ...s.pageBtn, opacity: hasPrev ? 1 : 0.4 }}
                  disabled={!hasPrev}
                  onClick={handlePrev}
                >
                  ← Previous
                </button>
                <button
                  style={{ ...s.pageBtn, opacity: hasMore ? 1 : 0.4 }}
                  disabled={!hasMore}
                  onClick={handleNext}
                >
                  Next →
                </button>
              </div>
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
              <span style={{ fontWeight: 700, fontSize: "var(--text-sm)", color: "var(--c-text-primary)" }}>{b.badge_name}</span>
              {b.earned_at ? (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>{formatDateTime(b.earned_at)}</span>
              ) : (
                <em style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)" }}>Not yet earned</em>
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
                    background: isSystem ? "var(--c-surface-low)" : "var(--c-surface-lowest)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                        {isSystem ? (
                          <em style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>System</em>
                        ) : (
                          <strong style={{ fontSize: "var(--text-sm)", color: "var(--c-text-primary)" }}>{entry.source}</strong>
                        )}
                        <span style={{ fontSize: "var(--text-sm)", color: "var(--c-text-secondary)" }}>
                          {ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, " ")}
                        </span>
                        {entry.action === "anonymous_merge_received" && (
                          <span className="chip chip-blue">MERGE RECEIVED</span>
                        )}
                        {entry.action === "anonymous_merge_completed" && (
                          <span className="chip chip-grey">MERGED</span>
                        )}
                        {entry.previous_value && entry.new_value && (
                          <span
                            style={{
                              fontSize: "var(--text-xs)",
                              color: "var(--c-text-muted)",
                              background: "var(--c-surface-low)",
                              borderRadius: "var(--radius-sm)",
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
                            fontSize: "var(--text-xs)",
                            color: "var(--c-text-secondary)",
                            paddingLeft: 16,
                            borderLeft: "2px solid var(--c-border)",
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
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)" }}>Matched reporter: </span>
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
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-subtle)", flexShrink: 0, paddingTop: 2 }}>
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
              <span style={{ fontSize: "var(--text-xs)", color: "var(--c-text-muted)", alignSelf: "center" }}>
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

  usePageTitle(reporter?.reporter_id != null ? `Reporter #${reporter.reporter_id}` : "Reporter Detail");

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["reporter-detail", reporterId] });
  }

  if (isLoading) {
    return (
      <div style={s.container}>
        <Header title="Reporter Profile" />
        <PageSpinner label="Loading reporter profile…" />
      </div>
    );
  }

  if (isError || !reporter) {
    return (
      <div style={s.container}>
        <Header title="Reporter Profile" />
        <ErrorState message="Failed to load reporter profile. Please refresh the page." />
      </div>
    );
  }

  // Short readable ID: sequential display_id (integer)
  const shortId = `#${reporter.reporter_id}`;
  // Display name: decrypted name if available, else "Reporter #<shortId>"
  const displayName = reporter.name || null;

  return (
    <div style={s.container}>
      <Header
        title="Reporter Profile"
        subtitle={displayName ? displayName : `ID: ${shortId}`}
      />

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <div style={s.content}>

        {/* Section 1: Profile header */}
        <div style={s.profileHeader}>
          <div style={s.avatarCircle}>
            <User size={36} color="var(--c-primary-container)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
              {displayName ? (
                <div style={s.profileName}>{displayName}</div>
              ) : (
                <>
                  <div style={s.profileName}>Reporter</div>
                  <span style={{
                    fontFamily: "monospace",
                    fontSize: "var(--text-sm)",
                    color: "var(--c-text-muted)",
                    background: "var(--c-surface-low)",
                    borderRadius: "var(--radius-sm)",
                    padding: "2px 8px",
                    userSelect: "all" as const,
                  }} title={reporter.uuid || String(reporter.reporter_id)}>
                    {shortId}
                  </span>
                </>
              )}
            </div>
            {displayName && (
              <div style={{ fontFamily: "monospace", fontSize: 12, color: "var(--c-text-muted)", marginBottom: 4 }}>
                ID: {shortId}
              </div>
            )}
            <div style={s.profileType}>{formatProfileType(reporter.profile_type)}</div>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className={statusChipClass(reporter.profile_status)}>
                {formatProfileStatus(reporter.profile_status)}
              </span>
              {reporter.country && (
                <span style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--c-text-muted)",
                  background: "var(--c-surface-low)",
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 8px",
                  fontWeight: 500,
                }}>
                  {reporter.country}
                </span>
              )}
              <span style={s.memberSince}>
                First seen {formatDateTime(reporter.created_at)}
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
              <DetailRow label="MCC (cell tower)" value={reporter.mcc || "—"} />
              <DetailRow label="Device Model" value={reporter.device_model || "—"} />
              <DetailRow label="Device Brand" value={reporter.device_brand || "—"} />
              <DetailRow label="Network Type" value={reporter.network_type || "—"} />
            </div>
            <div>
              <DetailRow label="Platform" value={platformDisplay(reporter)} />
              <DetailRow label="Language" value={reporter.language_code || "—"} />
              <DetailRow label="First Seen" value={formatDateTime(reporter.created_at)} />
              <DetailRow label="Last Active" value={formatDateTime(reporter.last_active_at)} />
              <DetailRow
                label="Email"
                value={
                  reporter.email ? (
                    <span>
                      {reporter.email}{" "}
                      <em style={{ fontSize: 11, color: "var(--c-text-muted)", fontStyle: "normal", fontWeight: 500 }}>
                        (Unverified)
                      </em>
                    </span>
                  ) : null
                }
              />
              <DetailRow
                label="Name"
                value={
                  reporter.name ? (
                    <span>
                      {reporter.name}{" "}
                      <em style={{ fontSize: 11, color: "var(--c-text-muted)", fontStyle: "normal", fontWeight: 500 }}>
                        (Unverified)
                      </em>
                    </span>
                  ) : null
                }
              />
            </div>
          </div>
        </Card>

        {/* Section 3: Submission Statistics */}
        <Card title="Submission Statistics">
          <div style={s.statGrid}>
            <StatBox label="Total Submitted" value={reporter.total_reports} />
            <StatBox label="Confirmed (Green + Orange)" value={reporter.green_orange_reports} />
            <StatBox label="Red Flagged" value={reporter.red_reports} />
            <StatBox label="Discarded" value={reporter.discarded_reports} />
            <StatBox label="Unique Properties" value={reporter.total_unique_properties} />
            <StatBox
              label="Last Active"
              value={reporter.last_active_at ? formatDateTime(reporter.last_active_at) : "—"}
            />
          </div>
          {(reporter.first_report_at || reporter.last_report_at) && (
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 4 }}>
              {reporter.first_report_at && (
                <DetailRow label="First report" value={formatDateTime(reporter.first_report_at)} />
              )}
              {reporter.last_report_at && (
                <DetailRow label="Most recent report" value={formatDateTime(reporter.last_report_at)} />
              )}
            </div>
          )}
        </Card>

        {/* Safety Tips Progress */}
        <div className="card card-padded">
          <h2 className="section-label" style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--c-border-ghost)", display: "block" }}>SAFETY TIPS PROGRESS</h2>
          {(reporter as any).safety_progress ? (
            <div style={{display: 'flex', gap: 12}}>
              {['A', 'B', 'C'].map(part => {
                const done = (reporter as any).safety_progress?.[`part_${part.toLowerCase()}_complete`];
                return (
                  <div key={part} style={{flex: 1, textAlign: 'center', padding: '10px 0',
                    background: done ? 'rgba(56,161,105,0.1)' : 'var(--c-surface-low)',
                    borderRadius: 'var(--radius-md)'}}>
                    <div style={{fontSize: 'var(--text-sm)', fontWeight: 700,
                      color: done ? 'var(--c-flag-green)' : 'var(--c-text-muted)'}}>
                      Part {part}
                    </div>
                    <div style={{fontSize: 'var(--text-xs)', color: done
                      ? 'var(--c-flag-green)' : 'var(--c-text-subtle)', marginTop: 2}}>
                      {done ? '✓ Complete' : 'Not started'}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize: 'var(--text-sm)', color: 'var(--c-text-muted)'}}>
              {/* TODO: backend needs to return safety_progress on reporter profile endpoint */}
              Progress data not available
            </div>
          )}
        </div>

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

  profileHeader: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-lg)",
    padding: "24px 28px",
    boxShadow: "var(--shadow-card)",
    border: "1px solid var(--c-border)",
    display: "flex",
    alignItems: "flex-start" as const,
    gap: 20,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    background: "rgba(4,104,177,0.08)",
    border: "2px solid rgba(4,104,177,0.2)",
    display: "flex",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  profileName: { fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--c-text-primary)" },
  profileType: { fontSize: "var(--text-sm)", color: "var(--c-text-muted)", marginTop: 4 },
  memberSince: { fontSize: "var(--text-xs)", color: "var(--c-text-subtle)" },

  twoColGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0 32px",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between" as const,
    alignItems: "flex-start" as const,
    padding: "8px 0",
    borderBottom: "1px solid var(--c-border-ghost)",
    gap: 12,
  },
  detailLabel: { fontSize: "var(--text-sm)", color: "var(--c-text-muted)", flexShrink: 0, paddingTop: 1 },
  detailValue: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    fontWeight: 500,
    textAlign: "right" as const,
    wordBreak: "break-word" as const,
  },

  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
  },

  amberBanner: {
    background: "#FFF3E0",
    border: "1px solid #FFB74D",
    borderRadius: "var(--radius-md)",
    padding: "12px 16px",
    fontSize: "var(--text-sm)",
    color: "#E65100",
    marginBottom: 12,
    lineHeight: 1.5,
  },

  mutedText: { fontSize: "var(--text-sm)", color: "var(--c-text-subtle)", fontStyle: "italic" },

  filterSelect: {
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    padding: "6px 10px",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    background: "var(--c-surface-lowest)",
    outline: "none",
    cursor: "pointer",
  },

  subLoading: { padding: "24px 0", textAlign: "center" as const, color: "var(--c-text-muted)", fontSize: "var(--text-sm)" },

  subTable: { width: "100%", borderCollapse: "collapse" as const, minWidth: 700 },
  subThead: { background: "var(--c-surface-low)" },
  subTh: {
    padding: "9px 12px",
    textAlign: "left" as const,
    fontSize: "var(--text-xs)",
    fontWeight: 700,
    color: "var(--c-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    borderBottom: "1px solid var(--c-border-ghost)",
    whiteSpace: "nowrap" as const,
  },
  subTr: { borderBottom: "1px solid var(--c-border-ghost)" },
  subTd: { padding: "10px 12px", fontSize: "var(--text-sm)", color: "var(--c-text-secondary)", verticalAlign: "middle" as const },

  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--c-primary-container)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
    textUnderlineOffset: 2,
    fontFamily: "monospace",
  },

  pageBtn: {
    padding: "7px 14px",
    background: "var(--c-surface-lowest)",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    color: "var(--c-text-secondary)",
    cursor: "pointer",
  },

  activityEntry: {
    padding: "12px 0",
    borderBottom: "1px solid var(--c-border-ghost)",
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
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 24,
  },
  modal: {
    background: "var(--c-surface-lowest)",
    borderRadius: "var(--radius-xl)",
    padding: "28px 28px 24px",
    width: "100%",
    maxWidth: 480,
    boxShadow: "var(--shadow-float)",
    border: "1px solid var(--c-border)",
  },
  modalTitle: {
    fontSize: "var(--text-lg)",
    fontWeight: 700,
    color: "var(--c-text-primary)",
    marginBottom: 12,
  },
  modalWarning: {
    fontSize: "var(--text-sm)",
    color: "var(--c-text-secondary)",
    background: "#FFF3E0",
    border: "1px solid #FFB74D",
    borderRadius: "var(--radius-md)",
    padding: "10px 12px",
    marginBottom: 16,
    lineHeight: 1.5,
  },
  fieldLabel: {
    display: "block",
    fontSize: "var(--text-xs)",
    fontWeight: 600,
    color: "var(--c-text-muted)",
    marginBottom: 6,
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    border: "1.5px solid var(--c-border)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    color: "var(--c-text-primary)",
    resize: "vertical" as const,
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
    boxSizing: "border-box" as const,
    background: "var(--c-surface-lowest)",
  },
  charCounter: {
    fontSize: "var(--text-xs)",
    marginTop: 5,
    textAlign: "right" as const,
    transition: "color 0.15s",
  },
  errorBox: {
    background: "rgba(229,62,62,0.06)",
    border: "1px solid var(--c-flag-red)",
    borderRadius: "var(--radius-md)",
    padding: "10px 14px",
    fontSize: "var(--text-sm)",
    color: "var(--c-flag-red)",
    marginBottom: 16,
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end" as const,
    gap: 10,
    paddingTop: 4,
  },
  cancelBtn: {
    padding: "9px 20px",
    background: "var(--c-surface-high)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    color: "var(--c-text-primary)",
    cursor: "pointer",
  },
  confirmBtn: {
    padding: "9px 22px",
    background: "var(--c-primary-container)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "#fff",
    transition: "opacity 0.12s",
  },
  confirmBtnRed: {
    padding: "9px 22px",
    background: "var(--c-flag-red)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "#fff",
    transition: "opacity 0.12s",
  },

  toast: {
    position: "fixed",
    bottom: 28,
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--c-text-primary)",
    color: "#fff",
    padding: "10px 22px",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-sm)",
    fontWeight: 500,
    zIndex: 999,
    boxShadow: "var(--shadow-float)",
  },
};
