import { useState, useEffect, createContext, useContext } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";

// ── Edit-permission context ────────────────────────────────────────────────────
// Provides canEdit=true to all sub-editors by default; set to false for
// view-only users (custom roles) who cannot call admin-only PATCH endpoints.

const ContentEditCtx = createContext(true);

// ── Types ──────────────────────────────────────────────────────────────────────

interface SafetyTipSlide {
  title: string;
  dos: string[];
  donts: string[];
}

interface SlideshowSlide {
  title: string;
  bullets: string[];
}

interface KeyValueItem {
  key: string;
  text: string;
}

type SectionGroup = "reporter-safety" | "system-text";
type SafetyPart = "A" | "B" | "C";
type SystemTab = "tc" | "onboarding" | "error_messages" | "system_messages";

const DISASTER_TYPES = [
  { key: "earthquake",        label: "Earthquake" },
  { key: "flood",             label: "Flood" },
  { key: "tsunami",           label: "Tsunami" },
  { key: "hurricane_cyclone", label: "Hurricane / Cyclone" },
  { key: "wildfire",          label: "Wildfire" },
  { key: "explosion",         label: "Explosion" },
  { key: "chemical_incident", label: "Chemical Incident" },
  { key: "conflict",          label: "Conflict" },
  { key: "civil_unrest",      label: "Civil Unrest" },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function arrSet<T>(arr: T[], idx: number, val: T): T[] {
  return arr.map((x, i) => (i === idx ? val : x));
}
function arrRemove<T>(arr: T[], idx: number): T[] {
  return arr.filter((_, i) => i !== idx);
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  border: "1.5px solid var(--c-border)",
  background: "var(--c-surface-lowest)",
  fontSize: 14,
  color: "var(--c-text-primary)",
  outline: "none",
  boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 260,
  resize: "vertical",
  fontFamily: "inherit",
  lineHeight: 1.6,
};

const addBulletBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--c-primary-container)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  padding: "2px 8px",
};

const removeBulletBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#C1C7D2",
  cursor: "pointer",
  fontSize: 14,
  padding: "0 8px",
  lineHeight: 1,
};

const addSlideBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "14px 0",
  borderRadius: 10,
  border: "1.5px dashed #C1C7D2",
  background: "transparent",
  color: "var(--c-primary-container)",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  textAlign: "center",
};

function SaveBar({
  version,
  updatedAt,
  saved,
  isPending,
  onSave,
  minWidth = 110,
}: {
  version?: number;
  updatedAt?: string | null;
  saved: boolean;
  isPending: boolean;
  onSave: () => void;
  minWidth?: number;
}) {
  const canEdit = useContext(ContentEditCtx);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <span style={{ fontSize: 13, color: "#717782" }}>
        {version ? `v${version}` : ""}
        {updatedAt ? ` · Last saved ${new Date(updatedAt).toLocaleString()}` : ""}
      </span>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {saved && <span style={{ fontSize: 13, color: "#38A169", fontWeight: 600 }}>✓ Saved</span>}
        {!canEdit && (
          <span style={{ fontSize: 12, color: "#717782", fontStyle: "italic" }}>Admin access required to edit</span>
        )}
        <button
          className="btn-primary"
          onClick={onSave}
          disabled={isPending || !canEdit}
          style={{ minWidth, opacity: !canEdit ? 0.5 : 1, cursor: !canEdit ? "not-allowed" : "pointer" }}
          title={!canEdit ? "You have view-only access. Ask an admin to make changes." : undefined}
        >
          {isPending ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

// ── Confirmation dialog ────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  body,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div style={{
        background: "#fff", borderRadius: 16, padding: "32px 36px", maxWidth: 480, width: "90%",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#1B1C1C", marginBottom: 14 }}>{title}</div>
        <div style={{ fontSize: 14, color: "#414751", lineHeight: 1.6, marginBottom: 24 }}>{body}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{ padding: "9px 20px", borderRadius: 8, border: "1.5px solid #E4E2E1", background: "#fff", color: "#414751", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button className="btn-primary" onClick={onConfirm} style={{ padding: "9px 20px" }}>
            Confirm Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Part A editor ─────────────────────────────────────────────────────────────

function PartAEditor({ disasterKey }: { disasterKey: string }) {
  const qc = useQueryClient();
  const [slides, setSlides] = useState<SafetyTipSlide[]>([]);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["content-safety-tips", disasterKey],
    queryFn: async () => {
      const res = await api.get(`/api/content/safety-tips/${disasterKey}`);
      return res.data as { slides: SafetyTipSlide[]; version: number; updated_at: string | null };
    },
  });

  useEffect(() => {
    if (data?.slides) setSlides(data.slides);
  }, [data]);

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => api.patch(`/api/content/safety-tips/${disasterKey}`, { slides }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      qc.invalidateQueries({ queryKey: ["content-safety-tips", disasterKey] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading slides…</div>;
  }

  return (
    <div>
      <SaveBar version={data?.version} updatedAt={data?.updated_at} saved={saved} isPending={isPending} onSave={() => save()} />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {slides.map((slide, si) => (
          <div key={si} style={{ background: "#F6F3F2", borderRadius: 12, padding: 20, border: "1px solid #E4E2E1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Slide {si + 1}
              </span>
              <button
                onClick={() => setSlides(arrRemove(slides, si))}
                style={{ background: "none", border: "none", color: "#e53e3e", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "2px 8px" }}
              >
                ✕ Remove
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#414751", display: "block", marginBottom: 6 }}>Title</label>
              <input
                value={slide.title}
                onChange={(e) => setSlides(arrSet(slides, si, { ...slide, title: e.target.value }))}
                style={inputStyle}
                placeholder="Slide title"
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#276749" }}>DO bullets</label>
                <button onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: [...slide.dos, ""] }))} style={addBulletBtn}>+ Add</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.dos.map((d, di) => (
                  <div key={di} style={{ display: "flex", gap: 8 }}>
                    <input
                      value={d}
                      onChange={(e) => setSlides(arrSet(slides, si, { ...slide, dos: arrSet(slide.dos, di, e.target.value) }))}
                      style={{ ...inputStyle, borderLeft: "3px solid #38A169", flex: 1 }}
                      placeholder="Do bullet…"
                    />
                    <button onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: arrRemove(slide.dos, di) }))} style={removeBulletBtn}>✕</button>
                  </div>
                ))}
                {slide.dos.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DO bullets</span>}
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#e53e3e" }}>DON'T bullets</label>
                <button onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: [...slide.donts, ""] }))} style={addBulletBtn}>+ Add</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.donts.map((d, di) => (
                  <div key={di} style={{ display: "flex", gap: 8 }}>
                    <input
                      value={d}
                      onChange={(e) => setSlides(arrSet(slides, si, { ...slide, donts: arrSet(slide.donts, di, e.target.value) }))}
                      style={{ ...inputStyle, borderLeft: "3px solid #e53e3e", flex: 1 }}
                      placeholder="Don't bullet…"
                    />
                    <button onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: arrRemove(slide.donts, di) }))} style={removeBulletBtn}>✕</button>
                  </div>
                ))}
                {slide.donts.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DON'T bullets</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={() => setSlides([...slides, { title: "New Slide", dos: [], donts: [] }])} style={{ marginTop: 16, ...addSlideBtn }}>
        + Add Slide
      </button>
    </div>
  );
}

// ── Part B / C editor ─────────────────────────────────────────────────────────

function SlideshowEditor({ contentType }: { contentType: "reporting-guidelines" | "first-aid" }) {
  const qc = useQueryClient();
  const [slides, setSlides] = useState<SlideshowSlide[]>([]);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["content-slideshow", contentType],
    queryFn: async () => {
      const res = await api.get(`/api/content/${contentType}`);
      return res.data as { slides: SlideshowSlide[]; version: number; updated_at: string | null };
    },
  });

  useEffect(() => {
    if (data?.slides) setSlides(data.slides);
  }, [data]);

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => api.patch(`/api/content/${contentType}`, { slides }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      qc.invalidateQueries({ queryKey: ["content-slideshow", contentType] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading slides…</div>;
  }

  return (
    <div>
      <SaveBar version={data?.version} updatedAt={data?.updated_at} saved={saved} isPending={isPending} onSave={() => save()} />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {slides.map((slide, si) => (
          <div key={si} style={{ background: "#F6F3F2", borderRadius: 12, padding: 20, border: "1px solid #E4E2E1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Slide {si + 1}
              </span>
              <button onClick={() => setSlides(arrRemove(slides, si))} style={{ background: "none", border: "none", color: "#e53e3e", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "2px 8px" }}>
                ✕ Remove
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#414751", display: "block", marginBottom: 6 }}>Title</label>
              <input
                value={slide.title}
                onChange={(e) => setSlides(arrSet(slides, si, { ...slide, title: e.target.value }))}
                style={inputStyle}
                placeholder="Slide title"
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#414751" }}>Bullets</label>
                <button onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: [...slide.bullets, ""] }))} style={addBulletBtn}>+ Add</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.bullets.map((b, bi) => (
                  <div key={bi} style={{ display: "flex", gap: 8 }}>
                    <input
                      value={b}
                      onChange={(e) => setSlides(arrSet(slides, si, { ...slide, bullets: arrSet(slide.bullets, bi, e.target.value) }))}
                      style={{ ...inputStyle, flex: 1 }}
                      placeholder="Bullet point…"
                    />
                    <button onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: arrRemove(slide.bullets, bi) }))} style={removeBulletBtn}>✕</button>
                  </div>
                ))}
                {slide.bullets.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No bullets yet</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={() => setSlides([...slides, { title: "New Slide", bullets: [""] }])} style={{ marginTop: 16, ...addSlideBtn }}>
        + Add Slide
      </button>
    </div>
  );
}

// ── Plain text editor (T&C, Onboarding) ───────────────────────────────────────

function PlainTextEditor({
  contentType,
  label,
  placeholder,
  showTcWarning,
}: {
  contentType: string;
  label: string;
  placeholder?: string;
  showTcWarning?: boolean;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["content-plain", contentType],
    queryFn: async () => {
      const res = await api.get(`/api/content/${contentType}`);
      return res.data as { content: string; version: number; updated_at: string | null };
    },
  });

  useEffect(() => {
    if (data?.content !== undefined) setText(data.content);
  }, [data]);

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => api.patch(`/api/content/${contentType}`, { content: text }),
    onSuccess: () => {
      setSaved(true);
      setConfirmOpen(false);
      setTimeout(() => setSaved(false), 3000);
      qc.invalidateQueries({ queryKey: ["content-plain", contentType] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div>
      {showTcWarning && (
        <div style={{
          background: "#FFFBEA",
          border: "1.5px solid #F6E05E",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 20,
          fontSize: 13,
          color: "#744210",
          lineHeight: 1.6,
        }}>
          <strong>Note on reporter re-acceptance:</strong> Saving will publish the updated T&amp;C text and bump the backend version counter. However, reporters are only prompted to re-accept when the <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 5px", borderRadius: 4 }}>tc_version</code> string key in the language package is updated. These two values are currently managed independently — after saving major changes, update the <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 5px", borderRadius: 4 }}>tc_version</code> key via the Languages page to trigger re-acceptance.
        </div>
      )}

      <SaveBar
        version={data?.version}
        updatedAt={data?.updated_at}
        saved={saved}
        isPending={isPending}
        onSave={() => showTcWarning ? setConfirmOpen(true) : save()}
      />

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: "#414751", display: "block", marginBottom: 6 }}>{label}</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={textareaStyle}
          placeholder={placeholder}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Save Terms & Conditions?"
        body={
          <>
            Saving will publish the updated T&amp;C text to all reporters.
            <br /><br />
            Remember to also update the <strong>tc_version</strong> string key in the Languages page so reporters are prompted to re-accept the new terms.
          </>
        }
        onConfirm={() => save()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

// ── Key-value list editor (Error Messages, System Messages) ───────────────────

function KeyValueListEditor({ contentType }: { contentType: "error_messages" | "system_messages" }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<KeyValueItem[]>([]);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["content-kv", contentType],
    queryFn: async () => {
      const res = await api.get(`/api/content/${contentType}`);
      return res.data as { items: KeyValueItem[]; version: number; updated_at: string | null };
    },
  });

  useEffect(() => {
    if (data?.items) setItems(data.items);
  }, [data]);

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => api.patch(`/api/content/${contentType}`, { items }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      qc.invalidateQueries({ queryKey: ["content-kv", contentType] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div>
      <SaveBar version={data?.version} updatedAt={data?.updated_at} saved={saved} isPending={isPending} onSave={() => save()} />

      <div style={{ fontSize: 13, color: "#717782", marginBottom: 16 }}>
        Message keys are fixed and map to specific in-app states. Edit the text only.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((item, idx) => (
          <div key={item.key} style={{ background: "#F6F3F2", borderRadius: 10, padding: "14px 16px", border: "1px solid #E4E2E1" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              {item.key}
            </div>
            <input
              value={item.text}
              onChange={(e) => setItems(arrSet(items, idx, { ...item, text: e.target.value }))}
              style={inputStyle}
              placeholder="Message text…"
            />
          </div>
        ))}
        {items.length === 0 && (
          <div style={{ textAlign: "center", color: "#C1C7D2", fontSize: 14, padding: "32px 0" }}>No items</div>
        )}
      </div>
    </div>
  );
}

// ── Sub-tab bar ────────────────────────────────────────────────────────────────

function SubTabBar<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 24, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: active === t.key ? "none" : "1.5px solid #E4E2E1",
            background: active === t.key ? "var(--c-primary-container)" : "#fff",
            color: active === t.key ? "#fff" : "#414751",
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Reporter Safety section ────────────────────────────────────────────────────

const SAFETY_TABS: { key: SafetyPart; label: string }[] = [
  { key: "A", label: "Safety Tips" },
  { key: "B", label: "Reporting Guidelines" },
  { key: "C", label: "First Aid" },
];

function ReporterSafetySection() {
  const [activePart, setActivePart] = useState<SafetyPart>("A");
  const [activeDisaster, setActiveDisaster] = useState(DISASTER_TYPES[0].key);

  return (
    <div>
      <SubTabBar tabs={SAFETY_TABS} active={activePart} onChange={setActivePart} />

      {activePart === "A" && (
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 24, alignItems: "flex-start" }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", overflow: "hidden" }}>
            {DISASTER_TYPES.map((d) => (
              <button
                key={d.key}
                onClick={() => setActiveDisaster(d.key)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "12px 16px",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid #E4E2E1",
                  background: activeDisaster === d.key ? "rgba(4,104,177,0.07)" : "#fff",
                  color: activeDisaster === d.key ? "var(--c-primary-container)" : "#414751",
                  fontWeight: activeDisaster === d.key ? 700 : 500,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>
              {DISASTER_TYPES.find((d) => d.key === activeDisaster)?.label} Slides
            </h3>
            <PartAEditor key={activeDisaster} disasterKey={activeDisaster} />
          </div>
        </div>
      )}

      {activePart === "B" && (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Reporting Guidelines Slides</h3>
          <SlideshowEditor contentType="reporting-guidelines" />
        </div>
      )}

      {activePart === "C" && (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>First Aid Slides</h3>
          <SlideshowEditor contentType="first-aid" />
        </div>
      )}
    </div>
  );
}

// ── System Text section ────────────────────────────────────────────────────────

const SYSTEM_TABS: { key: SystemTab; label: string }[] = [
  { key: "tc",              label: "Terms & Conditions" },
  { key: "onboarding",      label: "Onboarding" },
  { key: "error_messages",  label: "Error Messages" },
  { key: "system_messages", label: "System Messages" },
];

function SystemTextSection() {
  const [activeTab, setActiveTab] = useState<SystemTab>("tc");

  return (
    <div>
      <SubTabBar tabs={SYSTEM_TABS} active={activeTab} onChange={setActiveTab} />

      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
        {activeTab === "tc" && (
          <>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Terms &amp; Conditions</h3>
            <PlainTextEditor
              contentType="tc"
              label="T&C text (shown to reporters before first report submission)"
              placeholder="Enter the full Terms & Conditions text…"
              showTcWarning
            />
          </>
        )}

        {activeTab === "onboarding" && (
          <>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Onboarding Text</h3>
            <PlainTextEditor
              contentType="onboarding"
              label="Welcome message shown to reporters during onboarding"
              placeholder="Enter the onboarding welcome text…"
            />
          </>
        )}

        {activeTab === "error_messages" && (
          <>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Error Messages</h3>
            <KeyValueListEditor contentType="error_messages" />
          </>
        )}

        {activeTab === "system_messages" && (
          <>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>System Messages</h3>
            <KeyValueListEditor contentType="system_messages" />
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const GROUP_TABS: { key: SectionGroup; label: string; subtitle: string }[] = [
  { key: "reporter-safety", label: "Reporter Safety",  subtitle: "Safety tips, reporting guidelines, and first aid slides shown in the reporter app" },
  { key: "system-text",     label: "System Text",      subtitle: "Terms & Conditions, onboarding copy, error messages, and system notifications" },
];

export default function ContentManagementPage() {
  const { user } = useAuthStore();
  const canEdit = user?.role === "admin" || user?.role === "superadmin";
  const [activeGroup, setActiveGroup] = useState<SectionGroup>("reporter-safety");
  const activeGroupMeta = GROUP_TABS.find((g) => g.key === activeGroup)!;

  return (
    <ContentEditCtx.Provider value={canEdit}>
      <div className="page-wrapper">
        <Header title="Content Management" subtitle="Manage all reporter-facing content published through the language pipeline" />

        <div className="page-content">
          {!canEdit && (
            <div style={{
              background: "#EBF4FF",
              border: "1.5px solid #BEE3F8",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 13,
              color: "#2B6CB0",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>👁</span>
              <span>
                <strong>View-only mode.</strong> Your role has read access to this section but cannot save changes.
                Contact a system administrator to request edit access.
              </span>
            </div>
          )}

          {/* Group tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {GROUP_TABS.map((g) => (
              <button
                key={g.key}
                onClick={() => setActiveGroup(g.key)}
                style={{
                  padding: "10px 26px",
                  borderRadius: 10,
                  border: activeGroup === g.key ? "none" : "1.5px solid #E4E2E1",
                  background: activeGroup === g.key ? "var(--c-primary-container)" : "#fff",
                  color: activeGroup === g.key ? "#fff" : "#414751",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {g.label}
              </button>
            ))}
          </div>

          <p style={{ fontSize: 13, color: "#717782", marginBottom: 24, marginTop: 6 }}>
            {activeGroupMeta.subtitle}
          </p>

          {activeGroup === "reporter-safety" && <ReporterSafetySection />}
          {activeGroup === "system-text"     && <SystemTextSection />}
        </div>
      </div>
    </ContentEditCtx.Provider>
  );
}
