import { describe, expect, it } from "vitest";
import on008083V1 from "../../test/fixtures/zarr/on008083-index-v1.json";
import v3Sample from "../../test/fixtures/zarr/v3-sample-index.json";
import { bidsRowId } from "./bids-tree";
import { renderZarrCoveragePanel } from "./render-zarr-coverage";
import { parseZarrIndex } from "./zarr-index";

describe("renderZarrCoveragePanel — real v1 fixture (on008083)", () => {
  const index = parseZarrIndex(on008083V1);
  if (!index) throw new Error("fixture failed to parse");
  const html = renderZarrCoveragePanel(index);

  it("reports M = stores + failures (v1 has no discovered_count)", () => {
    // 2 stores + 36 failures = 38.
    expect(html).toContain("<strong>2</strong> of <strong>38</strong> recordings viewable");
  });

  it("says pending counts are not reported by this index version", () => {
    expect(html).toContain("Pending counts are not reported by this index version.");
  });

  it("groups all 36 failures under the single file_read_error code, with its viewer-safe reason", () => {
    expect(html).toContain("36 recordings failed");
    expect(html).toContain("<code>file_read_error</code>");
    expect(html).toContain("This recording could not be prepared for viewing.");
  });

  it("has no pending section at all (v1 never reports pending)", () => {
    expect(html).not.toContain("pending");
  });

  it("links a failed recording to its BIDS row anchor", () => {
    const path = "sub-001/ses-01/eeg/sub-001_ses-01_task-HierPrior_eeg.edf";
    expect(html).toContain(`href="#${bidsRowId(path)}"`);
    expect(html).toContain(`data-jump-path="${path}"`);
  });

  it("omits the detail disclosure when a v1 failure carries none", () => {
    // v1 failures parse with detail: null -- no <details class="zcov__detail">.
    expect(html).not.toContain("zcov__detail");
  });
});

describe("renderZarrCoveragePanel — v3 fixture (schema-valid, with pending)", () => {
  const index = parseZarrIndex(v3Sample);
  if (!index) throw new Error("fixture failed to parse");
  const html = renderZarrCoveragePanel(index);

  it("reports M = discovered_count (7), not stores+failures", () => {
    expect(html).toContain("<strong>2</strong> of <strong>7</strong> recordings viewable");
  });

  it("does not say pending is unreported (v3 does report it)", () => {
    expect(html).not.toContain("Pending counts are not reported");
  });

  it("groups the 2 failures by their distinct codes", () => {
    expect(html).toContain("2 recordings failed");
    expect(html).toContain("<code>not_continuous</code>");
    expect(html).toContain("<code>retry_exhausted</code>");
  });

  it("shows a detail disclosure for the failure that carries one", () => {
    expect(html).toContain("zcov__detail");
    expect(html).toContain("TimeoutError: S3 GET timed out after 60s");
  });

  it("groups the 3 pending recordings by reason, with attempt counts", () => {
    expect(html).toContain("3 recordings pending");
    expect(html).toContain("<code>infra_failure</code>");
    expect(html).toContain("<code>memory_budget</code>");
    expect(html).toContain("<code>not_attempted</code>");
    expect(html).toContain("(2 attempts)"); // sub-04, infra_failure
    expect(html).toContain("(1 attempt)"); // sub-05, memory_budget
    expect(html).toContain("(0 attempts)"); // sub-06, not_attempted
  });

  it("links a pending recording to its BIDS row anchor", () => {
    const path = "sub-05/eeg/sub-05_task-rest_eeg.bdf";
    expect(html).toContain(`href="#${bidsRowId(path)}"`);
  });

  it("does not warn about an unrecognized pending reason (all three are known)", () => {
    expect(html).not.toContain("doesn't recognize yet");
  });
});

describe("renderZarrCoveragePanel — edge cases", () => {
  it("returns empty string when the dataset has no Zarr data at all", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000001",
      format: "nemar-zarr-index",
      stores: [],
    });
    expect(index).not.toBeNull();
    expect(renderZarrCoveragePanel(index!)).toBe("");
  });

  it("reports 100% coverage with no failed/pending sections when everything converted", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000001",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [{ path: "a.set", zarr: "a.zarr" }],
      failures: [],
      pending: [],
      discovered_count: 1,
    });
    const html = renderZarrCoveragePanel(index!);
    expect(html).toContain("<strong>1</strong> of <strong>1</strong> recordings viewable");
    expect(html).not.toContain("zcov__group");
  });

  it("flags an unrecognized pending reason with the forward-compat note", () => {
    const index = parseZarrIndex({
      dataset_id: "nm000001",
      format: "nemar-zarr-index",
      format_version: 3,
      stores: [],
      failures: [],
      pending: [{ path: "a.set", reason: "quota_exceeded", attempts: 1 }],
      discovered_count: 1,
    });
    const html = renderZarrCoveragePanel(index!);
    expect(html).toContain("doesn't recognize yet");
    expect(html).toContain("<code>quota_exceeded</code>");
  });
});
