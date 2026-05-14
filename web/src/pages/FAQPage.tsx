import { useState } from "react";
import { useNavigate } from "react-router-dom";

const BLUE = "#0468B1";

interface FAQItem {
  q: string;
  a: string;
}

const FAQS: FAQItem[] = [
  {
    q: "How do I submit a report?",
    a: 'Tap "Report an Incident" on the Home screen. You will be guided through 4 steps — take or upload a photo, confirm your location, answer damage assessment questions, then review and submit. At least one photo is required.',
  },
  {
    q: "Do I need an internet connection to submit a report?",
    a: "No. If you are offline your report will be saved to a queue on your device and sent automatically when internet returns. You can see queued reports in My Reports.",
  },
  {
    q: "How do I enable GPS on my device?",
    a: "On most devices go to Settings, then Location or Privacy, and enable Location Services. In your browser you may need to allow location access when prompted. GPS helps us pinpoint the exact building affected.",
  },
  {
    q: "Can I submit a report anonymously?",
    a: "Yes. You do not need to create an account or fill in any profile details to submit a report. Adding your email or phone number is optional and links your reports to your profile.",
  },
  {
    q: "What happens to my report after I submit it?",
    a: "Your report is received by UNDP staff who review it for accuracy. Verified reports are used to coordinate crisis response and damage assessment. Your identity is never shared publicly.",
  },
  {
    q: "How do I earn a Safety Training badge?",
    a: "Complete all three parts of Safety Tips — Part A covers all 9 disaster types, Part B covers reporting guidelines, Part C covers first aid. Then add an email or phone number to your profile. The badge is awarded automatically.",
  },
  {
    q: "What if my country is not in the list?",
    a: "Crisis Reporter is currently operational in countries where UNDP is actively responding to a crisis. If your country is not listed it means UNDP has not yet activated it. Check back during an active crisis event.",
  },
  {
    q: "How do I contact support?",
    a: "Email us at support@crisisreporter.org — we will respond within 48 hours.",
  },
  {
    q: "Can I edit or delete a report after submitting?",
    a: "Reports cannot be edited after submission. If you submitted a report in error please contact support with the date and location of the report.",
  },
  {
    q: "Is my data secure?",
    a: "Yes. All data is transmitted over encrypted connections and stored securely. Photos are anonymised before storage. Your personal details are never shared with third parties.",
  },
];

function IconBack() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
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
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  function toggle(i: number) {
    setOpenIndex((prev) => (prev === i ? null : i));
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: BLUE,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
          }}
          aria-label="Back"
        >
          <IconBack />
        </button>
        <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>
          FAQ
        </span>
      </div>

      {/* Accordion */}
      <div style={{ flex: 1 }}>
        {FAQS.map((item, i) => {
          const expanded = openIndex === i;
          return (
            <div key={i} style={{ borderBottom: "1px solid #E2E8F0" }}>
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
          borderTop: "1px solid #E2E8F0",
          textAlign: "center",
          padding: "24px 20px 40px",
        }}>
          <p style={{ color: "#718096", fontSize: "0.875rem", margin: "0 0 8px" }}>
            Can't find what you're looking for?
          </p>
          <a
            href="mailto:support@crisisreporter.org"
            style={{ color: "#0468B1", fontWeight: 600, fontSize: "0.9rem", textDecoration: "underline" }}
          >
            Contact Support
          </a>
        </div>
      </div>
    </div>
  );
}
