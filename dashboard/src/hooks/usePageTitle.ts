import { useEffect } from "react";

const APP_SUFFIX = "Crisis Reporter";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — ${APP_SUFFIX}`;
    return () => {
      document.title = APP_SUFFIX;
    };
  }, [title]);
}
