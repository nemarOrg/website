/**
 * The extractors behind the mail contract drift check, proved on this repo's own copy and on
 * inline sources, so the drift test cannot pass vacuously on a machine with no nemar-cli beside
 * it (the same reason `copy-drift.ts` is a separate module).
 */

import { describe, expect, it } from "vitest";
import {
  MAIL_ERROR_CODES,
  QUEUE_STRATEGIES,
  SETTABLE_STATUSES,
  TICKET_STATUSES,
} from "../src/lib/mail-admin-contract";
import CONTRACT_COPY from "../src/lib/mail-admin-contract.ts?raw";
import { compareLists, extractStringArray, extractStringUnion } from "./mail-contract-drift";

describe("extractStringArray", () => {
  it("reads every list out of this repo's copy and agrees with the values it exports", () => {
    expect(extractStringArray(CONTRACT_COPY, "TICKET_STATUSES")).toEqual([...TICKET_STATUSES]);
    expect(extractStringArray(CONTRACT_COPY, "SETTABLE_STATUSES")).toEqual([...SETTABLE_STATUSES]);
    expect(extractStringArray(CONTRACT_COPY, "QUEUE_STRATEGIES")).toEqual([...QUEUE_STRATEGIES]);
    expect(extractStringArray(CONTRACT_COPY, "MAIL_ERROR_CODES")).toEqual([...MAIL_ERROR_CODES]);
  });

  it("returns undefined for a name that is absent or not a literal list", () => {
    expect(extractStringArray("export const A = [1, 2] as const;", "B")).toBeUndefined();
    expect(extractStringArray("export const A = makeList();", "A")).toBeUndefined();
  });

  it("ignores a list quoted in a comment", () => {
    const src = '// export const A = ["x"] as const;\n/* export const A = ["y"] as const; */';
    expect(extractStringArray(src, "A")).toBeUndefined();
  });
});

describe("extractStringUnion", () => {
  it("reads a leading-bar union across lines", () => {
    const src = 'export type Code =\n  | "a"\n  | "b_c"\n  | "d";';
    expect(extractStringUnion(src, "Code")).toEqual(["a", "b_c", "d"]);
  });

  it("refuses a type that is not a pure literal union, rather than reading part of it", () => {
    expect(extractStringUnion("export type Code = (typeof LIST)[number];", "Code")).toBeUndefined();
    expect(extractStringUnion('export type Code = "a" | Other;', "Code")).toBeUndefined();
  });
});

describe("compareLists", () => {
  it("is null for equal lists and names both sides of a difference", () => {
    expect(compareLists("L", ["a", "b"], ["a", "b"])).toBeNull();
    const added = compareLists("L", ["a"], ["a", "b"]);
    expect(added).toContain("only in the contract: [\"b\"]");
    const removed = compareLists("L", ["a", "b"], ["a"]);
    expect(removed).toContain("only here: [\"b\"]");
  });

  it("treats a reorder as drift and a missing list as drift", () => {
    expect(compareLists("L", ["a", "b"], ["b", "a"])).not.toBeNull();
    expect(compareLists("L", ["a"], undefined)).toContain("not found");
  });
});
