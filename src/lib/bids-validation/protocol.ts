/**
 * What the upload page and the validator worker say to each other, and the two conversions the
 * worker makes: dropped files into the `File` list the validator reads, and a validator result
 * into plain data a message can carry (website ADR 0028).
 *
 * **This file imports nothing at runtime, and every relative import it ever gains must spell its
 * extension (`./x.ts`).** Deno bundles it into the worker (`scripts/vendor-bids-validator.ts`), and
 * Deno resolves neither extensionless specifiers nor `node_modules`. The page imports it too, so
 * what the worker sends and what the page reads are one declaration. Changing it changes the
 * committed worker: re-run the vendor script (a test fails until you do).
 */

/** Severity as the validator spells it. `ignore` is only ever set by a config file, which the
 *  page never passes, but it is part of the validator's type and is dropped everywhere here. */
export type IssueSeverity = "error" | "warning" | "ignore";

/** One finding, trimmed to what the page shows and gates on. */
export interface ReportIssue {
  readonly severity: IssueSeverity;
  readonly code: string;
  readonly subCode?: string;
  /** Dataset-relative path with a leading slash, the shape the repository check compares on. */
  readonly location?: string;
  /** Set instead of `location` by the checks that are about a file that is not there. */
  readonly affects?: readonly string[];
  readonly issueMessage?: string;
  readonly suggestion?: string;
  readonly rule?: string;
}

/** The validator's own tally of what it read. Counts, not lists: a dataset can have thousands of
 *  subjects and the page shows one number for each. */
export interface ReportSummary {
  readonly totalFiles: number;
  readonly size: number;
  readonly subjectCount: number;
  readonly sessionCount: number;
  readonly tasks: readonly string[];
  readonly modalities: readonly string[];
  readonly dataTypes: readonly string[];
  /** The BIDS schema the rules came from, as the validator reports it. */
  readonly schemaVersion: string;
}

export interface ValidationReport {
  readonly issues: readonly ReportIssue[];
  /** Issue code to the validator's description of it. Markdown; `plainText` in `report.ts`. */
  readonly codeMessages: Readonly<Record<string, string>>;
  readonly summary: ReportSummary;
}

/** A dropped file and where it sits in the dataset (no leading slash, root already stripped). */
export interface WorkerFileEntry {
  readonly path: string;
  readonly file: File;
}

export type WorkerRequest = {
  readonly type: "validate";
  readonly entries: readonly WorkerFileEntry[];
};

export type WorkerResponse =
  | { readonly type: "phase"; readonly phase: "tree" | "validate"; readonly fileCount: number }
  | { readonly type: "result"; readonly report: ValidationReport }
  | { readonly type: "failure"; readonly name: string; readonly message: string };

/**
 * The first path segment of `webkitRelativePath` is the folder the person picked, and the
 * validator's browser reader cuts it off (`substring(indexOf("/"))`). A dropped `File` has no such
 * property, so the worker invents the folder and the validator removes it again.
 */
const ROOT_DIRECTORY = "dataset";

/**
 * The `File` list `fileListToTree` expects: each file with the `webkitRelativePath` an
 * `<input webkitdirectory>` would have given it.
 *
 * A drag-and-drop walk (`walkDataTransferItems`) yields `File`s whose `webkitRelativePath` is the
 * empty string, and the property is read-only, so each file is wrapped in a new `File` over the
 * same bytes (a `File` built from a `File` reads lazily; nothing is copied) and the property is
 * defined on the wrapper. The caller's files are never touched.
 */
export function withRelativePaths(entries: readonly WorkerFileEntry[]): File[] {
  return entries.map(({ path, file }) => {
    const wrapper = new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
    Object.defineProperty(wrapper, "webkitRelativePath", { value: `${ROOT_DIRECTORY}/${path}` });
    return wrapper;
  });
}

/**
 * The options `validate` runs with: the ones the repository check runs with.
 *
 * That check is `deno run -A jsr:@bids/validator@<pin> . --json --ignoreWarnings` in
 * `nemarDatasets/.github` (`run-bids-validation.yml`), so every other option is the command line's
 * default. `maxRows` is the default of `--max-rows`: the validator reads at most that many rows of
 * each table, which is also what keeps a table of a million events from stalling the tab.
 *
 * Warnings are NOT dropped here, unlike the check, because the page lists them. They never gate.
 * `schema` is left unset on purpose: unset means the schema bundled in the validator, and a value
 * would make it fetch one from the network.
 */
export function validatorOptions(): {
  datasetPath: string;
  debug: "ERROR";
  datasetTypes: string[];
  blacklistModalities: string[];
  maxRows: number;
} {
  return {
    datasetPath: "/",
    debug: "ERROR",
    datasetTypes: [],
    blacklistModalities: [],
    maxRows: 1000,
  };
}

/** What `validate` returns, as far as this file reads it. The real type lives in the package. */
export interface RawValidationResult {
  readonly issues: {
    readonly issues: readonly {
      readonly code: string;
      readonly subCode?: string;
      readonly severity?: string;
      readonly location?: string;
      readonly affects?: string[];
      readonly issueMessage?: string;
      readonly suggestion?: string;
      readonly rule?: string;
    }[];
    readonly codeMessages: ReadonlyMap<string, string>;
  };
  readonly summary: {
    readonly totalFiles: number;
    readonly size: number;
    readonly subjects: readonly string[];
    readonly sessions: readonly string[];
    readonly tasks: readonly string[];
    readonly modalities: readonly string[];
    readonly dataTypes: readonly string[];
    readonly schemaVersion: string;
  };
}

function severityOf(value: string | undefined): IssueSeverity {
  // The validator defaults a missing severity to error (`DatasetIssues.add`), so this does too.
  return value === "warning" || value === "ignore" ? value : "error";
}

/** Plain data only (no class instances, no `Map`, no `undefined` keys) so it survives a message. */
export function toReport(result: RawValidationResult): ValidationReport {
  const issues: ReportIssue[] = result.issues.issues.map((issue) => ({
    severity: severityOf(issue.severity),
    code: issue.code,
    ...(issue.subCode ? { subCode: issue.subCode } : {}),
    ...(issue.location ? { location: issue.location } : {}),
    ...(issue.affects?.length ? { affects: [...issue.affects] } : {}),
    ...(issue.issueMessage ? { issueMessage: issue.issueMessage } : {}),
    ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
    ...(issue.rule ? { rule: issue.rule } : {}),
  }));
  const { summary } = result;
  return {
    issues,
    codeMessages: Object.fromEntries(result.issues.codeMessages),
    summary: {
      totalFiles: summary.totalFiles,
      size: summary.size,
      subjectCount: summary.subjects.length,
      sessionCount: summary.sessions.length,
      tasks: [...summary.tasks],
      modalities: [...summary.modalities],
      dataTypes: [...summary.dataTypes],
      schemaVersion: summary.schemaVersion,
    },
  };
}

/** A plain object as text, for a thrown value that is not an `Error`. */
function stringify(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    // A value that refers to itself cannot be written out; say what it is instead of nothing.
    return Object.prototype.toString.call(value);
  }
}

/**
 * A thrown value as the two strings a message carries. The validator throws plain objects for a
 * few of its own refusals (`throw { code: "FILE_READ", location }`), and `String` of one of those
 * is `[object Object]`, which tells a person nothing.
 */
export function describeFailure(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (typeof error === "object" && error !== null) {
    return { name: "Error", message: stringify(error) };
  }
  return { name: "Error", message: String(error) };
}
