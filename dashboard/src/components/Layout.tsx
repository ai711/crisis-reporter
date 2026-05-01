import Sidebar from "./Sidebar";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  return (
    <div style={styles.container}>
      <Sidebar />
      <div style={styles.main}>
        {children}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    minHeight: "100vh",
    background: "#f4f6f9",
  },
  main: {
    flex: 1,
    marginLeft: 240,
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    overflow: "auto",
  },
};