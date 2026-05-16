import Header from "../components/Header";

export default function ProjectsPage() {
  return (
    <div>
      <Header title="Projects" subtitle="Multi-crisis project management" />
      <div style={styles.body}>
        <p style={styles.msg}>Coming soon — projects view.</p>
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
