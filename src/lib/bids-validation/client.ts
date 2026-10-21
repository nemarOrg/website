/**
 * Runs the vendored BIDS validator for the upload page, in a module Web Worker (website ADR 0028).
 *
 * Browser-only. The worker script is a static file under `public/vendor/`, fetched when the first
 * folder is validated and not before: nothing on the page imports it, so `/upload` loads exactly
 * what it loaded without this feature, plus this file.
 */

import pin from "../../../validator-version.json";
import type { ValidationReport, WorkerFileEntry, WorkerRequest, WorkerResponse } from "./protocol";

/** The release the page runs: the same pin the CLI and the repository check run, copied from
 *  nemar-cli (`validator-version.json`). */
export const VALIDATOR_VERSION: string = pin.version;

/**
 * Where the worker script for `version` is served. Same-origin and versioned: the page's
 * `worker-src 'self'` allows it, and a new release is a new URL, so a cached script is never
 * mistaken for the new one.
 */
export function workerUrl(version: string = VALIDATOR_VERSION): string {
  return `/vendor/bids-validator/${version}/bids-validator-worker.js`;
}

/**
 * A run that has not answered in this long is given up as "could not run", and the upload is
 * possible. A worker that hangs would otherwise leave Cancel as the only way out of the page, and
 * Cancel leaves the upload blocked. Long enough that a slow machine with a very large dataset is
 * not cut short: 20,003 files took 24 seconds.
 */
export const VALIDATION_DEADLINE_MS = 15 * 60 * 1000;

export type RunOutcome =
  /** The validator ran to the end. Its findings may still be errors. */
  | { readonly kind: "report"; readonly report: ValidationReport }
  /** It could not run, or crashed. Nothing is known about the dataset. */
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The person stopped it. */
  | { readonly kind: "cancelled" };

export interface RunOptions {
  /** Aborting terminates the worker and settles the run as `cancelled`. */
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: "tree" | "validate", fileCount: number) => void;
}

/**
 * Validate `entries` in a fresh worker. Never rejects: every way it can go wrong is an outcome the
 * page words, because "the validator crashed" must reach a person as that and not as a stack
 * trace in a console.
 */
export function runValidation(
  entries: readonly WorkerFileEntry[],
  { signal, onPhase }: RunOptions = {},
): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    if (signal?.aborted) return resolve({ kind: "cancelled" });
    if (typeof Worker === "undefined") {
      return resolve({ kind: "unavailable", reason: "this browser has no Web Workers" });
    }

    let worker: Worker;
    try {
      worker = new Worker(workerUrl(), { type: "module" });
    } catch (error) {
      return resolve({ kind: "unavailable", reason: describeError(error) });
    }

    const settle = (outcome: RunOutcome): void => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(deadline);
      worker.terminate();
      resolve(outcome);
    };
    const onAbort = (): void => settle({ kind: "cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(
      () =>
        settle({
          kind: "unavailable",
          reason: `the check had not finished after ${VALIDATION_DEADLINE_MS / 60_000} minutes`,
        }),
      VALIDATION_DEADLINE_MS,
    );

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "phase") {
        // Progress is only shown, so a page that cannot show it does not end the check.
        try {
          onPhase?.(message.phase, message.fileCount);
        } catch (error) {
          console.error("[bids-validation] the progress could not be shown:", error);
        }
      } else if (message.type === "result") {
        // The worker is declared to send a report, and everything after this reads one. A script
        // that sends anything else is a validator this page cannot use, said in words here and not
        // as a TypeError somewhere in the panel.
        settle(
          isValidationReport(message.report)
            ? { kind: "report", report: message.report }
            : { kind: "unavailable", reason: "the validator sent an answer this page cannot read" },
        );
      } else if (message.type === "failure") {
        settle({ kind: "unavailable", reason: `${message.name}: ${message.message}` });
      }
    };
    // A script that fails to load (offline, a 404, a browser without module workers) and one
    // that throws both arrive here; the first has no message.
    worker.onerror = (event) =>
      settle({ kind: "unavailable", reason: event.message || "the validator could not be loaded" });
    worker.onmessageerror = () =>
      settle({ kind: "unavailable", reason: "the validator sent an answer this page cannot read" });

    try {
      worker.postMessage({ type: "validate", entries } satisfies WorkerRequest);
    } catch (error) {
      settle({ kind: "unavailable", reason: describeError(error) });
    }
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

function isReportIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.severity === "error" || value.severity === "warning" || value.severity === "ignore") &&
    typeof value.code === "string" &&
    isOptionalString(value.subCode) &&
    isOptionalString(value.location) &&
    isOptionalString(value.issueMessage) &&
    isOptionalString(value.suggestion) &&
    isOptionalString(value.rule) &&
    (value.affects === undefined || isStringArray(value.affects))
  );
}

/**
 * Whether `value` is a report in the shape `ValidationReport` declares and the page reads: a
 * finding is a severity and a code with optional text, the code descriptions are text, and the
 * summary has its counts, lists and schema version. A message crosses from another script, so the
 * type says what it should be and this says what it is.
 */
export function isValidationReport(value: unknown): value is ValidationReport {
  if (!isRecord(value)) return false;
  const { issues, codeMessages, summary } = value;
  return (
    Array.isArray(issues) &&
    issues.every(isReportIssue) &&
    isRecord(codeMessages) &&
    Object.values(codeMessages).every((text) => typeof text === "string") &&
    isRecord(summary) &&
    typeof summary.schemaVersion === "string" &&
    ["totalFiles", "size", "subjectCount", "sessionCount"].every(
      (key) => typeof summary[key] === "number",
    ) &&
    ["tasks", "modalities", "dataTypes"].every((key) => isStringArray(summary[key]))
  );
}

/** An error as one line, for a reason shown to a person or written to the console. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
