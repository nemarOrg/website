/**
 * The sentences of the BIDS validation panel on the upload page. Pure, so that what a person is
 * told, and above all what they are told about their data, can be read and tested in one place.
 */

/**
 * The privacy statement. Both sentences were checked against the vendored bundle and against a
 * real run (website ADR 0028): the worker made no request at all for a dataset whose HED schema
 * ships with the validator, and one GET to `raw.githubusercontent.com` for one whose does not. The
 * worker's own Content-Security-Policy (`public/_headers`) allows no other host, so the claim is
 * what the browser enforces, not only what the code does.
 */
export const PRIVACY_NOTICE =
  "This check runs in your browser. Your files are read on this computer, and nothing from them is sent anywhere.";

export const PRIVACY_HED_NOTICE =
  "One exception: if dataset_description.json names a HED schema version that is not built in, the check downloads that public schema file from GitHub (raw.githubusercontent.com). No part of your files is in that request: it names only the schema and its version.";

/** The panel's waiting line while the structure check has errors: the full check starts after. */
export const WAITING_FOR_STRUCTURE =
  "The full BIDS check runs once the structure errors above are fixed.";

/** A reason (`the validator could not be loaded`) as a sentence of its own. */
function sentence(reason: string): string {
  const trimmed = reason.replace(/[.\s]+$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function runningLine(phase: "tree" | "validate", fileCount: number): string {
  const files = `${fileCount} ${plural(fileCount, "file", "files")}`;
  return phase === "tree"
    ? `Reading ${files}...`
    : `Checking ${files} against the BIDS schema. Large datasets can take a few minutes.`;
}

export interface VerdictWords {
  /**
   * `unchecked` is a pass that is not a clean one: nothing stops the upload, and something was not
   * looked at. It is amber, like `unavailable`, and is never worded as "no errors found".
   */
  readonly tone: "blocked" | "unchecked" | "passed";
  readonly headline: string;
  readonly detail: string;
  /** Errors left out of the count, with why. Empty when there are none. */
  readonly note: string;
}

/**
 * `warnings` is the number of findings listed as warnings, the schema-download-failed ones
 * included, so the sentence counts what the list below it shows. `annexSkipped` and
 * `schemaDownloadFailed` are the errors that are not counted, and the note says which and why.
 *
 * Nothing that was left out of the count is called a clean pass: a dataset with a HED schema that
 * could not be downloaded is told its HED annotations were not checked, and one with errors on
 * pointer files is told nothing needs fixing, with the note saying what was set aside.
 */
export function verdictWords(counts: {
  readonly blocking: number;
  readonly warnings: number;
  readonly annexSkipped: number;
  readonly schemaDownloadFailed: number;
}): VerdictWords {
  const { blocking, warnings, annexSkipped, schemaDownloadFailed } = counts;
  const advisory = (count: number, qualifier = ""): string =>
    `${count} ${qualifier}${plural(count, "warning", "warnings")}`;
  const notes: string[] = [];
  if (annexSkipped > 0) {
    notes.push(
      `${annexSkipped} ${plural(annexSkipped, "error", "errors")} on git-annex pointer files ${plural(annexSkipped, "was", "were")} not counted, as in NEMAR's repository check.`,
    );
  }
  if (schemaDownloadFailed > 0) {
    // With nothing else to fix the headline already says the annotations were not checked; beside
    // errors that must be fixed, the headline is about them and the note has to say it.
    const unchecked =
      blocking > 0
        ? ": the HED annotations were not checked here, and NEMAR's repository check downloads the schema again after the upload."
        : "; NEMAR's repository check downloads the schema again after the upload and checks the annotations then.";
    notes.push(
      `${schemaDownloadFailed} ${plural(schemaDownloadFailed, "error", "errors")} about a HED schema that could not be downloaded ${plural(schemaDownloadFailed, "is", "are")} listed with the warnings and not counted${unchecked}`,
    );
  }
  const note = notes.join(" ");
  if (blocking > 0) {
    return {
      tone: "blocked",
      headline: `${blocking} ${plural(blocking, "error", "errors")} must be fixed before you can upload.`,
      detail: `Fix ${plural(blocking, "it", "them")} in your dataset, then drop the folder again.${
        warnings > 0
          ? ` ${advisory(warnings)} ${plural(warnings, "is", "are")} advisory and ${plural(warnings, "does", "do")} not stop the upload.`
          : ""
      }`,
      note,
    };
  }
  if (schemaDownloadFailed > 0) {
    const others = warnings - schemaDownloadFailed;
    return {
      tone: "unchecked",
      headline: "The HED annotations were not checked.",
      detail: `No other BIDS errors need fixing.${
        others > 0
          ? ` ${advisory(others, "other ")} below ${plural(others, "is", "are")} advisory and ${plural(others, "does", "do")} not stop the upload.`
          : ""
      }`,
      note,
    };
  }
  return {
    tone: "passed",
    headline: annexSkipped > 0 ? "No BIDS errors need fixing." : "No BIDS errors found.",
    detail:
      warnings > 0
        ? `${advisory(warnings)} below ${plural(warnings, "is", "are")} advisory and ${plural(warnings, "does", "do")} not stop the upload.`
        : "No warnings either.",
    note,
  };
}

/** The validator could not run, which says nothing about the dataset. Never worded as a pass. */
export function unavailableWords(reason: string): { headline: string; detail: string } {
  return {
    headline: "The BIDS check could not run in this browser.",
    detail: `${sentence(reason)} You can still upload: NEMAR runs the BIDS validator on the dataset repository after the upload and reports any errors then.`,
  };
}

export function footerLine(validatorVersion: string, schemaVersion: string): string {
  return `BIDS validator ${validatorVersion}, BIDS schema ${schemaVersion}. NEMAR runs the BIDS validator again on the dataset repository after the upload.`;
}

/** The hint beside the disabled upload button when the check stopped it. */
export const BLOCKED_STATUS = "Fix the BIDS errors above to enable the upload.";
