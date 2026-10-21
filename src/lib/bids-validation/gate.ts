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
 * error that says the browser could not download a HED schema (`isSchemaDownloadFailure`) is
 * listed with the warnings and does not gate, and the verdict then says the HED annotations were
 * not checked, never that no errors were found. The validator downloads a schema it does not
 * ship, from the person's browser, and that request can fail where the check's, on GitHub, would
 * not: offline, a failed lookup, a blocker. That is the browser's failure and not the dataset's.
 *
 * It is exempt only when the request got no answer at all. The validator gives one sub-code,
 * `SCHEMA_LOAD_FAILED`, to seven conditions, and every other one is a fact about the dataset that
 * the check fails too: no schema specification (HED columns and no `HEDVersion`), an invalid one,
 * library schemas that cannot be merged, a version GitHub answers 404 for. An answer, of any
 * status, is the answer the check would get, so it gates like any other error.
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
 * The HED validator's wording for a schema it could not download (its `remoteSchemaLoadFailed`),
 * and for the server having answered (its `networkReadError`, which is the quoted cause when
 * GitHub gave any HTTP status). Both come from real runs of the committed bundle, in Chrome, Node
 * and Deno (`gate.test.ts` holds them), and both are anchored at the start of the message: the
 * validator quotes a dataset's own `HEDVersion` into its other messages, and text the dataset
 * controls must not be able to say it is a download failure.
 *
 * The cause of a request that got no answer is the browser's own words (`Failed to fetch` in
 * Chrome, `fetch failed` in Node and Deno), which differ between browsers, so it is not matched;
 * what is matched is that the cause is not the validator's wording for an answer.
 */
const REMOTE_SCHEMA_REQUEST =
  /^ERROR: \[SCHEMA_LOAD_FAILED\] Could not load HED schema ".*?" from remote repository - "/s;
const SERVER_ANSWERED =
  /^ERROR: \[INTERNAL_ERROR\] I\/O error when reading from network - server responded to URL /;

/**
 * The validator saying the browser could not download a HED schema, where the request got no
 * answer: `HED_ERROR`, sub-code `SCHEMA_LOAD_FAILED`, in the wording above. Anything else with
 * that sub-code is about the dataset, and so is a download the server answered, whatever the
 * status, 404 for a version that does not exist included.
 *
 * A wording this does not recognise is not a download failure: the answer to an unknown message is
 * to stop the upload, so a release that rewords one makes the tests that run the real bundle fail
 * and does not quietly let errors through.
 */
export function isSchemaDownloadFailure(issue: ReportIssue): boolean {
  if (issue.code !== "HED_ERROR" || issue.subCode !== "SCHEMA_LOAD_FAILED") return false;
  const message = issue.issueMessage ?? "";
  const request = REMOTE_SCHEMA_REQUEST.exec(message);
  if (request === null) return false;
  return !SERVER_ANSWERED.test(message.slice(request[0].length));
}

export interface Verdict {
  /** Errors that stop the upload. */
  readonly blocking: readonly ReportIssue[];
  /** Errors on pointer files, which the repository check ignores and so does the page. */
  readonly annexSkipped: readonly ReportIssue[];
  /**
   * Errors that say the browser could not download a HED schema: listed with the warnings and not
   * counted, and the HED annotations were not checked.
   */
  readonly schemaDownloadFailed: readonly ReportIssue[];
  /** Advisory. */
  readonly warnings: readonly ReportIssue[];
}

export function applyGate(issues: readonly ReportIssue[], pointers: ReadonlySet<string>): Verdict {
  const blocking: ReportIssue[] = [];
  const annexSkipped: ReportIssue[] = [];
  const schemaDownloadFailed: ReportIssue[] = [];
  const warnings: ReportIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === "warning") {
      warnings.push(issue);
    } else if (issue.severity === "error") {
      if (issue.location !== undefined && pointers.has(issue.location)) annexSkipped.push(issue);
      else if (isSchemaDownloadFailure(issue)) schemaDownloadFailed.push(issue);
      else blocking.push(issue);
    }
  }
  return { blocking, annexSkipped, schemaDownloadFailed, warnings };
}

/** A dropped file and where it sits in the dataset (no leading slash), as the page holds it. */
export interface DroppedCandidate {
  readonly path: string;
  readonly file: PointerCandidate;
}

/**
 * What the page does with a finished run: find which of the errors sit on pointer files, then
 * apply the gate. It is one function so that the tests that run the real validator on real files
 * go through the same lines the page does.
 */
export async function judge(
  issues: readonly ReportIssue[],
  files: readonly DroppedCandidate[],
): Promise<Verdict> {
  const byLocation = new Map<string, PointerCandidate>(
    files.map(({ path, file }) => [`/${path}`, file]),
  );
  const pointers = await findAnnexPointers(errorLocations(issues), (location) =>
    byLocation.get(location),
  );
  return applyGate(issues, pointers);
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
