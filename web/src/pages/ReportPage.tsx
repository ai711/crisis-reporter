import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";
import { addToQueue } from "../utils/offlineQueue";
import type { DamageLevel, QueuedPhoto } from "../types";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

const DAMAGE_LABELS: Record<string, string> = {
  minimal: "Minimal / No damage",
  partial: "Partially damaged",
  complete: "Completely damaged",
};

const INFRA_LABELS: Record<string, string> = {
  residential: "Residential Infrastructure",
  commercial: "Commercial Infrastructure",
  government: "Government Building",
  utility: "Utility Infrastructure",
  transport_communication: "Transport & Communication Infrastructure",
  community: "Community Infrastructure",
  public_spaces: "Public Spaces / Recreation Infrastructure",
  other: "Other",
};

const DISASTER_LABELS: Record<string, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  cyclone: "Cyclone / Typhoon / Hurricane",
  landslide: "Landslide",
  fire: "Fire",
  conflict: "Conflict / War",
  other: "Other",
};

const DEBRIS_LABELS: Record<string, string> = {
  yes: "Yes",
  no: "No",
  partially: "Partially",
};

export default function ReportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reporterId, countryCode, languageCode } = useAuthStore();

  // Form state
  const [damageLevel, setDamageLevel] = useState<DamageLevel | "">("");
  const [infrastructureTypes, setInfrastructureTypes] = useState<string[]>([]);
  const [infrastructureOther, setInfrastructureOther] = useState("");
  const [infrastructureName, setInfrastructureName] = useState("");
  const [disasterType, setDisasterType] = useState("");
  const [debrisBlocking, setDebrisBlocking] = useState("");
  const [damageQuestion, setDamageQuestion] = useState(1);
  const [photos, setPhotos] = useState<File[]>([]);
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLandmark, setLocationLandmark] = useState("");

  // UI state
  const [step, setStep] = useState<"photos" | "location" | "damage" | "review">("photos");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [crisisId, setCrisisId] = useState<string | null>(null);
  const [crisisLoading, setCrisisLoading] = useState(true);
  const [crisisError, setCrisisError] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get("/api/crises/active")
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
        if (list.length > 0) {
          setCrisisId(list[0].id);
        } else {
          setCrisisError(true);
        }
      })
      .catch(() => setCrisisError(true))
      .finally(() => setCrisisLoading(false));
  }, []);

  const toggleInfraType = (value: string) => {
    setInfrastructureTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  };

  const isDamageQuestionAnswered = (): boolean => {
    switch (damageQuestion) {
      case 1: return !!damageLevel;
      case 2: return infrastructureTypes.length > 0;
      case 3: return infrastructureName.trim().length > 0;
      case 4: return !!disasterType;
      case 5: return !!debrisBlocking;
      default: return false;
    }
  };

  const handleDamageBack = () => {
    if (damageQuestion === 1) setStep("location");
    else setDamageQuestion((q) => q - 1);
  };

  const handleDamageNext = () => {
    if (damageQuestion < 5) setDamageQuestion((q) => q + 1);
    else setStep("review");
  };

  const handlePhotoAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = 3 - photos.length;
    setPhotos((prev) => [...prev, ...files.slice(0, remaining)]);
  };

  const handlePhotoRemove = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!damageLevel || infrastructureTypes.length === 0 || !infrastructureName.trim() || !disasterType || !debrisBlocking || photos.length === 0) {
      setError("Please complete all required fields");
      return;
    }

    setSubmitting(true);
    setError("");

    const reportPayload = {
      crisis_id: crisisId!,
      damage_level: damageLevel as DamageLevel,
      infrastructure_types: infrastructureTypes,
      ...(infrastructureTypes.includes("other") && { infrastructure_other: infrastructureOther }),
      infrastructure_name: infrastructureName,
      disaster_type: disasterType,
      debris_blocking: debrisBlocking,
      platform: "web" as const,
      submitted_at: new Date().toISOString(),
      location: {
        gps_latitude: null,
        gps_longitude: null,
        gps_accuracy_meters: null,
        gps_available: false,
        location_address: locationAddress || null,
        location_landmark: locationLandmark || null,
        location_building_name: null,
      },
      reporter_id: reporterId || undefined,
      language_code: languageCode,
      was_queued: false,
    };

    if (!navigator.onLine) {
      // Save to offline queue
      const queuedPhotos: QueuedPhoto[] = photos.map((file, index) => ({
        blob: file,
        filename: file.name,
        content_type: file.type,
        display_order: index,
      }));

      await addToQueue({ ...reportPayload, was_queued: true }, queuedPhotos);
      setSubmitted(true);
      setSubmitting(false);
      return;
    }

    try {
      // Submit report
      const response = await api.post("/api/reports", reportPayload);
      const reportId = response.data.report_id;

      // Upload photos
      for (let i = 0; i < photos.length; i++) {
        const formData = new FormData();
        formData.append("report_id", reportId);
        formData.append("display_order", String(i));
        formData.append("file", photos[i]);

        await api.post("/api/photos", formData, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }

      setSubmitted(true);
    } catch {
      setError(t("report.error"));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div style={styles.container}>
        <div style={styles.successContainer}>
          <div style={styles.successIcon}>✅</div>
          <h2 style={styles.successTitle}>
            {navigator.onLine ? t("report.success") : t("report.queued")}
          </h2>
          <p style={styles.successText}>
            {navigator.onLine
              ? "Your damage report has been submitted to UNDP."
              : "Your report is saved and will sync when you have internet."}
          </p>
            <button
            style={{
              padding: "16px 40px",
              background: "#0468B1",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
              width: "100%",
              maxWidth: 300,
            }}
            onClick={() => navigate("/")}
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (crisisLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.centeredMessage}>
          <div style={{ fontSize: 16, color: "#666" }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (crisisError || !crisisId) {
    return (
      <div style={styles.container}>
        <div style={styles.centeredMessage}>
          <p style={styles.centeredError}>
            No active crisis found. Please try again later.
          </p>
          <button style={styles.secondaryButton} onClick={() => navigate(-1)}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={() => navigate(-1)}>←</button>
        <h1 style={styles.title}>{t("report.title")}</h1>
        <span style={styles.stepIndicator}>
          {step === "photos" ? "1/4" : step === "location" ? "2/4" : step === "damage" ? "3/4" : "4/4"}
        </span>
      </div>

      {/* Progress bar */}
      <div style={styles.progressBar}>
        <div style={{
          ...styles.progressFill,
          width: step === "photos" ? "25%" : step === "location" ? "50%" : step === "damage" ? "75%" : "100%",
        }} />
      </div>

      <div style={styles.content}>

        {/* Step 3 — Damage Assessment */}
        {step === "damage" && (
          <div style={styles.step}>
            <div style={styles.questionProgress}>Question {damageQuestion} of 5</div>

            {/* Q1 — Damage level */}
            {damageQuestion === 1 && (
              <>
                <h2 style={styles.stepTitle}>How bad is the damage? *</h2>
                {([
                  { value: "minimal" as DamageLevel, label: "Minimal / No damage" },
                  { value: "partial" as DamageLevel, label: "Partially damaged" },
                  { value: "complete" as DamageLevel, label: "Completely damaged" },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: damageLevel === value ? "#0468B1" : "#e0e0e0",
                      background: damageLevel === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDamageLevel(value)}
                  >
                    <span style={styles.optionIcon}>
                      {value === "minimal" ? "🟢" : value === "partial" ? "🟠" : "🔴"}
                    </span>
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {/* Q2 — Infrastructure type (multi-select) */}
            {damageQuestion === 2 && (
              <>
                <h2 style={styles.stepTitle}>What type of infrastructure is this? *</h2>
                <p style={styles.photoHint}>Select all that apply.</p>
                {[
                  { value: "residential", label: "Residential Infrastructure" },
                  { value: "commercial", label: "Commercial Infrastructure" },
                  { value: "government", label: "Government Building" },
                  { value: "utility", label: "Utility Infrastructure" },
                  { value: "transport_communication", label: "Transport and Communication Infrastructure" },
                  { value: "community", label: "Community Infrastructure" },
                  { value: "public_spaces", label: "Public Spaces / Recreation Infrastructure" },
                  { value: "other", label: "Other (please specify)" },
                ].map(({ value, label }) => (
                  <div
                    key={value}
                    style={styles.checkRow}
                    onClick={() => toggleInfraType(value)}
                  >
                    <div style={{
                      ...styles.checkbox,
                      ...(infrastructureTypes.includes(value) ? styles.checkboxSelected : {}),
                    }}>
                      {infrastructureTypes.includes(value) && <span style={styles.checkmark}>✓</span>}
                    </div>
                    <span style={styles.checkRowText}>{label}</span>
                  </div>
                ))}
                {infrastructureTypes.includes("other") && (
                  <input
                    style={{ ...styles.input, marginTop: 8 }}
                    type="text"
                    maxLength={100}
                    placeholder="Please specify (max 100 characters)"
                    value={infrastructureOther}
                    onChange={(e) => setInfrastructureOther(e.target.value)}
                  />
                )}
              </>
            )}

            {/* Q3 — Infrastructure name */}
            {damageQuestion === 3 && (
              <>
                <h2 style={styles.stepTitle}>What is the name of this infrastructure? *</h2>
                <input
                  style={styles.input}
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Main Street Bridge"
                  value={infrastructureName}
                  onChange={(e) => setInfrastructureName(e.target.value)}
                />
                <div style={styles.charCounter}>{infrastructureName.length} / 200</div>
              </>
            )}

            {/* Q4 — Disaster type */}
            {damageQuestion === 4 && (
              <>
                <h2 style={styles.stepTitle}>What type of disaster caused this damage? *</h2>
                {[
                  { value: "earthquake", label: "Earthquake" },
                  { value: "flood", label: "Flood" },
                  { value: "cyclone", label: "Cyclone / Typhoon / Hurricane" },
                  { value: "landslide", label: "Landslide" },
                  { value: "fire", label: "Fire" },
                  { value: "conflict", label: "Conflict / War" },
                  { value: "other", label: "Other" },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: disasterType === value ? "#0468B1" : "#e0e0e0",
                      background: disasterType === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDisasterType(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            {/* Q5 — Debris blocking */}
            {damageQuestion === 5 && (
              <>
                <h2 style={styles.stepTitle}>Is there debris blocking access? *</h2>
                {[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                  { value: "partially", label: "Partially" },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    style={{
                      ...styles.optionBtn,
                      borderColor: debrisBlocking === value ? "#0468B1" : "#e0e0e0",
                      background: debrisBlocking === value ? "#E8F4FD" : "#fff",
                    }}
                    onClick={() => setDebrisBlocking(value)}
                  >
                    <span style={styles.optionTitle}>{label}</span>
                  </button>
                ))}
              </>
            )}

            <div style={styles.navButtons}>
              <button style={styles.secondaryButton} onClick={handleDamageBack}>
                ← Back
              </button>
              <button
                style={{
                  ...styles.primaryButton,
                  opacity: isDamageQuestionAnswered() ? 1 : 0.5,
                }}
                disabled={!isDamageQuestionAnswered()}
                onClick={handleDamageNext}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Location */}
        {step === "location" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>{t("report.location")}</h2>
            <div style={styles.infoBox}>
              📍 GPS location will be captured automatically when available.
              You can also describe the location below.
            </div>

            <label style={styles.label}>{t("report.address")}</label>
            <input
              style={styles.input}
              type="text"
              placeholder="Street address or area name"
              value={locationAddress}
              onChange={(e) => setLocationAddress(e.target.value)}
            />

            <label style={styles.label}>{t("report.landmark")}</label>
            <input
              style={styles.input}
              type="text"
              placeholder="e.g. Near the central market"
              value={locationLandmark}
              onChange={(e) => setLocationLandmark(e.target.value)}
            />

            <div style={styles.navButtons}>
              <button style={styles.secondaryButton} onClick={() => setStep("photos")}>
                ← Back
              </button>
              <button style={styles.primaryButton} onClick={() => setStep("damage")}>
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 1 — Photos */}
        {step === "photos" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>{t("report.photos")} *</h2>
            <p style={styles.photoHint}>
              Add up to 3 photos of the damage. At least 1 is required.
            </p>

            <div style={styles.photoGrid}>
              {photos.map((photo, index) => (
                <div key={index} style={styles.photoThumb}>
                  <img
                    src={URL.createObjectURL(photo)}
                    style={styles.thumbImg}
                    alt={`Photo ${index + 1}`}
                  />
                  <button
                    style={styles.removePhotoBtn}
                    onClick={() => handlePhotoRemove(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}

              {photos.length < 3 && (
                <button
                  style={styles.addPhotoBtn}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span style={{ fontSize: 32 }}>📷</span>
                  <span style={{ fontSize: 13 }}>{t("report.addPhoto")}</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              multiple
              style={{ display: "none" }}
              onChange={handlePhotoAdd}
            />

            <button
              style={{
                ...styles.primaryButton,
                opacity: photos.length > 0 ? 1 : 0.5,
              }}
              disabled={photos.length === 0}
              onClick={() => setStep("location")}
            >
              Next →
            </button>
          </div>
        )}

        {/* Step 4 — Review and Submit */}
        {step === "review" && (
          <div style={styles.step}>
            <h2 style={styles.stepTitle}>Review Your Report</h2>

            <div style={styles.reviewCard}>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Damage Level</span>
                <span style={styles.reviewValue}>{DAMAGE_LABELS[damageLevel] ?? damageLevel}</span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Infrastructure</span>
                <span style={styles.reviewValue}>
                  {infrastructureTypes.map((v) => INFRA_LABELS[v] ?? v).join(", ")}
                </span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Infrastructure Name</span>
                <span style={styles.reviewValue}>{infrastructureName}</span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Disaster Type</span>
                <span style={styles.reviewValue}>{DISASTER_LABELS[disasterType] ?? disasterType}</span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Debris Blocking</span>
                <span style={styles.reviewValue}>{DEBRIS_LABELS[debrisBlocking] ?? debrisBlocking}</span>
              </div>
              <div style={styles.reviewRow}>
                <span style={styles.reviewLabel}>Photos</span>
                <span style={styles.reviewValue}>{photos.length} photo(s)</span>
              </div>
              {locationAddress && (
                <div style={styles.reviewRow}>
                  <span style={styles.reviewLabel}>Address</span>
                  <span style={styles.reviewValue}>{locationAddress}</span>
                </div>
              )}
            </div>

            {!navigator.onLine && (
              <div style={styles.offlineNotice}>
                📵 You are offline. This report will be saved and submitted when you reconnect.
              </div>
            )}

            {error && <p style={styles.error}>{error}</p>}

            <div style={styles.navButtons}>
              <button style={styles.secondaryButton} onClick={() => { setDamageQuestion(5); setStep("damage"); }}>
                ← Back
              </button>
              <button
                style={{
                  ...styles.primaryButton,
                  opacity: submitting ? 0.7 : 1,
                  flex: 1,
                }}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? t("report.submitting") : t("report.submit")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "#f4f6f9",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    background: "#1A2B4A",
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    gap: 16,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
  },
  title: {
    color: "#fff",
    fontSize: 18,
    fontWeight: 700,
    flex: 1,
  },
  stepIndicator: {
    color: "#A0B4CC",
    fontSize: 14,
  },
  progressBar: {
    height: 4,
    background: "#e0e0e0",
  },
  progressFill: {
    height: "100%",
    background: "#0468B1",
    transition: "width 0.3s ease",
  },
  content: {
    flex: 1,
    overflowY: "auto",
  },
  step: {
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  stepTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: "#1A2B4A",
  },
  optionBtn: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "16px",
    borderRadius: 10,
    border: "1.5px solid",
    cursor: "pointer",
    background: "#fff",
    textAlign: "left",
    transition: "all 0.15s",
  },
  optionIcon: {
    fontSize: 28,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: "#1A2B4A",
  },
  typeGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  typeBtn: {
    padding: "12px",
    borderRadius: 8,
    border: "1.5px solid",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    transition: "all 0.15s",
  },
  textarea: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    fontSize: 15,
    fontFamily: "inherit",
    resize: "none",
    outline: "none",
    background: "#fff",
  },
  infoBox: {
    background: "#E8F4FD",
    border: "1px solid #b3d4f0",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    color: "#0468B1",
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: "#666",
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
    fontSize: 15,
    outline: "none",
    background: "#fff",
  },
  photoHint: {
    fontSize: 14,
    color: "#666",
  },
  photoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
  },
  photoThumb: {
    position: "relative",
    aspectRatio: "1",
    borderRadius: 8,
    overflow: "hidden",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  removePhotoBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    border: "none",
    borderRadius: "50%",
    width: 24,
    height: 24,
    cursor: "pointer",
    fontSize: 12,
  },
  addPhotoBtn: {
    aspectRatio: "1",
    borderRadius: 8,
    border: "2px dashed #ccc",
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    color: "#666",
  },
  navButtons: {
    display: "flex",
    gap: 12,
    marginTop: 16,
  },
  primaryButton: {
    flex: 1,
    padding: "16px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    maxHeight: 56,
  },
  secondaryButton: {
    padding: "16px 20px",
    background: "#fff",
    color: "#1A2B4A",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
  },
  reviewCard: {
    background: "#fff",
    borderRadius: 12,
    padding: "4px 0",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  reviewRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  reviewLabel: {
    fontSize: 14,
    color: "#666",
  },
  reviewValue: {
    fontSize: 14,
    fontWeight: 500,
    color: "#1A2B4A",
    maxWidth: "60%",
    textAlign: "right",
  },
  offlineNotice: {
    background: "#fff3e0",
    border: "1px solid #ffcc02",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    color: "#e65100",
  },
  successContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    gap: 20,
    textAlign: "center",
    minHeight: "100vh",
  },
  successIcon: {
    fontSize: 72,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "#1A2B4A",
  },
  successText: {
    fontSize: 16,
    color: "#666",
    lineHeight: 1.6,
  },
  error: {
    color: "#d32f2f",
    fontSize: 14,
    textAlign: "center",
  },
  questionProgress: {
    fontSize: 13,
    fontWeight: 600,
    color: "#0468B1",
    textAlign: "center" as const,
    marginBottom: 4,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 4px",
    borderBottom: "1px solid #f0f0f0",
    cursor: "pointer",
  },
  checkbox: {
    width: 22,
    height: 22,
    border: "2px solid #ccc",
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxSelected: {
    border: "2px solid #0468B1",
    background: "#0468B1",
  },
  checkmark: {
    color: "#fff",
    fontSize: 13,
    fontWeight: 700,
  },
  checkRowText: {
    fontSize: 15,
    color: "#1A2B4A",
  },
  charCounter: {
    fontSize: 12,
    color: "#999",
    textAlign: "right" as const,
  },
  centeredMessage: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    gap: 20,
    textAlign: "center",
    minHeight: "100vh",
  },
  centeredError: {
    fontSize: 16,
    color: "#d32f2f",
    textAlign: "center",
  },
};