import { describe, expect, it } from "vitest";
import {
  BLOCKED_STATUS,
  PRIVACY_HED_NOTICE,
  PRIVACY_NOTICE,
  WAITING_FOR_STRUCTURE,
  footerLine,
  runningLine,
  unavailableWords,
  verdictWords,
} from "./wording";

const counts = (partial: Partial<Parameters<typeof verdictWords>[0]>) => ({
  blocking: 0,
  warnings: 0,
  annexSkipped: 0,
  schemaDownloadFailed: 0,
  ...partial,
});

describe("verdictWords", () => {
  it("says what stops the upload, and what to do", () => {
    expect(verdictWords(counts({ blocking: 2 }))).toEqual({
      tone: "blocked",
      headline: "2 errors must be fixed before you can upload.",
      detail: "Fix them in your dataset, then drop the folder again.",
      note: "",
    });
  });

  it("uses the singular for one error, and says warnings do not stop the upload", () => {
    const words = verdictWords(counts({ blocking: 1, warnings: 1 }));
    expect(words.headline).toBe("1 error must be fixed before you can upload.");
    expect(words.detail).toBe(
      "Fix it in your dataset, then drop the folder again. 1 warning is advisory and does not stop the upload.",
    );
  });

  it("passes a dataset with warnings, and says they are advisory", () => {
    const words = verdictWords(counts({ warnings: 30 }));
    expect(words.tone).toBe("passed");
    expect(words.headline).toBe("No BIDS errors found.");
    expect(words.detail).toBe("30 warnings below are advisory and do not stop the upload.");
  });

  it("passes a dataset with nothing to report", () => {
    expect(verdictWords(counts({})).detail).toBe("No warnings either.");
  });

  it("says when errors were left out because they are on git-annex pointer files", () => {
    expect(verdictWords(counts({ annexSkipped: 2 })).note).toBe(
      "2 errors on git-annex pointer files were not counted, as in NEMAR's repository check.",
    );
    expect(verdictWords(counts({ annexSkipped: 1 })).note).toBe(
      "1 error on git-annex pointer files was not counted, as in NEMAR's repository check.",
    );
  });

  it("does not call a dataset clean when errors were set aside", () => {
    const words = verdictWords(counts({ annexSkipped: 2 }));
    expect(words.tone).toBe("passed");
    expect(words.headline).toBe("No BIDS errors need fixing.");
  });
});

describe("verdictWords, for a schema the browser could not download", () => {
  const UNCHECKED_NOTE =
    "1 error about a HED schema that could not be downloaded is listed with the warnings and not counted; NEMAR's repository check downloads the schema again after the upload and checks the annotations then.";
  const BLOCKED_NOTE =
    "1 error about a HED schema that could not be downloaded is listed with the warnings and not counted: the HED annotations were not checked here, and NEMAR's repository check downloads the schema again after the upload.";

  it("says the HED annotations were not checked, and never that no errors were found", () => {
    const words = verdictWords(counts({ warnings: 31, schemaDownloadFailed: 1 }));
    expect(words.tone).toBe("unchecked");
    expect(words.headline).toBe("The HED annotations were not checked.");
    expect(words.detail).toBe(
      "No other BIDS errors need fixing. 30 other warnings below are advisory and do not stop the upload.",
    );
    expect(words.note).toBe(UNCHECKED_NOTE);
    expect(`${words.headline} ${words.detail} ${words.note}`).not.toMatch(/no bids errors found/i);
  });

  it("has nothing to add about warnings when the HED error was the only finding", () => {
    const words = verdictWords(counts({ warnings: 1, schemaDownloadFailed: 1 }));
    expect(words.detail).toBe("No other BIDS errors need fixing.");
  });

  it("uses the singular for one other warning", () => {
    expect(verdictWords(counts({ warnings: 2, schemaDownloadFailed: 1 })).detail).toBe(
      "No other BIDS errors need fixing. 1 other warning below is advisory and does not stop the upload.",
    );
  });

  it("keeps the two notes apart when pointer files had errors too", () => {
    const { note } = verdictWords(
      counts({ warnings: 3, annexSkipped: 2, schemaDownloadFailed: 1 }),
    );
    expect(note).toContain("2 errors on git-annex pointer files were not counted");
    expect(note).toContain("1 error about a HED schema");
  });

  it("does not hide a real error behind it, and still says the annotations were not checked", () => {
    const words = verdictWords(counts({ blocking: 1, warnings: 1, schemaDownloadFailed: 1 }));
    expect(words.tone).toBe("blocked");
    expect(words.headline).toBe("1 error must be fixed before you can upload.");
    expect(words.note).toBe(BLOCKED_NOTE);
  });
});

describe("runningLine", () => {
  it("names the step and the number of files", () => {
    expect(runningLine("tree", 1)).toBe("Reading 1 file...");
    expect(runningLine("validate", 1200)).toBe(
      "Checking 1200 files against the BIDS schema. Large datasets can take a few minutes.",
    );
  });
});

describe("unavailableWords", () => {
  it("says the check could not run, and that the upload is still possible", () => {
    const words = unavailableWords("this browser has no Web Workers");
    expect(words.headline).toBe("The BIDS check could not run in this browser.");
    expect(words.detail).toBe(
      "This browser has no Web Workers. You can still upload: NEMAR runs the BIDS validator on the dataset repository after the upload and reports any errors then.",
    );
  });

  it("does not double a full stop that the reason already ends with", () => {
    expect(unavailableWords("Failed to load.").detail.startsWith("Failed to load. You")).toBe(true);
  });

  it("is never worded as a pass", () => {
    const { headline, detail } = unavailableWords("NetworkError: failed to fetch");
    expect(`${headline} ${detail}`).not.toMatch(/no bids errors|\bpassed\b|\bvalid\b/i);
  });
});

describe("footerLine", () => {
  it("names the validator and the schema it read, and who runs it again", () => {
    expect(footerLine("3.0.2", "1.2.7")).toBe(
      "BIDS validator 3.0.2, BIDS schema 1.2.7. NEMAR runs the BIDS validator again on the dataset repository after the upload.",
    );
  });
});

describe("the privacy statement", () => {
  it("promises that nothing from the files is sent anywhere", () => {
    expect(PRIVACY_NOTICE).toContain("nothing from them is sent anywhere");
  });

  it("states its one exception, with the host and what the request carries", () => {
    // `public/_headers` lets the worker reach this host and no other
    // (test/bids-validator-vendor.test.ts), and the exception must name it.
    expect(PRIVACY_HED_NOTICE).toContain("raw.githubusercontent.com");
    expect(PRIVACY_HED_NOTICE).toContain("No part of your files is in that request");
  });
});

describe("the hint beside a blocked upload button", () => {
  it("points at the errors above", () => {
    expect(BLOCKED_STATUS).toBe("Fix the BIDS errors above to enable the upload.");
    expect(WAITING_FOR_STRUCTURE).toContain("structure errors above");
  });
});
