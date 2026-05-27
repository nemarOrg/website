import { describe, expect, it } from "vitest";
import bundleFixture from "../../test/fixtures/dataset-page-bundle-on005505.min.json";
import {
  bundleFieldToOutcome,
  findReadmeContentInSummary,
  findReadmePathInSummary,
  isUnpublished,
  outcomeValue,
  resolveDatasetPageStatus,
} from "./data-api";
import type { BundleField, DatasetPageBundle, FetchOutcome, Summary } from "./data-api";
import type { LandingPayload, NeuroschemaDataset } from "./neuroschema";

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

describe("findReadmeContentInSummary", () => {
  it("returns null on schema 1.0 (no content field)", () => {
    const s = makeSummary({ readme: { path: "README.md" } });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("returns content on schema 1.1 when not truncated", () => {
    const s = makeSummary({
      readme: { path: "README.md", content: "# Hello\n\nbody", truncated: false },
    });
    expect(findReadmeContentInSummary(s)).toBe("# Hello\n\nbody");
  });

  it("treats truncated:true as schema 1.0 (returns null even if content present)", () => {
    const s = makeSummary({
      readme: { path: "README.md", content: "partial markdown ...", truncated: true },
    });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("returns null for empty-string content (generator wrote a placeholder)", () => {
    const s = makeSummary({ readme: { path: "README.md", content: "" } });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("returns null when readme object is absent entirely", () => {
    const s = makeSummary({ paths: ["dataset_description.json"] });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("returns null for whitespace-only content (would render to empty HTML)", () => {
    const s = makeSummary({ readme: { path: "README.md", content: "   \n\n\t  " } });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("returns null when content is explicitly null (generator's truncation signal)", () => {
    const s = makeSummary({ readme: { path: "README.md", content: null, truncated: true } });
    expect(findReadmeContentInSummary(s)).toBeNull();
  });

  it("preserves leading whitespace inside otherwise-valid markdown", () => {
    const s = makeSummary({ readme: { path: "README.md", content: "  # Title\n\nbody" } });
    expect(findReadmeContentInSummary(s)).toBe("  # Title\n\nbody");
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
    // Exhaustiveness: this list MUST cover every non-ok kind in the
    // FetchOutcome union. If a new kind is added, an explicit case must
    // be added below — TypeScript's `satisfies` keeps the list honest.
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
  const upstream = {
    kind: "upstream_error",
    status: 503,
    statusText: "Service Unavailable",
  } as const;
  const network = { kind: "network_error", message: "ECONNREFUSED" } as const;
  const parse = { kind: "parse_error", message: "Unexpected token" } as const;
  const rate = { kind: "rate_limited" } as const;

  // Sentinel ok values — we never inspect their contents in these tests.
  const okLanding = ok({} as LandingPayload);
  const okMetadata = ok({} as NeuroschemaDataset);

  it("returns ok when both landing and metadata succeeded", () => {
    expect(resolveDatasetPageStatus(okLanding, okMetadata).kind).toBe("ok");
  });

  it("returns 404 only when both landing and metadata report not_found", () => {
    expect(resolveDatasetPageStatus(notFound, notFound).kind).toBe("not_found");
  });

  it("returns degraded when only landing is not_found (partial publish, not a typo'd URL)", () => {
    const status = resolveDatasetPageStatus(notFound, okMetadata);
    expect(status.kind).toBe("degraded");
    if (status.kind === "degraded") {
      expect(status.signal).toBe("landing");
      expect(status.outcome).toBe("not_found");
    }
  });

  it("treats metadata not_found as ok (metadata.json is optional)", () => {
    // A fresh dataset can have landing without metadata yet. Don't degrade.
    expect(resolveDatasetPageStatus(okLanding, notFound).kind).toBe("ok");
  });

  it("returns degraded when landing has any hard failure", () => {
    for (const out of [timeout, upstream, network, parse, rate]) {
      const status = resolveDatasetPageStatus(out, okMetadata);
      expect(status.kind).toBe("degraded");
      if (status.kind === "degraded") expect(status.signal).toBe("landing");
    }
  });

  it("returns degraded when metadata has any hard failure (but not not_found)", () => {
    for (const out of [timeout, upstream, network, parse, rate]) {
      const status = resolveDatasetPageStatus(okLanding, out);
      expect(status.kind).toBe("degraded");
      if (status.kind === "degraded") expect(status.signal).toBe("metadata");
    }
  });

  it("prioritises landing failure over metadata failure for the degraded signal", () => {
    // When both are non-ok, landing's failure mode is the more actionable
    // one to surface (the page can't render without it).
    const status = resolveDatasetPageStatus(timeout, upstream);
    expect(status.kind).toBe("degraded");
    if (status.kind === "degraded") {
      expect(status.signal).toBe("landing");
      expect(status.outcome).toBe("timeout");
    }
  });
});

describe("bundleFieldToOutcome", () => {
  it("returns kind=ok with the value when ok=true and data is non-null", () => {
    const field: BundleField<string> = { ok: true, data: "hello" };
    const out = bundleFieldToOutcome(field);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value).toBe("hello");
  });

  it("returns upstream_error when ok=false (data is ignored)", () => {
    const field: BundleField<string> = { ok: false, data: "stale" };
    const out = bundleFieldToOutcome(field);
    expect(out.kind).toBe("upstream_error");
    if (out.kind === "upstream_error") {
      expect(out.status).toBe(0);
      expect(out.statusText).toMatch(/bundle field ok=false/);
    }
  });

  it("returns upstream_error when ok=false and data is null", () => {
    const field: BundleField<string> = { ok: false, data: null };
    expect(bundleFieldToOutcome(field).kind).toBe("upstream_error");
  });

  it("returns upstream_error when ok=true but data is null (envelope contract violation)", () => {
    const field: BundleField<string> = { ok: true, data: null };
    expect(bundleFieldToOutcome(field).kind).toBe("upstream_error");
  });
});

describe("DatasetPageBundle shape (captured fixture)", () => {
  // Real-shape coverage. Catches a future CLI change that drops or renames a
  // top-level field, restructures the per-field envelope, or breaks the
  // schema 1.1 readme.content contract Phase 2 depends on. Re-capture from
  // `curl https://data.nemar.org/on005505/page-bundle.json?v=v1.0.0` and
  // slim per the comment at the top of the fixture if the live shape
  // legitimately evolves.
  const bundle = bundleFixture as unknown as DatasetPageBundle;

  it("carries the expected top-level keys", () => {
    expect(Object.keys(bundle).sort()).toEqual(
      [
        "catalog_row",
        "complete",
        "dataset_id",
        "enrichment_degraded",
        "landing",
        "metadata",
        "served_at",
        "summary",
        "version",
      ].sort(),
    );
    expect(typeof bundle.complete).toBe("boolean");
    expect(typeof bundle.enrichment_degraded).toBe("boolean");
  });

  it("wraps each data payload in a { ok, data } envelope", () => {
    for (const field of [bundle.landing, bundle.metadata, bundle.summary, bundle.catalog_row]) {
      expect(field).toHaveProperty("ok");
      expect(field).toHaveProperty("data");
      expect(typeof field.ok).toBe("boolean");
    }
  });

  it("lifts each envelope into the existing FetchOutcome union via the adapter", () => {
    expect(bundleFieldToOutcome(bundle.landing).kind).toBe("ok");
    expect(bundleFieldToOutcome(bundle.metadata).kind).toBe("ok");
    expect(bundleFieldToOutcome(bundle.summary).kind).toBe("ok");
    expect(bundleFieldToOutcome(bundle.catalog_row).kind).toBe("ok");
    // outcomeValue then unwraps to the raw payload — same flow the consumer uses.
    const landing = outcomeValue(bundleFieldToOutcome(bundle.landing));
    expect(landing).not.toBeNull();
    if (landing) expect(landing.dataset_id).toBe(bundle.dataset_id);
  });

  it("preserves schema 1.1 readme.content (Phase 2 fast-path dependency)", () => {
    const summary = bundle.summary.data;
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.schema_version).toBe("1.1");
    expect(summary.readme?.content).toBeTypeOf("string");
    expect((summary.readme?.content ?? "").length).toBeGreaterThan(0);
    expect(summary.readme?.truncated).toBe(false);
  });
});
