import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";

export function usePageTitle(title: string) {
  const dashboardTitle = useSettingsStore((s) => s.dashboardTitle);

  useEffect(() => {
    document.title = `${title} | ${dashboardTitle}`;
    return () => {
      document.title = dashboardTitle;
    };
  }, [title, dashboardTitle]);
}
