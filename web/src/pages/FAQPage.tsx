import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

const BLUE = "#0468B1";

interface FAQItem {
  q: string;
  a: string;
}

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

function IconChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke={BLUE}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.22s ease",
        flexShrink: 0,
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function FAQPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [supportEmail, setSupportEmail] = useState("support@crisisreporter.org");

  useEffect(() => {
    fetch("/api/settings/public")
      .then((r) => r.json())
      .then((data) => {
        if (data?.support_email) setSupportEmail(data.support_email);
      })
      .catch(() => {});
  }, []);

  const FAQS: FAQItem[] = [
    { q: t('faq.q1_question'), a: t('faq.q1_answer') },
    { q: t('faq.q2_question'), a: t('faq.q2_answer') },
    { q: t('faq.q3_question'), a: t('faq.q3_answer') },
    { q: t('faq.q4_question'), a: t('faq.q4_answer') },
    { q: t('faq.q5_question'), a: t('faq.q5_answer') },
    { q: t('faq.q6_question'), a: t('faq.q6_answer') },
    { q: t('faq.q7_question'), a: t('faq.q7_answer') },
    { q: t('faq.q8_question'), a: t('faq.q8_answer', { email: supportEmail }) },
    { q: t('faq.q9_question'), a: t('faq.q9_answer') },
    { q: t('faq.q10_question'), a: t('faq.q10_answer') },
  ];

  function toggle(i: number) {
    setOpenIndex((prev) => (prev === i ? null : i));
  }

  return (
    <div style={{ flex: 1, background: "#F6F3F2", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header className="page-header">
        <button className="page-header-back" onClick={() => navigate("/")} aria-label="Back">
          <IconBack />
        </button>
        <span className="page-header-title">{t('faq.title')}</span>
        <div className="page-header-spacer" />
      </header>

      {/* Accordion */}
      <div style={{ flex: 1, padding: "12px 0" }}>
        {FAQS.map((item, i) => {
          const expanded = openIndex === i;
          return (
            <div key={i} style={{ background: "#fff", borderRadius: 16, margin: "0 16px 8px", border: "1px solid #E2E8F0", overflow: "hidden" }}>
              <button
                onClick={() => toggle(i)}
                style={{
                  width: "100%",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "16px 20px",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#1a202c",
                    lineHeight: 1.45,
                    flex: 1,
                  }}
                >
                  {item.q}
                </span>
                <IconChevron expanded={expanded} />
              </button>

              {/* Answer — rendered in DOM always, height animated via max-height trick */}
              <div
                style={{
                  maxHeight: expanded ? 400 : 0,
                  overflow: "hidden",
                  transition: "max-height 0.25s ease",
                }}
              >
                <p
                  style={{
                    margin: 0,
                    padding: "0 20px 18px",
                    fontSize: 14,
                    color: "#4A5568",
                    lineHeight: 1.65,
                  }}
                >
                  {item.a}
                </p>
              </div>
            </div>
          );
        })}

        {/* E3: Contact Support link */}
        <div style={{
          textAlign: "center",
          padding: "16px 20px 40px",
        }}>
          <p style={{ color: "#718096", fontSize: "0.875rem", margin: "0 0 8px" }}>
            {t('faq.contact_prompt')}
          </p>
          <a
            href={`mailto:${supportEmail}`}
            style={{ color: "#0468B1", fontWeight: 600, fontSize: "0.9rem", textDecoration: "underline" }}
          >
            {t('faq.contact_link')}
          </a>
        </div>
      </div>
    </div>
  );
}
