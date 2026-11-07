/**
 * The failure sentences of the job page (phase E3, website#496). The list of codes is the transcribed
 * contract (`compute-contract.ts`, drift-tested against nemar-cli), so a code the backend adds fails
 * `test/compute-job-contract-drift.test.ts` first and this file second.
 */
import { describe, expect, it } from "vitest";
import {
  COMPUTE_FAILURE_CODES,
  COMPUTE_LAUNCHER_FAILURE_CODES,
  COMPUTE_UPLOAD_EXPIRED_SENTENCE,
} from "./compute-contract";
import { FAILURE_SENTENCES, failureView } from "./compute-failure";

const ID = "job_0123456789abcdef01234567";

describe("failureView", () => {
  it("has a plain sentence for each of the 17 codes", () => {
    expect(COMPUTE_FAILURE_CODES.length).toBe(17);
    for (const code of COMPUTE_FAILURE_CODES) {
      const v = failureView(code, ID);
      expect(v.known, code).toBe(true);
      expect(v.sentence.length, code).toBeGreaterThan(10);
      expect(v.sentence, code).toMatch(/[.]$/);
      expect(v.code, code).toBe(code);
    }
    // And the table carries nothing the contract does not.
    expect(Object.keys(FAILURE_SENTENCES).sort()).toEqual([...COMPUTE_FAILURE_CODES].sort());
  });

  it("points at the log for the seven launcher codes and at nothing for the other ten", () => {
    for (const code of COMPUTE_FAILURE_CODES) {
      const v = failureView(code, ID);
      const launcher = (COMPUTE_LAUNCHER_FAILURE_CODES as readonly string[]).includes(code);
      if (launcher) {
        expect(v.logHint, code).toEqual({
          lead: "Read the log below, or run ",
          command: `nemar compute logs ${ID}`,
        });
      } else {
        expect(v.logHint, code).toBeNull();
      }
    }
    expect(COMPUTE_LAUNCHER_FAILURE_CODES.length).toBe(7);
  });

  it("names no one at fault and promises no refund", () => {
    for (const code of COMPUTE_FAILURE_CODES) {
      const { sentence } = failureView(code, ID);
      expect(sentence, code).not.toMatch(/\b(your|you|fault|blame|because|refund|compensat)/i);
    }
  });

  it("uses the backend's own sentence for an upload that expired", () => {
    expect(failureView("upload_expired", ID).sentence).toBe(COMPUTE_UPLOAD_EXPIRED_SENTENCE);
  });

  it("prints an unknown code itself, with no log hint and no claim", () => {
    const v = failureView("disk_on_fire", ID);
    expect(v.known).toBe(false);
    expect(v.code).toBe("disk_on_fire");
    expect(v.sentence).toContain("disk_on_fire");
    expect(v.logHint).toBeNull();
  });

  it("escapes a hostile or empty code", () => {
    const hostile = failureView("a‮b\u0000c<script>​", ID);
    expect(hostile.code).toBe("a\\u202eb\\x00c<script>\\u200b");
    expect(hostile.sentence).toContain(hostile.code);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the check.
    expect(hostile.sentence).not.toMatch(/[\u0000-\u001f​-‏‪-‮]/);
    const empty = failureView("", ID);
    expect(empty.known).toBe(false);
    expect(empty.sentence.length).toBeGreaterThan(0);
  });

  it("does not take a prototype property name for a known code", () => {
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const v = failureView(word, ID);
      expect(v.known, word).toBe(false);
      expect(v.sentence, word).toContain(word);
    }
  });
});
