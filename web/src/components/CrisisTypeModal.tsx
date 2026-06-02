import { useTranslation } from "react-i18next";

interface CrisisTypeModalProps {
  onClose: () => void;
}

const CRISIS_TYPES: {
  key: string;
  name: string;
  icon: string;
  bg: string;
  desc: string;
}[] = [
  { key: "earthquake",        name: "Earthquake",          icon: "🌍", bg: "#FEF3C7", desc: "Collapsed buildings, ground damage, structural failures" },
  { key: "flood",             name: "Flood",               icon: "🌊", bg: "#DBEAFE", desc: "Water damage, flooded roads, submerged structures" },
  { key: "tsunami",           name: "Tsunami",             icon: "🏄", bg: "#E0F2FE", desc: "Coastal flooding and wave-driven infrastructure damage" },
  { key: "hurricane_cyclone", name: "Hurricane / Cyclone", icon: "🌀", bg: "#EDE9FE", desc: "Wind damage, roof collapse, flooding, downed trees" },
  { key: "wildfire",          name: "Wildfire",            icon: "🔥", bg: "#FEE2E2", desc: "Fire damage to structures and emergency evacuations" },
  { key: "explosion",         name: "Explosion",           icon: "💥", bg: "#FFE4CC", desc: "Blast damage to buildings and surrounding infrastructure" },
  { key: "chemical_incident", name: "Chemical Incident",   icon: "☣️", bg: "#DCFCE7", desc: "Hazardous material leaks or contamination zones" },
  { key: "conflict",          name: "Conflict",            icon: "⚔️",  bg: "#FEE2E2", desc: "Armed conflict damage to infrastructure and buildings" },
  { key: "civil_unrest",      name: "Civil Unrest",        icon: "🚨", bg: "#FEF9C3", desc: "Damage from public disorder or civil disturbances" },
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
                <div style={{ ...s.iconCircle, background: ct.bg }}>
                  <span style={s.iconEmoji}>{ct.icon}</span>
                </div>
                <div style={s.itemText}>
                  <p style={s.itemName}>
                    {t(`disaster_label.${ct.key}`, ct.name)}
                  </p>
                  <p style={s.itemDesc}>
                    {t(`crisis_types.${ct.key}`, ct.desc)}
                  </p>
                </div>
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
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
  },
  iconCircle: {
    width: 46,
    height: 46,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconEmoji: {
    fontSize: 22,
    lineHeight: "1",
  },
  itemText: {
    flex: 1,
    minWidth: 0,
    paddingTop: 2,
  },
  itemName: {
    fontSize: 14,
    fontWeight: 700,
    color: "#1A2B4A",
    margin: "0 0 3px",
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
    marginLeft: 60,
  },
};
