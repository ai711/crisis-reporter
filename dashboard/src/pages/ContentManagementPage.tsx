import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import Header from "../components/Header";

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

type Part = "A" | "B" | "C";

const DISASTER_TYPES = [
  { key: "earthquake",       label: "Earthquake" },
  { key: "flood",            label: "Flood" },
  { key: "tsunami",          label: "Tsunami" },
  { key: "hurricane_cyclone",label: "Hurricane / Cyclone" },
  { key: "wildfire",         label: "Wildfire" },
  { key: "explosion",        label: "Explosion" },
  { key: "chemical_incident",label: "Chemical Incident" },
  { key: "conflict",         label: "Conflict" },
  { key: "civil_unrest",     label: "Civil Unrest" },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function arrSet<T>(arr: T[], idx: number, val: T): T[] {
  return arr.map((x, i) => (i === idx ? val : x));
}
function arrRemove<T>(arr: T[], idx: number): T[] {
  return arr.filter((_, i) => i !== idx);
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
    mutationFn: () =>
      api.patch(`/api/content/safety-tips/${disasterKey}`, { slides }),
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <span style={{ fontSize: 13, color: "#717782" }}>
            {slides.length} slides{data?.version ? ` · v${data.version}` : ""}
            {data?.updated_at ? ` · Last saved ${new Date(data.updated_at).toLocaleString()}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {saved && (
            <span style={{ fontSize: 13, color: "#38A169", fontWeight: 600 }}>✓ Saved</span>
          )}
          <button
            className="btn-primary"
            onClick={() => save()}
            disabled={isPending}
            style={{ minWidth: 100 }}
          >
            {isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

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

            {/* Title */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#414751", display: "block", marginBottom: 6 }}>Title</label>
              <input
                value={slide.title}
                onChange={(e) => setSlides(arrSet(slides, si, { ...slide, title: e.target.value }))}
                style={inputStyle}
                placeholder="Slide title"
              />
            </div>

            {/* Do's */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#276749" }}>DO bullets</label>
                <button
                  onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: [...slide.dos, ""] }))}
                  style={addBulletBtn}
                >+ Add</button>
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
                    <button
                      onClick={() => setSlides(arrSet(slides, si, { ...slide, dos: arrRemove(slide.dos, di) }))}
                      style={removeBulletBtn}
                    >✕</button>
                  </div>
                ))}
                {slide.dos.length === 0 && (
                  <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DO bullets</span>
                )}
              </div>
            </div>

            {/* Don'ts */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#e53e3e" }}>DON'T bullets</label>
                <button
                  onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: [...slide.donts, ""] }))}
                  style={addBulletBtn}
                >+ Add</button>
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
                    <button
                      onClick={() => setSlides(arrSet(slides, si, { ...slide, donts: arrRemove(slide.donts, di) }))}
                      style={removeBulletBtn}
                    >✕</button>
                  </div>
                ))}
                {slide.donts.length === 0 && (
                  <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No DON'T bullets</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setSlides([...slides, { title: "New Slide", dos: [], donts: [] }])}
        style={{ marginTop: 16, ...addSlideBtn }}
      >
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: "#717782" }}>
          {slides.length} slides{data?.version ? ` · v${data.version}` : ""}
          {data?.updated_at ? ` · Last saved ${new Date(data.updated_at).toLocaleString()}` : ""}
        </span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {saved && <span style={{ fontSize: 13, color: "#38A169", fontWeight: 600 }}>✓ Saved</span>}
          <button className="btn-primary" onClick={() => save()} disabled={isPending} style={{ minWidth: 100 }}>
            {isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

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
              >✕ Remove</button>
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
                <button
                  onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: [...slide.bullets, ""] }))}
                  style={addBulletBtn}
                >+ Add</button>
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
                    <button
                      onClick={() => setSlides(arrSet(slides, si, { ...slide, bullets: arrRemove(slide.bullets, bi) }))}
                      style={removeBulletBtn}
                    >✕</button>
                  </div>
                ))}
                {slide.bullets.length === 0 && (
                  <span style={{ fontSize: 12, color: "#C1C7D2", fontStyle: "italic" }}>No bullets yet</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => setSlides([...slides, { title: "New Slide", bullets: [""] }])}
        style={{ marginTop: 16, ...addSlideBtn }}
      >
        + Add Slide
      </button>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 8,
  border: "1.5px solid #E4E2E1",
  background: "#FFFFFF",
  fontSize: 14,
  color: "#1B1C1C",
  outline: "none",
  boxSizing: "border-box",
};

const addBulletBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#0468B1",
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
  color: "#0468B1",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  textAlign: "center",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ContentManagementPage() {
  const [activePart, setActivePart] = useState<Part>("A");
  const [activeDisaster, setActiveDisaster] = useState(DISASTER_TYPES[0].key);

  return (
    <div className="page-wrapper">
      <Header title="Content Management" subtitle="Edit safety tips and training slides shown to reporters" />

      <div className="page-content">
        {/* Part tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
          {(["A", "B", "C"] as Part[]).map((p) => (
            <button
              key={p}
              onClick={() => setActivePart(p)}
              style={{
                padding: "10px 24px",
                borderRadius: 10,
                border: activePart === p ? "none" : "1.5px solid #E4E2E1",
                background: activePart === p ? "#0468B1" : "#fff",
                color: activePart === p ? "#fff" : "#414751",
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Part {p} — {p === "A" ? "Safety Tips" : p === "B" ? "Reporting Guidelines" : "First Aid"}
            </button>
          ))}
        </div>

        {/* Part A: disaster selector + editor */}
        {activePart === "A" && (
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 24, alignItems: "flex-start" }}>
            {/* Disaster list */}
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
                    color: activeDisaster === d.key ? "#0468B1" : "#414751",
                    fontWeight: activeDisaster === d.key ? 700 : 500,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {/* Slide editor */}
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
              <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>
                {DISASTER_TYPES.find((d) => d.key === activeDisaster)?.label} Slides
              </h3>
              <PartAEditor key={activeDisaster} disasterKey={activeDisaster} />
            </div>
          </div>
        )}

        {/* Part B */}
        {activePart === "B" && (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>
              Reporting Guidelines Slides
            </h3>
            <SlideshowEditor contentType="reporting-guidelines" />
          </div>
        )}

        {/* Part C */}
        {activePart === "C" && (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E4E2E1", padding: 24 }}>
            <h3 style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 700, color: "#1B1C1C" }}>
              First Aid Slides
            </h3>
            <SlideshowEditor contentType="first-aid" />
          </div>
        )}
      </div>
    </div>
  );
}
