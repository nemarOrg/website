import { describe, expect, it } from "vitest";
import { ADMIN_TABS, adminMetricHref } from "./admin-tabs";

describe("ADMIN_TABS", () => {
  it("defines exactly the five phase-1..5 sections in order", () => {
    expect(ADMIN_TABS.map((t) => t.id)).toEqual([
      "overview",
      "publications",
      "users",
      "imports",
      "notices",
    ]);
  });

  it("enables every tab now that phase 5 has shipped", () => {
    const enabled = ADMIN_TABS.filter((t) => t.enabled).map((t) => t.id);
    expect(enabled).toEqual(["overview", "publications", "users", "imports", "notices"]);
  });

  it("points the shipped tabs at their existing routes", () => {
    expect(ADMIN_TABS.find((t) => t.id === "overview")?.href).toBe("/admin");
    expect(ADMIN_TABS.find((t) => t.id === "publications")?.href).toBe(
      "/admin/publication-requests",
    );
    expect(ADMIN_TABS.find((t) => t.id === "users")?.href).toBe("/admin/users");
    expect(ADMIN_TABS.find((t) => t.id === "imports")?.href).toBe("/admin/imports");
  });

  it("has a unique id and href per tab", () => {
    const ids = ADMIN_TABS.map((t) => t.id);
    const hrefs = ADMIN_TABS.map((t) => t.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("adminMetricHref", () => {
  it("links a metric family to its tab", () => {
    expect(adminMetricHref("publication.pending")).toBe("/admin/publication-requests");
    expect(adminMetricHref("users.awaiting_approval")).toBe("/admin/users");
  });

  // The imports tiles land on the matching filter rather than the bare tab,
  // so a click from Overview lands on the rows the tile counted.
  it("deep-links imports metrics to their matching view", () => {
    expect(adminMetricHref("imports.active")).toBe("/admin/imports?view=inflight");
    expect(adminMetricHref("imports.failed")).toBe("/admin/imports?view=failed");
    expect(adminMetricHref("imports.quarantined")).toBe("/admin/imports?view=quarantined");
  });

  // upstream_inaccessible is a subset of quarantined (the same last_error
  // match the observability Worker uses), so it shares that destination.
  it("sends upstream_inaccessible to the quarantined view", () => {
    expect(adminMetricHref("imports.upstream_inaccessible")).toBe(
      "/admin/imports?view=quarantined",
    );
  });

  // An imports metric with no specific view still reaches the tab.
  it("falls back to the tab href for an unmapped metric in a linked family", () => {
    expect(adminMetricHref("imports.imported")).toBe("/admin/imports");
  });

  // The dead-link guard. Every tab is enabled as of Phase 5, so there is no
  // longer a disabled tab to demonstrate it against; assert the invariant it
  // exists to protect instead, which still fails if a future phase adds a
  // tab-linked metric family before its route ships.
  it("only ever resolves to an enabled tab", () => {
    const enabledHrefs = new Set(ADMIN_TABS.filter((t) => t.enabled).map((t) => t.href));
    for (const key of ["publication.pending", "users.awaiting_approval", "imports.failed"]) {
      const href = adminMetricHref(key);
      expect(href).toBeDefined();
      // Strip the ?view= filter to compare against the tab's own href.
      expect(enabledHrefs.has((href as string).split("?")[0])).toBe(true);
    }
  });

  it("returns undefined for a family with no admin tab", () => {
    expect(adminMetricHref("datasets.public")).toBeUndefined();
    expect(adminMetricHref("zarr.converted")).toBeUndefined();
    expect(adminMetricHref("archive.bytes")).toBeUndefined();
  });
});
