/**
 * Whether what the validator found stops the upload, decided the way the repository check decides
 * it (website ADR 0028).
 *
 * That check is `run-bids-validation.yml` in `nemarDatasets/.github`. It fails a dataset on any
 * `error` whose location is not a git-annex pointer file, and ignores every `warning`. The page
 * must agree with it, because a person told "fine" here and "failed" an hour later, or the other
 * way round, has been misled by one of the two. So the decision is the same one, in four parts:
 *
 *  - `warning` never gates;
 *  - an `error` gates, unless its `location` is a pointer file;
 *  - a pointer file is a regular file of fewer than 1024 bytes with a line that starts with
 *    `/annex/objects/` (the check's `find -size -1024c` and `grep -l '^/annex/objects/'`);
 *  - the check also treats a symlink as a pointer. A browser is never told about a symlink, so
 *    that half has no counterpart here: a dataset dropped from an annex whose files are symlinks
 *    arrives as whatever the browser read through them.
 *
 * `location` is compared as a whole string, as the check's `index($loc)` does, and an error with
 * no `location` (the checks about a missing file carry `affects` instead) is never a pointer.
 *
 * One rule goes the other way, and is the one place the page is more lenient than the check: an
 * error that says a HED schema could not be loaded (`isSchemaLoadFailure`) is listed with the
 * warnings and does not gate. The validator downloads a schema it does not ship, from the
 * person's browser, and a download can fail where the check's, on GitHub, would not; that is the
 * browser's failure and not the dataset's, and the page must never refuse what the check passes.
 * The same error is what a version that does not exist raises, so that case is caught by the
 * check, after the upload, and not here: a miss, which the repository check covers, in place of a
 * lockout, which nothing would.
 */

import type { ReportIssue } from "./protocol";

/** `find -size -1024c` is "fewer than 1024 bytes". */
export const ANNEX_POINTER_MAX_BYTES = 1024;

const ANNEX_PREFIX = "/annex/objects/";

/** `size` and `text` of a file, which is all the rule needs; a `File` has both. */
export interface PointerCandidate {
  readonly size: number;
  text(): Promise<string>;
}

/** The rule on one file's size and text. */
export function isAnnexPointer(size: number, text: string): boolean {
  return (
    size < ANNEX_POINTER_MAX_BYTES &&
    (text.startsWith(ANNEX_PREFIX) || text.includes(`\n${ANNEX_PREFIX}`))
  );
}

/** The distinct locations of the errors: the only files whose pointer-ness can change the verdict. */
export function errorLocations(issues: readonly ReportIssue[]): string[] {
  const locations = new Set<string>();
  for (const issue of issues) {
    if (issue.severity === "error" && issue.location) locations.add(issue.location);
  }
  return [...locations];
}

/**
 * Which of `locations` are pointer files. Only a file under the size limit is read, so a dataset
 * with ten thousand errors on large files reads nothing. A file that cannot be read is not a
 * pointer: the error stays an error.
 *
 * @param lookup the dropped file at a validator location (leading slash), if there is one.
 */
export async function findAnnexPointers(
  locations: readonly string[],
  lookup: (location: string) => PointerCandidate | undefined,
): Promise<Set<string>> {
  const pointers = new Set<string>();
  const small: [string, PointerCandidate][] = [];
  for (const location of locations) {
    const file = lookup(location);
    if (file !== undefined && file.size < ANNEX_POINTER_MAX_BYTES) small.push([location, file]);
  }
  // Batches, so thousands of small reads are not thousands of simultaneous ones.
  const BATCH = 64;
  for (let start = 0; start < small.length; start += BATCH) {
    await Promise.all(
      small.slice(start, start + BATCH).map(async ([location, file]) => {
        let text: string;
        try {
          text = await file.text();
        } catch {
          return;
        }
        if (isAnnexPointer(file.size, text)) pointers.add(location);
      }),
    );
  }
  return pointers;
}

/**
 * The validator saying it could not load a HED schema: `HED_ERROR`, sub-code `SCHEMA_LOAD_FAILED`,
 * with no location. Raised for a schema that failed to download and for one that does not exist.
 */
export function isSchemaLoadFailure(issue: ReportIssue): boolean {
  return issue.code === "HED_ERROR" && issue.subCode === "SCHEMA_LOAD_FAILED";
}

export interface Verdict {
  /** Errors that stop the upload. */
  readonly blocking: readonly ReportIssue[];
  /** Errors on pointer files, which the repository check ignores and so does the page. */
  readonly annexSkipped: readonly ReportIssue[];
  /** Errors that only say a HED schema could not be loaded: shown with the warnings, not counted. */
  readonly schemaNotLoaded: readonly ReportIssue[];
  /** Advisory. */
  readonly warnings: readonly ReportIssue[];
}

export function applyGate(issues: readonly ReportIssue[], pointers: ReadonlySet<string>): Verdict {
  const blocking: ReportIssue[] = [];
  const annexSkipped: ReportIssue[] = [];
  const schemaNotLoaded: ReportIssue[] = [];
  const warnings: ReportIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === "warning") {
      warnings.push(issue);
    } else if (issue.severity === "error") {
      if (issue.location !== undefined && pointers.has(issue.location)) annexSkipped.push(issue);
      else if (isSchemaLoadFailure(issue)) schemaNotLoaded.push(issue);
      else blocking.push(issue);
    }
  }
  return { blocking, annexSkipped, schemaNotLoaded, warnings };
}

/** Where the full validation stands, for the upload button. */
export type ValidationState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly blockingErrors: number }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Whether the upload button may be enabled.
 *
 * `unavailable` (the validator could not run: no worker, a failed download, a crash) lets the
 * upload through. The check here is a convenience and the repository check is the authority, so a
 * person must not be locked out by a failure of the convenience. It is its own state precisely so
 * that nothing renders it as "passed".
 */
export function canUpload(input: {
  readonly structurePassed: boolean;
  readonly validation: ValidationState;
}): boolean {
  if (!input.structurePassed) return false;
  switch (input.validation.kind) {
    case "finished":
      return input.validation.blockingErrors === 0;
    case "unavailable":
      return true;
    default:
      return false;
  }
}
