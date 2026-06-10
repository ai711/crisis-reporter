// Generates and persists a Web Session ID in the format CR-WEB-[15 alphanumeric chars].
// Must be the very first module executed in main.tsx.

import { generateUUID } from "./uuid";

declare global {
  interface Window {
    __crWebSessionId?: string;
  }
}

function generateId(): string {
  const alphanum = generateUUID().replace(/-/g, "").slice(0, 15);
  return `CR-WEB-${alphanum}`;
}

export function initWebSessionId(): string {
  try {
    let id = localStorage.getItem("cr_web_session_id");
    if (!id) {
      id = generateId();
      localStorage.setItem("cr_web_session_id", id);
    }
    return id;
  } catch {
    // localStorage unavailable (Safari private mode quota, security exception, etc.)
    if (!window.__crWebSessionId) {
      window.__crWebSessionId = generateId();
    }
    return window.__crWebSessionId;
  }
}

// Module-level constant — initialized once when the module is first imported.
export const WEB_SESSION_ID: string = initWebSessionId();
