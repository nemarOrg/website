import { describe, expect, it } from "vitest";
import {
  APP_HOST,
  MARKETING_HOST,
  appUrl,
  getCrossHostRedirect,
  hostMode,
  isAppRoute,
  marketingUrl,
} from "./host";

describe("hostMode", () => {
  it("classifies the production app host", () => {
    expect(hostMode(APP_HOST)).toBe("app");
  });

  it("classifies the production marketing host and its www alias", () => {
    expect(hostMode(MARKETING_HOST)).toBe("marketing");
    expect(hostMode(`www.${MARKETING_HOST}`)).toBe("marketing");
  });

  it("falls back to single-host mode for localhost and previews", () => {
    expect(hostMode("localhost")).toBe("single");
    expect(hostMode("127.0.0.1")).toBe("single");
    expect(hostMode("fa9dbfa0.nemar-website.pages.dev")).toBe("single");
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

  it("redirects app paths from marketing host to app host", () => {
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/dashboard"))).toBe(
      `https://${APP_HOST}/dashboard`,
    );
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/login?next=/upload"))).toBe(
      `https://${APP_HOST}/login?next=/upload`,
    );
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/dataset/nm000103/collaborators"))).toBe(
      `https://${APP_HOST}/dataset/nm000103/collaborators`,
    );
  });

  it("redirects marketing paths from app host to marketing host", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/discover"))).toBe(
      `https://${MARKETING_HOST}/discover`,
    );
    expect(getCrossHostRedirect(url(APP_HOST, "/dataset/nm000103"))).toBe(
      `https://${MARKETING_HOST}/dataset/nm000103`,
    );
  });

  it("returns null when the path matches the current host", () => {
    expect(getCrossHostRedirect(url(MARKETING_HOST, "/discover"))).toBeNull();
    expect(getCrossHostRedirect(url(APP_HOST, "/dashboard"))).toBeNull();
  });

  it("never redirects in single-host mode", () => {
    expect(getCrossHostRedirect(url("localhost:4321", "/dashboard"))).toBeNull();
    expect(getCrossHostRedirect(url("fa9dbfa0.nemar-website.pages.dev", "/login"))).toBeNull();
  });

  it("preserves query strings on redirect", () => {
    expect(getCrossHostRedirect(url(APP_HOST, "/discover?modality=eeg&limit=10"))).toBe(
      `https://${MARKETING_HOST}/discover?modality=eeg&limit=10`,
    );
  });
});

describe("appUrl / marketingUrl", () => {
  it("rewrites to absolute when crossing hosts", () => {
    expect(appUrl("/login", MARKETING_HOST)).toBe(`https://${APP_HOST}/login`);
    expect(marketingUrl("/discover", APP_HOST)).toBe(`https://${MARKETING_HOST}/discover`);
  });

  it("returns relative paths within the same host", () => {
    expect(appUrl("/login", APP_HOST)).toBe("/login");
    expect(marketingUrl("/discover", MARKETING_HOST)).toBe("/discover");
  });

  it("returns relative paths in single-host mode", () => {
    expect(appUrl("/login", "localhost")).toBe("/login");
    expect(marketingUrl("/discover", "localhost")).toBe("/discover");
  });
});
