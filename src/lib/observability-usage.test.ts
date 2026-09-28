import { describe, expect, it, vi } from "vitest";
import audienceFixture from "../../test/fixtures/observability-audience.json";
import timeseriesFixture from "../../test/fixtures/observability-timeseries.json";
import {
  type UsageAudience,
  type UsageRange,
  type UsageTimeseries,
  fetchUsageAudience,
  fetchUsageTimeseries,
  last30DaysUtc,
  parseAudience,
  parseTimeseries,
  rangeText,
  usageKpis,
} from "./observability-usage";

// Both fixtures are real responses captured from dashboard.nemar.org for
// 2026-08-28 to 2026-09-27: the edge covered only part of that range, website
// analytics were not configured, and storage egress reported through Sep 26.
function parsed<T>(value: T | null): T {
  if (value === null) throw new Error("fixture did not parse");
  return value;
}
const series: UsageTimeseries = parsed(parseTimeseries(timeseriesFixture));
const audience: UsageAudience = parsed(parseAudience(audienceFixture));
const range: UsageRange = { start: "2026-08-28", end: "2026-09-27" };

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("last30DaysUtc", () => {
  it("is the 30 complete UTC days ending yesterday, as the dashboard's default", () => {
    expect(last30DaysUtc(new Date("2026-09-28T21:50:00Z"))).toEqual({
      start: "2026-08-29",
      end: "2026-09-27",
    });
  });

  it("follows the UTC day, not the local one", () => {
    expect(last30DaysUtc(new Date("2026-03-01T00:30:00Z")).end).toBe("2026-02-28");
  });
});

describe("rangeText", () => {
  it("names the dates as the dashboard's range chip does", () => {
    expect(rangeText({ start: "2026-08-29", end: "2026-09-27" })).toBe("Aug 29 to Sep 27, 2026");
    expect(rangeText({ start: "2025-12-15", end: "2026-01-13" })).toBe(
      "Dec 15, 2025 to Jan 13, 2026",
    );
  });
});

describe("parsers", () => {
  it("parse the captured payloads", () => {
    expect(series.series[0]).toMatchObject({ section: "egress", unit: "bytes" });
    expect(series.series[0].points).toHaveLength(30);
    expect(audience.cloudflare).toMatchObject({ status: "partial", requests: 15_282_180 });
    expect(audience.cloudflare.coverage).toEqual({ start: "2026-08-30", end: "2026-09-27" });
    expect(audience.umami).toMatchObject({ status: "unconfigured", visitors: null });
  });

  it("reject a body without its range and drop malformed points", () => {
    expect(parseTimeseries({ series: [] })).toBeNull();
    expect(parseAudience({ cloudflare: {} })).toBeNull();
    const messy = parseTimeseries({
      start: "2026-09-01",
      end: "2026-09-02",
      series: [
        {
          section: "egress",
          key: "k",
          label: "L",
          unit: "bytes",
          points: [
            { date: "2026-09-01", value: 5 },
            { date: "bad", value: 1 },
            { date: "2026-09-02" },
          ],
        },
        { section: "cf" },
      ],
    });
    expect(messy?.series).toHaveLength(1);
    expect(messy?.series[0].points).toEqual([{ date: "2026-09-01", value: 5 }]);
  });

  it("read a missing source as unavailable, never as zero", () => {
    const bare = parseAudience({ start: "2026-09-01", end: "2026-09-02" });
    expect(bare?.cloudflare).toEqual({ status: "unavailable", coverage: null, requests: null });
  });
});

describe("fetchers", () => {
  it("ask for the range and parse the answer", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://dashboard.nemar.org/observability/api/timeseries?start=2026-08-28&end=2026-09-27",
      );
      return new Response(JSON.stringify(timeseriesFixture), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchUsageTimeseries(range, { fetch: fakeFetch }))?.series).toHaveLength(1);
  });

  it("resolve to null on an error status, a network failure, or a bad body", async () => {
    expect(
      await fetchUsageAudience(range, { fetch: fetchReturning({ error: "x" }, 400) }),
    ).toBeNull();
    const throwing = vi.fn(async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await fetchUsageAudience(range, { fetch: throwing })).toBeNull();
    const notJson = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await fetchUsageTimeseries(range, { fetch: notJson })).toBeNull();
  });

  it("give up at the deadline instead of hanging the page", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect(await fetchUsageAudience(range, { fetch: hanging, timeoutMs: 20 })).toBeNull();
  });
});

describe("usageKpis", () => {
  it("builds the three cards from the captured payloads", () => {
    const [requests, served, sessions] = usageKpis(range, series, audience);
    expect(requests).toMatchObject({ label: "Requests", value: "15.3M", muted: false });
    // The edge covered only part of the range, and the card says which part.
    expect(requests.context[0]).toBe("Measured Aug 30 to Sep 27, 2026 only.");
    expect(requests.context[1]).toContain("not a count of people");

    expect(served).toMatchObject({ label: "Data served", muted: false });
    expect(served.context[0]).toBe("30 of 31 days reported, through Sep 26.");
    expect(served.spark).toMatchObject({ format: "bytes", cadence: "daily" });
    expect(served.spark?.points).toHaveLength(30);

    expect(sessions).toMatchObject({
      label: "Website sessions",
      value: "Not measured",
      muted: true,
    });
    expect(sessions.context[0]).toBe(
      "Website analytics are not reporting yet. Unknown is not zero.",
    );
  });

  it("sums only the reported days inside the range", () => {
    const [, served] = usageKpis({ start: "2026-09-25", end: "2026-09-26" }, series, audience);
    // 10,787,529,513,694 + 8,631,588,503,864 bytes.
    expect(served.value).toBe("19.4 TB");
    expect(served.context[0]).toBe("Storage egress for every day in the range.");
  });

  it("says unavailable, never zero, when the endpoints did not answer", () => {
    const specs = usageKpis(range, null, null);
    expect(specs.map((s) => [s.value, s.muted])).toEqual([
      ["Unavailable", true],
      ["Unavailable", true],
      ["Unavailable", true],
    ]);
    expect(specs[0].context[0]).toContain("Unknown is not zero");
  });

  it("says not measured for a range with no reported days", () => {
    const [, served] = usageKpis({ start: "2026-01-01", end: "2026-01-30" }, series, audience);
    expect(served).toMatchObject({ value: "Not measured", muted: true, spark: null });
  });
});
