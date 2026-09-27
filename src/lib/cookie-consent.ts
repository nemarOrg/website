export const COOKIE_CONSENT_KEY = "nemar:cookie-consent";
export const COOKIE_CONSENT_CHANGED_EVENT = "nemar:cookie-consent-changed";

export type CookieConsent = "accepted" | "strict";

export function readCookieConsent(): CookieConsent | null {
  try {
    const value = window.localStorage.getItem(COOKIE_CONSENT_KEY);
    return value === "accepted" || value === "strict" ? value : null;
  } catch {
    return null;
  }
}

export function saveCookieConsent(value: CookieConsent): void {
  try {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, value);
  } catch {
    // Storage may be disabled; still notify listeners so they can fail closed.
  }
  document.dispatchEvent(new Event(COOKIE_CONSENT_CHANGED_EVENT));
}
