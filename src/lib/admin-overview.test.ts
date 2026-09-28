import { describe, expect, it } from "vitest";
import archiveMissingFixture from "../../test/fixtures/observability-history-archive-missing.json";
import archiveReadyFixture from "../../test/fixtures/observability-history-archive-ready.json";
import historyFixture from "../../test/fixtures/observability-history.json";
import currentFixture from "../../test/fixtures/observability-snapshot-current.json";
import olderFixture from "../../test/fixtures/observability-snapshot.json";
import storageFixture from "../../test/fixtures/observability-storage-section.json";
import {
  DAILY_STALE_AFTER_MINUTES,
  KPI_HISTORY_KEYS,
  OVERVIEW_HISTORY_KEYS,
  STALE_AFTER_MINUTES,
  STORAGE_COMPARISON_NOTE,
  arrangeSections,
  badgeToneFor,
  breakdownView,
  coverageMetric,
  coveragePoints,
  deriveAttention,
  formatSnapshotTime,
  freshnessReference,
  hasUnlinkedDrilldown,
  histogramBins,
  historyDelta,
  kpiSpecs,
  measuredDayFromHint,
  percentOf,
  portalLinkFor,
  sectionHref,
  sectionLabel,
  sectionParts,
  sectionStatus,
  sectionTrends,
  severityRank,
  shareText,
  sparkGeometry,
  staleBoundMinutes,
  storageView,
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
const archiveReady: MetricHistory = parsed(parseHistory(archiveReadyFixture));
const archiveMissing: MetricHistory = parsed(parseHistory(archiveMissingFixture));

/** When the current fixture was generated: the clock its sections' ages are read against. */
const AT_GENERATION = new Date(current.generated_at);
/** Half an hour after the current fixture was generated. */
const SOON_AFTER = new Date(Date.parse(current.generated_at) + 30 * 60_000);

/** An ISO time `minutes` before the current fixture was generated. */
function minutesBeforeGeneration(minutes: number): string {
  return new Date(Date.parse(current.generated_at) - minutes * 60_000).toISOString();
}

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

  it("warns that the snapshot time is unknown rather than treating it as fresh", () => {
    const undated: MetricSnapshot = { ...current, generated_at: "not a date" };
    const summary = deriveAttention(undated, SOON_AFTER);
    expect(summary.ageMinutes).toBeNull();
    expect(summary.stale).toBe(true);
    const item = summary.items.find((i) => i.key === "snapshot.time_unknown");
    expect(item).toMatchObject({ kind: "stale", tone: "warn", label: "Snapshot time is unknown" });
    expect(item?.link.href).toBe("#snapshot-meta");
  });

  it("says no data, not all clear, for a snapshot with no sections", () => {
    const empty: MetricSnapshot = { ...current, sections: [], section_errors: [] };
    const summary = deriveAttention(empty, SOON_AFTER);
    expect(summary.tone).toBe("unknown");
    expect(summary.unknownCount).toBe(1);
    expect(summary.items).toMatchObject([
      { kind: "no_data", tone: "unknown", label: "The snapshot has no sections" },
    ]);
  });

  it("lists a section that reported no figures as unknown, after the warnings", () => {
    const hollow: MetricSnapshot = {
      ...current,
      section_errors: [],
      sections: [section("cf"), { ...section("imports"), metrics: [] }, section("users")],
    };
    const summary = deriveAttention(hollow, SOON_AFTER);
    expect(summary.items.map((i) => [i.key, i.tone])).toEqual([
      ["users.verified", "warn"],
      ["imports.empty", "unknown"],
    ]);
    expect(summary.items[1]).toMatchObject({
      kind: "section_empty",
      label: "OpenNeuro import reported no figures",
      link: { href: "#section-imports" },
    });
    expect(summary.tone).toBe("warn");
  });

  it("flags a section whose figures lag the snapshot, on its own cadence", () => {
    const lagging: MetricSnapshot = {
      ...current,
      section_errors: [],
      sections: [
        // An hourly section five hours behind, and a daily one two days behind.
        { ...section("cf"), updated_at: minutesBeforeGeneration(5 * 60) },
        { ...section("egress"), updated_at: minutesBeforeGeneration(48 * 60) },
        section("imports"),
      ],
    };
    const items = deriveAttention(lagging, SOON_AFTER).items.filter(
      (i) => i.kind === "section_stale",
    );
    expect(items.map((i) => i.key)).toEqual(["cf.stale", "egress.stale"]);
    expect(items[0].detail).toBe(
      "Last updated 5 hours before this snapshot; it normally updates every hour.",
    );
    expect(items[1]).toMatchObject({ tone: "warn", link: { href: "#section-egress" } });
    expect(items[1].detail).toContain(
      "2 days before this snapshot; it normally updates once a day",
    );
  });

  it("does not repeat an old snapshot's staleness on every section it computed", () => {
    const generated = Date.parse(current.generated_at);
    const summary = deriveAttention(current, new Date(generated + 5 * 3_600_000));
    expect(summary.items.filter((i) => i.kind === "section_stale")).toEqual([]);
    expect(summary.items.filter((i) => i.kind === "stale").map((i) => i.key)).toEqual([
      "snapshot.stale",
    ]);
  });

  it("links a catalog figure to the catalog block, which has no card of its own", () => {
    const warned: MetricSnapshot = {
      ...current,
      sections: current.sections.map((s) =>
        s.key === "datasets"
          ? {
              ...s,
              metrics: s.metrics.map((m) =>
                m.key === "datasets.private" ? { ...m, severity: "warn" } : m,
              ),
            }
          : s,
      ),
    };
    const item = deriveAttention(warned, SOON_AFTER).items.find(
      (i) => i.key === "datasets.private",
    );
    expect(item?.link.href).toBe("#section-catalog");
    expect(sectionHref("sizes")).toBe("#section-catalog");
    expect(sectionHref("zarr")).toBe("#section-zarr");
  });
});

describe("sectionStatus and arrangeSections", () => {
  it("summarizes a section's worst state with counts", () => {
    expect(sectionStatus(section("zarr"), AT_GENERATION)).toMatchObject({
      tone: "error",
      text: "1 error, 1 warning",
      stale: false,
    });
    expect(sectionStatus(section("users"), AT_GENERATION).text).toBe("1 warning");
    expect(sectionStatus(section("cf"), AT_GENERATION)).toMatchObject({ tone: "ok", text: "OK" });
  });

  it("never calls a section with no metrics OK", () => {
    const status = sectionStatus({ ...section("cf"), metrics: [] }, AT_GENERATION);
    expect(status).toMatchObject({ tone: "unknown", text: "No data" });
    expect(badgeToneFor(status.tone)).toBe("neutral");
  });

  it("marks a section out of date past its bound, with a longer bound for daily pushes", () => {
    expect(staleBoundMinutes("cf")).toBe(STALE_AFTER_MINUTES);
    expect(staleBoundMinutes("storage")).toBe(DAILY_STALE_AFTER_MINUTES);
    const hourly = sectionStatus(
      { ...section("cf"), updated_at: minutesBeforeGeneration(STALE_AFTER_MINUTES + 1) },
      AT_GENERATION,
    );
    expect(hourly).toMatchObject({ tone: "warn", text: "Out of date", stale: true });
    // The same age is ordinary for a section pushed once a day...
    const daily = sectionStatus(
      { ...section("egress"), updated_at: minutesBeforeGeneration(STALE_AFTER_MINUTES + 1) },
      AT_GENERATION,
    );
    expect(daily).toMatchObject({ tone: "ok", stale: false });
    // ...until it misses a run.
    const missed = sectionStatus(
      { ...section("egress"), updated_at: minutesBeforeGeneration(DAILY_STALE_AFTER_MINUTES + 1) },
      AT_GENERATION,
    );
    expect(missed.text).toBe("Out of date");
    const errored = sectionStatus(
      { ...section("zarr"), updated_at: minutesBeforeGeneration(STALE_AFTER_MINUTES + 1) },
      AT_GENERATION,
    );
    expect(errored).toMatchObject({ tone: "error", text: "1 error, 1 warning, out of date" });
  });

  it("treats an unreadable update time as unknown freshness, not as current", () => {
    const status = sectionStatus({ ...section("cf"), updated_at: "yesterday" }, AT_GENERATION);
    expect(status).toMatchObject({
      tone: "warn",
      lagMinutes: null,
      stale: true,
      text: "Update time unknown",
    });
  });

  it("reads a section's age against the snapshot's own time", () => {
    expect(freshnessReference(current, SOON_AFTER)).toEqual(AT_GENERATION);
    const undated = { ...current, generated_at: "" };
    expect(freshnessReference(undated, SOON_AFTER)).toEqual(SOON_AFTER);
  });

  it("puts problem sections first, errors before warnings, and keeps the catalog apart", () => {
    const arranged = arrangeSections(current, SOON_AFTER);
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

  it("unfolds stale and empty sections instead of filing them as healthy", () => {
    const snap: MetricSnapshot = {
      ...current,
      sections: [
        { ...section("cf"), metrics: [] },
        {
          ...section("egress"),
          updated_at: minutesBeforeGeneration(DAILY_STALE_AFTER_MINUTES + 60),
        },
        section("users"),
      ],
    };
    const arranged = arrangeSections(snap, SOON_AFTER);
    // Warnings (users, and stale egress) before the section with no data.
    expect(arranged.problems.map((s) => s.key)).toEqual(["egress", "users", "cf"]);
    expect(arranged.healthy).toEqual([]);
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

describe("formatSnapshotTime", () => {
  it("prints the snapshot time in UTC, as the dashboard does", () => {
    expect(formatSnapshotTime("2026-09-28T21:17:25.735Z")).toBe("Sep 28, 9:17 PM UTC");
    expect(formatSnapshotTime("not a date")).toBe("an unknown time");
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

  it("drains the real archive backlog with a minus sign", () => {
    // Captured 2026-09-21 to 2026-09-28: 117 missing archives down to 8.
    expect(historyDelta(archiveMissing.points, formatExactCount)).toEqual({
      direction: "down",
      text: "−109 in 7 days",
    });
  });

  it("counts hours for a short window", () => {
    const points = [
      { at: "2026-09-28T00:00:00Z", value: 2 },
      { at: "2026-09-28T06:00:00Z", value: 5 },
    ];
    expect(historyDelta(points, formatExactCount)?.text).toBe("+3 in 6 hours");
  });

  it("says no change rather than +0, including a change that rounds away", () => {
    const flat = [
      { at: "2026-09-21T00:00:00Z", value: 5 },
      { at: "2026-09-28T00:00:00Z", value: 5 },
    ];
    expect(historyDelta(flat, formatExactCount)?.text).toBe("No change in 7 days");
    const tiny = [
      { at: "2026-09-21T00:00:00Z", value: 98.81 },
      { at: "2026-09-28T00:00:00Z", value: 98.83 },
    ];
    expect(historyDelta(tiny, (v) => `${Math.round(v * 10) / 10} points`)?.direction).toBe("flat");
  });

  it("has nothing to say without a span", () => {
    expect(historyDelta([{ at: "2026-09-21T00:00:00Z", value: 5 }], formatExactCount)).toBeNull();
    expect(historyDelta(undefined, formatExactCount)).toBeNull();
  });
});

describe("coveragePoints", () => {
  it("turns a count-of-total history into the percentage a coverage card shows", () => {
    const points = coveragePoints(archiveReady.points);
    expect(points).toHaveLength(archiveReady.points.length);
    expect(points[0].value).toBe(84.9); // 657 of 774
    expect(points.at(-1)?.value).toBe(98.8); // 660 of 668
  });

  it("drops points without a total instead of plotting them as zero", () => {
    expect(coveragePoints([{ at: "2026-09-28T00:00:00Z", value: 3 }])).toEqual([]);
  });
});

describe("sectionTrends", () => {
  it("draws the archive backlog trend on the archive card only", () => {
    const hist = { "archive.missing": archiveMissing };
    const trends = sectionTrends(section("archive"), hist);
    expect(trends.map((t) => t.metric.key)).toEqual(["archive.missing"]);
    expect(trends[0].delta?.text).toBe("−109 in 7 days");
    expect(sectionTrends(section("zarr"), hist)).toEqual([]);
    expect(OVERVIEW_HISTORY_KEYS).toContain("archive.missing");
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
  const withHistory = {
    "datasets.public": history,
    "archive.ready": archiveReady,
  };

  it("fetches history for every card it trends", () => {
    expect(KPI_HISTORY_KEYS).toEqual([
      "datasets.public",
      "datasets.bytes",
      "archive.ready",
      "zarr.ready",
    ]);
  });

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
    expect(specs[0].spark).toMatchObject({ label: "Public datasets", format: "count" });
    expect(specs[0].spark?.points.length).toBe(history.points.length);
  });

  it("trends a coverage card in percentage points of its own total", () => {
    const archive = kpiSpecs(current, withHistory)[2];
    expect(archive.spark).toMatchObject({ label: "Archive coverage", format: "percent" });
    expect(archive.spark?.points.at(-1)?.value).toBe(98.8);
    expect(archive.delta).toEqual({ direction: "up", text: "+13.9 points in 7 days" });
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

describe("storageView", () => {
  // Contract-derived until a real snapshot carries the section: the pushed
  // `storage` section is not deployed yet, so this fixture is the output of
  // nemarOrg/nemar-observability PR #82's own collector (storageSection() and
  // storageFailureStatus() in scripts/push-s3-storage.ts) over that PR's real
  // CloudWatch capture, with updated_at stamped as the Worker's ingest does.
  // See the fixture's `_derivation`. Replace it with a captured snapshot
  // section once one exists.
  // Through the page's own parser, as a pushed section would arrive.
  const parsedSection = (raw: unknown): MetricSection => {
    const [only] = parsed(parseSnapshot({ ...currentFixture, sections: [raw] })).sections;
    if (!only) throw new Error("storage fixture did not parse");
    return only;
  };
  const storageSection = parsedSection(storageFixture.success);
  const failedSection = parsedSection(storageFixture.failure);
  const growth = { "storage.bucket_bytes": parsed(parseHistory(storageFixture.history)) };
  const withSection = (s: MetricSection): MetricSnapshot => ({
    ...current,
    sections: [...current.sections, s],
  });
  const withStorage = withSection(storageSection);

  it("says not collected yet, never zero, when the section is absent", () => {
    const view = storageView(current, {}, SOON_AFTER);
    expect(view.collected).toBe(false);
    expect(view.title).toBe("Data storage");
    expect(view.bucket).toBe("Not collected yet");
    expect(view.badge).toEqual({ tone: "neutral", text: "Not collected yet" });
    expect(view.bars).toEqual([]);
    expect(view.delta).toBeNull();
    expect(view.dateLine).toBeNull();
    expect(view.note).toContain("Unknown is not zero");
    // The catalog side of the comparison is still known, and still said.
    expect(view.comparison).toBe("Public catalog is 65.6 TB.");
  });

  it("says the collection failed when the collector pushed its failure status", () => {
    const view = storageView(withSection(failedSection), growth, SOON_AFTER);
    expect(view.collected).toBe(false);
    expect(view.bucket).toBe("Not collected yet");
    expect(view.badge).toEqual({ tone: "error", text: "Collection failed" });
    expect(view.note).toContain("latest collection failed");
    expect(view.note).toContain("Unknown is not zero");
    expect(view.delta).toBeNull();
    // The failure is an error metric, so it leads the attention summary.
    const item = deriveAttention(withSection(failedSection), SOON_AFTER).items.find(
      (i) => i.key === "storage.collector.errors",
    );
    expect(item).toMatchObject({ tone: "error", link: { href: "#section-storage" } });
  });

  it("treats a section without a bucket size as not collected", () => {
    const partial = withSection({
      ...storageSection,
      metrics: storageSection.metrics.filter((m) => m.key === "storage.object_count"),
    });
    const view = storageView(partial, growth, SOON_AFTER);
    expect(view.collected).toBe(false);
    expect(view.badge).toEqual({ tone: "neutral", text: "No bucket size" });
    expect(view.note).toBe("The storage section reported no bucket size. Unknown is not zero.");
  });

  it("compares the bucket with the public catalog without calling the gap waste", () => {
    const view = storageView(withStorage, growth, SOON_AFTER);
    expect(view.collected).toBe(true);
    expect(view.title).toBe("Data storage");
    expect(view.bucket).toBe("121.7 TB");
    expect(view.objects).toBe("1,347,607,631 objects");
    expect(view.comparison).toBe("Bucket holds 121.7 TB; public catalog is 65.6 TB.");
    expect(view.bars.map((b) => [b.label, b.value])).toEqual([
      ["S3 bucket", "121.7 TB"],
      ["Public catalog", "65.6 TB"],
    ]);
    expect(view.bars[0].widthPct).toBe(100);
    expect(view.bars[1].widthPct).toBeCloseTo(53.9, 1);
    expect(view.note).toBe(STORAGE_COMPARISON_NOTE);
    expect(view.note).toContain("not unused space");
    expect(view.byClass?.breakdown).toEqual([{ label: "Standard", value: 121_650_377_907_484 }]);
    expect(view.badge).toEqual({ tone: "ok", text: "OK" });
  });

  it("reports growth over the history and the day CloudWatch measured", () => {
    const view = storageView(withStorage, growth, SOON_AFTER);
    expect(view.delta).toEqual({ direction: "up", text: "+6.5 TB in 6 days" });
    expect(view.points).toHaveLength(7);
    // The collector's hint names the day: "Total bytes stored on 2026-09-28 UTC ...".
    expect(view.dateLine).toBe("Measured Sep 28, 2026 (UTC).");
  });

  it("says when the figure was received, never measured, when the hint names no day", () => {
    const undated = withSection({
      ...storageSection,
      metrics: storageSection.metrics.map((m) =>
        m.key === "storage.bucket_bytes" ? { ...m, hint: "Total bytes stored." } : m,
      ),
    });
    const view = storageView(undated, {}, SOON_AFTER);
    expect(view.dateLine).toBe("Received Sep 28, 2026 (UTC).");
    expect(view.dateLine).not.toContain("Measured");
  });

  it("reads the measurement day from either collector's hint, and only a real day", () => {
    expect(measuredDayFromHint("Total bytes stored on 2026-09-28 UTC across all classes.")).toBe(
      "Sep 28, 2026",
    );
    expect(measuredDayFromHint("2026-09-26 UTC; bytes served that day")).toBe("Sep 26, 2026");
    expect(measuredDayFromHint("Stored on 2026-02-30 UTC.")).toBeNull();
    expect(measuredDayFromHint("Updated 2026-09-28.")).toBeNull();
    expect(measuredDayFromHint(undefined)).toBeNull();
  });

  it("marks storage out of date once a daily push is missed", () => {
    const late = withSection({
      ...storageSection,
      updated_at: minutesBeforeGeneration(3 * 24 * 60),
    });
    expect(storageView(late, growth, SOON_AFTER).badge).toEqual({
      tone: "warn",
      text: "Out of date",
    });
    const item = deriveAttention(late, SOON_AFTER).items.find((i) => i.key === "storage.stale");
    expect(item).toMatchObject({ kind: "section_stale", link: { href: "#section-storage" } });
    expect(item?.detail).toContain("once a day");
  });

  it("keeps storage out of the pipeline grid but in the attention summary", () => {
    expect(arrangeSections(withStorage, SOON_AFTER).healthy.map((s) => s.key)).not.toContain(
      "storage",
    );
    const warned = withSection({
      ...storageSection,
      metrics: storageSection.metrics.map((m) =>
        m.key === "storage.bucket_bytes" ? { ...m, severity: "warn" } : m,
      ),
    });
    const item = deriveAttention(warned, SOON_AFTER).items.find(
      (i) => i.key === "storage.bucket_bytes",
    );
    expect(item).toMatchObject({ tone: "warn", value: "121.7 TB", sectionLabel: "Data storage" });
    expect(item?.link.href).toBe("#section-storage");
    expect(OVERVIEW_HISTORY_KEYS).toContain("storage.bucket_bytes");
  });
});
