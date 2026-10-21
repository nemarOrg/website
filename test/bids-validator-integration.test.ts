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
import { isValidationReport } from "../src/lib/bids-validation/client";
import {
  applyGate,
  errorLocations,
  isSchemaDownloadFailure,
  judge,
} from "../src/lib/bids-validation/gate";
import {
  type RawValidationResult,
  type ValidationReport,
  type WorkerFileEntry,
  toReport,
  validatorOptions,
  withRelativePaths,
} from "../src/lib/bids-validation/protocol";
import { groupIssues } from "../src/lib/bids-validation/report";
import { verdictWords } from "../src/lib/bids-validation/wording";
import { toDroppedFile } from "../src/lib/upload-client";
import pin from "../validator-version.json";
import { type Bytes, closedLocalOrigin, nodeFs, repoPath, serveStatus } from "./node";

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
  const report = toReport(await bundle.validate(tree, validatorOptions()));
  // Every report these tests get is held to the check the page makes of a worker's answer, after
  // the structured clone a message goes through, so the check cannot drift from what is sent.
  expect(isValidationReport(structuredClone(report)), "a report the worker could send").toBe(true);
  return report;
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

/**
 * Run `run` with every request the validator makes through `fetch` sent to `origin` instead, by
 * the real `fetch`. The validator asks for a schema at a fixed GitHub URL, which a test must not
 * depend on; this keeps the real client, the real request and a real answer (or a real refusal to
 * connect), and changes only who is on the other end. Returns the URLs the validator asked for.
 */
async function withSchemaHostAt<T>(
  origin: string,
  run: () => Promise<T>,
): Promise<{ result: T; asked: string[] }> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return real(`${origin}/schema.xml`, init);
  }) as typeof fetch;
  try {
    return { result: await run(), asked };
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
    // `judge` is what the page calls with a finished run: the pointer lookup, then the gate.
    const entries = drop(withPointer);
    const report = await validate(entries);
    const verdict = await judge(report.issues, entries);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.annexSkipped).toHaveLength(2);
    expect(verdict.annexSkipped.map((issue) => issue.location)).toEqual([
      "/participants.tsv",
      "/participants.tsv",
    ]);
  });

  it("is told apart from a real table of the same name, which `judge` does not let through", async () => {
    const entries = drop(variant());
    const report = await validate(entries);
    expect((await judge(report.issues, entries)).annexSkipped).toEqual([]);
  });

  it("stops the upload when nothing says the file is a pointer", async () => {
    // The same two errors, with the pointer rule not applied: what an ordinary broken table gets.
    const report = await validate(drop(withPointer));
    expect(applyGate(report.issues, new Set()).blocking).toHaveLength(2);
  });
});

describe("a file BIDS does not name, and the .bidsignore that lists it", () => {
  const bytes = (text: string): Bytes => new TextEncoder().encode(text);
  const stray = bytes("notes about the recording\n");
  const errorsOf = (report: ValidationReport) =>
    report.issues.filter((issue) => issue.severity === "error");
  /** A drop of `files` after the dropzone has left out what it leaves out. */
  const throughTheDropzone = (files: ReadonlyMap<string, Bytes>): WorkerFileEntry[] =>
    [...files].flatMap(([path, content]) => {
      const dropped = toDroppedFile(new File([content], path.split("/").pop() as string), path);
      return dropped ? [{ path: dropped.path, file: dropped.file }] : [];
    });

  it("stops the upload: a file that is not in BIDS is an error on that file", async () => {
    const report = await validate(drop(variant({ "foo.xyz": stray })));
    expect(errorsOf(report).map((issue) => `${issue.code}@${issue.location}`)).toEqual([
      "NOT_INCLUDED@/foo.xyz",
    ]);
    expect(applyGate(report.issues, new Set()).blocking).toHaveLength(1);
  });

  it("is let through when .bidsignore lists the file, because the validator reads that file", async () => {
    const files = variant({ "foo.xyz": stray, ".bidsignore": bytes("foo.xyz\n") });
    const report = await validate(drop(files));
    expect(errorsOf(report)).toEqual([]);
    expect(applyGate(report.issues, new Set()).blocking).toEqual([]);
  });

  it("is let through when the drop is what the dropzone keeps, which includes .bidsignore", async () => {
    // Real files through the rule the dropzone applies to every file of a drop, by drag and drop
    // and from the file input alike (`toDroppedFile`). The dotfiles that are not .bidsignore are
    // left out, and the validator never needed them.
    const files = variant({
      "foo.xyz": stray,
      ".bidsignore": bytes("foo.xyz\n"),
      ".DS_Store": bytes("junk"),
      ".gitattributes": bytes("* text=auto\n"),
    });
    const kept = throughTheDropzone(files);
    expect(kept.map((entry) => entry.path)).toContain(".bidsignore");
    expect(kept.map((entry) => entry.path)).not.toContain(".DS_Store");
    expect(kept.map((entry) => entry.path)).not.toContain(".gitattributes");
    expect(errorsOf(await validate(kept))).toEqual([]);
  });

  it("is stopped again when .bidsignore is missing from the drop, as it was when dotfiles were skipped", async () => {
    const kept = throughTheDropzone(variant({ "foo.xyz": stray }));
    expect(errorsOf(await validate(kept)).map((issue) => issue.code)).toEqual(["NOT_INCLUDED"]);
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

/**
 * `HED_ERROR` with sub-code `SCHEMA_LOAD_FAILED` is seven conditions of the validator under one
 * name, and the page lets exactly one of them through: the browser's request for a schema got no
 * answer. Each of these runs the real bundle on a real dataset (the HED overlay, with
 * `dataset_description.json` changed as the name says) and asks the page's gate what it does.
 *
 * The cases that need a schema from GitHub send the request to a real server on this machine, or
 * to a port nothing listens on, so no test depends on GitHub being reachable or on a version
 * number staying free. The validator's own words for each are asserted, because the gate reads
 * them: a release that rewords one fails here, and not quietly in front of a person.
 */
describe("a HED dataset whose schema cannot be had", () => {
  const events = "sub-01/eeg/sub-01_task-rest_events.tsv";
  const description = JSON.parse(
    new TextDecoder().decode(MINIMAL.get("dataset_description.json")),
  ) as Record<string, unknown>;
  /** The HED dataset, with `HEDVersion` as given, or with none when it is `undefined`. */
  const named = (hedVersion?: unknown): Map<string, Bytes> =>
    variant({
      "dataset_description.json": new TextEncoder().encode(
        JSON.stringify(
          hedVersion === undefined ? description : { ...description, HEDVersion: hedVersion },
        ),
      ),
      [events]: HED.get("sub-01_task-rest_events.tsv") as Bytes,
    });
  const errorsOf = (report: ValidationReport) =>
    report.issues.filter((issue) => issue.severity === "error");
  const SCHEMA_URL_9_9_9 =
    "https://raw.githubusercontent.com/hed-standard/hed-schemas/refs/heads/main/standard_schema/hedxml/HED9.9.9.xml";

  it("is stopped when it has HED columns and no HEDVersion, without any request", async () => {
    const { result: report, urls } = await recordingFetches(() => validate(drop(named())));
    const errors = errorsOf(report);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "HED_ERROR", subCode: "SCHEMA_LOAD_FAILED" });
    expect(errors[0].location).toBe(`/${events}`);
    expect(errors[0].issueMessage).toContain("No valid HED schema specification was supplied.");

    const verdict = applyGate(report.issues, new Set());
    expect(verdict.blocking).toEqual(errors);
    expect(verdict.schemaDownloadFailed).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("is stopped when the specification is not valid, without any request", async () => {
    const { result: report, urls } = await recordingFetches(() =>
      validate(drop(named("a:b:8.3.0"))),
    );
    const errors = errorsOf(report);
    expect(errors).toHaveLength(1);
    expect(errors[0].issueMessage).toContain(
      "The supplied HED schema specification is invalid. Specification: a:b:8.3.0.",
    );
    expect(applyGate(report.issues, new Set()).blocking).toEqual(errors);
    expect(urls).toEqual([]);
  });

  it("is stopped when two library schemas cannot be merged, without any request", async () => {
    const { result: report, urls } = await recordingFetches(() =>
      validate(drop(named(["score_1.2.0", "score_2.0.0"]))),
    );
    const errors = errorsOf(report);
    expect(errors).toHaveLength(1);
    expect(errors[0].issueMessage).toContain("Could not merge lazy partnered schemas");
    expect(applyGate(report.issues, new Set()).blocking).toEqual(errors);
    expect(urls).toEqual([]);
  });

  it("is not let through by a HEDVersion that quotes the validator's download wording", async () => {
    const quoted = 'Could not load HED schema "x" from remote repository - "y';
    const report = await validate(drop(named(quoted)));
    const hed = errorsOf(report).filter((issue) => issue.code === "HED_ERROR");
    expect(hed).toHaveLength(1);
    expect(hed[0].issueMessage).toContain(`Specification: ${quoted}`);
    expect(isSchemaDownloadFailure(hed[0])).toBe(false);
    expect(applyGate(report.issues, new Set()).blocking).toContainEqual(hed[0]);
  });

  it("is stopped when GitHub answers 404 for the version, which is a version that is not there", async () => {
    const server = await serveStatus(404, "404: Not Found");
    try {
      const { result: report, asked } = await withSchemaHostAt(server.origin, () =>
        validate(drop(named("9.9.9"))),
      );
      expect(asked).toEqual([SCHEMA_URL_9_9_9]);
      const errors = errorsOf(report);
      expect(errors).toHaveLength(1);
      expect(errors[0].issueMessage).toContain("from remote repository");
      expect(errors[0].issueMessage).toContain("HTTP status code 404 Not Found");
      expect(isSchemaDownloadFailure(errors[0])).toBe(false);

      const verdict = applyGate(report.issues, new Set());
      expect(verdict.blocking).toEqual(errors);
      expect(verdict.schemaDownloadFailed).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("is stopped when the server answers with an error, whatever the status", async () => {
    const server = await serveStatus(503, "unavailable");
    try {
      const { result: report } = await withSchemaHostAt(server.origin, () =>
        validate(drop(named("9.9.9"))),
      );
      const errors = errorsOf(report);
      expect(errors).toHaveLength(1);
      expect(errors[0].issueMessage).toContain("HTTP status code 503 Service Unavailable");
      expect(applyGate(report.issues, new Set()).blocking).toEqual(errors);
    } finally {
      await server.close();
    }
  });

  it("is let through, and told its HED annotations were not checked, when the request gets no answer", async () => {
    const { result: report, asked } = await withSchemaHostAt(await closedLocalOrigin(), () =>
      validate(drop(named("9.9.9"))),
    );
    expect(asked).toEqual([SCHEMA_URL_9_9_9]);
    const errors = errorsOf(report);
    expect(errors).toHaveLength(1);
    // Node's own words for a refused connection; Chrome's are "Failed to fetch" (`gate.test.ts`).
    expect(errors[0].issueMessage).toContain('from remote repository - "fetch failed".');
    expect(isSchemaDownloadFailure(errors[0])).toBe(true);

    const verdict = applyGate(report.issues, new Set());
    expect(verdict.blocking).toEqual([]);
    expect(verdict.schemaDownloadFailed).toEqual(errors);

    const words = verdictWords({
      blocking: verdict.blocking.length,
      warnings: verdict.warnings.length + verdict.schemaDownloadFailed.length,
      annexSkipped: verdict.annexSkipped.length,
      schemaDownloadFailed: verdict.schemaDownloadFailed.length,
    });
    expect(words.tone).toBe("unchecked");
    expect(words.headline).toBe("The HED annotations were not checked.");
    expect(`${words.headline} ${words.detail} ${words.note}`).not.toMatch(/no bids errors found/i);
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
