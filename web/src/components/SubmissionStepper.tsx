import { useTranslation } from "react-i18next";

export type StepperStep = "photo" | "location" | "questions" | "review" | "submit";

const STEPS: StepperStep[] = ["photo", "location", "questions", "review", "submit"];

const STEP_ICONS: Record<StepperStep, string> = {
  photo: "photo_camera",
  location: "location_on",
  questions: "description",
  review: "visibility",
  submit: "check_circle",
};

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

export default function SubmissionStepper({ currentStep }: SubmissionStepperProps) {
  const { t } = useTranslation();
  const currentIndex = STEPS.indexOf(currentStep);

  return (
    <nav style={{
      background: "#FFFFFF",
      paddingTop: 24,
      paddingBottom: 16,
      paddingLeft: 24,
      paddingRight: 24,
      borderBottom: "1px solid #F0EDED",
      position: "relative",
      flexShrink: 0,
    }}>
      {/* Single background line behind all circles */}
      <div style={{
        position: "absolute",
        top: 37,   /* 24px paddingTop + 13px (half of 28px circle) */
        left: 38,  /* 24px padding + half of first circle */
        right: 38,
        height: 1,
        background: "#E4E2E1",
        zIndex: 0,
      }} />

      {/* Step circles and labels */}
      <div style={{
        position: "relative",
        zIndex: 1,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}>
        {STEPS.map((step, idx) => {
          const isCompleted = idx < currentIndex;
          const isActive = idx === currentIndex;

          const circleBackground = isCompleted ? "#38A169"
            : isActive ? "#0468B1"
            : "#FFFFFF";

          const circleBorder = (isCompleted || isActive) ? "none" : "1.5px solid #C1C7D2";
          const iconColor = (isCompleted || isActive) ? "#FFFFFF" : "#717782";

          const labelColor = isCompleted ? "#38A169"
            : isActive ? "#0468B1"
            : "#717782";

          const labelWeight = isActive ? 700 : isCompleted ? 600 : 400;

          return (
            <div key={step} style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                background: circleBackground,
                border: circleBorder,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                boxShadow: isActive ? "0 2px 8px rgba(4,104,177,0.25)" : "none",
              }}>
                {isCompleted ? (
                  <span className="material-symbols-outlined" style={{
                    fontSize: 14,
                    color: "#FFFFFF",
                    fontVariationSettings: "'FILL' 1",
                  }}>check</span>
                ) : (
                  <span className="material-symbols-outlined" style={{
                    fontSize: 14,
                    color: iconColor,
                    fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0",
                  }}>{STEP_ICONS[step]}</span>
                )}
              </div>

              <span style={{
                fontSize: 10,
                fontWeight: labelWeight,
                color: labelColor,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontFamily: "'Public Sans', sans-serif",
                whiteSpace: "nowrap",
              }}>
                {t(I18N_KEYS[step])}
              </span>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
