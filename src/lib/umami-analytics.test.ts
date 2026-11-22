import { describe, expect, it } from "vitest";
import BASE_LAYOUT from "../layouts/Base.astro?raw";
import {
  ANALYTICS_EXCLUDED_PATHS,
  UMAMI_EVENT_NAMES,
  isAnalyticsExcludedPath,
  isProductionAnalyticsHost,
  isUmamiWebsiteId,
  pageViewForPathname,
  safeUmamiScriptUrl,
} from "./umami-analytics";

describe("anonymous Umami tracking contract", () => {
  it("maps dataset paths to a fixed generic page without the dataset identifier", () => {
    expect(pageViewForPathname("/dataset/nm000232")).toEqual({
      url: "/dataset",
      title: "Dataset record",
    });
    expect(pageViewForPathname("/dataset/nm000232/collaborators")).toBeNull();
  });

  it("maps upload success to a fixed path without its query identifier", () => {
    expect(pageViewForPathname("/upload/success")).toEqual({ url: "/upload", title: "Upload" });
  });

  it("tracks only fixed public page categories", () => {
    expect(pageViewForPathname("/discover")).toEqual({
      url: "/discover",
      title: "Discover datasets",
    });
    expect(pageViewForPathname("/settings")).toBeNull();
    expect(pageViewForPathname("/admin")).toBeNull();
  });

  it("allows production website hosts and excludes preview hosts", () => {
    expect(isProductionAnalyticsHost("ww2.nemar.org")).toBe(true);
    expect(isProductionAnalyticsHost("app.nemar.org")).toBe(true);
    expect(isProductionAnalyticsHost("test.nemar.org")).toBe(false);
    expect(isProductionAnalyticsHost("nemar-website.pages.dev")).toBe(false);
  });

  it("accepts only a public Umami website identifier", () => {
    expect(isUmamiWebsiteId("94db1cb1-74f4-4a40-ad6c-962362670409")).toBe(true);
    expect(isUmamiWebsiteId("https://analytics.nemar.org")).toBe(false);
    expect(isUmamiWebsiteId(undefined)).toBe(false);
  });

  it("keeps the tracker script on the configured analytics host", () => {
    expect(safeUmamiScriptUrl(undefined)).toBe("https://analytics.nemar.org/nmr-analytics.js");
    expect(safeUmamiScriptUrl("https://analytics.nemar.org/custom.js")).toBe(
      "https://analytics.nemar.org/custom.js",
    );
    expect(safeUmamiScriptUrl("https://example.com/script.js")).toBeNull();
    expect(safeUmamiScriptUrl("https://analytics.nemar.org/script.js?site=other")).toBeNull();
  });

  it("defines the exact event allowlist consumed by the pusher", () => {
    expect(UMAMI_EVENT_NAMES).toEqual([
      "citation_click",
      "viewer_open",
      "viewer_interaction",
      "upload_started",
      "upload_completed",
    ]);
  });
});

describe("pages that never load analytics (nemar-cli ADR 0132)", () => {
  it("excludes the unsubscribe page and everything below it, not a sibling", () => {
    expect([...ANALYTICS_EXCLUDED_PATHS]).toContain("/unsubscribe");
    expect(isAnalyticsExcludedPath("/unsubscribe")).toBe(true);
    expect(isAnalyticsExcludedPath("/unsubscribe/v1.42.news.7.signature")).toBe(true);
    expect(isAnalyticsExcludedPath("/unsubscribed")).toBe(false);
    expect(isAnalyticsExcludedPath("/discover")).toBe(false);
  });

  it("is a gate in the layout: the installer script renders only when the path is not excluded", () => {
    expect(BASE_LAYOUT).toContain(
      "const analyticsAllowed = !isAnalyticsExcludedPath(Astro.url.pathname);",
    );
    // The one installer call sits inside the `analyticsAllowed &&` block, not beside it.
    const gate = BASE_LAYOUT.indexOf("{analyticsAllowed && (");
    const install = BASE_LAYOUT.indexOf("installUmamiAnalytics(");
    const gateEnd = BASE_LAYOUT.indexOf(")}", install);
    expect(gate).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(gate);
    expect(gateEnd).toBeGreaterThan(install);
    expect(BASE_LAYOUT.split("installUmamiAnalytics(").length - 1).toBe(1);
  });

  it("is checked by the installer too, so a page that still loads it stays idle", async () => {
    const source = (await import("./umami-analytics.ts?raw")).default as string;
    expect(source).toMatch(
      /const eligible = \(\): boolean =>\s*!isAnalyticsExcludedPath\(window\.location\.pathname\) &&/,
    );
  });
});
