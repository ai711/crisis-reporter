import { useState, useEffect, createContext, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import { usePageTitle } from "../hooks/usePageTitle";

// ── Edit-permission context ─────────────────────────────────────────────────
const ContentEditCtx = createContext(true);

// ── Types ───────────────────────────────────────────────────────────────────

interface SafetyTipSlide {
  slide_id?: string;
  title: string;
  dos: string[];
  donts: string[];
}

interface SlideshowSlide {
  slide_id?: string;
  title: string;
  bullets: string[];
}

interface KeyValueItem {
  key: string;
  label?: string;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function arrSet<T>(arr: T[], idx: number, val: T): T[] {
  return arr.map((x, i) => (i === idx ? val : x));
}
function arrRemove<T>(arr: T[], idx: number): T[] {
  return arr.filter((_, i) => i !== idx);
}

// ── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  border: "1.5px solid var(--c-surface-high)",
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

// ── CharCounter ──────────────────────────────────────────────────────────────
// Only renders when the value is over 60% of the limit.

function CharCounter({ value, max }: { value: string; max: number }) {
  const len = value.length;
  const pct = len / max;
  if (pct < 0.6) return null;
  const over = len > max;
  const warn = len > max * 0.875;
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      color: over ? "#e53e3e" : warn ? "#D69E2E" : "#C1C7D2",
      marginLeft: 6,
      flexShrink: 0,
    }}>
      {len}/{max}
    </span>
  );
}

// ── Inline remove confirm ────────────────────────────────────────────────────

function RemoveButton({
  onConfirm,
  disabled,
}: {
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (disabled) return null;
  if (confirming) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#e53e3e", fontWeight: 600 }}>Remove this slide?</span>
        <button
          onClick={() => { setConfirming(false); onConfirm(); }}
          style={{ background: "#e53e3e", border: "none", color: "#fff", borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
        >
          Remove
        </button>
        <button
          onClick={() => setConfirming(false)}
          style={{ background: "none", border: "1.5px solid #C1C7D2", color: "#717782", borderRadius: 6, padding: "3px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      style={{ background: "none", border: "none", color: "#C1C7D2", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "2px 8px" }}
    >
      ✕ Remove
    </button>
  );
}

// ── Mobile slide preview modal ───────────────────────────────────────────────

function SlidePreviewModal({
  slide,
  part,
  slideNum,
  total,
  onClose,
}: {
  slide: SafetyTipSlide | SlideshowSlide;
  part: "A" | "B" | "C";
  slideNum: number;
  total: number;
  onClose: () => void;
}) {
  const isA = part === "A";
  const tipSlide = slide as SafetyTipSlide;
  const bcSlide = slide as SlideshowSlide;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        {/* Phone frame */}
        <div style={{
          width: 390, background: "#F6F3F2", borderRadius: 40, overflow: "hidden",
          boxShadow: "0 30px 80px rgba(0,0,0,0.4)", border: "8px solid #1B1C1C",
          maxHeight: "80vh", display: "flex", flexDirection: "column",
        }}>
          {/* Status bar notch */}
          <div style={{ background: "#1B1C1C", height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 80, height: 12, background: "#333", borderRadius: 10 }} />
          </div>
          {/* App bar */}
          <div style={{ background: "#0468B1", padding: "12px 20px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "#fff", fontSize: 13, fontWeight: 700 }}>
              {part === "A" ? "Safety Tips" : part === "B" ? "Reporting Guidelines" : "First Aid Essentials"}
            </span>
          </div>
          {/* Progress dots */}
          <div style={{ padding: "10px 20px 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "#717782", fontWeight: 500 }}>Slide {slideNum} of {total}</span>
            <div style={{ display: "flex", gap: 4 }}>
              {Array.from({ length: total }).map((_, i) => (
                <div key={i} style={{
                  width: i + 1 === slideNum ? 16 : 6, height: 6, borderRadius: 3,
                  background: i + 1 === slideNum ? "#0468B1" : "#C1C7D2",
                  transition: "width 0.2s",
                }} />
              ))}
            </div>
          </div>
          {/* Slide content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 20px" }}>
            <div style={{
              background: "#fff", borderRadius: 16, padding: "20px 18px",
              boxShadow: "0 2px 12px rgba(0,0,0,0.08)", marginBottom: 12,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1B1C1C", marginBottom: 16, lineHeight: 1.4 }}>
                {slide.title || <span style={{ color: "#C1C7D2", fontStyle: "italic" }}>No title</span>}
              </div>
              {isA ? (
                <>
                  {tipSlide.dos.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#276749", letterSpacing: "0.1em", marginBottom: 8 }}>DO</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {tipSlide.dos.map((d, i) => (
                          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#38A169", flexShrink: 0, marginTop: 6 }} />
                            <span style={{ fontSize: 13, color: "#1B1C1C", lineHeight: 1.5 }}>{d || <span style={{ color: "#C1C7D2", fontStyle: "italic" }}>Empty bullet</span>}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {tipSlide.donts.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "#C53030", letterSpacing: "0.1em", marginBottom: 8 }}>DON'T</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {tipSlide.donts.map((d, i) => (
                          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#e53e3e", flexShrink: 0, marginTop: 6 }} />
                            <span style={{ fontSize: 13, color: "#1B1C1C", lineHeight: 1.5 }}>{d || <span style={{ color: "#C1C7D2", fontStyle: "italic" }}>Empty bullet</span>}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {tipSlide.dos.length === 0 && tipSlide.donts.length === 0 && (
                    <span style={{ color: "#C1C7D2", fontStyle: "italic", fontSize: 13 }}>No bullets added yet</span>
                  )}
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {bcSlide.bullets.map((b, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#0468B1", flexShrink: 0, marginTop: 6 }} />
                      <span style={{ fontSize: 13, color: "#1B1C1C", lineHeight: 1.5 }}>{b || <span style={{ color: "#C1C7D2", fontStyle: "italic" }}>Empty bullet</span>}</span>
                    </div>
                  ))}
                  {bcSlide.bullets.length === 0 && (
                    <span style={{ color: "#C1C7D2", fontStyle: "italic", fontSize: 13 }}>No bullets added yet</span>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Nav footer */}
          <div style={{ padding: "12px 20px 20px", background: "#F6F3F2", borderTop: "1px solid #E4E2E1", display: "flex", gap: 10 }}>
            <div style={{ flex: 1, height: 44, borderRadius: 10, border: "1.5px solid #C1C7D2", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#C1C7D2" }}>← Previous</span>
            </div>
            <div style={{ flex: 1, height: 44, borderRadius: 10, background: "#0468B1", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Next →</span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ color: "#fff", background: "none", border: "1.5px solid rgba(255,255,255,0.4)", borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          Close preview
        </button>
      </div>
    </div>
  );
}

// ── Post-save publish callout ────────────────────────────────────────────────

function PublishCallout({ onDismiss }: { onDismiss: () => void }) {
  const navigate = useNavigate();
  return (
    <div style={{
      background: "#EBF8FF",
      border: "1.5px solid #90CDF4",
      borderRadius: 10,
      padding: "12px 16px",
      marginTop: 12,
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
    }}>
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>✓</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#2B6CB0", marginBottom: 3 }}>
          Saved — auto-translation queued for 5 languages
        </div>
        <div style={{ fontSize: 12, color: "#2C5282", lineHeight: 1.6 }}>
          Non-English reporters won't see changes until you publish a new language package.
        </div>
        <button
          onClick={() => navigate("/settings")}
          style={{ marginTop: 6, background: "none", border: "none", color: "#2B6CB0", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0, textDecoration: "underline" }}
        >
          Go to Languages page to publish →
        </button>
      </div>
      <button
        onClick={onDismiss}
        style={{ background: "none", border: "none", color: "#90CDF4", cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ── SaveBar ──────────────────────────────────────────────────────────────────

function SaveBar({
  version,
  updatedAt,
  saved,
  isPending,
  onSave,
  showPublishReminder = false,
  minWidth = 110,
}: {
  version?: number;
  updatedAt?: string | null;
  saved: boolean;
  isPending: boolean;
  onSave: () => void;
  showPublishReminder?: boolean;
  minWidth?: number;
}) {
  const canEdit = useContext(ContentEditCtx);
  const [calloutDismissed, setCalloutDismissed] = useState(false);
  const showCallout = saved && showPublishReminder && !calloutDismissed;

  // Reset dismiss when a new save happens
  useEffect(() => {
    if (saved) setCalloutDismissed(false);
  }, [saved]);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#717782" }}>
          {version ? `v${version}` : ""}
          {updatedAt ? ` · Last saved ${new Date(updatedAt).toLocaleString()}` : ""}
        </span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
      {showCallout && <PublishCallout onDismiss={() => setCalloutDismissed(true)} />}
    </div>
  );
}

// ── Confirmation dialog ───────────────────────────────────────────────────────

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
        background: "var(--c-surface-lowest)", borderRadius: 16, padding: "32px 36px", maxWidth: 480, width: "90%",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--c-text-primary)", marginBottom: 14 }}>{title}</div>
        <div style={{ fontSize: 14, color: "var(--c-text-secondary)", lineHeight: 1.6, marginBottom: 24 }}>{body}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{ padding: "9px 20px", borderRadius: 8, border: "1.5px solid var(--c-surface-high)", background: "var(--c-surface-lowest)", color: "var(--c-text-secondary)", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
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
  const canEdit = useContext(ContentEditCtx);
  const qc = useQueryClient();
  const [slides, setSlides] = useState<SafetyTipSlide[]>([]);
  const [saved, setSaved] = useState(false);
  const [previewSlide, setPreviewSlide] = useState<{ slide: SafetyTipSlide; idx: number } | null>(null);

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
      setTimeout(() => setSaved(false), 8000);
      qc.invalidateQueries({ queryKey: ["content-safety-tips", disasterKey] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading slides…</div>;
  }

  const readOnly = !canEdit;

  return (
    <div>
      <SaveBar
        version={data?.version}
        updatedAt={data?.updated_at}
        saved={saved}
        isPending={isPending}
        onSave={() => save()}
        showPublishReminder
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {slides.map((slide, si) => (
          <div key={si} style={{ background: "#F6F3F2", borderRadius: 12, padding: 20, border: "1px solid #E4E2E1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Slide {si + 1}
              </span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => setPreviewSlide({ slide, idx: si })}
                  style={{ background: "none", border: "1.5px solid #C1C7D2", color: "#717782", borderRadius: 6, fontSize: 11, fontWeight: 600, padding: "3px 10px", cursor: "pointer" }}
                >
                  Preview
                </button>
                <RemoveButton disabled={readOnly} onConfirm={() => setSlides(arrRemove(slides, si))} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#414751" }}>Title</label>
                <CharCounter value={slide.title} max={80} />
              </div>
              <input
                value={slide.title}
                onChange={(e) => !readOnly && setSlides(arrSet(slides, si, { ...slide, title: e.target.value }))}
                readOnly={readOnly}
                maxLength={80}
                style={{ ...inputStyle, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
                placeholder="Slide title"
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#276749" }}>DO bullets</label>
                {!readOnly && (
                  <button onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: [...slide.dos, ""] }))} style={addBulletBtn}>+ Add</button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.dos.map((d, di) => (
                  <div key={di} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={d}
                      onChange={(e) => !readOnly && setSlides(arrSet(slides, si, { ...slide, dos: arrSet(slide.dos, di, e.target.value) }))}
                      readOnly={readOnly}
                      maxLength={160}
                      style={{ ...inputStyle, borderLeft: "3px solid #38A169", flex: 1, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
                      placeholder="Do bullet…"
                    />
                    <CharCounter value={d} max={160} />
                    {!readOnly && (
                      <button onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: arrRemove(slide.dos, di) }))} style={{ background: "none", border: "none", color: "#C1C7D2", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
                    )}
                  </div>
                ))}
                {slide.dos.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DO bullets</span>}
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#e53e3e" }}>DON'T bullets</label>
                {!readOnly && (
                  <button onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: [...slide.donts, ""] }))} style={addBulletBtn}>+ Add</button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.donts.map((d, di) => (
                  <div key={di} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={d}
                      onChange={(e) => !readOnly && setSlides(arrSet(slides, si, { ...slide, donts: arrSet(slide.donts, di, e.target.value) }))}
                      readOnly={readOnly}
                      maxLength={160}
                      style={{ ...inputStyle, borderLeft: "3px solid #e53e3e", flex: 1, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
                      placeholder="Don't bullet…"
                    />
                    <CharCounter value={d} max={160} />
                    {!readOnly && (
                      <button onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: arrRemove(slide.donts, di) }))} style={{ background: "none", border: "none", color: "#C1C7D2", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
                    )}
                  </div>
                ))}
                {slide.donts.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DON'T bullets</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <button onClick={() => setSlides([...slides, { title: "New Slide", dos: [], donts: [] }])} style={{ marginTop: 16, ...addSlideBtn }}>
          + Add Slide
        </button>
      )}

      {previewSlide && (
        <SlidePreviewModal
          slide={previewSlide.slide}
          part="A"
          slideNum={previewSlide.idx + 1}
          total={slides.length}
          onClose={() => setPreviewSlide(null)}
        />
      )}
    </div>
  );
}

// ── Part B / C editor ─────────────────────────────────────────────────────────

function SlideshowEditor({ contentType }: { contentType: "reporting-guidelines" | "first-aid" }) {
  const canEdit = useContext(ContentEditCtx);
  const qc = useQueryClient();
  const [slides, setSlides] = useState<SlideshowSlide[]>([]);
  const [saved, setSaved] = useState(false);
  const part: "B" | "C" = contentType === "reporting-guidelines" ? "B" : "C";
  const [previewSlide, setPreviewSlide] = useState<{ slide: SlideshowSlide; idx: number } | null>(null);

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
      setTimeout(() => setSaved(false), 8000);
      qc.invalidateQueries({ queryKey: ["content-slideshow", contentType] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: "32px 0", color: "#717782", textAlign: "center" }}>Loading slides…</div>;
  }

  const readOnly = !canEdit;

  return (
    <div>
      <SaveBar
        version={data?.version}
        updatedAt={data?.updated_at}
        saved={saved}
        isPending={isPending}
        onSave={() => save()}
        showPublishReminder
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {slides.map((slide, si) => (
          <div key={si} style={{ background: "#F6F3F2", borderRadius: 12, padding: 20, border: "1px solid #E4E2E1" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Slide {si + 1}
              </span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => setPreviewSlide({ slide, idx: si })}
                  style={{ background: "none", border: "1.5px solid #C1C7D2", color: "#717782", borderRadius: 6, fontSize: 11, fontWeight: 600, padding: "3px 10px", cursor: "pointer" }}
                >
                  Preview
                </button>
                <RemoveButton disabled={readOnly} onConfirm={() => setSlides(arrRemove(slides, si))} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#414751" }}>Title</label>
                <CharCounter value={slide.title} max={80} />
              </div>
              <input
                value={slide.title}
                onChange={(e) => !readOnly && setSlides(arrSet(slides, si, { ...slide, title: e.target.value }))}
                readOnly={readOnly}
                maxLength={80}
                style={{ ...inputStyle, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
                placeholder="Slide title"
              />
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#414751" }}>Bullets</label>
                {!readOnly && (
                  <button onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: [...slide.bullets, ""] }))} style={addBulletBtn}>+ Add</button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {slide.bullets.map((b, bi) => (
                  <div key={bi} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={b}
                      onChange={(e) => !readOnly && setSlides(arrSet(slides, si, { ...slide, bullets: arrSet(slide.bullets, bi, e.target.value) }))}
                      readOnly={readOnly}
                      maxLength={160}
                      style={{ ...inputStyle, flex: 1, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
                      placeholder="Bullet point…"
                    />
                    <CharCounter value={b} max={160} />
                    {!readOnly && (
                      <button onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: arrRemove(slide.bullets, bi) }))} style={{ background: "none", border: "none", color: "#C1C7D2", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
                    )}
                  </div>
                ))}
                {slide.bullets.length === 0 && <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No bullets yet</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <button onClick={() => setSlides([...slides, { title: "New Slide", bullets: [""] }])} style={{ marginTop: 16, ...addSlideBtn }}>
          + Add Slide
        </button>
      )}

      {previewSlide && (
        <SlidePreviewModal
          slide={previewSlide.slide}
          part={part}
          slideNum={previewSlide.idx + 1}
          total={slides.length}
          onClose={() => setPreviewSlide(null)}
        />
      )}
    </div>
  );
}

// ── Plain text editor (T&C, Onboarding) ──────────────────────────────────────

function PlainTextEditor({
  contentType,
  label,
  placeholder,
  showTcConfirm,
}: {
  contentType: string;
  label: string;
  placeholder?: string;
  showTcConfirm?: boolean;
}) {
  const canEdit = useContext(ContentEditCtx);
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

  const readOnly = !canEdit;

  return (
    <div>
      <SaveBar
        version={data?.version}
        updatedAt={data?.updated_at}
        saved={saved}
        isPending={isPending}
        onSave={() => showTcConfirm ? setConfirmOpen(true) : save()}
      />

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: "#414751", display: "block", marginBottom: 6 }}>{label}</label>
        <textarea
          value={text}
          onChange={(e) => !readOnly && setText(e.target.value)}
          readOnly={readOnly}
          style={{ ...textareaStyle, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
          placeholder={placeholder}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Save Terms & Conditions?"
        body={
          <>
            Saving will update the T&amp;C text shown to reporters in all 6 UN languages (auto-translated).
            Reporters who previously accepted will be prompted to re-accept.
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
  const canEdit = useContext(ContentEditCtx);
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

  const readOnly = !canEdit;

  return (
    <div>
      <SaveBar version={data?.version} updatedAt={data?.updated_at} saved={saved} isPending={isPending} onSave={() => save()} />

      <div style={{ fontSize: 13, color: "#717782", marginBottom: 16 }}>
        Changes are auto-translated into all 6 UN languages. Keys map to specific in-app states — edit text only.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((item, idx) => (
          <div key={item.key} style={{ background: "#F6F3F2", borderRadius: 10, padding: "14px 16px", border: "1px solid #E4E2E1" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
              {item.label || item.key}
            </div>
            <input
              value={item.text}
              onChange={(e) => !readOnly && setItems(arrSet(items, idx, { ...item, text: e.target.value }))}
              readOnly={readOnly}
              style={{ ...inputStyle, background: readOnly ? "#F8F7F6" : "var(--c-surface-lowest)" }}
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

// ── Sub-tab bar ───────────────────────────────────────────────────────────────

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

// ── Reporter Safety section ───────────────────────────────────────────────────

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
          {/* Disaster type sidebar */}
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
                  borderLeft: activeDisaster === d.key ? "3px solid var(--c-primary-container)" : "3px solid transparent",
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
            {/* Breadcrumb */}
            <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>
              Reporter Safety › Safety Tips › {DISASTER_TYPES.find((d) => d.key === activeDisaster)?.label}
            </div>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>
              {DISASTER_TYPES.find((d) => d.key === activeDisaster)?.label} Slides
            </h3>
            <PartAEditor key={activeDisaster} disasterKey={activeDisaster} />
          </div>
        </div>
      )}

      {activePart === "B" && (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
          <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>
            Reporter Safety › Reporting Guidelines
          </div>
          <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Reporting Guidelines Slides</h3>
          <SlideshowEditor contentType="reporting-guidelines" />
        </div>
      )}

      {activePart === "C" && (
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
          <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>
            Reporter Safety › First Aid
          </div>
          <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>First Aid Slides</h3>
          <SlideshowEditor contentType="first-aid" />
        </div>
      )}
    </div>
  );
}

// ── System Text section ───────────────────────────────────────────────────────

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
            <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>System Text › Terms &amp; Conditions</div>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Terms &amp; Conditions</h3>
            <PlainTextEditor
              contentType="tc"
              label="T&C text (auto-translated to all 6 UN languages and published on save)"
              placeholder="Enter the full Terms & Conditions text…"
              showTcConfirm
            />
          </>
        )}

        {activeTab === "onboarding" && (
          <>
            <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>System Text › Onboarding</div>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Onboarding Text</h3>
            <PlainTextEditor
              contentType="onboarding"
              label="Welcome message (shown on the onboarding screen · auto-translated to all 6 UN languages)"
              placeholder="Enter the onboarding welcome text…"
            />
          </>
        )}

        {activeTab === "error_messages" && (
          <>
            <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>System Text › Error Messages</div>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>Error Messages</h3>
            <KeyValueListEditor contentType="error_messages" />
          </>
        )}

        {activeTab === "system_messages" && (
          <>
            <div style={{ fontSize: 12, color: "#C1C7D2", marginBottom: 4, fontWeight: 500 }}>System Text › System Messages</div>
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
  usePageTitle("Content Management");
  const { user } = useAuthStore();
  const canEdit = user?.role === "admin" || user?.role === "superadmin";
  const [activeGroup, setActiveGroup] = useState<SectionGroup>("reporter-safety");
  const activeGroupMeta = GROUP_TABS.find((g) => g.key === activeGroup)!;

  return (
    <ContentEditCtx.Provider value={canEdit}>
      <div className="page-wrapper">
        <Header title="Content Management" subtitle="Manage reporter-facing content · Changes to Reporter Safety are auto-translated and published via the Languages page" />

        <div className="page-content">
          {!canEdit && (
            <div style={{
              background: "#F7FAFF",
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
              <span style={{ fontSize: 16 }}>🔒</span>
              <span>
                <strong>View-only mode.</strong> All fields are read-only. Contact a system administrator to request edit access.
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
