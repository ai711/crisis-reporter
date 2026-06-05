import { useEffect, useRef } from "react";

/**
 * useIdleTimer — tracks user inactivity and redirects to the login screen
 * with `?reason=expired` when the idle threshold is exceeded.
 *
 * Listens to: mousemove, mousedown, keydown, scroll, touchstart.
 * The timer is reset on every event. It starts immediately on mount.
 * Cleanup removes all listeners and clears the timer on unmount.
 *
 * @param timeoutMinutes  Idle duration in minutes before logout. Pass 0 to disable.
 */
export function useIdleTimer(timeoutMinutes: number): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutMs = timeoutMinutes > 0 ? timeoutMinutes * 60 * 1000 : 0;

  useEffect(() => {
    // If timeout is 0 or negative, do nothing
    if (!timeoutMs) return;

    const handleIdle = () => {
      // Clear tokens from localStorage directly — avoid importing api module
      // to prevent circular dependency risks.
      localStorage.removeItem("dash_access_token");
      localStorage.removeItem("dash_refresh_token");
      window.location.href = "/login?reason=session_expired";
    };

    const reset = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(handleIdle, timeoutMs);
    };

    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
    ] as const;

    events.forEach((evt) =>
      window.addEventListener(evt, reset, { passive: true })
    );

    // Kick off the initial timer
    reset();

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, reset));
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [timeoutMs]);
}
