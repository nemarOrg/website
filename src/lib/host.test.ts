import { describe, expect, it } from "vitest";
import {
  APP_HOST,
  MARKETING_BASE_URL,
  MARKETING_HOST,
  appUrl,
  getCrossHostRedirect,
  hostMode,
  isAppRoute,
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
