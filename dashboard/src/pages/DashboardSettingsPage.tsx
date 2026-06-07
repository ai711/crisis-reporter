import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Info, Lock } from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import Header from "../components/Header";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "var(--c-primary-container)";
const GREEN = "#38a169";
const AMBER = "#f5a623";
const RED = "#e53e3e";

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
  logo_url: string | null;
}

interface SecuritySettings {
  session_timeout: number;
  max_login_attempts: number;
  lockout_duration: number;
  password_min_length: number;
  require_special_char: boolean;
  require_number: boolean;
  require_uppercase: boolean;
  require_lowercase: boolean;
  password_expiry_days: number;
}

interface NotificationType {
  key: string;
  label: string;
  description: string;
  active: boolean;
  subscribers: string[];
  threshold?: number | null;
  delivery_mode?: "immediate" | "summary";
  summary_interval_minutes?: number | null;
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
  app_version?: string;
  python_version?: string;
  database_version?: string;
  environment?: string;
}

interface GreyCountResponse {
  grey_count: number;
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

interface ThresholdsSettings {
  stuck_report_threshold_minutes: number;
  auto_block_confirmation_hours: number;
  language_deprecation_window_days: number;
}

interface DashboardUserBasic {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

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
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function statusColor(s: string): string {
  return s === "operational" ? GREEN : s === "degraded" ? AMBER : RED;
}

// ── UI Primitives ──────────────────────────────────────────────────────────────

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
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        transition: "left 0.2s",
      }} />
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
      {children}
    </div>
  );
}

function FieldGroup({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ marginBottom: 20, ...style }}>{children}</div>;
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{children}</div>;
}

function TextInput({
  value, onChange, type = "text", placeholder,
}: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "9px 12px",
        border: "1.5px solid #e0e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#1A2B4A",
        background: "#f7f9fc",
        outline: "none",
        boxSizing: "border-box",
        fontFamily: "inherit",
        transition: "border-color 0.15s",
      }}
    />
  );
}

function NumberInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        width: 120,
        padding: "9px 12px",
        border: "1.5px solid #e0e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#1A2B4A",
        background: "#f7f9fc",
        outline: "none",
        boxSizing: "border-box",
        fontFamily: "inherit",
      }}
    />
  );
}

function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "9px 12px",
        border: "1.5px solid #e0e8f0",
        borderRadius: 8,
        fontSize: 14,
        color: "#1A2B4A",
        background: "#f7f9fc",
        outline: "none",
        minWidth: 180,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function SaveBar({ onSave, saving, saved }: { onSave: () => void; saving: boolean; saved: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 20, borderTop: "1px solid #f0f4f8", marginTop: 24 }}>
      <button
        onClick={onSave}
        disabled={saving}
        style={{
          padding: "10px 28px",
          background: saving ? "#a0aec0" : BLUE,
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
          cursor: saving ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          transition: "background 0.15s",
        }}
      >
        {saving ? "Saving…" : "Save Changes"}
      </button>
      {saved && (
        <span style={{ color: GREEN, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
          ✓ Saved
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    operational: { bg: "rgba(56,161,105,0.12)", color: "#276749", label: "Operational" },
    degraded:    { bg: "rgba(245,166,35,0.12)",  color: "#744210", label: "Degraded" },
    outage:      { bg: "rgba(229,62,62,0.12)",   color: "#822727", label: "Outage" },
  };
  const cfg = map[status] ?? { bg: "#e2e8f0", color: "#4a5568", label: status };
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: cfg.bg, color: cfg.color, letterSpacing: "0.03em" }}>
      {cfg.label}
    </span>
  );
}

/** Card with ambient shadow and optional coloured left indicator bar */
function SettingsCard({
  title,
  subtitle,
  accentColor = BLUE,
  noAccent = false,
  children,
}: {
  title?: string;
  subtitle?: string;
  accentColor?: string;
  noAccent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      position: "relative",
      background: "#fff",
      borderRadius: 12,
      boxShadow: "0 4px 20px rgba(8,27,57,0.04), 0 12px 40px rgba(8,27,57,0.08)",
      overflow: "hidden",
    }}>
      {!noAccent && (
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: accentColor }} />
      )}
      <div style={{ padding: "24px 28px", paddingLeft: noAccent ? 28 : 32 }}>
        {title && (
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ fontSize: 11, fontWeight: 800, color: "#1A2B4A", textTransform: "uppercase", letterSpacing: "0.15em", margin: 0 }}>
              {title}
            </h4>
            {subtitle && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>{subtitle}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function UNDPBrandingBanner() {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      padding: "14px 18px",
      background: "#ebf5fb",
      border: "1px solid #aed6f1",
      borderRadius: 10,
      marginBottom: 4,
    }}>
      <Info size={16} color="#1a6fa8" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13, color: "#1a6fa8", lineHeight: 1.6 }}>
        <strong>UNDP Branding Notice</strong> — Full UNDP branding, including use of the official UNDP logo
        in any public-facing context, is to be confirmed only after the challenge award and IP licensing
        agreement is in place. The dashboard may display UNDP branding internally for the prototype but
        this must be reviewed and formalised before any public deployment.
      </div>
    </div>
  );
}

function ComingSoonRow({ label, description }: { label: string; description: string }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 20px",
      background: "#f7f9fc",
      border: "1.5px dashed #e0e8f0",
      borderRadius: 10,
      opacity: 0.8,
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#6b7280" }}>{label}</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2, maxWidth: 500 }}>{description}</div>
      </div>
      <span style={{
        fontSize: 10, fontWeight: 800, color: "#9ca3af", background: "#e5e7eb",
        padding: "4px 12px", borderRadius: 20, whiteSpace: "nowrap", letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}>
        Coming Soon
      </span>
    </div>
  );
}

// ── Tab 1 — General Settings ───────────────────────────────────────────────────

function GeneralSettingsTab() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<GeneralSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<GeneralSettings>({
    queryKey: ["settings", "general"],
    queryFn: async () => (await api.get("/api/settings/general")).data,
  });

  useEffect(() => {
    if (data) {
      setForm(data);
      setLogoPreview(data.logo_url ?? null);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (payload: GeneralSettings) => {
      const fd = new FormData();
      fd.append("org_name", payload.org_name);
      fd.append("dashboard_title", payload.dashboard_title);
      fd.append("support_email", payload.support_email);
      fd.append("timezone", payload.timezone);
      fd.append("date_format", payload.date_format);
      if (logoFile) fd.append("logo", logoFile);
      return api.patch("/api/settings/general", fd, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      setLogoFile(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  if (isLoading || !form) {
    return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;
  }

  const set = (k: keyof GeneralSettings) => (v: string) =>
    setForm((f) => f ? { ...f, [k]: v } : f);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <UNDPBrandingBanner />

      {/* General Config */}
      <SettingsCard title="General Configuration" accentColor={GREEN}>
        <FieldGroup>
          <FieldLabel>Dashboard Display Name</FieldLabel>
          <TextInput value={form.dashboard_title} onChange={set("dashboard_title")} placeholder="Crisis Reporter Dashboard" />
          <FieldHint>Shown in the browser tab, dashboard header, and system-generated emails.</FieldHint>
        </FieldGroup>
        <FieldGroup>
          <FieldLabel>Organisation Name</FieldLabel>
          <TextInput value={form.org_name} onChange={set("org_name")} placeholder="UNDP" />
        </FieldGroup>
        <FieldGroup>
          <FieldLabel>Support Email</FieldLabel>
          <TextInput type="email" value={form.support_email} onChange={set("support_email")} placeholder="support@example.org" />
        </FieldGroup>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <FieldGroup style={{ marginBottom: 0 }}>
            <FieldLabel>Time Zone</FieldLabel>
            <SelectInput value={form.timezone} onChange={set("timezone")} options={TIMEZONES} />
          </FieldGroup>
          <FieldGroup style={{ marginBottom: 0 }}>
            <FieldLabel>Date Format</FieldLabel>
            <SelectInput value={form.date_format} onChange={set("date_format")} options={DATE_FORMATS} />
          </FieldGroup>
        </div>
      </SettingsCard>

      {/* Logo upload */}
      <SettingsCard title="Organisation Logo" accentColor={BLUE}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
          {logoPreview ? (
            <img
              src={logoPreview}
              alt="Logo preview"
              style={{ height: 60, maxWidth: 200, objectFit: "contain", border: "1px solid #e0e8f0", borderRadius: 8, padding: 6, background: "#f7f9fc" }}
            />
          ) : (
            <div style={{ width: 200, height: 60, border: "1.5px dashed #d1d5db", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>
              No logo uploaded
            </div>
          )}
          <div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: "8px 18px", background: "#f7f9fc", border: "1.5px solid #e0e8f0", borderRadius: 8, fontSize: 13, cursor: "pointer", color: "#1A2B4A", fontFamily: "inherit" }}
            >
              {logoPreview ? "Change Logo" : "Upload Logo"}
            </button>
            <FieldHint>JPEG, PNG or SVG · Recommended: 800 × 400px · Max 2 MB</FieldHint>
            <FieldHint>Logo takes effect on next page load for all active sessions.</FieldHint>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/svg+xml" style={{ display: "none" }} onChange={handleLogoChange} />

        <SaveBar
          onSave={() => mutation.mutate(form)}
          saving={mutation.isPending}
          saved={saved}
        />
      </SettingsCard>
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
    queryFn: async () => (await api.get("/api/settings/security")).data,
  });

  useEffect(() => { if (data) setForm(data); }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: Partial<SecuritySettings>) => api.patch("/api/settings/security", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "security"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading || !form) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;

  const setNum = (k: keyof SecuritySettings) => (v: number) =>
    setForm((f) => f ? { ...f, [k]: v } : f);
  const setBool = (k: keyof SecuritySettings) => (v: boolean) =>
    setForm((f) => f ? { ...f, [k]: v } : f);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Session & Access */}
      <SettingsCard title="Session & Access Control" accentColor={BLUE}>
        <FieldGroup>
          <FieldLabel>Session Timeout (minutes)</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NumberInput value={form.session_timeout} onChange={setNum("session_timeout")} min={5} max={480} />
            <span style={{ fontSize: 12, color: "#9ca3af" }}>Min 5 · Max 480 (8 hours)</span>
          </div>
          <FieldHint>Users are automatically logged out after this many minutes of inactivity. Applies from next login.</FieldHint>
        </FieldGroup>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <FieldGroup style={{ marginBottom: 0 }}>
            <FieldLabel>Max Login Attempts</FieldLabel>
            <NumberInput value={form.max_login_attempts} onChange={setNum("max_login_attempts")} min={3} max={10} />
            <FieldHint>IP is locked after this many consecutive failures within 10 minutes. Min 3 · Max 10</FieldHint>
          </FieldGroup>
          <FieldGroup style={{ marginBottom: 0 }}>
            <FieldLabel>Lockout Duration (minutes)</FieldLabel>
            <NumberInput value={form.lockout_duration} onChange={setNum("lockout_duration")} min={1} />
            <FieldHint>How long the IP remains blocked after lockout.</FieldHint>
          </FieldGroup>
        </div>
      </SettingsCard>

      {/* Password Policy */}
      <SettingsCard title="Password Policy" accentColor={BLUE}>
        <FieldGroup>
          <FieldLabel>Minimum Password Length</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NumberInput value={form.password_min_length} onChange={setNum("password_min_length")} min={8} max={64} />
            <span style={{ fontSize: 12, color: "#9ca3af" }}>Min 8 · Max 64 characters</span>
          </div>
        </FieldGroup>

        {/* Complexity toggles */}
        {(
          [
            { key: "require_uppercase" as const, label: "Require Uppercase Letter",   hint: "At least one A–Z character" },
            { key: "require_lowercase" as const, label: "Require Lowercase Letter",   hint: "At least one a–z character" },
            { key: "require_number"    as const, label: "Require Number",             hint: "At least one numeric digit" },
            { key: "require_special_char" as const, label: "Require Special Character", hint: "At least one of !@#$%^&*()_+-=[]{}|;'\",./<>?" },
          ] as { key: keyof SecuritySettings; label: string; hint: string }[]
        ).map(({ key, label, hint }) => (
          <FieldGroup key={key}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 560 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2B4A" }}>{label}</div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{hint}</div>
              </div>
              <Toggle
                checked={(form[key] as boolean) ?? true}
                onChange={setBool(key)}
              />
            </div>
          </FieldGroup>
        ))}

        <FieldGroup style={{ marginBottom: 0 }}>
          <FieldLabel>Password Expiry (days)</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NumberInput value={form.password_expiry_days ?? 90} onChange={setNum("password_expiry_days")} min={0} />
            <span style={{ fontSize: 12, color: "#9ca3af" }}>Days before users must reset. Set 0 to disable expiry entirely.</span>
          </div>
        </FieldGroup>

        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>
          Rules apply to all new and changed passwords. Existing passwords are not retroactively invalidated.
        </div>

        <SaveBar onSave={() => mutation.mutate(form)} saving={mutation.isPending} saved={saved} />
      </SettingsCard>

      {/* Future Features */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
          Future Security Features
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ComingSoonRow
            label="Two-Factor Authentication"
            description="Require dashboard users to verify their identity via a second method — authenticator app or SMS code — in addition to their password."
          />
          <ComingSoonRow
            label="IP Allowlisting"
            description="Restrict dashboard access to specific IP addresses or IP ranges — useful for UNDP office networks where access should be limited to known locations."
          />
        </div>
      </div>
    </div>
  );
}

// ── Subscribers Modal ──────────────────────────────────────────────────────────

function SubscribersModal({
  notifKey: _notifKey,
  label,
  subscribers,
  onClose,
  onSave,
}: {
  notifKey: string;
  label: string;
  subscribers: string[];
  onClose: () => void;
  onSave: (updatedSubscribers: string[]) => void;
}) {
  const [localSubs, setLocalSubs] = useState<string[]>(subscribers);

  const { data: allUsers } = useQuery<DashboardUserBasic[]>({
    queryKey: ["dashboard-users-basic"],
    queryFn: async () => {
      const res = await api.get("/api/dashboard/users");
      return res.data.items ?? [];
    },
  });

  const subscribedUsers  = allUsers?.filter((u) => localSubs.includes(u.id)) ?? [];
  const availableUsers   = allUsers?.filter((u) => !localSubs.includes(u.id)) ?? [];

  return (
    <div style={ms.overlay}>
      <div style={ms.box}>
        {/* Header */}
        <div style={ms.header}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#1A2B4A" }}>Manage Subscribers</div>
            <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 2 }}>{label}</div>
          </div>
          <button style={ms.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
            Current Subscribers ({subscribedUsers.length})
          </div>
          {subscribedUsers.length === 0 ? (
            <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 16 }}>No subscribers yet.</div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              {subscribedUsers.map((u) => (
                <div key={u.id} style={ms.userRow}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2B4A" }}>{u.full_name}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>{u.email} · {u.role}</div>
                  </div>
                  <button
                    onClick={() => setLocalSubs((p) => p.filter((id) => id !== u.id))}
                    style={{ padding: "4px 12px", background: "rgba(229,62,62,0.08)", border: "1px solid rgba(229,62,62,0.2)", color: RED, borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {availableUsers.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                Add Subscriber
              </div>
              {availableUsers.map((u) => (
                <div key={u.id} style={{ ...ms.userRow, background: "#fff", border: "1px solid #e0e8f0" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2B4A" }}>{u.full_name}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>{u.email} · {u.role}</div>
                  </div>
                  <button
                    onClick={() => setLocalSubs((p) => [...p, u.id])}
                    style={{ padding: "4px 12px", background: BLUE, border: "none", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}
                  >
                    Add
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 24px", borderTop: "1px solid #f0f4f8", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button style={ms.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={ms.saveBtn} onClick={() => { onSave(localSubs); onClose(); }}>
            Save Subscribers
          </button>
        </div>
      </div>
    </div>
  );
}

const ms: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  box: { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" },
  header: { padding: "20px 24px", borderBottom: "1px solid #f0f4f8", display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  closeBtn: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 0 },
  userRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#f7f9fc", borderRadius: 8, marginBottom: 8 },
  cancelBtn: { padding: "8px 20px", background: "#fff", border: "1.5px solid #e0e8f0", borderRadius: 8, fontSize: 14, cursor: "pointer", color: "#1A2B4A", fontFamily: "inherit" },
  saveBtn: { padding: "8px 20px", background: BLUE, border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", color: "#fff", fontFamily: "inherit" },
};

// ── Tab 3 — Notification Settings ─────────────────────────────────────────────

function NotificationSettingsTab() {
  const queryClient = useQueryClient();
  const [types, setTypes] = useState<NotificationType[]>([]);
  const [saved, setSaved] = useState(false);
  const [subscriberModal, setSubscriberModal] = useState<NotificationType | null>(null);

  const { data, isLoading } = useQuery<NotificationSettings>({
    queryKey: ["settings", "notifications"],
    queryFn: async () => (await api.get("/api/settings/notifications")).data,
  });

  useEffect(() => { if (data?.types) setTypes(data.types); }, [data]);

  const mutation = useMutation({
    mutationFn: (updated: NotificationType[]) =>
      api.patch("/api/settings/notifications", {
        types: updated.map((t) => ({
          key: t.key,
          active: t.active,
          subscribers: t.subscribers,
          threshold: t.threshold,
          delivery_mode: t.delivery_mode,
          summary_interval_minutes: t.summary_interval_minutes,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "notifications"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const toggleActive = (key: string, v: boolean) =>
    setTypes((prev) => prev.map((t) => t.key === key ? { ...t, active: v } : t));

  const updateSubscribers = (key: string, subs: string[]) =>
    setTypes((prev) => prev.map((t) => t.key === key ? { ...t, subscribers: subs } : t));

  const updateField = <K extends keyof NotificationType>(key: string, field: K, value: NotificationType[K]) =>
    setTypes((prev) => prev.map((t) => t.key === key ? { ...t, [field]: value } : t));

  if (isLoading) return <div style={{ padding: 40, color: "#9ca3af" }}>Loading…</div>;

  return (
    <div>
      <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 20, lineHeight: 1.6 }}>
        Configure which system events trigger notifications, who receives them, and through which channels.
        Subscribed users receive alerts via the in-dashboard bell and email.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {types.map((t) => (
          <div
            key={t.key}
            style={{
              background: "#fff",
              border: "1px solid #e0e8f0",
              borderRadius: 10,
              padding: "16px 20px",
              borderLeft: `4px solid ${t.active ? BLUE : "#e0e8f0"}`,
              opacity: t.active ? 1 : 0.65,
              transition: "opacity 0.2s, border-left-color 0.2s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1A2B4A" }}>{t.label}</div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{t.description}</div>
                <div style={{ fontSize: 11, color: "#cbd5e0", marginTop: 6 }}>
                  {t.subscribers.length} subscriber{t.subscribers.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 20, flexShrink: 0 }}>
                <button
                  onClick={() => setSubscriberModal(t)}
                  style={{ fontSize: 12, color: BLUE, background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}
                >
                  Manage Subscribers
                </button>
                <Toggle checked={t.active} onChange={(v) => toggleActive(t.key, v)} />
              </div>
            </div>

            {/* review_queue_threshold — threshold input */}
            {t.key === "review_queue_threshold" && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f0f4f8" }}>
                <FieldLabel>Alert threshold — pending reports before alert fires</FieldLabel>
                <NumberInput value={t.threshold ?? 50} onChange={(v) => updateField(t.key, "threshold", v)} min={1} />
              </div>
            )}

            {/* new_red_flagged_report — delivery mode */}
            {t.key === "new_red_flagged_report" && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f0f4f8" }}>
                <FieldLabel>Alert delivery mode</FieldLabel>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "#1A2B4A" }}>
                    <input
                      type="radio"
                      name={`delivery_${t.key}`}
                      checked={(t.delivery_mode ?? "summary") === "immediate"}
                      onChange={() => updateField(t.key, "delivery_mode", "immediate")}
                    />
                    Send individual alert per report
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, color: "#1A2B4A" }}>
                    <input
                      type="radio"
                      name={`delivery_${t.key}`}
                      checked={t.delivery_mode === "summary"}
                      onChange={() => updateField(t.key, "delivery_mode", "summary")}
                    />
                    Send summary alert every N minutes
                  </label>
                  {t.delivery_mode === "summary" && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 22 }}>
                      <NumberInput
                        value={t.summary_interval_minutes ?? 15}
                        onChange={(v) => updateField(t.key, "summary_interval_minutes", v)}
                        min={5}
                      />
                      <span style={{ fontSize: 13, color: "#9ca3af" }}>minutes between summary alerts</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <SaveBar onSave={() => mutation.mutate(types)} saving={mutation.isPending} saved={saved} />

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

// ── System Thresholds Card ─────────────────────────────────────────────────────

function SystemThresholdsCard() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ThresholdsSettings | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<ThresholdsSettings>({
    queryKey: ["settings", "thresholds"],
    queryFn: async () => (await api.get("/api/settings/thresholds")).data,
  });

  useEffect(() => { if (data) setForm(data); }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: Partial<ThresholdsSettings>) => api.patch("/api/settings/thresholds", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "thresholds"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading || !form) return null;

  const setNum = (k: keyof ThresholdsSettings) => (v: number) =>
    setForm((f) => f ? { ...f, [k]: v } : f);

  return (
    <SettingsCard title="System Thresholds" subtitle="Configurable operational timing parameters" accentColor={AMBER}>
      <FieldGroup>
        <FieldLabel>Stuck Report Threshold (minutes)</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.stuck_report_threshold_minutes} onChange={setNum("stuck_report_threshold_minutes")} min={1} max={60} />
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Grey-flagged reports stuck beyond this threshold trigger a processing alert. Min 1 · Max 60</span>
        </div>
      </FieldGroup>
      <FieldGroup>
        <FieldLabel>Auto-block Confirmation Window (hours)</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.auto_block_confirmation_hours} onChange={setNum("auto_block_confirmation_hours")} min={24} max={168} />
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Hours before an unreviewed auto-block is automatically confirmed. Min 24 · Max 168 (7 days)</span>
        </div>
      </FieldGroup>
      <FieldGroup style={{ marginBottom: 0 }}>
        <FieldLabel>Language Deprecation Window (days)</FieldLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NumberInput value={form.language_deprecation_window_days} onChange={setNum("language_deprecation_window_days")} min={30} max={365} />
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Days before a deprecated language is permanently removed. Min 30 · Max 365</span>
        </div>
      </FieldGroup>
      <SaveBar onSave={() => mutation.mutate(form)} saving={mutation.isPending} saved={saved} />
    </SettingsCard>
  );
}

// ── Tab 4 — System Status ──────────────────────────────────────────────────────

function SystemStatusTab() {
  const [secondsSinceRefresh, setSecondsSinceRefresh] = useState(0);
  const [incidentsOpen, setIncidentsOpen] = useState(false);

  const { data: health, isLoading: healthLoading, refetch } = useQuery<HealthResponse>({
    queryKey: ["health-status"],
    queryFn: async () => (await api.get("/api/health")).data,
    refetchInterval: 30_000,
  });

  const { data: greyData } = useQuery<GreyCountResponse>({
    queryKey: ["health-grey-count"],
    queryFn: async () => (await api.get("/api/health/grey-count")).data,
    refetchInterval: 30_000,
  });

  const { data: incidentsData, isLoading: incidentsLoading } = useQuery<{ incidents: HealthIncident[] }>({
    queryKey: ["health-incidents"],
    queryFn: async () => (await api.get("/api/health/incidents")).data,
  });

  useEffect(() => {
    setSecondsSinceRefresh(0);
    const interval = setInterval(() => setSecondsSinceRefresh((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [health]);

  const handleManualRefresh = useCallback(() => { refetch(); }, [refetch]);

  const overall = health?.overall ?? "operational";
  const overallColor = statusColor(overall);
  const overallBg  = overall === "operational" ? "#f0fff4" : overall === "degraded" ? "#fffbeb" : "#fff5f5";
  const overallBdr = overall === "operational" ? "#c6f6d5" : overall === "degraded" ? "#fde68a" : "#fed7d7";
  const overallTextColor = overall === "operational" ? "#276749" : overall === "degraded" ? "#744210" : "#822727";
  const overallLabel = overall === "operational" ? "All Systems Operational" : overall === "degraded" ? "Degraded Performance" : "System Outage";

  const greyCount = greyData?.grey_count ?? 0;
  const greyBg = greyCount === 0 ? "#f0fff4" : greyCount < 5 ? "#fffbeb" : "#fff5f5";
  const greyBdr = greyCount === 0 ? "#c6f6d5" : greyCount < 5 ? "#fde68a" : "#fed7d7";
  const greyNumColor = greyCount === 0 ? GREEN : greyCount < 5 ? AMBER : RED;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{`
        @keyframes ds-ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>

      {/* Overall status banner */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px",
        background: overallBg,
        border: `1px solid ${overallBdr}`,
        borderRadius: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ position: "relative", display: "inline-flex", width: 12, height: 12, flexShrink: 0 }}>
            <span style={{
              position: "absolute", inset: 0, borderRadius: "50%",
              background: overallColor, opacity: 0.75,
              animation: "ds-ping 2s cubic-bezier(0,0,0.2,1) infinite",
            }} />
            <span style={{ position: "relative", width: 12, height: 12, borderRadius: "50%", background: overallColor }} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: overallTextColor }}>{overallLabel}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>Updated {secondsSinceRefresh}s ago · auto-refreshes every 30s</span>
          <button
            onClick={handleManualRefresh}
            style={{ padding: "6px 14px", background: "#fff", border: "1px solid #e0e8f0", borderRadius: 7, fontSize: 12, cursor: "pointer", color: "#1A2B4A", fontFamily: "inherit" }}
          >
            Refresh Now
          </button>
        </div>
      </div>

      {/* Grey flag queue count */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "16px 20px",
        background: greyBg,
        border: `1px solid ${greyBdr}`,
        borderRadius: 10,
      }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: greyNumColor, lineHeight: 1, minWidth: 40 }}>
          {greyCount}
        </span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1A2B4A" }}>Reports in Grey Flag Status</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>
            {greyCount === 0
              ? "No reports are pending auto-flagging — all processing is complete."
              : `${greyCount} report${greyCount !== 1 ? "s" : ""} awaiting auto-flagging. Non-zero counts persisting beyond the threshold trigger a processing alert.`}
          </div>
        </div>
      </div>

      {/* Component grid */}
      <SettingsCard title="Component Status" noAccent>
        {healthLoading ? (
          <div style={{ color: "#9ca3af", padding: "12px 0" }}>Checking components…</div>
        ) : (
          <>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: health?.app_version ? 16 : 0,
            }}>
              {health?.components.map((comp) => (
                <div key={comp.key} style={{
                  padding: "16px 18px",
                  background: "#f7f9fc",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
                      {comp.label}
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <StatusBadge status={comp.status} />
                    </div>
                    {comp.message && (
                      <div style={{ fontSize: 11, color: "#718096" }}>{comp.message}</div>
                    )}
                    <div style={{ fontSize: 10, color: "#cbd5e0", marginTop: 4 }}>{timeAgo(comp.checked_at)}</div>
                  </div>
                  <div style={{
                    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
                    background: statusColor(comp.status),
                    boxShadow: `0 0 8px ${statusColor(comp.status)}99`,
                  }} />
                </div>
              ))}
            </div>

            {health?.app_version && (
              <div style={{ fontSize: 11, color: "#cbd5e0", paddingTop: 12, borderTop: "1px solid #f0f4f8" }}>
                Crisis Reporter v{health.app_version}
                {health.python_version && ` · Python ${health.python_version}`}
                {health.database_version && ` · ${health.database_version}`}
                {health.environment && ` · ${health.environment}`}
              </div>
            )}
          </>
        )}
      </SettingsCard>

      {/* System Thresholds */}
      <SystemThresholdsCard />

      {/* Incident History — collapsible */}
      <div>
        <button
          onClick={() => setIncidentsOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "14px 20px",
            background: "#fff",
            border: "1px solid #e0e8f0",
            borderRadius: incidentsOpen ? "10px 10px 0 0" : 10,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
            color: "#1A2B4A",
            fontFamily: "inherit",
            textAlign: "left",
            borderBottom: incidentsOpen ? "1px solid #f0f4f8" : undefined,
          }}
        >
          <span style={{ color: "#9ca3af", fontSize: 12 }}>{incidentsOpen ? "▼" : "▶"}</span>
          Incident History — Last 90 Days
          {!incidentsLoading && incidentsData && (
            <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 500, color: "#9ca3af" }}>
              {incidentsData.incidents.length} record{incidentsData.incidents.length !== 1 ? "s" : ""}
            </span>
          )}
        </button>

        {incidentsOpen && (
          <div style={{ background: "#fff", border: "1px solid #e0e8f0", borderTop: "none", borderRadius: "0 0 10px 10px", overflow: "hidden" }}>
            {incidentsLoading ? (
              <div style={{ padding: 20, color: "#9ca3af", fontSize: 13 }}>Loading incidents…</div>
            ) : (incidentsData?.incidents.length ?? 0) === 0 ? (
              <div style={{ padding: "24px 20px", color: "#cbd5e0", fontSize: 14, textAlign: "center" }}>
                No incidents recorded in the last 90 days.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f7f9fc" }}>
                      {["Component", "Event", "Start", "End", "Duration", "Notes"].map((h) => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #e0e8f0", whiteSpace: "nowrap" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {incidentsData?.incidents.map((inc, idx) => (
                      <tr key={inc.id} style={{ borderTop: idx > 0 ? "1px solid #f0f4f8" : "none" }}>
                        <td style={{ padding: "12px 16px", color: "#1A2B4A", fontWeight: 500 }}>{inc.component}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <span style={{
                            display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                            background: inc.event_type === "restored" ? "rgba(56,161,105,0.12)" : inc.event_type === "outage" ? "rgba(229,62,62,0.12)" : "rgba(245,166,35,0.12)",
                            color: inc.event_type === "restored" ? "#276749" : inc.event_type === "outage" ? "#822727" : "#744210",
                          }}>
                            {inc.event_type.charAt(0).toUpperCase() + inc.event_type.slice(1)}
                          </span>
                        </td>
                        <td style={{ padding: "12px 16px", color: "#6b7280", whiteSpace: "nowrap" }}>
                          {inc.started_at ? new Date(inc.started_at).toLocaleString() : "—"}
                        </td>
                        <td style={{ padding: "12px 16px", color: "#6b7280", whiteSpace: "nowrap" }}>
                          {inc.ended_at ? new Date(inc.ended_at).toLocaleString() : <span style={{ color: RED, fontWeight: 600 }}>Ongoing</span>}
                        </td>
                        <td style={{ padding: "12px 16px", color: "#6b7280" }}>{formatDuration(inc.duration_seconds)}</td>
                        <td style={{ padding: "12px 16px", color: "#9ca3af", fontSize: 12 }}>{inc.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab definitions ────────────────────────────────────────────────────────────

const TABS = [
  { key: "general",       label: "General Settings" },
  { key: "security",      label: "Security Settings" },
  { key: "notifications", label: "Notification Settings" },
  { key: "status",        label: "System Status" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function DashboardSettingsPage() {
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabKey>("general");

  const isSuperadmin = user?.role === "superadmin";

  return (
    <div style={s.page}>
      <Header title="Dashboard Settings" subtitle="System-wide configuration — Superadmin only" />

      {/* Superadmin-only badge row */}
      <div style={s.badgeRow}>
        <Lock size={12} color={AMBER} />
        <span style={s.badgeLabel}>Superadmin Only</span>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => isSuperadmin && setActiveTab(tab.key)}
            style={{
              ...s.tabBtn,
              color: activeTab === tab.key ? BLUE : "#6b7280",
              fontWeight: activeTab === tab.key ? 600 : 400,
              borderBottom: activeTab === tab.key ? `3px solid ${BLUE}` : "3px solid transparent",
              cursor: isSuperadmin ? "pointer" : "default",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={s.tabPanelWrap}>
        <div style={s.tabContent}>
          {!isSuperadmin ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "50vh", gap: 16 }}>
              <Lock size={48} color={BLUE} />
              <div style={{ fontSize: 22, fontWeight: 700, color: "#1A2B4A" }}>Access Restricted</div>
              <div style={{ fontSize: 15, color: "#9ca3af", textAlign: "center", maxWidth: 420 }}>
                This section is only accessible to Superadmin users.
              </div>
            </div>
          ) : (
            <>
              {activeTab === "general"       && <GeneralSettingsTab />}
              {activeTab === "security"      && <SecuritySettingsTab />}
              {activeTab === "notifications" && <NotificationSettingsTab />}
              {activeTab === "status"        && <SystemStatusTab />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "var(--c-surface-low)",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 32px",
    background: "rgba(245,166,35,0.06)",
    borderBottom: "1px solid rgba(245,166,35,0.15)",
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: "#744210",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
  },
  tabBar: {
    background: "var(--c-surface-lowest)",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    padding: "0 32px",
    gap: 4,
  },
  tabBtn: {
    padding: "14px 20px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 14,
    transition: "color 0.15s, border-color 0.15s",
    whiteSpace: "nowrap" as const,
    fontFamily: "inherit",
  },
  tabPanelWrap: {
    flex: 1,
    overflowY: "auto",
  },
  tabContent: {
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    maxWidth: 900,
  },
};
