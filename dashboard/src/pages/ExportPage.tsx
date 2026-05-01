import { useState } from "react";
import Header from "../components/Header";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

const EXPORT_TYPES = [
  {
    id: "field_operations",
    name: "Field Operations Report",
    format: "CSV + GeoJSON",
    description: "Core damage data, GPS coordinates, timestamps. For field teams.",
  },
  {
    id: "full_data",
    name: "Full Data Report",
    format: "CSV",
    description: "All fields including metadata, compression data, platform info.",
  },
  {
    id: "gis_shapefile",
    name: "GIS Export",
    format: "Shapefile (.shp)",
    description: "Spatial data formatted for GIS tools like QGIS and ArcGIS.",
  },
  {
    id: "geopackage",
    name: "GeoPackage Export",
    format: "GeoPackage (.gpkg)",
    description: "Modern GIS format — single file containing all layers.",
  },
  {
    id: "rapida_summary",
    name: "RAPIDA Summary",
    format: "CSV",
    description: "RAPIDA-compatible field names for direct pipeline ingestion.",
  },
];

export default function ExportPage() {
  const { activeCrisisId } = useAuthStore();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedType, setSelectedType] = useState("");
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");

  const handleExport = async () => {
    if (!selectedType || !dateFrom || !dateTo) {
      setMessage("Please select an export type and date range.");
      return;
    }
    if (!activeCrisisId) {
      setMessage("Please select a crisis from the Map page first.");
      return;
    }

    setExporting(true);
    setMessage("");

    try {
      setMessage(
        "Export generation started. In full implementation, the file will download automatically when ready."
      );
    } catch {
      setMessage("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={styles.container}>
      <Header
        title="Export Data"
        subtitle="Generate and download crisis reports"
      />
      <div style={styles.content}>
        {/* Export type selection */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Select Export Type</h2>
          <div style={styles.typeGrid}>
            {EXPORT_TYPES.map((type) => (
              <div
                key={type.id}
                style={{
                  ...styles.typeCard,
                  borderColor:
                    selectedType === type.id ? "#0468B1" : "#e0e0e0",
                  background:
                    selectedType === type.id ? "#E8F4FD" : "#fff",
                }}
                onClick={() => setSelectedType(type.id)}
              >
                <div style={styles.typeName}>{type.name}</div>
                <div style={styles.typeFormat}>{type.format}</div>
                <div style={styles.typeDesc}>{type.description}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>Date Range (required)</h2>
          <div style={styles.dateRow}>
            <div style={styles.dateField}>
              <label style={styles.dateLabel}>From</label>
              <input
                type="date"
                style={styles.dateInput}
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div style={styles.dateField}>
              <label style={styles.dateLabel}>To</label>
              <input
                type="date"
                style={styles.dateInput}
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Default inclusions */}
        <div style={styles.infoBox}>
          📋 By default, exports include Green and Orange flagged reports only.
          Grey (processing) and Red (under review) reports are excluded.
        </div>

        {message && (
          <div style={styles.messageBox}>{message}</div>
        )}

        <button
          style={{
            ...styles.exportBtn,
            opacity: exporting || !selectedType || !dateFrom || !dateTo ? 0.6 : 1,
          }}
          onClick={handleExport}
          disabled={exporting || !selectedType || !dateFrom || !dateTo}
        >
          {exporting ? "Generating Export..." : "Generate Export"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100vh" },
  content: { flex: 1, padding: "24px 32px", overflow: "auto", display: "flex", flexDirection: "column", gap: 24 },
  section: { display: "flex", flexDirection: "column", gap: 16 },
  sectionTitle: { fontSize: 16, fontWeight: 600, color: "#1A2B4A" },
  typeGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 },
  typeCard: {
    padding: "16px",
    borderRadius: 10,
    border: "1.5px solid",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  typeName: { fontSize: 14, fontWeight: 600, color: "#1A2B4A", marginBottom: 4 },
  typeFormat: {
    fontSize: 12,
    color: "#0468B1",
    fontWeight: 500,
    marginBottom: 8,
    background: "#E8F4FD",
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
  },
  typeDesc: { fontSize: 13, color: "#666", lineHeight: 1.5 },
  dateRow: { display: "flex", gap: 24 },
  dateField: { display: "flex", flexDirection: "column", gap: 6 },
  dateLabel: { fontSize: 14, fontWeight: 500, color: "#666" },
  dateInput: { padding: "10px 14px", borderRadius: 8, border: "1px solid #e0e0e0", fontSize: 14 },
  infoBox: {
    background: "#E8F4FD",
    border: "1px solid #b3d4f0",
    borderRadius: 8,
    padding: "14px 16px",
    fontSize: 14,
    color: "#0468B1",
  },
  messageBox: {
    background: "#f4f6f9",
    borderRadius: 8,
    padding: "14px 16px",
    fontSize: 14,
    color: "#1A2B4A",
    border: "1px solid #e0e0e0",
  },
  exportBtn: {
    padding: "14px 32px",
    background: "#0468B1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
};