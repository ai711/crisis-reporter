import Sidebar from "./Sidebar";
import { useAuthStore } from "../stores/authStore";
import { useIdleTimer } from "../hooks/useIdleTimer";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { user } = useAuthStore();

  // Start the inactivity timer for every authenticated page.
  // The timeout value comes from the user object (set on login from the backend).
  // Falls back to 30 minutes if the user object is not yet loaded.
  useIdleTimer(user?.inactivity_timeout_minutes ?? 30);

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
