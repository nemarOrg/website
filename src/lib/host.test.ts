import { describe, expect, it } from "vitest";
import {
  APP_HOST,
  MARKETING_BASE_URL,
  MARKETING_HOST,
  appUrl,
  canonicalOriginFor,
  getCrossHostRedirect,
  getLegacyRedirect,
  getRetiredRedirect,
  hostMode,
  isAppRoute,
  isHostNeutralRoute,
  isNoindexHost,
  isProductionHost,
  marketingUrl,
} from "./host";

const BETA_HOST = "ww2.nemar.org";

describe("hostMode", () => {
  it("classifies the production app host", () => {
    expect(hostMode(APP_HOST)).toBe("app");
  });

  it("classifies the marketing hosts (beta + canonical + www alias)", () => {
    expect(hostMode(BETA_HOST)).toBe("marketing");
    expect(hostMode(MARKETING_HOST)).toBe("marketing");
    expect(hostMode(`www.${MARKETING_HOST}`)).toBe("marketing");
  });

  it("falls back to single-host mode for localhost and previews", () => {
    expect(hostMode("localhost")).toBe("single");
    expect(hostMode("127.0.0.1")).toBe("single");
    expect(hostMode("fa9dbfa0.nemar-website.pages.dev")).toBe("single");
  });

  it("normalizes uppercase host headers (browsers do this, proxies sometimes don't)", () => {
    expect(hostMode(APP_HOST.toUpperCase())).toBe("app");
    expect(hostMode("App.Nemar.Org")).toBe("app");
    expect(hostMode(BETA_HOST.toUpperCase())).toBe("marketing");
  });
});

describe("isAppRoute", () => {
  it.each([
    "/login",
    "/login/verify",
    "/login/pending",
    "/welcome",
    "/dashboard",
    "/upload",
    "/upload/success",
    "/admin",
    "/admin/publication-requests",
    "/settings",
    "/api/auth/code/request",
    "/api/auth/logout",
    "/api/admin",
    "/api/admin/publication-requests",
    "/api/v1",
    "/api/v1/datasets",
    "/api/v1/datasets/nm000103",
    "/api/v1/admin/publish/requests",
    "/dataset/nm000103/collaborators",
    "/dataset/nm000103/collaborators/",
  ])("treats %s as app", (path) => {
    expect(isAppRoute(path)).toBe(true);
  });

  it.each([
    "/",
    "/discover",
    "/about",
    "/support",
    "/community",
    "/citation-dashboard",
    "/docs",
    "/docs/getting-started",
    "/signup",
    "/dataset/nm000103",
    "/dataset/nm000103/",
    "/api/dataset/nm000103/readme",
  ])("treats %s as marketing", (path) => {
    expect(isAppRoute(path)).toBe(false);
  });

  it("doesn't match prefix-collisions", () => {
    expect(isAppRoute("/loginish")).toBe(false);
    expect(isAppRoute("/dashboard-help")).toBe(false);
  });
});

describe("getCrossHostRedirect", () => {
  const url = (host: string, pathAndSearch: string) => new URL(`https://${host}${pathAndSearch}`);

  // website#181. The site-wide notice banner renders on both hosts and
  // fetches this route same-origin. A 301 off either host is cross-origin,
  // where no CORS headers apply, so the fetch rejects and no notice ever
  // displays — silently, because the banner fails soft. This must stay put
  // on whichever host asked.
  it("never redirects the host-neutral notices feed off either host", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/api/notices"))).toBeNull();
    expect(getCrossHostRedirect(url(BETA_HOST, "/api/notices"))).toBeNull();
    expect(getCrossHostRedirect(url(APP_HOST, "/api/notices?x=1"))).toBeNull();
  });

  // The neutral list is prefix-matched like the others, but must not swallow
  // a sibling path that merely starts with the same characters.
  it("does not treat a lookalike sibling path as host-neutral", () => {
    expect(isHostNeutralRoute("/api/notices")).toBe(true);
    expect(isHostNeutralRoute("/api/notices/history")).toBe(true);
    expect(isHostNeutralRoute("/api/notices-admin")).toBe(false);
    expect(isHostNeutralRoute("/api/v1/notices")).toBe(false);
  });

  // Regression guard: the cookie-scoped proxies must keep redirecting, or
  // the session cookie (Domain=app.nemar.org) stops reaching them.
  it("still redirects the cookie-scoped api prefixes to the app host", () => {
    expect(getCrossHostRedirect(url(BETA_HOST, "/api/v1/datasets"))).toBe(
      `https://${APP_HOST}/api/v1/datasets`,
    );
    expect(getCrossHostRedirect(url(BETA_HOST, "/api/auth/code/request"))).toBe(
      `https://${APP_HOST}/api/auth/code/request`,
    );
  });

  it("redirects app paths from the beta marketing host to the app host", () => {
    expect(getCrossHostRedirect(url(BETA_HOST, "/dashboard"))).toBe(
      `https://${APP_HOST}/dashboard`,
    );
    expect(getCrossHostRedirect(url(BETA_HOST, "/login?next=/upload"))).toBe(
      `https://${APP_HOST}/login?next=/upload`,
    );
    expect(getCrossHostRedirect(url(BETA_HOST, "/dataset/nm000103/collaborators"))).toBe(
      `https://${APP_HOST}/dataset/nm000103/collaborators`,
    );
  });

  it("redirects app paths from the canonical marketing host (post-DNS-cutover)", () => {
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/dashboard"))).toBe(
      `https://${APP_HOST}/dashboard`,
    );
  });

  it("redirects app paths from the www.nemar.org alias too", () => {
    expect(getCrossHostRedirect(url(`www.${MARKETING_HOST}`, "/dashboard"))).toBe(
      `https://${APP_HOST}/dashboard`,
    );
    expect(getCrossHostRedirect(url(`www.${MARKETING_HOST}`, "/discover"))).toBeNull();
  });

  it("redirects marketing paths from app host to the live marketing base URL", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/discover"))).toBe(`${MARKETING_BASE_URL}/discover`);
    expect(getCrossHostRedirect(url(APP_HOST, "/dataset/nm000103"))).toBe(
      `${MARKETING_BASE_URL}/dataset/nm000103`,
    );
  });

  it("returns null when the path matches the current host", () => {
    expect(getCrossHostRedirect(url(BETA_HOST, "/discover"))).toBeNull();
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/discover"))).toBeNull();
    expect(getCrossHostRedirect(url(APP_HOST, "/dashboard"))).toBeNull();
  });

  it("never redirects in single-host mode", () => {
    expect(getCrossHostRedirect(url("localhost:4321", "/dashboard"))).toBeNull();
    expect(getCrossHostRedirect(url("fa9dbfa0.nemar-website.pages.dev", "/login"))).toBeNull();
  });

  it("preserves query strings on redirect", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/discover?modality=eeg&limit=10"))).toBe(
      `${MARKETING_BASE_URL}/discover?modality=eeg&limit=10`,
    );
  });
});

describe("getRetiredRedirect", () => {
  const u = (p: string) => new URL(`https://ww2.nemar.org${p}`);

  it("redirects retired /docs pages to the docs site", () => {
    expect(getRetiredRedirect(u("/docs"))).toBe("https://docs.nemar.org/web/");
    expect(getRetiredRedirect(u("/docs/"))).toBe("https://docs.nemar.org/web/");
    expect(getRetiredRedirect(u("/docs/upload"))).toBe("https://docs.nemar.org/web/uploading/");
    expect(getRetiredRedirect(u("/docs/cli-vs-web"))).toBe(
      "https://docs.nemar.org/ecosystem/cli-vs-web/",
    );
  });

  it("falls back to the docs home for unmapped /docs paths", () => {
    expect(getRetiredRedirect(u("/docs/whatever"))).toBe("https://docs.nemar.org/");
  });

  it("redirects the retired citation dashboard to dashboard.nemar.org", () => {
    expect(getRetiredRedirect(u("/citation-dashboard"))).toBe(
      "https://dashboard.nemar.org/citations",
    );
  });

  it("returns null for live routes", () => {
    expect(getRetiredRedirect(u("/discover"))).toBeNull();
    expect(getRetiredRedirect(u("/dashboard"))).toBeNull();
    expect(getRetiredRedirect(u("/"))).toBeNull();
  });
});

describe("appUrl / marketingUrl", () => {
  it("rewrites to absolute when crossing hosts", () => {
    expect(appUrl("/login", BETA_HOST)).toBe(`https://${APP_HOST}/login`);
    expect(appUrl("/login", MARKETING_HOST)).toBe(`https://${APP_HOST}/login`);
    expect(marketingUrl("/discover", APP_HOST)).toBe(`${MARKETING_BASE_URL}/discover`);
  });

  it("returns relative paths within the same host class", () => {
    expect(appUrl("/login", APP_HOST)).toBe("/login");
    expect(marketingUrl("/discover", BETA_HOST)).toBe("/discover");
    expect(marketingUrl("/discover", MARKETING_HOST)).toBe("/discover");
  });

  it("returns relative paths in single-host mode", () => {
    expect(appUrl("/login", "localhost")).toBe("/login");
    expect(marketingUrl("/discover", "localhost")).toBe("/discover");
  });
});

describe("isProductionHost", () => {
  it("is true for the app host and every marketing host (beta + canonical + www alias)", () => {
    expect(isProductionHost(APP_HOST)).toBe(true);
    expect(isProductionHost(BETA_HOST)).toBe(true);
    expect(isProductionHost(MARKETING_HOST)).toBe(true);
    expect(isProductionHost(`www.${MARKETING_HOST}`)).toBe(true);
  });

  it("is false for staging, preview, and localhost", () => {
    expect(isProductionHost("test.nemar.org")).toBe(false);
    expect(isProductionHost("fa9dbfa0.nemar-website.pages.dev")).toBe(false);
    expect(isProductionHost("localhost")).toBe(false);
  });

  it("normalizes uppercase host headers", () => {
    expect(isProductionHost(APP_HOST.toUpperCase())).toBe(true);
    expect(isProductionHost("TEST.NEMAR.ORG")).toBe(false);
  });
});

describe("isNoindexHost", () => {
  it("is true for staging and preview hosts", () => {
    expect(isNoindexHost("test.nemar.org")).toBe(true);
    expect(isNoindexHost("fa9dbfa0.nemar-website.pages.dev")).toBe(true);
  });

  it("is false for every production host", () => {
    expect(isNoindexHost(APP_HOST)).toBe(false);
    expect(isNoindexHost(BETA_HOST)).toBe(false);
    expect(isNoindexHost(MARKETING_HOST)).toBe(false);
    expect(isNoindexHost(`www.${MARKETING_HOST}`)).toBe(false);
  });

  it("is false for localhost variants (nothing to keep crawlers off of)", () => {
    expect(isNoindexHost("localhost")).toBe(false);
    expect(isNoindexHost("127.0.0.1")).toBe(false);
    expect(isNoindexHost("foo.localhost")).toBe(false);
  });
});

describe("getLegacyRedirect", () => {
  const u = (pathAndSearch: string) => new URL(`https://nemar.org${pathAndSearch}`);
  const LEGACY = "/dataexplorer/detail?dataset_id=ds007964";

  it("ignores paths that aren't legacy routes", () => {
    expect(getLegacyRedirect(u("/discover"), null)).toBeNull();
    expect(getLegacyRedirect(u("/dataset/on007964"), null)).toBeNull();
    expect(getLegacyRedirect(u("/"), null)).toBeNull();
  });

  // The citation case, and the default. A paper links the legacy URL; the
  // reader must land on the dataset.
  it("sends an external visitor to the new dataset page", () => {
    expect(getLegacyRedirect(u(LEGACY), null)).toEqual({
      location: "/dataset/ds007964",
      status: 301,
    });
    expect(getLegacyRedirect(u(LEGACY), "https://scholar.google.com/")).toEqual({
      location: "/dataset/ds007964",
      status: 301,
    });
  });

  // Someone mid-session on the legacy site stays there rather than being
  // ejected to the new one.
  it("bounces a ww1 visitor back to ww1, preserving the query", () => {
    expect(getLegacyRedirect(u(LEGACY), "https://ww1.nemar.org/dataexplorer")).toEqual({
      location: "https://ww1.nemar.org/dataexplorer/detail?dataset_id=ds007964",
      status: 302,
    });
  });

  // 302 for ww1, not 301: ww1 retires, and a cached permanent redirect would
  // outlive it with no way to reach the clients holding it (website#183).
  it("uses a temporary status for the ww1 bounce and a permanent one for the move", () => {
    expect(getLegacyRedirect(u(LEGACY), "https://ww1.nemar.org/x")?.status).toBe(302);
    expect(getLegacyRedirect(u(LEGACY), null)?.status).toBe(301);
  });

  // Referer is unreliable — stripped by privacy modes, absent on typed and
  // bookmarked navigation. Absent or unparseable must therefore mean "new
  // site", because that is the citation case and the one that must not break.
  it("defaults to the new site when Referer is missing or malformed", () => {
    for (const referer of [null, "", "not a url", "ww1.nemar.org", "://broken"]) {
      expect(getLegacyRedirect(u(LEGACY), referer)?.location).toBe("/dataset/ds007964");
    }
  });

  it("does not mistake a lookalike host for ww1", () => {
    for (const referer of [
      "https://ww1.nemar.org.evil.test/x",
      "https://notww1.nemar.org/x",
      "https://ww2.nemar.org/x",
    ]) {
      expect(getLegacyRedirect(u(LEGACY), referer)?.location).toBe("/dataset/ds007964");
    }
  });

  // The id is passed through untranslated: /dataset/<id> already resolves a
  // ds* id to its on* canonical via a catalog lookup, which correctly
  // declines when no mirror exists. Re-deriving it here would duplicate that
  // rule and could disagree with it.
  it("passes the id through without translating it", () => {
    expect(getLegacyRedirect(u("/dataexplorer/detail?dataset_id=nm000103"), null)?.location).toBe(
      "/dataset/nm000103",
    );
    expect(getLegacyRedirect(u("/dataexplorer/detail?dataset_id=on007964"), null)?.location).toBe(
      "/dataset/on007964",
    );
  });

  it("encodes a hostile id rather than interpolating it raw", () => {
    const r = getLegacyRedirect(u("/dataexplorer/detail?dataset_id=..%2F..%2Fadmin"), null);
    expect(r?.location).toBe("/dataset/..%2F..%2Fadmin");
    expect(r?.location.startsWith("/dataset/")).toBe(true);
  });

  it("falls back to discover when there is no usable id", () => {
    expect(getLegacyRedirect(u("/dataexplorer/detail"), null)).toEqual({
      location: "/discover",
      status: 302,
    });
    expect(getLegacyRedirect(u("/dataexplorer/detail?dataset_id=%20%20"), null)?.location).toBe(
      "/discover",
    );
  });

  it("tolerates a trailing slash and case on the path", () => {
    expect(getLegacyRedirect(u("/dataexplorer/detail/?dataset_id=ds007964"), null)?.location).toBe(
      "/dataset/ds007964",
    );
    expect(getLegacyRedirect(u("/DataExplorer/Detail?dataset_id=ds007964"), null)?.location).toBe(
      "/dataset/ds007964",
    );
  });
  // The legacy dataset browser has a direct successor on the new site.
  it("sends the legacy dataset browser to /discover", () => {
    expect(getLegacyRedirect(u("/dataexplorer"), null)).toEqual({
      location: "/discover",
      status: 301,
    });
    expect(getLegacyRedirect(u("/dataexplorer/"), null)?.location).toBe("/discover");
    expect(getLegacyRedirect(u("/dataexplorer/browse?tag=eeg"), null)?.location).toBe("/discover");
  });

  // HUBzero sections the redesign didn't carry over. The content exists only
  // on ww1, so a new-site page would be a worse answer than the real thing.
  it.each(["/resources", "/tools", "/members", "/groups", "/citations"])(
    "sends legacy-only %s to ww1",
    (path) => {
      const r = getLegacyRedirect(u(path), null);
      expect(r?.location).toBe(`https://ww1.nemar.org${path}`);
      // 302: ww1 retires, so this must not be cached permanently.
      expect(r?.status).toBe(302);
    },
  );

  it("matches legacy-only subpaths but not prefix collisions", () => {
    expect(getLegacyRedirect(u("/tools/matlab"), null)?.location).toBe(
      "https://ww1.nemar.org/tools/matlab",
    );
    // A different route that merely starts with the same characters must not
    // be swept to the legacy site.
    expect(getLegacyRedirect(u("/toolsmith"), null)).toBeNull();
    expect(getLegacyRedirect(u("/resources-new"), null)).toBeNull();
  });

  // These exist on BOTH sites. Redirecting them would hide the current
  // content behind the retired version — the opposite of the intent.
  it.each(["/about", "/support", "/login", "/discover", "/", "/dataset/on007964"])(
    "leaves %s alone (the new site serves it)",
    (path) => {
      expect(getLegacyRedirect(u(path), null)).toBeNull();
    },
  );

  it("keeps a ww1 visitor on ww1 for every legacy path, not just dataset detail", () => {
    for (const path of ["/dataexplorer", "/resources", "/tools/matlab"]) {
      const r = getLegacyRedirect(u(path), "https://ww1.nemar.org/x");
      expect(r?.location).toBe(`https://ww1.nemar.org${path}`);
      expect(r?.status).toBe(302);
    }
  });
});

// website#210. A signed-in user clicking Discover on the app host used to be
// 301'd to the marketing host, where the `app.nemar.org`-scoped session cookie
// does not travel and `/auth/me` is deliberately never called — so the nav
// signed them out. The app host now renders marketing routes itself when a
// session is present.
describe("getCrossHostRedirect with a session", () => {
  const url = (host: string, pathAndSearch: string) => new URL(`https://${host}${pathAndSearch}`);

  it("keeps marketing routes on the app host for a signed-in user", () => {
    for (const path of ["/discover", "/about", "/support", "/community", "/"]) {
      expect(getCrossHostRedirect(url(APP_HOST, path), { hasSession: true })).toBeNull();
    }
  });

  it("preserves the query string case by not redirecting at all", () => {
    expect(
      getCrossHostRedirect(url(APP_HOST, "/discover?modality=eeg&page=3"), { hasSession: true }),
    ).toBeNull();
  });

  it("still redirects marketing routes off the app host without a session", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/discover"), { hasSession: false })).toBe(
      `${MARKETING_BASE_URL}/discover`,
    );
    // Omitted option behaves as absent, not as true.
    expect(getCrossHostRedirect(url(APP_HOST, "/discover"))).toBe(`${MARKETING_BASE_URL}/discover`);
  });

  // The load-bearing asymmetry. The marketing host's responses are shared edge
  // cache entries; letting a cookie change what it serves would vary a shared
  // entry per-user and hand one visitor's page to the next. Authenticated
  // routes leave the marketing host unconditionally.
  it("NEVER suppresses the marketing-to-app redirect, cookie or not", () => {
    for (const host of [MARKETING_HOST, BETA_HOST]) {
      expect(getCrossHostRedirect(url(host, "/dashboard"), { hasSession: true })).toBe(
        `https://${APP_HOST}/dashboard`,
      );
      expect(getCrossHostRedirect(url(host, "/settings"), { hasSession: true })).toBe(
        `https://${APP_HOST}/settings`,
      );
    }
  });

  it("leaves app routes on the app host and single-host mode untouched", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/dashboard"), { hasSession: true })).toBeNull();
    expect(getCrossHostRedirect(url("localhost", "/discover"), { hasSession: true })).toBeNull();
  });
});

describe("canonicalOriginFor", () => {
  // Canonical is a property of the route. Once the app host can render
  // /discover, a host-derived canonical would put `app.nemar.org/discover`
  // into competition with the marketing host for identical content.
  it("sends marketing routes to the marketing origin from either host", () => {
    expect(canonicalOriginFor("/discover", APP_HOST)).toBe(MARKETING_BASE_URL);
    expect(canonicalOriginFor("/discover", MARKETING_HOST)).toBe(MARKETING_BASE_URL);
    expect(canonicalOriginFor("/", APP_HOST)).toBe(MARKETING_BASE_URL);
  });

  it("sends app routes to the app origin", () => {
    expect(canonicalOriginFor("/dashboard", APP_HOST)).toBe(`https://${APP_HOST}`);
    expect(canonicalOriginFor("/settings", MARKETING_HOST)).toBe(`https://${APP_HOST}`);
  });

  it("keeps single-host mode on the marketing origin, as before", () => {
    expect(canonicalOriginFor("/dashboard", "localhost")).toBe(MARKETING_BASE_URL);
    expect(canonicalOriginFor("/discover", "abc.pages.dev")).toBe(MARKETING_BASE_URL);
  });
});
