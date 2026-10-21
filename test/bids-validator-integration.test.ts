/**
 * The committed validator, run on real datasets (website ADR 0028).
 *
 * This loads `public/vendor/bids-validator/<pin>/bids-validator-worker.js`, the very bytes the
 * browser's worker runs, and does what the worker does with it: wrap the files the way a drop
 * delivers them (`withRelativePaths`), build the tree (`fileListToTree`), validate with the options
 * the repository check uses (`validatorOptions`), and flatten the result (`toReport`). Then it
 * asks what the page asks: which findings stop the upload (`applyGate`), and how they read
 * (`groupIssues`). What it cannot do is run a worker, which Node has no `Worker` for; the worker
 * wiring is the thin message loop in `scripts/bids-validator-worker.ts`.
 *
 * The datasets are real files under `test/fixtures/bids-validation/` (see the README there), and
 * what is asserted is what the validator says about them, not what a stand-in would say. A
 * finding that changes with a validator release makes a test here fail, which is the point: a bump
 * is a change in what people are told, and it should be looked at.
 */

import { describe, expect, it } from "vitest";
import { applyGate, errorLocations, findAnnexPointers } from "../src/lib/bids-validation/gate";
import {
  type RawValidationResult,
  type ValidationReport,
  type WorkerFileEntry,
  toReport,
  validatorOptions,
  withRelativePaths,
} from "../src/lib/bids-validation/protocol";
import { groupIssues } from "../src/lib/bids-validation/report";
import pin from "../validator-version.json";
import { type Bytes, nodeFs, repoPath } from "./node";

interface Bundle {
  fileListToTree(files: File[]): Promise<unknown>;
  validate(
    tree: unknown,
    options: ReturnType<typeof validatorOptions>,
  ): Promise<RawValidationResult>;
}

const fs = await nodeFs();
const FIXTURES = "test/fixtures/bids-validation";
const bundlePath = repoPath(`public/vendor/bids-validator/${pin.version}/bids-validator-worker.js`);
const bundle = (await import(/* @vite-ignore */ `file://${bundlePath}`)) as Bundle;

/** Every file of a fixture directory, by path relative to it. */
function readDirectory(relative: string, prefix = ""): Map<string, Bytes> {
  const files = new Map<string, Bytes>();
  for (const name of fs.readdirSync(repoPath(`${relative}/${prefix}`.replace(/\/$/, ""))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(repoPath(`${relative}/${path}`)).isDirectory()) {
      for (const [inner, bytes] of readDirectory(relative, path)) files.set(inner, bytes);
    } else {
      files.set(path, fs.readFileSync(repoPath(`${relative}/${path}`)));
    }
  }
  return files;
}

const MINIMAL = readDirectory(`${FIXTURES}/bids-minimal`);
const POINTER = readDirectory(`${FIXTURES}/annex-pointer`);
const HED = readDirectory(`${FIXTURES}/hed`);

/** A drop of `files`, as the dropzone hands it over: a `File` and a path, no relative path set. */
function drop(files: ReadonlyMap<string, Bytes>): WorkerFileEntry[] {
  return [...files].map(([path, bytes]) => ({
    path,
    file: new File([bytes], path.split("/").pop() as string),
  }));
}

/** What the worker does between receiving a drop and answering. */
async function validate(entries: readonly WorkerFileEntry[]): Promise<ValidationReport> {
  const tree = await bundle.fileListToTree(withRelativePaths(entries));
  return toReport(await bundle.validate(tree, validatorOptions()));
}

/**
 * Run `run` and report every request it made through `fetch`. The requests are let through, so one
 * that should not happen is seen and not prevented: a recording of what the validator does, with
 * nothing standing in for it.
 */
async function recordingFetches<T>(run: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return real(input, init);
  }) as typeof fetch;
  try {
    return { result: await run(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

/** The dataset with some of its files replaced, or left out. */
function variant(
  replace: Record<string, Bytes> = {},
  leaveOut: readonly string[] = [],
): Map<string, Bytes> {
  const files = new Map(MINIMAL);
  for (const path of leaveOut) files.delete(path);
  for (const [path, bytes] of Object.entries(replace)) files.set(path, bytes);
  return files;
}

const countBy = (values: readonly string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});

describe("the committed bundle", () => {
  it("exports the two functions the worker uses, and nothing else", () => {
    expect(Object.keys(bundle).sort()).toEqual(["fileListToTree", "validate"]);
  });
});

describe("a valid dataset", () => {
  it("has no errors, only the warnings this release gives it", async () => {
    const report = await validate(drop(MINIMAL));
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(countBy(report.issues.map((issue) => issue.code))).toMatchObject({
      TOO_FEW_AUTHORS: 1,
      JSON_KEY_RECOMMENDED: 3,
    });
    expect(Object.keys(countBy(report.issues.map((issue) => issue.code))).sort()).toEqual([
      "JSON_KEY_RECOMMENDED",
      "SIDECAR_KEY_RECOMMENDED",
      "TOO_FEW_AUTHORS",
    ]);
    expect(
      report.issues
        .filter((issue) => issue.code === "JSON_KEY_RECOMMENDED")
        .map((issue) => issue.subCode)
        .sort(),
    ).toEqual(["GeneratedBy", "HEDVersion", "SourceDatasets"]);
  });

  it("reads the dataset's own summary out of the files", async () => {
    const { summary } = await validate(drop(MINIMAL));
    expect(summary).toMatchObject({
      totalFiles: 7,
      subjectCount: 1,
      sessionCount: 0,
      tasks: ["rest"],
      modalities: ["EEG"],
      dataTypes: ["eeg"],
    });
    // The schema the committed bundle ships is the one its provenance says it was built with.
    const provenance = JSON.parse(
      fs.readFileSync(
        repoPath(`public/vendor/bids-validator/${pin.version}/provenance.json`),
        "utf8",
      ),
    ) as { schemaVersion: string };
    expect(summary.schemaVersion).toBe(provenance.schemaVersion);
  });

  it("is told its files' paths as the dataset's, not as the drop's", async () => {
    // `withRelativePaths` invents a folder and the validator removes it; if either half were
    // wrong, every location here would start with that folder, or no file would be found.
    const report = await validate(drop(MINIMAL));
    const locations = report.issues.map((issue) => issue.location ?? "");
    expect(locations).toContain("/dataset_description.json");
    expect(locations).toContain("/sub-01/eeg/sub-01_task-rest_eeg.edf");
    expect(locations.filter((location) => location.startsWith("/dataset/"))).toEqual([]);
  });

  it("is read through the same wrapper whether or not the files carry a relative path", async () => {
    // A `<input webkitdirectory>` file already has one; the wrapper must not trip on it.
    const entries = drop(MINIMAL).map(({ path, file }) => {
      Object.defineProperty(file, "webkitRelativePath", { value: `picked/${path}` });
      return { path, file };
    });
    expect((await validate(entries)).summary.totalFiles).toBe(7);
  });

  it("is grouped with descriptions that are plain text", async () => {
    const report = await validate(drop(MINIMAL));
    const groups = groupIssues(report.issues, report.codeMessages);
    expect(groups.map((group) => group.severity)).toEqual(["warning", "warning", "warning"]);
    for (const group of groups) {
      expect(group.description).not.toBe("");
      expect(group.description).not.toContain("](");
      expect(group.description).not.toContain("SPEC_ROOT");
    }
  });

  it("lets the upload through", async () => {
    const report = await validate(drop(MINIMAL));
    const verdict = applyGate(report.issues, new Set());
    expect(verdict.blocking).toEqual([]);
    expect(verdict.warnings.length).toBe(report.issues.length);
  });
});

describe("a dataset with an error", () => {
  it("stops the upload when dataset_description.json is missing", async () => {
    const report = await validate(drop(variant({}, ["dataset_description.json"])));
    const errors = report.issues.filter((issue) => issue.severity === "error");
    expect(errors).toEqual([
      {
        severity: "error",
        code: "MISSING_DATASET_DESCRIPTION",
        affects: ["/dataset_description.json"],
      },
    ]);
    expect(applyGate(report.issues, new Set()).blocking).toHaveLength(1);
    // The error names the file it expected, not a file there: nothing to read as a pointer.
    expect(errorLocations(report.issues)).toEqual([]);
  });

  it("groups it first, with the file it is about", async () => {
    const report = await validate(drop(variant({}, ["dataset_description.json"])));
    const [first] = groupIssues(report.issues, report.codeMessages);
    expect(first).toMatchObject({
      severity: "error",
      code: "MISSING_DATASET_DESCRIPTION",
      count: 1,
      items: [{ path: "/dataset_description.json" }],
    });
  });
});

describe("a dataset with a git-annex pointer where a table should be", () => {
  const withPointer = variant({
    "participants.tsv": POINTER.get("participants.tsv") as Bytes,
  });

  it("is reported errors on the pointer file", async () => {
    const report = await validate(drop(withPointer));
    const errors = report.issues.filter((issue) => issue.severity === "error");
    expect(errors.map((issue) => `${issue.code}@${issue.location}`).sort()).toEqual([
      "PARTICIPANT_ID_MISMATCH@/participants.tsv",
      "TSV_COLUMN_MISSING@/participants.tsv",
    ]);
  });

  it("is let through, as the repository check lets it through", async () => {
    const entries = drop(withPointer);
    const report = await validate(entries);
    const byLocation = new Map(entries.map(({ path, file }) => [`/${path}`, file]));
    const pointers = await findAnnexPointers(errorLocations(report.issues), (location) =>
      byLocation.get(location),
    );
    expect([...pointers]).toEqual(["/participants.tsv"]);

    const verdict = applyGate(report.issues, pointers);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.annexSkipped).toHaveLength(2);
  });

  it("stops the upload when nothing says the file is a pointer", async () => {
    // The same two errors, with the pointer rule not applied: what an ordinary broken table gets.
    const report = await validate(drop(withPointer));
    expect(applyGate(report.issues, new Set()).blocking).toHaveLength(2);
  });
});

describe("a HED dataset", () => {
  const events = "sub-01/eeg/sub-01_task-rest_events.tsv";
  const hedFiles = (eventsFile: string) =>
    variant({
      "dataset_description.json": HED.get("dataset_description.json") as Bytes,
      [events]: HED.get(eventsFile) as Bytes,
    });

  it("is validated against the schema it ships, with no request to anywhere", async () => {
    const { result: report, urls } = await recordingFetches(() =>
      validate(drop(hedFiles("sub-01_task-rest_events.tsv"))),
    );
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("is told about a tag that is not in that schema, which stops the upload", async () => {
    const { result: report, urls } = await recordingFetches(() =>
      validate(drop(hedFiles("sub-01_task-rest_events-invalid.tsv"))),
    );
    const errors = report.issues.filter((issue) => issue.severity === "error");
    expect(errors.map((issue) => issue.code)).toEqual(["HED_ERROR"]);
    expect(errors[0].location).toBe(`/${events}`);
    expect(applyGate(report.issues, new Set()).blocking).toHaveLength(1);
    expect(urls).toEqual([]);
  });
});

describe("the request recorder the privacy checks rely on", () => {
  it("sees a request when one is made, so an empty list means none was", async () => {
    // A data: URL is fetched without a network, and the recorder lets it through like any other.
    const { result, urls } = await recordingFetches(async () =>
      (await fetch("data:text/plain,hello")).text(),
    );
    expect(urls).toEqual(["data:text/plain,hello"]);
    expect(result).toBe("hello");
  });
});

describe("a dataset that needs no schema from anywhere", () => {
  it("makes no request at all", async () => {
    const { urls } = await recordingFetches(() => validate(drop(MINIMAL)));
    expect(urls).toEqual([]);
  });
});
