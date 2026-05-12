import { useTranslation } from "react-i18next";

interface CrisisTypeModalProps {
  onClose: () => void;
}

const CRISIS_TYPES: { key: string; name: string }[] = [
  { key: "earthquake",       name: "Earthquake" },
  { key: "flood",            name: "Flood" },
  { key: "tsunami",          name: "Tsunami" },
  { key: "hurricane_cyclone", name: "Hurricane or Cyclone" },
  { key: "wildfire",         name: "Wildfire" },
  { key: "explosion",        name: "Explosion" },
  { key: "chemical_incident", name: "Chemical Incident" },
  { key: "conflict",         name: "Conflict" },
  { key: "civil_unrest",     name: "Civil Unrest" },
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
          <h2 style={s.title}>What can I report?</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#717782" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={s.list}>
          {CRISIS_TYPES.map((ct, idx) => (
            <div key={ct.key}>
              <div style={s.item}>
                <p style={s.itemName}>{ct.name}</p>
                <p style={s.itemDesc}>
                  {t(`crisis_types.${ct.key}`, ct.name)}
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
    borderRadius: 12,
    padding: 24,
    maxWidth: 480,
    width: "100%",
    maxHeight: "80vh",
    overflowY: "auto",
    boxShadow: "0 8px 32px rgba(0,0,0,0.16)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
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
  },
  item: {
    padding: "10px 0",
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
    background: "#E2E8F0",
  },
};
