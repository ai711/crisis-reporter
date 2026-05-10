import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";

const TIMEZONES = [
  "UTC-12", "UTC-11", "UTC-10", "UTC-9", "UTC-8", "UTC-7", "UTC-6",
  "UTC-5", "UTC-4", "UTC-3", "UTC-2", "UTC-1", "UTC+0", "UTC+1",
  "UTC+2", "UTC+3", "UTC+4", "UTC+5", "UTC+5:30", "UTC+6", "UTC+7",
  "UTC+8", "UTC+9", "UTC+10", "UTC+11", "UTC+12", "UTC+13", "UTC+14",
];

const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

// ── Types ──────────────────────────────────────────────────────────────────────

interface GeneralSettings {
  org_name: string;
  dashboard_title: string;
  support_email: string;
  timezone: string;
  date_format: string;
}

interface SecuritySettings {
  session_timeout: number;
  max_login_attempts: number;
  lockout_duration: number;
  password_min_length: number;
  require_special_char: boolean;
  require_number: boolean;
}

interface NotificationType {
  key: string;
  label: string;
  description: string;
  active: boolean;
  subscribers: string[];
}

interface NotificationSettings {
  types: NotificationType[];
}

interface HealthComponent {
  key: string;
  label: string;
  status: "operational" | "degraded" | "outage";
  message: string | null;
  checked_at: string;
}

interface HealthResponse {
  overall: string;
  components: HealthComponent[];
  checked_at: string;
}

interface HealthIncident {
  id: string;
  component: string;
  event_type: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  notes: string | null;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    operational: { bg: "#d4edda", color: "#155724", label: "Operational" },
    degraded: { bg: "#fff3cd", color: "#856404", label: "Degraded" },
    outage: { bg: "#f8d7da", color: "#721c24", label: "Outage" },
  };
  const cfg = map[status] ?? { bg: "#e2e8f0", color: "#4a5568", label: status };
  return (
    <span style={{
      display: "inline-block",
      padding: "3px 12px",
      borderRadius: 20,
      fontSize: 12,
      fontWeight: 600,
      background: cfg.bg,
      color: cfg.color,
    }}>
      {cfg.label}
    </span>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        border: "none",
        cursor: "pointer",
        background: checked ? BLUE : "#cbd5e0",
        position: "relative",
        flexShrink: 0,
        transition: "background 0.2s",
      }}
    >
      <span style={{
        position: "absolute",
        top: 3,
        left: checked ? 23 : 3,
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.2s",
      }} />
    </button>
  );
}

function SectionSaveBar({ onSave, saving, saved }: { onSave: () => void; saving: boolean; saved: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 28 }}>
      <button
        onClick={onSave}
        disabled={saving}
        style={{
          padding: "10px 28px",
          background: saving ? "#aaa" : BLUE,
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Saving…" : "Save Changes"}
      </button>
      {saved && (
        <span style={{ color: "#155724", fontSize: 13, fontWeight: 500 }}>
          ✓ Saved
        </span>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: "#2d3748", marginBottom: 6 }}>
      {children}
    </div>
  );
}

function FieldGroup({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: 20 }}>{children}</div>;
}

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "9px 14px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#2d3748",
        background: "#fff",
        outline: "none",
        boxSizing: "border-box",
      }}
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        width: 120,
        padding: "9px 14px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#2d3748",
        background: "#fff",
        outline: "none",
        boxSizing: "border-box",
      }}
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "9px 14px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#2d3748",
        background: "#fff",
        outline: "none",
        minWidth: 180,
        cursor: "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

// ── Locked screen ──────────────────────────────────────────────────────────────

function LockedScreen() {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "60vh",
      gap: 16,
    }}>
      <div style={{ fontSize: 48 }}>🔒</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#2d3748" }}>
        Access Restricted
      </div>
      <div style={{ fontSize: 15, color: "#718096", textAlign: "center", maxWidth: 420 }}>
        This section is only accessible to Superadmin users.
      </div>
    </div>
  );
}

// ── Tab 1 — General Settings ───────────────────────────────────────────────────

function GeneralSettingsTab() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<GeneralSettings | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<GeneralSettings>({
    queryKey: ["settings", "general"],
    queryFn: async () => {
      const res = await api.get("/api/settings/general");
      return res.data;
    },
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: Partial<GeneralSettings>) =>
      api.patch("/api/settings/general", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading || !form) {
    return <div style={{ padding: 40, color: "#718096" }}>Loading…</div>;
  }

  const set = (k: keyof GeneralSettings) => (v: string) =>
    setForm((f) => f ? { ...f, [k]: v } : f);

  return (
    <div>
      <FieldGroup>
        <FieldLabel>Organisation Name</FieldLabel>
        <TextInput value={form.org_name} onChange={set("org_name")} placeholder="UNDP" />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Dashboard Title</FieldLabel>
        <TextInput value={form.dashboard_title} onChange={set("dashboard_title")} placeholder="Crisis Reporter Dashboard" />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Support Email</FieldLabel>
        <TextInput type="email" value={form.support_email} onChange={set("support_email")} placeholder="support@example.org" />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Time Zone</FieldLabel>
        <SelectInput value={form.timezone} onChange={set("timezone")} options={TIMEZONES} />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Date Format</FieldLabel>
        <SelectInput value={form.date_format} onChange={set("date_format")} options={DATE_FORMATS} />
      </FieldGroup>
      <SectionSaveBar
        onSave={() => mutation.mutate(form)}
        saving={mutation.isPending}
        saved={saved}
      />
    </div>
  );
}

// ── Tab 2 — Security Settings ──────────────────────────────────────────────────

function SecuritySettingsTab() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SecuritySettings | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<SecuritySettings>({
    queryKey: ["settings", "security"],
    queryFn: async () => {
      const res = await api.get("/api/settings/security");
      return res.data;
    },
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: Partial<SecuritySettings>) =>
      api.patch("/api/settings/security", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "security"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading || !form) {
    return <div style={{ padding: 40, color: "#718096" }}>Loading…</div>;
  }

  const setNum = (k: keyof SecuritySettings) => (v: number) =>
    setForm((f) => f ? { ...f, [k]: v } : f);
  const setBool = (k: keyof SecuritySettings) => (v: boolean) =>
    setForm((f) => f ? { ...f, [k]: v } : f);

  return (
    <div>
      <FieldGroup>
        <FieldLabel>Session Timeout (minutes)</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.session_timeout} onChange={setNum("session_timeout")} min={15} max={480} />
          <span style={{ fontSize: 13, color: "#718096" }}>Min 15, Max 480</span>
        </div>
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Max Login Attempts</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.max_login_attempts} onChange={setNum("max_login_attempts")} min={3} max={10} />
          <span style={{ fontSize: 13, color: "#718096" }}>Account locked after this many failed attempts. Min 3, Max 10</span>
        </div>
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Lockout Duration (minutes)</FieldLabel>
        <NumberInput value={form.lockout_duration} onChange={setNum("lockout_duration")} min={1} />
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Password Minimum Length</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.password_min_length} onChange={setNum("password_min_length")} min={6} max={32} />
          <span style={{ fontSize: 13, color: "#718096" }}>Min 6, Max 32</span>
        </div>
      </FieldGroup>
      <FieldGroup>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 480 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>Require Special Character</div>
            <div style={{ fontSize: 12, color: "#718096" }}>Password must contain at least one special character</div>
          </div>
          <Toggle checked={form.require_special_char} onChange={setBool("require_special_char")} />
        </div>
      </FieldGroup>
      <FieldGroup>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 480 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>Require Number</div>
            <div style={{ fontSize: 12, color: "#718096" }}>Password must contain at least one numeric digit</div>
          </div>
          <Toggle checked={form.require_number} onChange={setBool("require_number")} />
        </div>
      </FieldGroup>
      <SectionSaveBar
        onSave={() => mutation.mutate(form)}
        saving={mutation.isPending}
        saved={saved}
      />
    </div>
  );
}

// ── Subscribers Modal ──────────────────────────────────────────────────────────

interface DashboardUserBasic {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface SubscribersModalProps {
  notifKey: string;
  label: string;
  subscribers: string[];
  onClose: () => void;
  onSave: (updatedSubscribers: string[]) => void;
}

function SubscribersModal({ notifKey, label, subscribers, onClose, onSave }: SubscribersModalProps) {
  const [localSubs, setLocalSubs] = useState<string[]>(subscribers);

  const { data: allUsers } = useQuery<DashboardUserBasic[]>({
    queryKey: ["dashboard-users-basic"],
    queryFn: async () => {
      const res = await api.get("/api/dashboard-users");
      return res.data.users ?? res.data ?? [];
    },
  });

  const subscribedUsers = allUsers?.filter((u) => localSubs.includes(u.id)) ?? [];
  const availableUsers = allUsers?.filter((u) => !localSubs.includes(u.id)) ?? [];

  return (
    <div style={s.modalOverlay}>
      <div style={{ ...s.modalBox, maxWidth: 560 }}>
        <div style={s.modalHeader}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Manage Subscribers</div>
          <div style={{ fontSize: 13, color: "#718096", marginTop: 2 }}>{label}</div>
          <button style={s.modalClose} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "20px 24px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#4a5568", marginBottom: 10 }}>
            Current Subscribers ({subscribedUsers.length})
          </div>
          {subscribedUsers.length === 0 ? (
            <div style={{ fontSize: 13, color: "#a0aec0", marginBottom: 16 }}>No subscribers yet.</div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              {subscribedUsers.map((u) => (
                <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#f7fafc", borderRadius: 8, marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>{u.full_name}</div>
                    <div style={{ fontSize: 12, color: "#718096" }}>{u.email} · {u.role}</div>
                  </div>
                  <button
                    onClick={() => setLocalSubs((prev) => prev.filter((id) => id !== u.id))}
                    style={{ padding: "4px 12px", background: "#fff", border: "1px solid #feb2b2", color: "#c53030", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {availableUsers.length > 0 && (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#4a5568", marginBottom: 10 }}>
                Add Subscriber
              </div>
              {availableUsers.map((u) => (
                <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>{u.full_name}</div>
                    <div style={{ fontSize: 12, color: "#718096" }}>{u.email} · {u.role}</div>
                  </div>
                  <button
                    onClick={() => setLocalSubs((prev) => [...prev, u.id])}
                    style={{ padding: "4px 12px", background: BLUE, border: "none", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
                  >
                    Add
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
        <div style={{ padding: "12px 24px", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={s.primaryBtn} onClick={() => { onSave(localSubs); onClose(); }}>
            Save Subscribers
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab 3 — Notification Settings ─────────────────────────────────────────────

function NotificationSettingsTab() {
  const queryClient = useQueryClient();
  const [types, setTypes] = useState<NotificationType[]>([]);
  const [saved, setSaved] = useState(false);
  const [subscriberModal, setSubscriberModal] = useState<NotificationType | null>(null);

  const { data, isLoading } = useQuery<NotificationSettings>({
    queryKey: ["settings", "notifications"],
    queryFn: async () => {
      const res = await api.get("/api/settings/notifications");
      return res.data;
    },
  });

  useEffect(() => {
    if (data?.types) setTypes(data.types);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updated: NotificationType[]) =>
      api.patch("/api/settings/notifications", {
        types: updated.map((t) => ({ key: t.key, active: t.active, subscribers: t.subscribers })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "notifications"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const toggleActive = (key: string, v: boolean) => {
    setTypes((prev) => prev.map((t) => t.key === key ? { ...t, active: v } : t));
  };

  const updateSubscribers = (key: string, subs: string[]) => {
    setTypes((prev) => prev.map((t) => t.key === key ? { ...t, subscribers: subs } : t));
  };

  if (isLoading) {
    return <div style={{ padding: 40, color: "#718096" }}>Loading…</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 20, fontSize: 13, color: "#718096" }}>
        Configure which events trigger notifications and who receives them.
      </div>
      <div>
        {types.map((t) => (
          <div key={t.key} style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            marginBottom: 10,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#2d3748" }}>{t.label}</div>
              <div style={{ fontSize: 12, color: "#718096", marginTop: 2 }}>{t.description}</div>
              <div style={{ fontSize: 12, color: "#a0aec0", marginTop: 4 }}>
                {t.subscribers.length} subscriber{t.subscribers.length !== 1 ? "s" : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <button
                onClick={() => setSubscriberModal(t)}
                style={{ fontSize: 12, color: BLUE, background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}
              >
                Manage Subscribers
              </button>
              <Toggle checked={t.active} onChange={(v) => toggleActive(t.key, v)} />
            </div>
          </div>
        ))}
      </div>
      <SectionSaveBar
        onSave={() => mutation.mutate(types)}
        saving={mutation.isPending}
        saved={saved}
      />
      {subscriberModal && (
        <SubscribersModal
          notifKey={subscriberModal.key}
          label={subscriberModal.label}
          subscribers={subscriberModal.subscribers}
          onClose={() => setSubscriberModal(null)}
          onSave={(subs) => updateSubscribers(subscriberModal.key, subs)}
        />
      )}
    </div>
  );
}

// ── Tab 4 — System Status ──────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ago`;
}

function SystemStatusTab() {
  const [secondsSinceRefresh, setSecondsSinceRefresh] = useState(0);

  const { data: health, isLoading: healthLoading, refetch } = useQuery<HealthResponse>({
    queryKey: ["health-status"],
    queryFn: async () => {
      const res = await api.get("/api/health");
      return res.data;
    },
    refetchInterval: 30_000,
  });

  const { data: incidentsData, isLoading: incidentsLoading } = useQuery<{ incidents: HealthIncident[] }>({
    queryKey: ["health-incidents"],
    queryFn: async () => {
      const res = await api.get("/api/health/incidents");
      return res.data;
    },
  });

  // Tick counter
  useEffect(() => {
    setSecondsSinceRefresh(0);
    const interval = setInterval(() => {
      setSecondsSinceRefresh((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [health]);

  const handleManualRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "#718096" }}>
          Last updated {secondsSinceRefresh}s ago · Auto-refreshes every 30 seconds
        </div>
        <button
          onClick={handleManualRefresh}
          style={{ padding: "6px 16px", background: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13, cursor: "pointer", color: "#2d3748" }}
        >
          Refresh Now
        </button>
      </div>

      {/* Components */}
      {healthLoading ? (
        <div style={{ color: "#718096", padding: 20 }}>Checking components…</div>
      ) : (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#2d3748", marginBottom: 12 }}>
            Component Status
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f7fafc", fontSize: 12, fontWeight: 600, color: "#718096", textTransform: "uppercase" }}>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Component</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Status</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Message</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Last Checked</th>
                </tr>
              </thead>
              <tbody>
                {health?.components.map((comp, idx) => (
                  <tr key={comp.key} style={{ borderTop: idx > 0 ? "1px solid #e2e8f0" : "none" }}>
                    <td style={{ padding: "14px 16px", fontSize: 14, fontWeight: 600, color: "#2d3748" }}>
                      {comp.label}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      <StatusBadge status={comp.status} />
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: "#718096" }}>
                      {comp.message ?? "—"}
                    </td>
                    <td style={{ padding: "14px 16px", fontSize: 13, color: "#a0aec0" }}>
                      {timeAgo(comp.checked_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Incident history */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#2d3748", marginBottom: 12 }}>
          Incident History — Last 90 Days
        </div>
        {incidentsLoading ? (
          <div style={{ color: "#718096" }}>Loading incidents…</div>
        ) : (incidentsData?.incidents.length ?? 0) === 0 ? (
          <div style={{ padding: "24px", background: "#f7fafc", borderRadius: 10, fontSize: 14, color: "#a0aec0", textAlign: "center" }}>
            No incidents recorded in the last 90 days.
          </div>
        ) : (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f7fafc", fontSize: 12, fontWeight: 600, color: "#718096", textTransform: "uppercase" }}>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Component</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Event</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Start Time</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>End Time</th>
                  <th style={{ padding: "10px 16px", textAlign: "left" }}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {incidentsData?.incidents.map((inc, idx) => (
                  <tr key={inc.id} style={{ borderTop: idx > 0 ? "1px solid #e2e8f0" : "none" }}>
                    <td style={{ padding: "12px 16px", fontSize: 14, color: "#2d3748" }}>{inc.component}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{
                        display: "inline-block",
                        padding: "2px 10px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        background: inc.event_type === "restored" ? "#d4edda" : inc.event_type === "outage" ? "#f8d7da" : "#fff3cd",
                        color: inc.event_type === "restored" ? "#155724" : inc.event_type === "outage" ? "#721c24" : "#856404",
                      }}>
                        {inc.event_type.charAt(0).toUpperCase() + inc.event_type.slice(1)}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "#718096" }}>
                      {inc.started_at ? new Date(inc.started_at).toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "#718096" }}>
                      {inc.ended_at ? new Date(inc.ended_at).toLocaleString() : "Ongoing"}
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, color: "#718096" }}>
                      {formatDuration(inc.duration_seconds)}
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

// ── Main Page ──────────────────────────────────────────────────────────────────

const TABS = [
  { key: "general", label: "General Settings" },
  { key: "security", label: "Security Settings" },
  { key: "notifications", label: "Notification Settings" },
  { key: "status", label: "System Status" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function DashboardSettingsPage() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabKey>("general");

  if (user?.role !== "superadmin") {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.title}>Dashboard Settings</h1>
        </div>
        <LockedScreen />
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Dashboard Settings</h1>
        <p style={s.subtitle}>System-wide configuration — Superadmin only</p>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              ...s.tabBtn,
              background: activeTab === tab.key ? BLUE : "transparent",
              color: activeTab === tab.key ? "#fff" : "#4a5568",
              fontWeight: activeTab === tab.key ? 700 : 400,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={s.tabContent}>
        {activeTab === "general" && <GeneralSettingsTab />}
        {activeTab === "security" && <SecuritySettingsTab />}
        {activeTab === "notifications" && <NotificationSettingsTab />}
        {activeTab === "status" && <SystemStatusTab />}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    padding: "32px 40px",
    minHeight: "100vh",
    background: "#f7fafc",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  header: {
    marginBottom: 28,
  },
  title: {
    fontSize: 26,
    fontWeight: 800,
    color: "#1A2B4A",
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "#718096",
    marginTop: 6,
    marginBottom: 0,
  },
  tabBar: {
    display: "flex",
    gap: 8,
    marginBottom: 28,
    background: "#fff",
    padding: 6,
    borderRadius: 12,
    border: "1px solid #e2e8f0",
    width: "fit-content",
  },
  tabBtn: {
    padding: "9px 20px",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
    transition: "all 0.15s",
  },
  tabContent: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    padding: "28px 32px",
    maxWidth: 800,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modalBox: {
    background: "#fff",
    borderRadius: 12,
    width: "100%",
    maxHeight: "80vh",
    overflowY: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
  modalHeader: {
    padding: "20px 24px",
    borderBottom: "1px solid #e2e8f0",
    position: "relative",
  },
  modalClose: {
    position: "absolute",
    top: 16,
    right: 20,
    background: "none",
    border: "none",
    fontSize: 18,
    cursor: "pointer",
    color: "#718096",
    lineHeight: 1,
  },
  cancelBtn: {
    padding: "8px 20px",
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
    color: "#2d3748",
  },
  primaryBtn: {
    padding: "8px 20px",
    background: BLUE,
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    color: "#fff",
  },
};
