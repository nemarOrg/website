import {
  COOKIE_CONSENT_CHANGED_EVENT,
  COOKIE_CONSENT_KEY,
  readCookieConsent,
} from "./cookie-consent";

export const UMAMI_EVENT_NAMES = [
  "citation_click",
  "viewer_open",
  "viewer_interaction",
  "upload_started",
  "upload_completed",
] as const;

export type UmamiEventName = (typeof UMAMI_EVENT_NAMES)[number];

export interface SafePageView {
  url: string;
  title: string;
}

const UPLOAD_COMPLETION_KEY = "nemar:umami:upload-completed";
const DEFAULT_UMAMI_SCRIPT_URL = "https://analytics.nemar.org/nmr-analytics.js";
const PRODUCTION_HOSTS = new Set(["nemar.org", "www.nemar.org", "ww2.nemar.org", "app.nemar.org"]);
const EVENT_NAMES = new Set<string>(UMAMI_EVENT_NAMES);

interface UmamiPayload {
  website: string;
  hostname?: string;
  url: string;
  title: string;
  name?: UmamiEventName;
}

interface UmamiTracker {
  track(payload: UmamiPayload | (() => UmamiPayload)): void;
}

export interface NemarAnalytics {
  track(eventName: UmamiEventName): void;
  trackViewerInteraction(host: HTMLElement): void;
  markUploadCompleted(): void;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
    nemarAnalytics?: NemarAnalytics;
  }
}

export function pageViewForPathname(pathname: string): SafePageView | null {
  if (pathname === "/" || pathname === "") return { url: "/", title: "NEMAR home" };
  if (pathname === "/discover" || pathname === "/discover/") {
    return { url: "/discover", title: "Discover datasets" };
  }
  if (/^\/dataset\/[^/]+\/?$/.test(pathname)) {
    return { url: "/dataset", title: "Dataset record" };
  }
  if (/^\/upload(?:\/success)?\/?$/.test(pathname)) {
    return { url: "/upload", title: "Upload" };
  }

  const fixedPages: Record<string, SafePageView> = {
    "/about": { url: "/about", title: "About NEMAR" },
    "/community": { url: "/community", title: "NEMAR community" },
    "/privacy": { url: "/privacy", title: "Privacy" },
    "/support": { url: "/support", title: "Support" },
  };
  return fixedPages[pathname.replace(/\/$/, "")] ?? null;
}

export function isProductionAnalyticsHost(hostname: string): boolean {
  return PRODUCTION_HOSTS.has(hostname.toLowerCase());
}

export function isUmamiWebsiteId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export function safeUmamiScriptUrl(value: string | undefined): string | null {
  const candidate = value ?? DEFAULT_UMAMI_SCRIPT_URL;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "analytics.nemar.org" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/[A-Za-z0-9._-]+\.js$/.test(url.pathname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function hasConsent(): boolean {
  return readCookieConsent() === "accepted";
}

function callTracker(payload: UmamiPayload | (() => UmamiPayload)): boolean {
  try {
    const tracker = window.umami;
    if (!tracker || typeof tracker.track !== "function") return false;
    tracker.track(payload);
    return true;
  } catch {
    // Analytics is optional and must never interrupt a user action.
    console.warn("[analytics] the Umami tracker rejected a tracking call");
    return false;
  }
}

function consumeUploadCompletion(): boolean {
  try {
    const pending = window.sessionStorage.getItem(UPLOAD_COMPLETION_KEY) === "1";
    window.sessionStorage.removeItem(UPLOAD_COMPLETION_KEY);
    return pending;
  } catch {
    return false;
  }
}

export function installUmamiAnalytics(websiteId: string | undefined, scriptUrl?: string): void {
  const validWebsiteId = isUmamiWebsiteId(websiteId) ? websiteId : null;
  const safeScriptUrl = safeUmamiScriptUrl(scriptUrl);
  let trackerLoading = false;
  let trackerLoaded = false;
  let pageViewSent = false;
  let viewerInteractionRecorded = false;
  const pendingEvents: UmamiEventName[] = [];

  const eligible = (): boolean =>
    validWebsiteId !== null &&
    safeScriptUrl !== null &&
    isProductionAnalyticsHost(window.location.hostname) &&
    pageViewForPathname(window.location.pathname) !== null;

  const sendPageView = (): void => {
    if (!hasConsent() || !eligible() || pageViewSent || !validWebsiteId) return;
    const page = pageViewForPathname(window.location.pathname);
    if (!page) return;
    pageViewSent = callTracker({ website: validWebsiteId, url: page.url, title: page.title });
  };

  const sendEvent = (eventName: UmamiEventName): void => {
    if (!hasConsent() || !eligible() || !validWebsiteId) return;
    const page = pageViewForPathname(window.location.pathname);
    if (!page) return;
    // Build a new payload instead of spreading Umami's default properties:
    // those include the live URL, title, and referrer.
    callTracker(() => ({
      website: validWebsiteId,
      hostname: window.location.hostname,
      url: page.url,
      title: page.title,
      name: eventName,
    }));
  };

  const startTracker = (): void => {
    if (!hasConsent() || !eligible() || trackerLoading || trackerLoaded) return;
    trackerLoading = true;
    const script = document.createElement("script");
    script.defer = true;
    script.src = safeScriptUrl ?? DEFAULT_UMAMI_SCRIPT_URL;
    // The page path can contain a dataset identifier. Do not send it as the
    // HTTP Referer while loading the external tracker.
    script.referrerPolicy = "no-referrer";
    script.dataset.websiteId = validWebsiteId ?? "";
    script.dataset.autoPageview = "false";
    script.dataset.excludeSearch = "true";
    script.dataset.domains = [...PRODUCTION_HOSTS].join(",");
    script.addEventListener(
      "load",
      () => {
        trackerLoading = false;
        trackerLoaded = true;
        if (!hasConsent()) {
          pendingEvents.length = 0;
          return;
        }
        sendPageView();
        for (const eventName of pendingEvents.splice(0)) sendEvent(eventName);
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        trackerLoading = false;
        pendingEvents.length = 0;
        console.warn("[analytics] the Umami tracker did not load");
      },
      { once: true },
    );
    document.head.append(script);
  };

  const track = (eventName: UmamiEventName): void => {
    if (!EVENT_NAMES.has(eventName) || !hasConsent() || !eligible()) return;
    if (trackerLoaded) {
      sendEvent(eventName);
      return;
    }
    pendingEvents.push(eventName);
    startTracker();
  };

  window.nemarAnalytics = {
    track,
    trackViewerInteraction(host) {
      if (viewerInteractionRecorded) return;
      const onInteraction = (event: Event): void => {
        if (viewerInteractionRecorded || !hasConsent()) return;
        if (event instanceof PointerEvent && event.button !== 0) return;
        if (event instanceof KeyboardEvent && event.key === "Tab") return;
        viewerInteractionRecorded = true;
        host.removeEventListener("pointerdown", onInteraction, true);
        host.removeEventListener("keydown", onInteraction, true);
        track("viewer_interaction");
      };
      host.addEventListener("pointerdown", onInteraction, true);
      host.addEventListener("keydown", onInteraction, true);
    },
    markUploadCompleted() {
      if (!hasConsent()) return;
      try {
        window.sessionStorage.setItem(UPLOAD_COMPLETION_KEY, "1");
      } catch {
        /* Analytics must not interrupt a successful upload when storage is unavailable. */
      }
    },
  };

  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("[data-nemar-analytics-event]");
      const eventName = target?.dataset.nemarAnalyticsEvent;
      if (eventName && EVENT_NAMES.has(eventName)) track(eventName as UmamiEventName);
    },
    true,
  );

  document.addEventListener(COOKIE_CONSENT_CHANGED_EVENT, () => {
    if (hasConsent()) {
      if (trackerLoaded) sendPageView();
      else startTracker();
    } else {
      pendingEvents.length = 0;
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== COOKIE_CONSENT_KEY) return;
    if (hasConsent()) {
      if (trackerLoaded) sendPageView();
      else startTracker();
    } else {
      pendingEvents.length = 0;
    }
  });

  if (consumeUploadCompletion()) track("upload_completed");
  if (hasConsent()) startTracker();
}
