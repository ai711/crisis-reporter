import Header from "../components/Header";

export default function LocationsPage() {
  return (
    <div>
      <Header title="Location Page" subtitle="Building and area-level location data" />
      <div style={styles.body}>
        <p style={styles.msg}>Coming soon — location data viewer.</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    padding: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 300,
  },
  msg: {
    fontSize: 16,
    color: "#888",
  },
};
