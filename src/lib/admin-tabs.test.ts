import { describe, expect, it } from "vitest";
import { ADMIN_TABS } from "./admin-tabs";

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

  it("enables only overview and publications in phase 1", () => {
    const enabled = ADMIN_TABS.filter((t) => t.enabled).map((t) => t.id);
    expect(enabled).toEqual(["overview", "publications"]);
  });

  it("points overview and publications at their existing routes", () => {
    expect(ADMIN_TABS.find((t) => t.id === "overview")?.href).toBe("/admin");
    expect(ADMIN_TABS.find((t) => t.id === "publications")?.href).toBe(
      "/admin/publication-requests",
    );
  });

  it("has a unique id and href per tab", () => {
    const ids = ADMIN_TABS.map((t) => t.id);
    const hrefs = ADMIN_TABS.map((t) => t.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
