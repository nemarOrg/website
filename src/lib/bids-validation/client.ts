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
      return resolve({ kind: "unavailable", reason: describe(error) });
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
      if (message.type === "phase") onPhase?.(message.phase, message.fileCount);
      else if (message.type === "result") settle({ kind: "report", report: message.report });
      else if (message.type === "failure") {
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
      settle({ kind: "unavailable", reason: describe(error) });
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
