import { describe, expect, it } from "vitest";
import { isUnpublished, outcomeValue, resolveDatasetPageStatus } from "./data-api";
import type { FetchOutcome } from "./data-api";
import type { LandingPayload } from "./neuroschema";

function makeLanding(overrides: Partial<LandingPayload>): LandingPayload {
  return {
    dataset_id: "on005506",
    latest: null,
    metadata_url: "/on005506/metadata.json",
    versions: [],
    ...overrides,
  };
}

describe("isUnpublished", () => {
  it("returns true when versions is empty and latest is null", () => {
    expect(isUnpublished(makeLanding({ versions: [], latest: null }))).toBe(true);
  });

  it("returns true when latest is null even if versions somehow populated", () => {
    const v = { version: "v1.0.0", doi: null, created_at: "", manifest_url: "", browse_url: "" };
    expect(isUnpublished(makeLanding({ latest: null, versions: [v] }))).toBe(true);
  });

  it("returns true when versions is empty even if latest is set", () => {
    expect(isUnpublished(makeLanding({ latest: "v1.0.0", versions: [] }))).toBe(true);
  });

  it("returns false when a published version exists", () => {
    const v = {
      version: "v1.0.0",
      doi: "10.5281/zenodo.123",
      created_at: "",
      manifest_url: "",
      browse_url: "",
    };
    expect(isUnpublished(makeLanding({ latest: "v1.0.0", versions: [v] }))).toBe(false);
  });

  it("returns false for null landing (dataset not found is not 'unpublished')", () => {
    expect(isUnpublished(null)).toBe(false);
  });

  it("returns true when latest is an empty string", () => {
    expect(isUnpublished(makeLanding({ latest: "" as unknown as null, versions: [] }))).toBe(true);
  });
});

describe("outcomeValue", () => {
  it("returns the parsed value when outcome is ok", () => {
    const ok: FetchOutcome<{ x: number }> = { kind: "ok", value: { x: 42 } };
    expect(outcomeValue(ok)).toEqual({ x: 42 });
  });

  it("returns null for every non-ok outcome kind", () => {
    // Exhaustiveness pin: if a new kind is added to FetchOutcome, an explicit
    // case below must be added — TypeScript's `satisfies` keeps the list
    // honest.
    const kinds = [
      { kind: "not_found" },
      { kind: "rate_limited" },
      { kind: "upstream_error", status: 500, statusText: "Internal Server Error" },
      { kind: "timeout" },
      { kind: "network_error", message: "ECONNREFUSED" },
      { kind: "parse_error", message: "Unexpected token < in JSON at position 0" },
    ] satisfies Exclude<FetchOutcome<unknown>, { kind: "ok" }>[];
    for (const o of kinds) {
      expect(outcomeValue(o)).toBeNull();
    }
  });
});

describe("resolveDatasetPageStatus", () => {
  function ok<T>(value: T): FetchOutcome<T> {
    return { kind: "ok", value };
  }
  const notFound = { kind: "not_found" } as const;
  const timeout = { kind: "timeout" } as const;
  const rateLimited = { kind: "rate_limited" } as const;
  const upstream = {
    kind: "upstream_error",
    status: 503,
    statusText: "Service Unavailable",
  } as const;
  const network = { kind: "network_error", message: "ECONNREFUSED" } as const;
  const parse = { kind: "parse_error", message: "Unexpected token" } as const;

  it("returns ok when both signals resolve", () => {
    expect(resolveDatasetPageStatus(ok("L"), ok("M"))).toEqual({ kind: "ok" });
  });

  it("returns not_found only when BOTH signals report not_found", () => {
    expect(resolveDatasetPageStatus(notFound, notFound)).toEqual({ kind: "not_found" });
  });

  it("treats lone landing not_found as degraded (a partial publish, not a 404)", () => {
    const status = resolveDatasetPageStatus(notFound, ok("M"));
    expect(status.kind).toBe("degraded");
    if (status.kind === "degraded") {
      expect(status.signal).toBe("landing");
      expect(status.outcome).toBe("not_found");
    }
  });

  it("ignores lone metadata not_found (metadata is optional on the data side)", () => {
    expect(resolveDatasetPageStatus(ok("L"), notFound)).toEqual({ kind: "ok" });
  });

  it("degrades on any hard failure of landing (timeout / rate / 5xx / network / parse)", () => {
    for (const out of [timeout, rateLimited, upstream, network, parse] as const) {
      const status = resolveDatasetPageStatus(out, ok("M"));
      expect(status.kind).toBe("degraded");
      if (status.kind === "degraded") {
        expect(status.signal).toBe("landing");
        expect(status.outcome).toBe(out.kind);
      }
    }
  });

  it("degrades on any hard failure of metadata (timeout / rate / 5xx / network / parse)", () => {
    for (const out of [timeout, rateLimited, upstream, network, parse] as const) {
      const status = resolveDatasetPageStatus(ok("L"), out);
      expect(status.kind).toBe("degraded");
      if (status.kind === "degraded") {
        expect(status.signal).toBe("metadata");
        expect(status.outcome).toBe(out.kind);
      }
    }
  });

  it("landing failure wins over metadata failure (logged first)", () => {
    const status = resolveDatasetPageStatus(timeout, parse);
    expect(status.kind).toBe("degraded");
    if (status.kind === "degraded") {
      expect(status.signal).toBe("landing");
      expect(status.outcome).toBe("timeout");
    }
  });
});
