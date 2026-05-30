import { useTranslation } from "react-i18next";

export type StepperStep = "photo" | "location" | "questions" | "review" | "submit";

const STEPS: StepperStep[] = ["photo", "location", "questions", "review", "submit"];

const I18N_KEYS: Record<StepperStep, string> = {
  photo: "stepper.step_photo",
  location: "stepper.step_location",
  questions: "stepper.step_questions",
  review: "stepper.step_review",
  submit: "stepper.step_submit",
};

interface SubmissionStepperProps {
  currentStep: StepperStep;
}

const STEP_ICONS: Record<StepperStep, string> = {
  photo: '📷',
  location: '📍',
  questions: '📝',
  review: '👁',
  submit: '✅',
};

export default function SubmissionStepper({ currentStep }: SubmissionStepperProps) {
  const { t } = useTranslation();
  const currentIndex = STEPS.indexOf(currentStep);

  return (
    <div style={styles.wrapper}>
      {STEPS.map((step, idx) => {
        const isCompleted = idx < currentIndex;
        const isActive = idx === currentIndex;
        const circleSize = isActive ? 36 : 28;

        return (
          <div key={step} style={styles.stepRow}>
            {/* Connector line before this step */}
            {idx > 0 && (
              <div
                style={{
                  ...styles.line,
                  background: isCompleted || isActive ? "#38A169" : "#E2E8F0",
                  marginBottom: 20,
                }}
              />
            )}

            {/* Circle + label */}
            <div style={styles.stepCol}>
              <div
                style={{
                  width: circleSize,
                  height: circleSize,
                  borderRadius: circleSize / 2,
                  background: isCompleted ? '#38A169' : isActive ? '#0468B1' : '#E2E8F0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all 0.2s ease',
                  boxShadow: isActive ? '0 2px 8px rgba(4,104,177,0.35)' : 'none',
                }}
              >
                {isCompleted ? (
                  <span style={{fontSize: 14, color: 'white'}}>✓</span>
                ) : isActive ? (
                  <span style={{fontSize: 16}}>{STEP_ICONS[step]}</span>
                ) : (
                  <span style={{fontSize: 12, color: '#717782'}}>{idx + 1}</span>
                )}
              </div>
              <span
                style={{
                  ...styles.label,
                  fontSize: 11,
                  color: isCompleted ? '#38A169' : isActive ? '#0468B1' : '#717782',
                  fontWeight: isActive ? 700 : isCompleted ? 600 : 400,
                }}
              >
                {t(I18N_KEYS[step])}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "12px 8px 4px",
    background: "#fff",
    borderBottom: "1px solid #f0f0f0",
    flexShrink: 0,
  },
  stepRow: {
    display: "flex",
    alignItems: "center",
    flex: 1,
  },
  line: {
    flex: 1,
    height: 2,
    minWidth: 8,
    marginBottom: 18,
  },
  stepCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  circle: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkmark: {
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1,
  },
  number: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1,
  },
  label: {
    fontSize: 10,
    textAlign: "center" as const,
    lineHeight: 1.2,
    maxWidth: 54,
    whiteSpace: "nowrap" as const,
  },
};
