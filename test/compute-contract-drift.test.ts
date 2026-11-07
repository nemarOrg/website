import { describe, expect, it } from "vitest";
import {
  extractNumber,
  extractNumberMap,
  extractProduct,
  extractRegexSource,
  extractSatisfiedArray,
  extractSatisfiedNumberMap,
  extractString,
  extractStringMap,
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

  it("read the maps, strings and products the job page's contract files use", () => {
    const map = [
      "export const STATUS = {",
      "  a: 403,",
      "  // 404: a note with a colon: and a number 12",
      "  b_c: 404,",
      "} as const satisfies Record<Code, number>;",
    ].join("\n");
    expect(extractSatisfiedNumberMap(map, "STATUS")).toEqual({ a: 403, b_c: 404 });
    const sentences = [
      "export const SENT = {",
      "  ...OTHER,",
      '  one: "First sentence.",',
      "  two:",
      '    "Second; with a semicolon.",',
      "} as const satisfies Partial<Record<Code, string>>;",
    ].join("\n");
    expect(extractStringMap(sentences, "SENT")).toEqual({
      one: "First sentence.",
      two: "Second; with a semicolon.",
    });
    expect(extractString('export const H = "X-Nemar-Truncated";', "H")).toBe("X-Nemar-Truncated");
    expect(extractProduct("export const MAX = 1024 * 1024;", "MAX")).toBe(1_048_576);
    expect(extractProduct("export const MAX = 1000;", "MAX")).toBe(1000);
  });

  it("answer undefined for a computed value, never a guess", () => {
    expect(extractProduct("export const N = make(5);", "N")).toBeUndefined();
    expect(extractSatisfiedNumberMap("export const M = build();", "M")).toBeUndefined();
    expect(extractStringMap("export const M = build();", "M")).toBeUndefined();
    expect(extractString("export const S = `a${b}`;", "S")).toBeUndefined();
    expect(extractNumber("export const N = 5 * 5;", "N")).toBeUndefined();
    expect(extractStringArray("export const L = make();", "L")).toBeUndefined();
    expect(extractNumberMap("export const M = build();", "M")).toBeUndefined();
  });
});
