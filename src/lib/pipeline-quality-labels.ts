/**
 * The words of a run's quality on the admin Pipelines tab (website phase W9, #588; nemar-cli
 * ADR 0137 decision 7): one sentence per run-quality word, per recordings word and per word of the
 * admin quality mount and its proxy. Pages and components type none of these; they come from here.
 * A word this build has no sentence for is shown raw, through `wordText`, in a neutral sentence.
 */

/** One sentence per `COMPUTE_RUN_QUALITY_STATES` word (nemar-cli `shared/contract/compute-admin.ts`). */
export const RUN_QUALITY_SENTENCES: Readonly<Record<string, string>> = {
  run_in_progress: "The run has not ended yet, so there is no derivative to show.",
  run_not_succeeded: "The run failed or was refused, so no derivative was made of it.",
  not_keyed: "The run succeeded and the derivative store decided to make no derivative of it.",
  awaiting_derivative: "The run succeeded and the derivative store has not decided yet.",
  failed: "The derivative's copy could not be trusted, so its files are not served.",
  expired: "The derivative has expired, so its files are deleted or about to be.",
  copying: "The derivative's files are being copied; look again shortly.",
  canary: "A canary: stored, and seen by administrators only.",
  current: "Stored, and the derivative public pages read while the dataset is public.",
  superseded: "Stored, and replaced by a later catalog derivative.",
  not_current:
    "Stored and of a public class, but a newer derivative of this dataset and recipe is the one public pages read.",
};

/** One sentence per `COMPUTE_RUN_QUALITY_RECORDINGS_STATES` word. */
export const RECORDINGS_SENTENCES: Readonly<Record<string, string>> = {
  listed: "The recordings that succeeded, a page at a time.",
  not_stored: "The derivative's files are not stored whole, so no recording is listed.",
  store_unavailable:
    "The derivatives store could not be reached, so no recording is listed. Try again later.",
  table_missing: "The stored derivative has no recordings table, so no recording is listed.",
  table_too_large: "The recordings table is larger than the server reads, so it was not read.",
  table_unreadable: "The recordings table could not be read, so no recording is listed.",
};

/** The admin mount's own words and the proxy's (the public route's are the panel's). */
export const ADMIN_VIEW_SENTENCES: Readonly<Record<string, string>> = {
  quality_not_found: "The run's derivative has no quality record for this recording.",
  stamp_not_found: "There is no such run.",
  derivative_not_keyed: "This run has no stored derivative, so it has no views to draw.",
  derivative_copying: "This run's derivative is being copied; look again shortly.",
  derivative_failed: "This run's derivative failed, so its files are not served.",
  quality_unavailable: "The derivatives store could not be reached. Try again later.",
  method_not_allowed: "The server refused the request's method.",
  not_found: "The server did not find this run's quality views.",
  upstream_unreachable: "The server could not be reached. Try again later.",
  upstream_redirect: "The server answered with a redirect, which is not followed.",
  answer_too_large: "The server's answer is larger than the page reads.",
};

export const PIPELINE_QUALITY_LABELS = {
  heading: "Quality views",
  drillHeading: "Quality views of the run",
  open: "Open the run's quality views",
  backToRun: "Back to the run",
  fieldState: "Derivative",
  fieldRetention: "Retention",
  fieldStored: "Stored",
  fieldExpires: "Expires",
  fieldExpired: "Expired on",
  fieldKey: "Key",
  fieldServingIndex: "Serving index",
  fieldSucceeded: "Succeeded recordings",
  notPublic: "Not public",
  notPublicBody:
    "This dataset is not public now, so no public page shows this derivative and this page gives no public link.",
  publicLink: "The dataset's public page",
  skipLead: "The store's reason",
  failureLead: "The failure",
  duplicateKey: "An earlier run with the same inputs holds the derivative under that key.",
  unknownState: "The server reports a word this page has no sentence for",
  deferredTitle: "Deferred: the serving index could not be staged",
  deferredBody:
    "The serving index could not be staged because of a temporary fault, so the run is deferred, not failed: its stamp records the deferral and a later dispatch tries again.",
  deferredAfter: "It goes ahead without the index after",
  deferredUnknown:
    "It goes ahead without the index 24 hours after its first deferral; this server does not say when that is. This deferral was recorded at",
  recordingsHeading: "Recordings",
  recording: "Recording",
  unlisted: "Succeeded rows left out (not a recording path, or listed twice)",
  nextPage: "Next recordings",
  firstPage: "First recordings",
  storedOnly:
    "Only views drawn from stored data are drawn here: the spectrum, the component maps and the class histogram.",
  computedHeading: "Computed views",
  computedLead: "Drawn from the dataset's signal, not stored data:",
  computedNote: "drawn on the dataset page once promoted",
  noComputed: "This recording declares no computed view.",
  loading: "Loading the recording's quality views…",
  needsScript: "The quality views are drawn in the browser and need JavaScript.",
  noRecording: "There is no recording to draw.",
  notAvailableTitle: "Not available on this server yet",
  notAvailableBody:
    "This API does not serve a run's quality yet; it arrives with nemar-cli epic #2324.",
  whatQuality: "the run's quality",
} as const;
