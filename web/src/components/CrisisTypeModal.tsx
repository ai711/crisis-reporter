import { useTranslation } from "react-i18next";

interface CrisisTypeModalProps {
  onClose: () => void;
}

const CRISIS_TYPES: { key: string; name: string; desc: string }[] = [
  { key: "earthquake",        name: "Earthquake",          desc: "Structural damage to buildings and infrastructure caused by seismic activity" },
  { key: "flood",             name: "Flood",               desc: "Water damage to properties, roads, and community areas" },
  { key: "tsunami",           name: "Tsunami",             desc: "Coastal destruction caused by large ocean waves" },
  { key: "hurricane_cyclone", name: "Hurricane / Cyclone", desc: "Wind and water damage from tropical storm systems" },
  { key: "wildfire",          name: "Wildfire",            desc: "Fire damage to buildings, land, and surrounding areas" },
  { key: "explosion",         name: "Explosion",           desc: "Blast damage to structures and nearby properties" },
  { key: "chemical_incident", name: "Chemical Incident",   desc: "Damage or contamination caused by hazardous substances" },
  { key: "conflict",          name: "Conflict",            desc: "Damage to buildings and infrastructure in conflict-affected areas" },
  { key: "civil_unrest",      name: "Civil Unrest",        desc: "Property damage resulting from civil disturbances" },
];

export default function CrisisTypeModal({ onClose }: CrisisTypeModalProps) {
  const { t } = useTranslation();

  return (
    <div
      style={s.overlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="What can I report?"
    >
      <div style={s.card} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <h2 style={s.title}>{t("home.whatCanReport", "What can I report?")}</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">
            <svg
              width={20}
              height={20}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#717782"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={s.list}>
          {CRISIS_TYPES.map((ct, idx) => (
            <div key={ct.key}>
              <div style={s.item}>
                <p style={s.itemName}>
                  {t(`disaster_label.${ct.key}`, ct.name)}
                </p>
                <p style={s.itemDesc}>
                  {t(`crisis_types.${ct.key}`, ct.desc)}
                </p>
              </div>
              {idx < CRISIS_TYPES.length - 1 && <div style={s.divider} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    maxWidth: 480,
    width: "100%",
    maxHeight: "82vh",
    overflowY: "auto",
    boxShadow: "0 8px 32px rgba(0,0,0,0.16)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 20px 14px",
    borderBottom: "1px solid #F0F4F8",
    position: "sticky",
    top: 0,
    background: "#fff",
    zIndex: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: 0,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    flexShrink: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    padding: "8px 20px 20px",
  },
  item: {
    padding: "12px 0",
  },
  itemName: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: "0 0 4px",
  },
  itemDesc: {
    fontSize: 13,
    color: "#717782",
    margin: 0,
    lineHeight: 1.5,
  },
  divider: {
    height: 1,
    background: "#F0F4F8",
  },
};
