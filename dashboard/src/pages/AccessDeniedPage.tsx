import { useNavigate } from "react-router-dom";

export default function AccessDeniedPage() {
  const navigate = useNavigate();

  return (
    <div style={styles.container}>
      <div style={styles.icon}>
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 56, color: "#0468B1", fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 48" }}
        >lock</span>
      </div>
      <h1 style={styles.heading}>Access Denied</h1>
      <p style={styles.message}>
        You do not have permission to access this section.
      </p>
      <button style={styles.backBtn} onClick={() => navigate("/map")}>
        ← Return to Main Map
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "80vh",
    padding: 40,
    textAlign: "center",
  },
  icon: {
    fontSize: 56,
    marginBottom: 20,
  },
  heading: {
    fontSize: 28,
    fontWeight: 700,
    color: "#1A2B4A",
    marginBottom: 12,
  },
  message: {
    fontSize: 16,
    color: "#555",
    marginBottom: 32,
    maxWidth: 420,
  },
  backBtn: {
    padding: "12px 28px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
};
