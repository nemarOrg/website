import { describe, expect, it, vi } from "vitest";
import historyFixture from "../../test/fixtures/observability-history.json";
import currentFixture from "../../test/fixtures/observability-snapshot-current.json";
import snapshotFixture from "../../test/fixtures/observability-snapshot.json";
import {
  type Metric,
  fetchMetricHistory,
  fetchObservabilitySnapshot,
  formatCompactCount,
  formatExactCount,
  formatMetricValue,
  formatSiBytes,
} from "./observability";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError("network error");
  }) as unknown as typeof fetch;
}

// A fetch impl that only ever settles by rejecting when its signal aborts —
// simulates a hung upstream (connection open, response never written)
// rather than an outright network failure, so it exercises the deadline
// path instead of the plain try/catch-on-throw path.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("fetchObservabilitySnapshot", () => {
  it("parses the real captured snapshot", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://dashboard.nemar.org/observability/api/snapshot");
      return new Response(JSON.stringify(snapshotFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const snapshot = await fetchObservabilitySnapshot({ fetch: fakeFetch });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.schema_version).toBe("1.0");
    expect(snapshot?.sections).toHaveLength(7);

    const datasets = snapshot?.sections.find((s) => s.key === "datasets");
    expect(datasets?.metrics).toHaveLength(6);
    const publicDatasets = datasets?.metrics.find((m) => m.key === "datasets.public");
    expect(publicDatasets).toMatchObject({
      value: 754,
      total: 785,
      unit: "datasets",
      severity: "info",
    });

    const byLicense = datasets?.metrics.find((m) => m.key === "datasets.by_license");
    expect(byLicense?.breakdown).toContainEqual({ label: "public", value: 570 });
  });

  it("passes section_errors through unmodified", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning(snapshotFixture),
    });
    expect(snapshot?.section_errors).toEqual([
      {
        key: "sync",
        error: "Error: D1_ERROR: no such column: nemar_sync_status at offset 166: SQLITE_ERROR",
      },
    ]);
  });

  it("returns null on a non-2xx response", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({ error: "internal" }, 500),
    });
    expect(snapshot).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const snapshot = await fetchObservabilitySnapshot({ fetch: throwingFetch() });
    expect(snapshot).toBeNull();
  });

  it("returns null when the upstream hangs past the deadline", async () => {
    await expect(
      fetchObservabilitySnapshot({ fetch: hangingFetch, timeoutMs: 10 }),
    ).resolves.toBeNull();
  });

  it("returns null on a garbage (non-JSON) body", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    const snapshot = await fetchObservabilitySnapshot({ fetch: fakeFetch });
    expect(snapshot).toBeNull();
  });

  it("returns null when the body has no sections array", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({ schema_version: "1.0" }),
    });
    expect(snapshot).toBeNull();
  });

  it("drops a malformed metric without dropping its section", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({
        schema_version: "1.0",
        generated_at: "2026-07-24T00:00:00Z",
        sections: [
          {
            key: "datasets",
            label: "Datasets",
            source: "nemar-cli",
            updated_at: "2026-07-24T00:00:00Z",
            metrics: [
              {
                key: "datasets.public",
                label: "Public",
                value: 5,
                unit: "datasets",
                severity: "ok",
              },
              {
                key: "datasets.broken",
                label: "Broken",
                value: "not a number",
                unit: "datasets",
                severity: "ok",
              },
            ],
          },
        ],
        section_errors: [],
      }),
    });
    expect(snapshot?.sections).toHaveLength(1);
    expect(snapshot?.sections[0]?.metrics).toHaveLength(1);
    expect(snapshot?.sections[0]?.metrics[0]?.key).toBe("datasets.public");
  });

  it("passes through an unknown severity and unit rather than dropping the metric", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({
        schema_version: "1.0",
        generated_at: "2026-07-24T00:00:00Z",
        sections: [
          {
            key: "sync",
            label: "Sync",
            source: "nemar-cli",
            updated_at: "2026-07-24T00:00:00Z",
            metrics: [
              {
                key: "sync.lag",
                label: "Lag",
                value: 3,
                unit: "minutes",
                severity: "critical",
              },
            ],
          },
        ],
        section_errors: [],
      }),
    });
    expect(snapshot?.sections[0]?.metrics[0]).toMatchObject({
      unit: "minutes",
      severity: "critical",
    });
  });
});

describe("fetchMetricHistory", () => {
  it("parses the real captured history fixture", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://dashboard.nemar.org/observability/api/snapshot/history?metric=datasets.public",
      );
      return new Response(JSON.stringify(historyFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const history = await fetchMetricHistory("datasets.public", { fetch: fakeFetch });
    expect(history).not.toBeNull();
    expect(history?.metric).toBe("datasets.public");
    expect(history?.points.length).toBeGreaterThan(0);
    expect(history?.points[0]).toMatchObject({
      at: expect.any(String),
      value: expect.any(Number),
    });
  });

  it("returns null on a non-2xx response", async () => {
    const history = await fetchMetricHistory("datasets.public", {
      fetch: fetchReturning({ error: "internal" }, 500),
    });
    expect(history).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const history = await fetchMetricHistory("datasets.public", { fetch: throwingFetch() });
    expect(history).toBeNull();
  });

  it("returns null when the upstream hangs past the deadline", async () => {
    await expect(
      fetchMetricHistory("datasets.public", { fetch: hangingFetch, timeoutMs: 10 }),
    ).resolves.toBeNull();
  });

  it("returns null on a garbage body", async () => {
    const fakeFetch = vi.fn(
      async () => new Response("not json", { status: 200 }),
    ) as unknown as typeof fetch;
    const history = await fetchMetricHistory("datasets.public", { fetch: fakeFetch });
    expect(history).toBeNull();
  });
});

describe("formatMetricValue", () => {
  function metric(overrides: Partial<Metric> = {}): Metric {
    return { key: "k", label: "L", value: 0, unit: "count", severity: "info", ...overrides };
  }

  // The public dashboard prints the same snapshot in SI units; binary units
  // here made the two surfaces disagree on one number (55.2 TB vs 60.7 TB).
  it("formats bytes in SI units, as the public dashboard does", () => {
    expect(formatMetricValue(metric({ value: 60710575997968, unit: "bytes" }))).toBe("60.7 TB");
  });

  it("formats datasets as an exact count", () => {
    expect(formatMetricValue(metric({ value: 754, unit: "datasets" }))).toBe("754");
  });

  it("formats count with thousands separators rather than abbreviating", () => {
    expect(formatMetricValue(metric({ value: 152299, unit: "count" }))).toBe("152,299");
  });

  it("appends a percent sign for the percent unit", () => {
    expect(formatMetricValue(metric({ value: 4.7, unit: "percent" }))).toBe("4.7%");
  });

  it("falls back to an exact count for an unknown unit", () => {
    expect(formatMetricValue(metric({ value: 42, unit: "widgets" }))).toBe("42");
  });
});

describe("formatSiBytes", () => {
  it("matches the dashboard's humanBytes at every scale", () => {
    expect(formatSiBytes(0)).toBe("0 B");
    expect(formatSiBytes(512)).toBe("512 B");
    expect(formatSiBytes(1500)).toBe("1.5 kB");
    expect(formatSiBytes(552_882_902_018)).toBe("552.9 GB");
    expect(formatSiBytes(65_588_144_252_044)).toBe("65.6 TB");
  });

  it("never prints a negative or non-finite value as a size", () => {
    expect(formatSiBytes(-5)).toBe("0 B");
    expect(formatSiBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatCompactCount", () => {
  it("stays exact below ten thousand and compacts above", () => {
    expect(formatCompactCount(9999)).toBe("9,999");
    expect(formatCompactCount(15_282_180)).toBe("15.3M");
    expect(formatCompactCount(38_811)).toBe("38.8K");
  });

  it("says Unknown rather than printing a non-finite number", () => {
    expect(formatCompactCount(Number.NaN)).toBe("Unknown");
    expect(formatExactCount(Number.POSITIVE_INFINITY)).toBe("Unknown");
  });
});

describe("breakdown_style", () => {
  it("is parsed through from the live snapshot, where sizes.largest is ranked", async () => {
    const snapshot = await fetchObservabilitySnapshot({ fetch: fetchReturning(currentFixture) });
    const sizes = snapshot?.sections.find((s) => s.key === "sizes");
    const largest = sizes?.metrics.find((m) => m.key === "sizes.largest");
    expect(largest?.breakdown_style).toBe("ranked");
    const histogram = sizes?.metrics.find((m) => m.key === "sizes.histogram");
    expect(histogram?.breakdown_style).toBeUndefined();
  });
});

describe("breakdown_unit", () => {
  // A tile can count datasets while its bars are bytes (access.top,
  // cf.bytes_by_host). Dropping this field made the admin Overview render raw
  // byte integers labelled with the tile's own unit (website#196).
  it("is parsed through when the upstream metric supplies it", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({
        schema_version: "1.0",
        generated_at: "2026-07-29T12:00:00.000Z",
        sections: [
          {
            key: "access",
            label: "Access (30d)",
            source: "access",
            updated_at: "2026-07-29T12:00:00.000Z",
            metrics: [
              {
                key: "access.top",
                label: "Most read datasets",
                value: 2,
                unit: "count",
                severity: "info",
                breakdown: [
                  { label: "on004080", value: 13124701 },
                  { label: "on004475", value: 12024714 },
                ],
                breakdown_unit: "bytes",
              },
            ],
          },
        ],
      }),
    });
    const top = snapshot?.sections[0]?.metrics[0];
    expect(top?.breakdown_unit).toBe("bytes");
    expect(top?.unit).toBe("count");
  });

  it("is absent when upstream omits it, so consumers fall back to unit", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({
        schema_version: "1.0",
        generated_at: "2026-07-29T12:00:00.000Z",
        sections: [
          {
            key: "datasets",
            label: "Datasets",
            source: "nemar-cli",
            updated_at: "2026-07-29T12:00:00.000Z",
            metrics: [
              {
                key: "datasets.by_license",
                label: "By license",
                value: 754,
                unit: "datasets",
                severity: "info",
                breakdown: [{ label: "public", value: 570 }],
              },
            ],
          },
        ],
      }),
    });
    expect(snapshot?.sections[0]?.metrics[0]?.breakdown_unit).toBeUndefined();
  });

  it("drops a non-string breakdown_unit rather than passing it through", async () => {
    const snapshot = await fetchObservabilitySnapshot({
      fetch: fetchReturning({
        schema_version: "1.0",
        generated_at: "2026-07-29T12:00:00.000Z",
        sections: [
          {
            key: "cf",
            label: "Edge traffic (30d)",
            source: "cloudflare",
            updated_at: "2026-07-29T12:00:00.000Z",
            metrics: [
              {
                key: "cf.bytes_by_host",
                label: "Bytes by host",
                value: 1,
                unit: "count",
                severity: "info",
                breakdown: [{ label: "data.nemar.org", value: 180000000 }],
                breakdown_unit: 42,
              },
            ],
          },
        ],
      }),
    });
    expect(snapshot?.sections[0]?.metrics[0]?.breakdown_unit).toBeUndefined();
  });
});
