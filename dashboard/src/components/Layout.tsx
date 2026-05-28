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
    <div className="dashboard-shell">
      <Sidebar />
      <div className="main-content">
        {children}
      </div>
    </div>
  );
}
