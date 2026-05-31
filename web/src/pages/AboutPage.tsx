import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

const BLUE = "#0468B1";

// ── Back arrow icon ────────────────────────────────────────────────────────────

function IconBack() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0468B1"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

// ── Small reusable card ────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 16,
        border: "1px solid #e2e8f0",
        overflow: "hidden",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Info row (label + value) ───────────────────────────────────────────────────

function InfoRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 16px",
        borderBottom: last ? "none" : "1px solid #f0f4f8",
      }}
    >
      <span style={{ fontSize: 14, color: "#4a5568", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 14, color: "#1a202c", fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ── Tech row ───────────────────────────────────────────────────────────────────

function TechRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 16px",
        borderBottom: last ? "none" : "1px solid #f0f4f8",
      }}
    >
      <span style={{ fontSize: 13, color: "#718096", fontWeight: 500 }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          color: BLUE,
          fontWeight: 600,
          textAlign: "right",
          maxWidth: "58%",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AboutPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div style={{ flex: 1, background: "#F6F3F2", display: "flex", flexDirection: "column" }}>
      {/* ── Header ── */}
      <header className="page-header">
        <button className="page-header-back" onClick={() => navigate("/")} aria-label="Back">
          <IconBack />
        </button>
        <span className="page-header-title">{t('about.title')}</span>
        <div className="page-header-spacer" />
      </header>

      {/* ── Scrollable content ── */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px 16px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* ── Logo section ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 8,
            paddingBottom: 4,
            gap: 6,
          }}
        >
          <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#0468B1", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4, fontSize: 32 }}>🆘</div>
          <p
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: BLUE,
              margin: 0,
              textAlign: "center",
              letterSpacing: -0.3,
            }}
          >
            Crisis Reporter
          </p>
          <p
            style={{
              fontSize: 13,
              color: "#a0aec0",
              margin: 0,
              fontWeight: 500,
              letterSpacing: 0.3,
            }}
          >
            Powered by UNDP
          </p>
        </div>

        {/* ── Mission statement card ── */}
        <Card
          style={{
            borderLeft: `4px solid ${BLUE}`,
            borderRadius: 10,
          }}
        >
          <p
            style={{
              fontSize: 14,
              color: "#2d3748",
              lineHeight: 1.7,
              margin: 0,
              padding: "16px 18px",
            }}
          >
            {t('about.mission')}
          </p>
        </Card>

        {/* ── Version info card ── */}
        <Card>
          <InfoRow label={t('about.version')} value="1.0.0" />
          <InfoRow label={t('about.build_date')} value="May 2026" last />
        </Card>

        {/* ── Technology card ── */}
        <Card>
          <div
            style={{
              padding: "12px 16px 8px",
              borderBottom: "1px solid #e2e8f0",
            }}
          >
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#a0aec0",
                textTransform: "uppercase",
                letterSpacing: 0.8,
                margin: 0,
              }}
            >
              {t('about.built_with')}
            </p>
          </div>
          <TechRow label="Backend"    value="FastAPI + PostgreSQL" />
          <TechRow label="Mobile App" value="React Native + Expo" />
          <TechRow label="Web App"    value="React + Vite" />
          <TechRow label="Maps"       value="MapLibre GL JS" />
          <TechRow label="Hosting"    value="Railway" last />
        </Card>

        {/* ── Legal text ── */}
        <p
          style={{
            fontSize: 12,
            color: "#a0aec0",
            lineHeight: 1.65,
            textAlign: "center",
            margin: "4px 4px 0",
          }}
        >
          {t('about.legal')}
        </p>
      </div>
    </div>
  );
}
