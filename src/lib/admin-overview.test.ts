import { describe, expect, it } from "vitest";
import historyFixture from "../../test/fixtures/observability-history.json";
import currentFixture from "../../test/fixtures/observability-snapshot-current.json";
import olderFixture from "../../test/fixtures/observability-snapshot.json";
import {
  KPI_HISTORY_KEYS,
  STALE_AFTER_MINUTES,
  arrangeSections,
  breakdownView,
  coverageMetric,
  deriveAttention,
  hasUnlinkedDrilldown,
  histogramBins,
  historyDelta,
  kpiSpecs,
  percentOf,
  portalLinkFor,
  sectionLabel,
  sectionParts,
  sectionStatus,
  severityRank,
  shareText,
  sparkGeometry,
  toneForSeverity,
} from "./admin-overview";
import {
  type Metric,
  type MetricHistory,
  type MetricSection,
  type MetricSnapshot,
  formatExactCount,
  parseHistory,
  parseSnapshot,
} from "./observability";

// Both fixtures are real snapshots captured from dashboard.nemar.org, run
// through the same parser the page uses: the older one carries a failed
// `sync` section, the current one the `cf`, `egress`, and `sizes` sections
// and `breakdown_style`.
function parsed<T>(value: T | null): T {
  if (value === null) throw new Error("fixture did not parse");
  return value;
}
const current: MetricSnapshot = parsed(parseSnapshot(currentFixture));
const older: MetricSnapshot = parsed(parseSnapshot(olderFixture));
const history: MetricHistory = parsed(parseHistory(historyFixture));

/** Half an hour after the current fixture was generated. */
const SOON_AFTER = new Date(Date.parse(current.generated_at) + 30 * 60_000);

function section(key: string, snap: MetricSnapshot = current): MetricSection {
  const found = snap.sections.find((s) => s.key === key);
  if (!found) throw new Error(`fixture has no ${key} section`);
  return found;
}

function metric(key: string, snap: MetricSnapshot = current): Metric {
  for (const s of snap.sections) {
    const found = s.metrics.find((m) => m.key === key);
    if (found) return found;
  }
  throw new Error(`fixture has no ${key} metric`);
}

describe("severityRank and toneForSeverity", () => {
  it("orders error above warn above ok, with info and unknown words at the bottom", () => {
    expect(severityRank("error")).toBeGreaterThan(severityRank("warn"));
    expect(severityRank("warn")).toBeGreaterThan(severityRank("ok"));
    expect(severityRank("ok")).toBeGreaterThan(severityRank("info"));
    expect(severityRank("critical")).toBe(severityRank("info"));
  });

  it("marks only the three known states and leaves plain counts unmarked", () => {
    expect(toneForSeverity("error")).toBe("error");
    expect(toneForSeverity("ok")).toBe("ok");
    expect(toneForSeverity("info")).toBeNull();
    expect(toneForSeverity("critical")).toBeNull();
  });
});

describe("deriveAttention", () => {
  it("lists every warn and error metric, errors first", () => {
    const summary = deriveAttention(current, SOON_AFTER);
    const keys = summary.items.map((i) => i.key);
    expect(keys).toEqual([
      "zarr.failed",
      "imports.quarantined",
      "publication.prescreen_failed",
      "archive.missing",
      "zarr.pending",
      "publication.open",
      "access.archive_daily",
      "users.verified",
    ]);
    expect(summary.errorCount).toBe(3);
    expect(summary.warnCount).toBe(5);
    expect(summary.tone).toBe("error");
    expect(summary.sectionCount).toBe(6);
  });

  it("links each item to its portal list when one exists, else to its section card", () => {
    const byKey = new Map(deriveAttention(current, SOON_AFTER).items.map((i) => [i.key, i]));
    expect(byKey.get("imports.quarantined")?.link.href).toBe("/admin/imports?view=quarantined");
    expect(byKey.get("imports.quarantined")?.inPortal).toBe(true);
    expect(byKey.get("users.verified")?.link).toEqual({
      href: "/admin/users",
      label: "Review in Users",
    });
    expect(byKey.get("publication.open")?.link.href).toBe("/admin/publication-requests");
    // Archive and Zarr lists are not in the portal yet (website#195), so the
    // item points at the section card on this page instead of a dead link.
    expect(byKey.get("zarr.failed")?.link).toEqual({
      href: "#section-zarr",
      label: "See Zarr conversion",
    });
    expect(byKey.get("zarr.failed")?.inPortal).toBe(false);
  });

  it("prints the value and its share exactly as the section card does", () => {
    const missing = deriveAttention(current, SOON_AFTER).items.find(
      (i) => i.key === "archive.missing",
    );
    expect(missing?.value).toBe("8");
    expect(missing?.detail).toBe("1.2% of 668");
  });

  it("turns a section that failed to compute into an error item", () => {
    const summary = deriveAttention(older, new Date(Date.parse(older.generated_at) + 60_000));
    const first = summary.items[0];
    expect(first.kind).toBe("section_error");
    expect(first.label).toBe("Sync did not compute");
    expect(first.detail).toContain("no such column: nemar_sync_status");
    expect(first.link.href).toBe("#section-errors");
  });

  it("warns when the snapshot is older than the staleness bound, and not before", () => {
    const generated = Date.parse(current.generated_at);
    const fresh = deriveAttention(current, new Date(generated + STALE_AFTER_MINUTES * 60_000));
    expect(fresh.stale).toBe(false);
    const late = deriveAttention(current, new Date(generated + 5 * 3_600_000));
    expect(late.stale).toBe(true);
    const stale = late.items.find((i) => i.kind === "stale");
    expect(stale?.tone).toBe("warn");
    expect(stale?.detail).toContain("5 hours ago");
  });

  it("is all clear when nothing is at warn or error", () => {
    const calm: MetricSnapshot = {
      ...current,
      section_errors: [],
      sections: [section("cf"), { ...section("imports"), metrics: [metric("imports.imported")] }],
    };
    const summary = deriveAttention(calm, SOON_AFTER);
    expect(summary.items).toEqual([]);
    expect(summary.tone).toBe("ok");
  });
});

describe("sectionStatus and arrangeSections", () => {
  it("summarizes a section's worst state with counts", () => {
    expect(sectionStatus(section("zarr"))).toMatchObject({
      tone: "error",
      text: "1 error, 1 warning",
    });
    expect(sectionStatus(section("users")).text).toBe("1 warning");
    expect(sectionStatus(section("cf"))).toMatchObject({ tone: "ok", text: "OK" });
  });

  it("puts problem sections first, errors before warnings, and keeps the catalog apart", () => {
    const arranged = arrangeSections(current);
    expect(arranged.problems.map((s) => s.key)).toEqual([
      "zarr",
      "imports",
      "publication",
      "archive",
      "access",
      "users",
    ]);
    expect(arranged.healthy.map((s) => s.key)).toEqual(["cf", "egress"]);
    expect(arranged.catalog.map((s) => s.key)).toEqual(["datasets", "sizes"]);
  });
});

describe("coverageMetric and sectionParts", () => {
  it("picks the ok count-of-total as the ring", () => {
    const coverage = coverageMetric(section("archive"));
    expect(coverage?.metric.key).toBe("archive.ready");
    expect(coverage?.percent).toBe(98.8);
    expect(coverageMetric(section("zarr"))?.percent).toBe(88.2);
  });

  it("has no ring for a section without a total", () => {
    expect(coverageMetric(section("imports"))).toBeNull();
  });

  it("splits scalar rows from breakdowns and leaves the ring metric out of both", () => {
    const parts = sectionParts(section("access"));
    expect(parts.coverage).toBeNull();
    expect(parts.breakdowns.map((m) => m.key)).toEqual(["access.top"]);
    expect(parts.rows.map((m) => m.key)).not.toContain("access.top");
    const archive = sectionParts(section("archive"));
    expect(archive.rows.map((m) => m.key)).not.toContain("archive.ready");
  });
});

describe("portal links", () => {
  it("names the tab a metric links to", () => {
    expect(portalLinkFor("imports.failed")).toEqual({
      href: "/admin/imports?view=failed",
      label: "Review in Imports",
    });
    expect(portalLinkFor("archive.missing")).toBeNull();
  });

  it("flags sections whose drill-downs have no portal list yet", () => {
    expect(hasUnlinkedDrilldown(section("archive"))).toBe(true);
    expect(hasUnlinkedDrilldown(section("zarr"))).toBe(true);
    expect(hasUnlinkedDrilldown(section("imports"))).toBe(false);
    expect(hasUnlinkedDrilldown(section("cf"))).toBe(false);
  });
});

describe("percentOf and shareText", () => {
  it("rounds to one decimal and refuses a missing or zero total", () => {
    expect(percentOf(660, 668)).toBe(98.8);
    expect(percentOf(1, 0)).toBeNull();
    expect(percentOf(1, undefined)).toBeNull();
  });

  it("formats the total in the metric's own unit", () => {
    expect(shareText(metric("datasets.public"))).toBe("95.2% of 816");
    expect(shareText(metric("zarr.failed"))).toBeNull();
  });
});

describe("sectionLabel", () => {
  it("prefers the snapshot's own label and falls back to a plain name", () => {
    expect(sectionLabel("access", current)).toBe("Access (30d)");
    expect(sectionLabel("sync", current)).toBe("Sync");
    expect(sectionLabel("new_pipeline_qa")).toBe("New pipeline qa");
  });
});

describe("historyDelta", () => {
  it("reports the change across the real captured window", () => {
    // The fixture runs 2026-07-18 to 2026-07-24 at 760 then 754.
    const first = history.points[0];
    const last = history.points[history.points.length - 1];
    const delta = historyDelta(history.points, formatExactCount);
    const days = Math.round((Date.parse(last.at) - Date.parse(first.at)) / 86_400_000);
    const diff = last.value - first.value;
    expect(delta?.direction).toBe(diff > 0 ? "up" : diff < 0 ? "down" : "flat");
    expect(delta?.text).toContain(`in ${days} days`);
  });

  it("uses a real minus sign, a noun, and hours for a short window", () => {
    const points = [
      { at: "2026-09-28T00:00:00Z", value: 117 },
      { at: "2026-09-28T06:00:00Z", value: 8 },
    ];
    expect(historyDelta(points, formatExactCount, "missing")).toEqual({
      direction: "down",
      text: "−109 missing in 6 hours",
    });
  });

  it("says no change rather than +0, and nothing without a span", () => {
    const flat = [
      { at: "2026-09-21T00:00:00Z", value: 5 },
      { at: "2026-09-28T00:00:00Z", value: 5 },
    ];
    expect(historyDelta(flat, formatExactCount)?.text).toBe("No change in 7 days");
    expect(historyDelta([flat[0]], formatExactCount)).toBeNull();
    expect(historyDelta(undefined, formatExactCount)).toBeNull();
  });
});

describe("sparkGeometry", () => {
  it("draws inside the box, ending on the last value", () => {
    const g = sparkGeometry([117, 60, 8], 100, 30);
    expect(g).not.toBeNull();
    expect(g?.line.startsWith("M3 ")).toBe(true);
    expect(g?.end.x).toBe(97);
    // The lowest value sits lowest (largest y) and stays inside the padding.
    expect(g?.end.y).toBeGreaterThan(20);
    expect(g?.end.y).toBeLessThanOrEqual(27);
    expect(g?.area.endsWith("Z")).toBe(true);
    expect(g).toMatchObject({ first: 117, last: 8, min: 8, max: 117, count: 3 });
  });

  it("keeps a flat series off the edges", () => {
    const g = sparkGeometry([5, 5, 5], 100, 30);
    expect(g?.end.y).toBeCloseTo(15, 0);
  });

  it("refuses fewer than two finite values", () => {
    expect(sparkGeometry([4], 100, 30)).toBeNull();
    expect(sparkGeometry([Number.NaN, 4], 100, 30)).toBeNull();
  });
});

describe("kpiSpecs", () => {
  const withHistory = Object.fromEntries(KPI_HISTORY_KEYS.map((k) => [k, history]));

  it("builds the four headline cards from the snapshot", () => {
    const specs = kpiSpecs(current, {});
    expect(specs.map((s) => [s.label, s.value])).toEqual([
      ["Public datasets", "777"],
      ["Public data", "65.6 TB"],
      ["Archive coverage", "98.8%"],
      ["Zarr coverage", "88.2%"],
    ]);
    expect(specs[0].context).toEqual(["39 private, 100% with a DOI"]);
    expect(specs[2].context).toEqual([
      "660 of 668 eligible datasets",
      "8 missing, 109 skipped as too large",
    ]);
    expect(specs[2].anchor).toBe("section-archive");
  });

  it("says the recent change is unavailable when history did not load", () => {
    const specs = kpiSpecs(current, { "datasets.public": null });
    expect(specs[0].delta).toEqual({ direction: "none", text: "Recent change unavailable" });
    expect(specs[0].spark).toBeNull();
  });

  it("attaches a sparkline and delta when history is present", () => {
    const specs = kpiSpecs(current, withHistory);
    expect(specs[0].spark?.points.length).toBe(history.points.length);
    expect(specs[2].spark?.label).toBe("Missing archives");
    expect(specs[2].delta?.text).toMatch(/ missing in \d+ days$|^No change/);
  });

  it("renders a missing metric as unavailable, never as zero", () => {
    const bare: MetricSnapshot = { ...current, sections: [section("users")] };
    const specs = kpiSpecs(bare, {});
    expect(specs.every((s) => s.muted && s.value === "Unavailable")).toBe(true);
    expect(specs[0].context[0]).toContain("Unknown is not zero");
  });
});

describe("breakdownView", () => {
  it("names modalities and shares them of the public datasets", () => {
    const view = breakdownView(metric("datasets.by_modality"));
    expect(view.style).toBe("bars");
    expect(view.visible[0]).toMatchObject({ label: "EEG", value: "612", share: "79%" });
    expect(view.visible[0].widthPct).toBe(100);
    expect(view.visible).toHaveLength(6);
    expect(view.hidden).toHaveLength(6);
    // perf (1 of 777) is under one percent and says so rather than "0%".
    expect(view.hidden.at(-1)?.share).toBe("<1%");
  });

  it("draws a ranked list with shares of the total and dataset links", () => {
    const view = breakdownView(metric("sizes.largest"), 10);
    expect(view.style).toBe("ranked");
    expect(view.visible[0]).toMatchObject({
      label: "on004395",
      value: "9.6 TB",
      share: "14.6%",
      href: "/dataset/on004395",
    });
  });

  it("formats byte breakdowns in bytes even when the tile counts something else", () => {
    const view = breakdownView(metric("access.top"));
    expect(view.style).toBe("ranked");
    expect(view.visible[0].value).toBe("15.2 GB");
    expect(view.visible[0].share).toBeNull();
    const hosts = breakdownView(metric("cf.bytes_by_host"));
    expect(hosts.visible[1]).toMatchObject({
      label: "data.nemar.org",
      value: "8.2 TB",
      href: null,
    });
  });

  it("spells out country codes", () => {
    const view = breakdownView(metric("cf.by_country"));
    expect(view.visible[0].label).toBe("United States");
  });
});

describe("histogramBins", () => {
  it("strips the cutoff marker and shades every bin from the cutoff up", () => {
    const { bins, cutoff } = histogramBins(metric("sizes.histogram"));
    expect(cutoff).toBe("100 GB");
    expect(bins).toHaveLength(23);
    expect(bins[0]).toMatchObject({ tick: "< 1 MB", range: "Under 1 MB", pastCutoff: false });
    const at = bins.findIndex((b) => b.tick === "100 GB");
    expect(bins[at]).toMatchObject({ range: "100 GB to 200 GB", pastCutoff: true });
    expect(bins[at - 1].pastCutoff).toBe(false);
    expect(bins.at(-1)?.range).toBe("10 TB and larger");
    expect(Math.max(...bins.map((b) => b.heightPct))).toBe(100);
  });
});
