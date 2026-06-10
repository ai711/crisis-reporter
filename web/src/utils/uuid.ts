/**
 * Cross-browser UUID v4 generator.
 *
 * crypto.randomUUID() was added in:
 *   Chrome 92, Firefox 95, Safari 15.4 (iOS 15.4 — March 2022)
 *
 * Crisis reporters may use older devices, so we provide a Math.random() fallback
 * for iOS < 15.4 and any other browser that lacks crypto.randomUUID.
 */
export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
