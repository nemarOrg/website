import { describe, expect, it } from "vitest";
import {
  UMAMI_EVENT_NAMES,
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
