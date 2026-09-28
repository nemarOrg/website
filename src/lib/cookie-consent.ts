export const COOKIE_CONSENT_KEY = "nemar:cookie-consent";
export const COOKIE_CONSENT_CHANGED_EVENT = "nemar:cookie-consent-changed";

export type CookieConsent = "accepted" | "strict";

export const ANALYTICS_PRODUCTION_HOSTS = [
  "nemar.org",
  "www.nemar.org",
  "ww2.nemar.org",
  "app.nemar.org",
] as const;

const SHARED_CONSENT_COOKIE = "nemar_analytics_consent";
const TAB_CONSENT_KEY = `${COOKIE_CONSENT_KEY}:tab`;
const SHARED_CONSENT_MAX_AGE = 60 * 60 * 24 * 365;
const SHARED_CONSENT_HOSTS = new Set<string>(ANALYTICS_PRODUCTION_HOSTS);

interface ConsentRecord {
  value: CookieConsent;
  changedAt: number;
}

let unsavedConsent: ConsentRecord | null = null;

function parseConsentRecord(value: string | null): ConsentRecord | null {
  if (value === "accepted" || value === "strict") return { value, changedAt: 0 };
  const match = /^(accepted|strict):(\d{1,16})$/.exec(value ?? "");
  if (!match) return null;
  const changedAt = Number(match[2]);
  return Number.isSafeInteger(changedAt) ? { value: match[1] as CookieConsent, changedAt } : null;
}

function serializeConsentRecord(record: ConsentRecord): string {
  return `${record.value}:${record.changedAt}`;
}

function canShareConsentAcrossHosts(): boolean {
  try {
    return SHARED_CONSENT_HOSTS.has(window.location.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readSharedConsent(): ConsentRecord | null {
  if (!canShareConsentAcrossHosts()) return null;
  try {
    const prefix = `${SHARED_CONSENT_COOKIE}=`;
    const value = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    return parseConsentRecord(value ?? null);
  } catch {
    return null;
  }
}

function writeSharedConsent(record: ConsentRecord): boolean {
  if (!canShareConsentAcrossHosts()) return false;
  const serialized = serializeConsentRecord(record);
  try {
    document.cookie = `${SHARED_CONSENT_COOKIE}=${serialized}; Domain=nemar.org; Path=/; Max-Age=${SHARED_CONSENT_MAX_AGE}; SameSite=Lax; Secure`;
    const saved = readSharedConsent();
    return saved?.value === record.value && saved.changedAt === record.changedAt;
  } catch {
    return false;
  }
}

function readTabConsent(): ConsentRecord | null {
  try {
    return parseConsentRecord(window.sessionStorage.getItem(TAB_CONSENT_KEY));
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== COOKIE_CONSENT_KEY) return;
    unsavedConsent = null;
    try {
      const next = parseConsentRecord(event.newValue);
      if (next) window.sessionStorage.setItem(TAB_CONSENT_KEY, serializeConsentRecord(next));
      else window.sessionStorage.removeItem(TAB_CONSENT_KEY);
    } catch {
      // The updated localStorage value remains the fallback for this origin.
    }
    document.dispatchEvent(new Event(COOKIE_CONSENT_CHANGED_EVENT));
  });
}

export function readCookieConsent(): CookieConsent | null {
  const sharedConsent = readSharedConsent();
  const tabConsent = readTabConsent();
  let localConsent: ConsentRecord | null = null;
  try {
    localConsent = parseConsentRecord(window.localStorage.getItem(COOKIE_CONSENT_KEY));
  } catch {
    // The shared cookie, tab-scoped value, or in-memory choice may still work.
  }

  // New writes carry timestamps so a failed cookie write cannot let an older
  // shared cookie override the latest choice stored in this tab or origin.
  // Shared cookies still carry the choice across origins when all writes work.
  const records = [unsavedConsent, tabConsent, localConsent, sharedConsent].filter(
    (record): record is ConsentRecord => record !== null,
  );
  const latest = records.reduce<ConsentRecord | null>((current, record) => {
    if (current === null || record.changedAt > current.changedAt) return record;
    if (record.changedAt < current.changedAt) return current;
    // Conflicting legacy values have no timestamp; preserve the opt-out.
    return record.value === "strict" ? record : current;
  }, null);

  if (localConsent?.changedAt === 0 && (sharedConsent === null || sharedConsent.changedAt === 0)) {
    // Migrate the resolved choice so a conflicting legacy opt-out remains
    // authoritative across hosts.
    if (latest !== null) writeSharedConsent(latest);
  }
  return latest?.value ?? null;
}

export function saveCookieConsent(value: CookieConsent): void {
  const record: ConsentRecord = { value, changedAt: Date.now() };
  const serialized = serializeConsentRecord(record);
  unsavedConsent = record;
  const sharedSaved = writeSharedConsent(record);
  let localSaved = false;
  try {
    window.localStorage.setItem(COOKIE_CONSENT_KEY, serialized);
    localSaved = true;
  } catch {
    // The shared cookie and tab-scoped storage are tried below.
  }

  if (sharedSaved) {
    unsavedConsent = null;
    try {
      window.sessionStorage.removeItem(TAB_CONSENT_KEY);
    } catch {
      // The shared cookie or localStorage already recorded the choice.
    }
  } else {
    try {
      window.sessionStorage.setItem(TAB_CONSENT_KEY, serialized);
      unsavedConsent = null;
    } catch {
      // Newer localStorage wins over an older shared cookie after navigation.
      // If that write also failed, the in-memory record covers this page.
      if (!localSaved) unsavedConsent = record;
      else unsavedConsent = null;
    }
  }
  document.dispatchEvent(new Event(COOKIE_CONSENT_CHANGED_EVENT));
}
