import { describe, expect, it } from "vitest";
import {
  extractNumber,
  extractNumberMap,
  extractRegexSource,
  extractSatisfiedArray,
} from "./compute-contract-drift";
import { extractStringArray } from "./mail-contract-drift";

describe("the extractors", () => {
  it("read the shapes the contract files use", () => {
    const state = [
      "export const COMPUTE_STATES = [",
      '  "created", // a comment',
      '  "running",',
      "] as const;",
      'export const TERMINAL = ["finished"] as const satisfies readonly ComputeState[];',
    ].join("\n");
    expect(extractStringArray(state, "COMPUTE_STATES")).toEqual(["created", "running"]);
    expect(extractSatisfiedArray(state, "TERMINAL")).toEqual(["finished"]);
    expect(extractNumber("export const N = 25;", "N")).toBe(25);
    expect(extractNumberMap("export const M = { a: 403, b_c: 401 } as const;", "M")).toEqual({
      a: 403,
      b_c: 401,
    });
    expect(extractRegexSource("export const R = /^job_[0-9a-f]{24}$/;", "R")).toBe(
      "^job_[0-9a-f]{24}$",
    );
  });

  it("answer undefined for a computed value, never a guess", () => {
    expect(extractNumber("export const N = 5 * 5;", "N")).toBeUndefined();
    expect(extractStringArray("export const L = make();", "L")).toBeUndefined();
    expect(extractNumberMap("export const M = build();", "M")).toBeUndefined();
  });
});
