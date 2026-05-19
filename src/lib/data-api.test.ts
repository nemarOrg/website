import { describe, expect, it } from "vitest";
import { findReadmePathInSummary, isUnpublished, outcomeValue } from "./data-api";
import type { FetchOutcome, Summary } from "./data-api";
import type { LandingPayload } from "./neuroschema";

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    dataset_id: "nm000103",
    version: "v1.0.0",
    paths: [],
    ...overrides,
  };
}

function makeLanding(overrides: Partial<LandingPayload>): LandingPayload {
  return {
    dataset_id: "on005506",
    latest: null,
    metadata_url: "/on005506/metadata.json",
    versions: [],
    ...overrides,
  };
}

describe("findReadmePathInSummary", () => {
  it("returns readme.path when present", () => {
    const s = makeSummary({ readme: { path: "README.md" }, paths: [] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });

  it("returns path from paths when readme field absent", () => {
    const s = makeSummary({ paths: ["dataset_description.json", "README.md", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });

  it("matches case-insensitively from paths", () => {
    const s = makeSummary({ paths: ["readme"] });
    expect(findReadmePathInSummary(s)).toBe("readme");
  });

  it("matches README.txt from paths", () => {
    const s = makeSummary({ paths: ["README.txt", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBe("README.txt");
  });

  it("returns null when no readme anywhere", () => {
    const s = makeSummary({ paths: ["dataset_description.json", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBeNull();
  });

  it("returns null for empty summary", () => {
    const s = makeSummary({ paths: [] });
    expect(findReadmePathInSummary(s)).toBeNull();
  });

  it("prefers readme.path over paths list", () => {
    const s = makeSummary({ readme: { path: "docs/README.md" }, paths: ["README.md"] });
    expect(findReadmePathInSummary(s)).toBe("docs/README.md");
  });

  it("falls through to paths when readme.path is absent (empty readme object)", () => {
    const s = makeSummary({ readme: {}, paths: ["README.md"] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });

  it("ignores README inside a subdirectory (BIDS treats only the root README as canonical)", () => {
    const s = makeSummary({ paths: ["sub-01/README.md", "code/README.md"] });
    expect(findReadmePathInSummary(s)).toBeNull();
  });
});

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
    // Defensive against an upstream API that emits "" instead of null for the
    // unpublished case; the OR-then-falsy check covers both.
    expect(isUnpublished(makeLanding({ latest: "" as unknown as null, versions: [] }))).toBe(true);
  });
});

describe("outcomeValue", () => {
  it("returns the parsed value when outcome is ok", () => {
    const ok: FetchOutcome<{ x: number }> = { kind: "ok", value: { x: 42 } };
    expect(outcomeValue(ok)).toEqual({ x: 42 });
  });

  it("returns null for every non-ok outcome kind", () => {
    // Pin the contract: any non-ok outcome collapses to null, regardless of
    // which specific failure mode it represents. Callers that need to
    // discriminate must inspect the outcome directly, not via this helper.
    const kinds: FetchOutcome<unknown>[] = [
      { kind: "not_found" },
      { kind: "rate_limited" },
      { kind: "upstream_error", status: 500, statusText: "Internal Server Error" },
      { kind: "timeout" },
      { kind: "network_error", message: "ECONNREFUSED" },
      { kind: "parse_error", message: "Unexpected token < in JSON at position 0" },
    ];
    for (const o of kinds) {
      expect(outcomeValue(o)).toBeNull();
    }
  });
});
