import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseZarrIndex,
  prefetchZarrStoreMetadata,
  zarrAvailablePaths,
  zarrFailureReasonByPath,
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
