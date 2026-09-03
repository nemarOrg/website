import { describe, expect, it } from "vitest";
import { citeKindLabel, citedByLabel } from "./citation-labels";

describe("citeKindLabel", () => {
  it("names what the citing work cites, with the article on both sides", () => {
    expect(citeKindLabel("dataset")).toBe("Cites the dataset");
    expect(citeKindLabel("paper")).toBe("Cites the paper");
  });
});

describe("citedByLabel", () => {
  it("hides zero, missing, and malformed counts", () => {
    expect(citedByLabel(0)).toBeNull();
    expect(citedByLabel(undefined)).toBeNull();
    expect(citedByLabel(null)).toBeNull();
    expect(citedByLabel("12")).toBeNull();
    expect(citedByLabel(Number.NaN)).toBeNull();
    expect(citedByLabel(-3)).toBeNull();
  });

  it("uses the singular for exactly one", () => {
    expect(citedByLabel(1)).toBe("cited once");
  });

  it("uses the caller's formatter for the plural", () => {
    expect(citedByLabel(36)).toBe("cited 36 times");
    expect(citedByLabel(1234)).toBe("cited 1,234 times");
    expect(citedByLabel(1234, (n) => String(n))).toBe("cited 1234 times");
  });
});
