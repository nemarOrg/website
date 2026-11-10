/**
 * One plain sentence per failure code of a job (website ADR 0030 phase E3, issue #496). WEBSITE-OWNED
 * wording: no sentence of this page exists in nemar-cli's copy (the CLI prints the raw code), so there
 * is no key parity to keep; see `compute-copy.ts`. The one exception is `upload_expired`, whose
 * sentence is the backend's own, transcribed and drift-tested.
 *
 * The user view deliberately carries no fault attribution (`failure_detail` and `platform_failure` are
 * not served), so NO SENTENCE SAYS WHOSE FAULT A FAILURE WAS and none promises a refund. The seven
 * launcher codes are the ones where the job's own log can explain; those sentences are followed by a
 * pointer to the log. A code this build does not know prints itself, escaped, and claims nothing.
 */
import {
  COMPUTE_LAUNCHER_FAILURE_CODES,
  COMPUTE_UPLOAD_EXPIRED_SENTENCE,
} from "./compute-contract";
import { displaySafeLine } from "./mail-display";

export const FAILURE_SENTENCES: Readonly<Record<string, string>> = {
  code_fetch_failed: "The job could not fetch its code.",
  dataset_fetch_failed: "The job could not read a dataset it asked for.",
  entry_not_found: "The job's entry file was not found in its code.",
  runtime_error: "The job's program stopped with an error.",
  out_of_memory: "The job ran out of memory.",
  time_limit: "The job reached its time limit and was stopped.",
  result_upload_failed: "The job ran, but NEMAR could not accept its result files.",
  tapis_submit_failed: "NEMAR could not hand the job to the cluster.",
  submit_timeout: "The cluster did not accept the job in time.",
  staging_failed: "The cluster could not prepare the job's files.",
  launch_failed: "The cluster could not start the job.",
  archive_failed: "The cluster could not save the job's output.",
  tapis_error: "The cluster reported an error for this job.",
  result_verification_failed:
    "The job finished, but NEMAR could not verify its results, so they are not offered.",
  records_unavailable:
    "The job finished, but NEMAR could not read the files it needs to check the results.",
  tapis_record_lost: "NEMAR lost track of this job on the cluster and ended it.",
  upload_expired: COMPUTE_UPLOAD_EXPIRED_SENTENCE,
};

export interface FailureView {
  /** The code, escaped for display. */
  readonly code: string;
  /** False for a code this build has no sentence for. */
  readonly known: boolean;
  readonly sentence: string;
  /** "Read the log below, or run <command>." where the log can help; null elsewhere. */
  readonly logHint: { readonly lead: string; readonly command: string } | null;
}

export function failureView(code: string, jobId: string): FailureView {
  const safe = displaySafeLine(code);
  if (!Object.hasOwn(FAILURE_SENTENCES, code)) {
    return {
      code: safe,
      known: false,
      sentence: `The job failed with a code this page has no wording for: ${safe || "(empty)"}.`,
      logHint: null,
    };
  }
  const helps = (COMPUTE_LAUNCHER_FAILURE_CODES as readonly string[]).includes(code);
  return {
    code: safe,
    known: true,
    sentence: FAILURE_SENTENCES[code],
    logHint: helps
      ? { lead: "Read the log below, or run ", command: `nemar compute logs ${jobId}` }
      : null,
  };
}
