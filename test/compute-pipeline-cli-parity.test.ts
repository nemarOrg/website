/**
 * The admin Pipelines tab explains the grid in the CLI's own words (nemar-cli ADR 0134 decision 5;
 * epic nemarOrg/nemar-cli#2324 phase 4b, website#586).
 *
 * `test/fixtures/compute/cli-help-pipeline/` is the REAL `nemar admin compute pipeline
 * status|failures --help-all` text, captured by `scripts/capture-pipeline-cli-help.mjs`. Every
 * sentence in `PIPELINE_HELP` must appear in it once whitespace is collapsed, and every filter the
 * grid's form offers must be a flag of `status`. A CLI rewording turns this red on re-capture, which
 * is the moment to reword the page too.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROGRESS_MAX_FAILURES } from "../src/lib/compute-pipeline-contract";
import { PIPELINE_HELP, failuresMeaning, stalledMeaning } from "../src/lib/compute-pipeline-labels";
import gridFixture from "./fixtures/compute/admin-pipeline-grid.json";
import index from "./fixtures/compute/cli-help-pipeline/index.json";

const dir = new URL("./fixtures/compute/cli-help-pipeline/", import.meta.url);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const status = readFileSync(new URL("status.txt", dir), "utf8");
const failures = readFileSync(new URL("failures.txt", dir), "utf8");
const statusText = collapse(status);
const failuresText = collapse(failures);

describe("the captured help", () => {
  it("names the commit it came from and is the real usage text", () => {
    expect(index.nemar_cli_commit).toMatch(/^[0-9a-f]{8}$/);
    expect(status).toContain("Usage: nemar admin compute pipeline status");
    expect(failures).toContain("Usage: nemar admin compute pipeline failures");
  });
});

describe("the page says what the CLI says", () => {
  it("contains every sentence of PIPELINE_HELP in the status help", () => {
    const sentences = [
      PIPELINE_HELP.grid,
      PIPELINE_HELP.columns,
      PIPELINE_HELP.row,
      PIPELINE_HELP.notStarted,
      PIPELINE_HELP.waiting,
      ...PIPELINE_HELP.legend,
      PIPELINE_HELP.coverage,
      PIPELINE_HELP.lag,
    ];
    const missing = sentences.filter((s) => !statusText.includes(collapse(s)));
    expect(missing).toEqual([]);
  });

  it("states stalled with the Worker's own threshold", () => {
    const minutes = gridFixture.all.body.stalled_after_seconds / 60;
    expect(statusText).toContain(collapse(stalledMeaning(minutes)));
  });

  it("states how many failures a checkpoint lists, and which recordings it leaves out", () => {
    expect(failuresText).toContain(collapse(failuresMeaning(PROGRESS_MAX_FAILURES)));
    expect(failuresText).toContain(collapse(PIPELINE_HELP.unlisted));
  });

  it("offers no filter the CLI does not have", () => {
    for (const flag of [
      "--recipe-version",
      "--executor",
      "--runner",
      "--status",
      "--dataset",
      "--after",
      "--limit",
    ]) {
      expect(status, flag).toContain(flag);
    }
  });
});
