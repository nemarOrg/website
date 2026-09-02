import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import on008083V1 from "../../test/fixtures/zarr/on008083-index-v1.json";
import v3Sample from "../../test/fixtures/zarr/v3-sample-index.json";
import {
  parseZarrIndex,
  prefetchZarrStoreMetadata,
  unitsNoticeText,
  zarrAvailablePaths,
  zarrCoverage,
  zarrFailureReasonByPath,
  zarrPendingPaths,
  zarrStoreByPath,
} from "./zarr-index";

describe("parseZarrIndex", () => {
  it("keeps valid stores and drops malformed entries", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        {
          path: "sub-01/eeg/sub-01_task-rest_eeg.set",
          zarr: "sub-01/eeg/sub-01_task-rest_eeg.zarr",
        },
        { path: "bad" },
        null,
      ],
    });

    expect(index?.stores).toEqual([
      { path: "sub-01/eeg/sub-01_task-rest_eeg.set", zarr: "sub-01/eeg/sub-01_task-rest_eeg.zarr" },
    ]);
  });

  it("rejects non-index payloads", () => {
    expect(parseZarrIndex(null)).toBeNull();
    expect(parseZarrIndex({ stores: [] })).toBeNull();
    expect(
      parseZarrIndex({ dataset_id: "nm000132", format: "nemar-zarr-index", stores: "x" }),
    ).toBeNull();
  });

  it("parses data failures and tolerates an absent failures array", () => {
    const index = parseZarrIndex({
      dataset_id: "on005261",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        {
          path: "derivatives/sub-01_task-x_ave.fif",
          zarr: "derivatives/sub-01_task-x_ave.zarr",
          code: "not_continuous",
          reason: "trial-averaged derivative",
        },
        { path: "bad-missing-path-field-only-zarr", zarr: "x.zarr" }, // kept (path is a string)
        { zarr: "no-path.zarr" }, // dropped (no path)
        null,
      ],
    });
    expect(index?.failures.map((f) => f.code)).toEqual(["not_continuous", undefined]);
    // Older index without `failures` -> empty array, not null.
    const legacy = parseZarrIndex({ dataset_id: "x", format: "nemar-zarr-index", stores: [] });
    expect(legacy?.failures).toEqual([]);
  });
});

describe("zarrFailureReasonByPath", () => {
  it("maps both the BIDS path and the .zarr path to the reason, skipping reasonless entries", () => {
    const index = parseZarrIndex({
      dataset_id: "on005261",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        { path: "a-ave.fif", zarr: "a-ave.zarr", code: "not_continuous", reason: "derivative" },
        { path: "b.edf", zarr: "b.zarr", code: "corrupt_or_truncated" }, // no reason -> skipped
      ],
    });
    expect(index).not.toBeNull();
    const m = zarrFailureReasonByPath(index!);
    expect(m.get("a-ave.fif")).toBe("derivative");
    expect(m.get("a-ave.zarr")).toBe("derivative"); // fallback key
    expect(m.has("b.edf")).toBe(false);
  });
});

describe("zarrPendingPaths (website#278 review)", () => {
  it("returns the pending BIDS paths on a v3 index", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index?.format_version).toBe(3);
    const paths = zarrPendingPaths(index!);
    expect([...paths].sort()).toEqual([
      "sub-04/eeg/sub-04_task-rest_eeg.set",
      "sub-05/eeg/sub-05_task-rest_eeg.bdf",
      "sub-06/eeg/sub-06_task-rest_eeg.vhdr",
    ]);
  });

  it("is empty on a v1 index (v1 never reports pending)", () => {
    const index = parseZarrIndex(on008083V1);
    expect(index?.format_version).toBe(1);
    expect(zarrPendingPaths(index!)).toEqual(new Set());
  });

  it("includes a pending directory recording's path (no name-derived extension)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
      pending: [{ path: "sub-01/meg/sub-01_task-rest_meg", reason: "not_attempted", attempts: 0 }],
      discovered_count: 1,
    });
    expect(zarrPendingPaths(index!).has("sub-01/meg/sub-01_task-rest_meg")).toBe(true);
  });
});

describe("zarrAvailablePaths", () => {
  it("returns BIDS source paths, not .zarr paths", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        { path: "sub-01/eeg/a.set", zarr: "sub-01/eeg/a.zarr" },
        { path: "sub-02/eeg/b.edf", zarr: "sub-02/eeg/b.zarr" },
      ],
    });

    expect(index).not.toBeNull();
    expect([...zarrAvailablePaths(index!)]).toEqual(["sub-01/eeg/a.set", "sub-02/eeg/b.edf"]);
  });
});

describe("zarrStoreByPath", () => {
  it("maps BIDS source paths to their Zarr store metadata", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [
        {
          path: "sub-01/eeg/a.set",
          zarr: "sub-01/eeg/a.zarr",
          groups: [{ name: "eeg_250hz" }],
        },
      ],
    });

    expect(index).not.toBeNull();
    expect(zarrStoreByPath(index!).get("sub-01/eeg/a.set")?.groups?.[0]?.name).toBe("eeg_250hz");
  });
});

describe("parseZarrIndex updated_utc (the cache-busting token, #240)", () => {
  const MINIMAL = { dataset_id: "nm000132", format: "nemar-zarr-index", stores: [] };

  it("keeps the producer's conversion stamp", () => {
    expect(parseZarrIndex({ ...MINIMAL, updated_utc: "2026-08-11T23:38:13Z" })?.updated_utc).toBe(
      "2026-08-11T23:38:13Z",
    );
  });

  it("defaults to '' for an index that predates the field", () => {
    expect(parseZarrIndex(MINIMAL)?.updated_utc).toBe("");
  });

  it("degrades a non-string stamp to '' instead of letting it reach the URL", () => {
    // A producer regression (serializing a datetime or epoch) must not put a
    // number/object into the query string.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseZarrIndex({ ...MINIMAL, updated_utc: 1786558143 })?.updated_utc).toBe("");
      expect(parseZarrIndex({ ...MINIMAL, updated_utc: null })?.updated_utc).toBe("");
      // ...and says so, so "cache-busting silently off" is traceable.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when a present stamp sanitizes away entirely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      parseZarrIndex({ ...MINIMAL, updated_utc: ":::" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent for the ordinary stamp and the legitimately-absent case", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      parseZarrIndex({ ...MINIMAL, updated_utc: "2026-08-11T23:38:13Z" });
      parseZarrIndex(MINIMAL);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("prefetchZarrStoreMetadata token threading (#240)", () => {
  const CALLS: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    CALLS.length = 0;
    // Transport boundary only: the real URL-building code under test still runs;
    // we just capture what it asked the network for.
    globalThis.fetch = ((input: RequestInfo | URL) => {
      CALLS.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const STORE = {
    path: "sub-01/eeg/sub-01_task-rest_eeg.set",
    zarr: "x",
    groups: [{ name: "eeg_250hz" }],
  };

  it("carries the token onto every warmed URL, so the prefetch matches the real open", () => {
    prefetchZarrStoreMetadata("nm000132", STORE.path, STORE, "2026-08-11T23:38:13Z");
    expect(CALLS.length).toBe(3);
    for (const url of CALLS) {
      expect(new URL(url).searchParams.get("v")).toBe("2026-08-11T233813Z");
    }
  });

  it("puts the key on the path, not spliced into the query", () => {
    prefetchZarrStoreMetadata("nm000132", STORE.path, STORE, "abc123");
    expect(new URL(CALLS[0]).pathname).toBe(
      "/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/zarr.json",
    );
    expect(new URL(CALLS[1]).pathname).toBe(
      "/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/eeg_250hz/zarr.json",
    );
    expect(new URL(CALLS[2]).pathname).toBe(
      "/nm000132/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/eeg_250hz/0/zarr.json",
    );
  });

  it("emits query-free URLs without a token, matching pre-#240 behaviour", () => {
    prefetchZarrStoreMetadata("nm000132", STORE.path, STORE);
    for (const url of CALLS) expect(url).not.toContain("?");
  });
});

describe("parseZarrIndex format_version discrimination (website#277)", () => {
  it("parses a real production v1 index (on008083) as format_version 1", () => {
    const index = parseZarrIndex(on008083V1);
    expect(index).not.toBeNull();
    expect(index?.format_version).toBe(1);
    expect(index?.dataset_id).toBe("on008083");
    expect(index?.stores.length).toBe(2);
    expect(index?.failures.length).toBe(36);
    // v1 has no `pending` array at all -- only reachable on the v3 branch.
    expect((index as { pending?: unknown })?.pending).toBeUndefined();
  });

  it("parses a schema-valid v3 fixture as format_version 3 with pending + discovered_count", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index).not.toBeNull();
    expect(index?.format_version).toBe(3);
    if (index?.format_version !== 3) throw new Error("expected v3");
    expect(index.dataset_id).toBe("on009991");
    expect(index.stores.length).toBe(2);
    expect(index.failures.length).toBe(2);
    expect(index.pending.length).toBe(3);
    expect(index.discovered_count).toBe(7);
    expect(index.discovered_count).toBe(
      index.stores.length + index.failures.length + index.pending.length,
    );
  });

  it("carries v3-only store detail (units_report, channels_tsv_read_error, source_tree)", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index?.format_version).toBe(3);
    const [first, second] = index?.stores ?? [];
    expect(first?.source_tree).toBe("raw");
    expect(first?.derived).toBe(false);
    expect(first?.units_report?.kept_importer_unit).toBe(1);
    expect(first?.channels_tsv_read_error).toBe(false);
    expect(second?.channels_tsv_read_error).toBe(true);
  });

  it("carries v3 failure detail and pending reasons", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index?.format_version).toBe(3);
    if (index?.format_version !== 3) throw new Error("expected v3");
    expect(index.failures.find((f) => f.code === "retry_exhausted")?.detail).toContain(
      "TimeoutError",
    );
    expect(index.failures.find((f) => f.code === "not_continuous")?.detail).toBeNull();
    expect(index.pending.map((p) => p.reason).sort()).toEqual([
      "infra_failure",
      "memory_budget",
      "not_attempted",
    ]);
  });

  it("treats an unrecognized format_version as v1 (forward-compat degrade, not a reject)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 4,
      stores: [],
    });
    expect(index?.format_version).toBe(1);
  });

  it("treats an absent format_version as v1 (legacy indexes that predate the field)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [],
    });
    expect(index?.format_version).toBe(1);
  });

  it('parsePending skips a null entry and defaults a non-string reason to "unknown" (PR #278 review)', () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
      pending: [null, { path: "x", reason: 123 }],
    });
    expect(index?.format_version).toBe(3);
    if (index?.format_version !== 3) throw new Error("expected v3");
    expect(index.pending).toEqual([
      {
        path: "x",
        zarr: undefined,
        reason: "unknown",
        attempts: 0,
        last_error: null,
        last_attempt_utc: null,
      },
    ]);
  });

  it("degrades a v3 document with a missing/malformed pending array to an empty list (ADR 0005)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
    });
    expect(index?.format_version).toBe(3);
    if (index?.format_version !== 3) throw new Error("expected v3");
    expect(index.pending).toEqual([]);
    // discovered_count falls back to the producer's own sum-of-parts formula.
    expect(index.discovered_count).toBe(0);
  });

  it("falls back discovered_count to stores+failures+pending when the field is missing", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [{ path: "a.set", zarr: "a.zarr" }],
      failures: [{ path: "b.set", code: "not_continuous", reason: "x" }],
      pending: [{ path: "c.set", reason: "not_attempted", attempts: 0 }],
    });
    expect(index?.format_version).toBe(3);
    if (index?.format_version !== 3) throw new Error("expected v3");
    expect(index.discovered_count).toBe(3);
  });
});

describe("parseZarrIndex discovered_count validation (PR #278 review)", () => {
  const THREE_PARTS = {
    dataset_id: "nm000132",
    format: "nemar-zarr-index",
    format_version: 3,
    stores: [{ path: "a.set", zarr: "a.zarr" }],
    failures: [{ path: "b.set", code: "not_continuous", reason: "x" }],
    pending: [{ path: "c.set", reason: "not_attempted", attempts: 0 }],
  }; // sum of parts = 3

  it("recomputes a too-small discovered_count from the sum of parts, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = parseZarrIndex({ ...THREE_PARTS, discovered_count: 1 });
      expect(index?.format_version).toBe(3);
      if (index?.format_version !== 3) throw new Error("expected v3");
      // Must never render "1 of ... viewable" undercounting what's actually
      // reported below it -- the too-small case that motivated this fix.
      expect(index.discovered_count).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("discovered_count=1");
      expect(warn.mock.calls[0][0]).toContain("stores+failures+pending=3");
    } finally {
      warn.mockRestore();
    }
  });

  it("recomputes a zero discovered_count even though stores/failures/pending are nonempty", () => {
    // The ?? fallback in zarrCoverage/renderZarrCoveragePanel does not treat
    // 0 as "missing" -- a raw 0 here must not hide a nonempty panel.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = parseZarrIndex({ ...THREE_PARTS, discovered_count: 0 });
      expect(index?.format_version).toBe(3);
      if (index?.format_version !== 3) throw new Error("expected v3");
      expect(index.discovered_count).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("recomputes a negative discovered_count, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = parseZarrIndex({ ...THREE_PARTS, discovered_count: -5 });
      expect(index?.format_version).toBe(3);
      if (index?.format_version !== 3) throw new Error("expected v3");
      expect(index.discovered_count).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("discovered_count=-5");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when the raw discovered_count matches the computed sum", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const index = parseZarrIndex({ ...THREE_PARTS, discovered_count: 3 });
      expect(index?.format_version).toBe(3);
      if (index?.format_version !== 3) throw new Error("expected v3");
      expect(index.discovered_count).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("zarrCoverage (website#277)", () => {
  it("computes coverage from the real v1 fixture: viewable 2, failed 36, discovered null", () => {
    const index = parseZarrIndex(on008083V1);
    expect(index).not.toBeNull();
    const cov = zarrCoverage(index!);
    expect(cov.viewable).toBe(2);
    expect(cov.failed).toBe(36);
    expect(cov.pending).toBe(0);
    expect(cov.discovered).toBeNull();
    expect(Object.keys(cov.byFailureCode)).toEqual(["file_read_error"]);
    expect(cov.byFailureCode.file_read_error.length).toBe(36);
    expect(cov.byPendingReason).toEqual({});
    expect(cov.unknownPending).toBe(false);
  });

  it("computes coverage from the v3 fixture: viewable, failed, pending, discovered all reported", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index).not.toBeNull();
    const cov = zarrCoverage(index!);
    expect(cov.viewable).toBe(2);
    expect(cov.failed).toBe(2);
    expect(cov.pending).toBe(3);
    expect(cov.discovered).toBe(7);
    expect(Object.keys(cov.byFailureCode).sort()).toEqual(["not_continuous", "retry_exhausted"]);
    expect(Object.keys(cov.byPendingReason).sort()).toEqual([
      "infra_failure",
      "memory_budget",
      "not_attempted",
    ]);
    expect(cov.byPendingReason.memory_budget[0]?.path).toBe("sub-05/eeg/sub-05_task-rest_eeg.bdf");
    expect(cov.unknownPending).toBe(false);
  });

  it("flags unknownPending for a pending reason the client doesn't recognize (forward-compat)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
      pending: [{ path: "a.set", reason: "quota_exceeded", attempts: 1 }],
      discovered_count: 1,
    });
    const cov = zarrCoverage(index!);
    expect(cov.unknownPending).toBe(true);
    expect(cov.byPendingReason.quota_exceeded.length).toBe(1);
  });

  it("groups multiple failures sharing a code together, in first-seen order", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        { path: "a.set", code: "not_continuous", reason: "x" },
        { path: "b.set", code: "corrupt_or_truncated", reason: "y" },
        { path: "c.set", code: "not_continuous", reason: "x" },
      ],
    });
    const cov = zarrCoverage(index!);
    expect(Object.keys(cov.byFailureCode)).toEqual(["not_continuous", "corrupt_or_truncated"]);
    expect(cov.byFailureCode.not_continuous.map((f) => f.path)).toEqual(["a.set", "c.set"]);
  });

  it("returns 0/empty coverage for an empty document (no zarr conversion attempted)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [],
    });
    const cov = zarrCoverage(index!);
    expect(cov).toEqual({
      viewable: 0,
      failed: 0,
      pending: 0,
      discovered: null,
      byFailureCode: {},
      byPendingReason: {},
      unknownPending: false,
    });
  });

  it("does not crash or pollute the prototype when a failure code is literally '__proto__' (PR #278 review)", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      stores: [],
      failures: [
        { path: "a.set", code: "__proto__", reason: "x" },
        { path: "b.set", code: "__proto__", reason: "x" },
      ],
    });
    expect(index).not.toBeNull();
    let cov: ReturnType<typeof zarrCoverage> | undefined;
    expect(() => {
      cov = zarrCoverage(index!);
    }).not.toThrow();
    // Dot notation is deliberate here (Biome's own lint/complexity/
    // useLiteralKeys rule prefers it): on this null-prototype object it is
    // a plain property read, not the special Object.prototype accessor an
    // ordinary {} would have.
    expect(cov?.byFailureCode.__proto__).toEqual([
      {
        path: "a.set",
        zarr: undefined,
        code: "__proto__",
        reason: "x",
        detail: null,
        attempts: undefined,
      },
      {
        path: "b.set",
        zarr: undefined,
        code: "__proto__",
        reason: "x",
        detail: null,
        attempts: undefined,
      },
    ]);
    // The real prototype must be untouched -- an ordinary object built
    // elsewhere in the same process must not have inherited an array.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("does not crash when a pending reason is literally '__proto__'", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000132",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
      pending: [{ path: "a.set", reason: "__proto__", attempts: 1 }],
      discovered_count: 1,
    });
    expect(() => zarrCoverage(index!)).not.toThrow();
    const cov = zarrCoverage(index!);
    expect(cov.byPendingReason.__proto__.length).toBe(1);
    expect(cov.unknownPending).toBe(true);
  });
});

describe("unitsNoticeText (website#277 decision 4)", () => {
  it("is null when the store is absent (no report to warn about)", () => {
    expect(unitsNoticeText(null)).toBeNull();
    expect(unitsNoticeText(undefined)).toBeNull();
  });

  it("is null for a v1 store (no units_report field at all)", () => {
    expect(unitsNoticeText({ path: "a.set", zarr: "a.zarr" })).toBeNull();
  });

  it("is null when units_report is present but kept_importer_unit is 0 and no read error", () => {
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        units_report: { kept_importer_unit: 0, converted: 30 },
        channels_tsv_read_error: false,
      }),
    ).toBeNull();
  });

  it("reports the exact channel count when kept_importer_unit > 0", () => {
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        units_report: { kept_importer_unit: 1 },
      }),
    ).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 1 channel.",
    );
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        units_report: { kept_importer_unit: 3 },
      }),
    ).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 3 channels.",
    );
  });

  it("falls back to the store's total channel count when the sidecar could not be read at all", () => {
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        channels_tsv_read_error: true,
        groups: [{ name: "eeg_250hz", n_channels: 29 }],
      }),
    ).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 29 channels.",
    );
  });

  it("sums n_channels across multiple groups", () => {
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        channels_tsv_read_error: true,
        groups: [
          { name: "eeg_250hz", n_channels: 20 },
          { name: "eog_250hz", n_channels: 2 },
        ],
      }),
    ).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 22 channels.",
    );
  });

  it("degrades to a generic sentence when the read error is set but no channel count is known", () => {
    expect(
      unitsNoticeText({
        path: "a.set",
        zarr: "a.zarr",
        channels_tsv_read_error: true,
      }),
    ).toBe("Units are the file's own; the dataset's channels.tsv unit could not be adopted.");
  });

  it("matches the real v3 fixture stores end-to-end", () => {
    const index = parseZarrIndex(v3Sample);
    expect(index?.format_version).toBe(3);
    const [first, second] = index?.stores ?? [];
    expect(unitsNoticeText(first)).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 1 channel.",
    );
    expect(unitsNoticeText(second)).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 29 channels.",
    );
  });

  it("pins kept_importer_unit as the winning branch when it overlaps with channels_tsv_read_error (PR #278 review)", () => {
    // Both conditions can legitimately co-occur: the sidecar was read (so
    // units_report exists and reports SOME channels kept the importer's
    // unit) but ALSO could not be read for a different reason the producer
    // still flags. kept_importer_unit is the more precise, exact count and
    // wins over the coarser channels_tsv_read_error fallback (which sums
    // the store's total channel count, an approximation for "read entirely
    // failed"). Both groups' n_channels are deliberately large here so a
    // regression that fell through to the fallback branch would produce a
    // visibly different (much larger) number.
    const store = {
      path: "a.set",
      zarr: "a.zarr",
      units_report: { kept_importer_unit: 2 },
      channels_tsv_read_error: true,
      groups: [{ name: "eeg_250hz", n_channels: 64 }],
    };
    expect(unitsNoticeText(store)).toBe(
      "Units are the file's own; the dataset's channels.tsv unit could not be adopted for 2 channels.",
    );
  });
});
