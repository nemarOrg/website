import { describe, expect, it } from "vitest";
import { findReadmePathInSummary } from "./data-api";
import type { Summary } from "./data-api";

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    dataset_id: "nm000103",
    version: "v1.0.0",
    paths: [],
    ...overrides,
  };
}

describe("findReadmePathInSummary", () => {
  it("returns readme.path when present", () => {
    const s = makeSummary({ readme: { path: "README.md" }, paths: [] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });

  it("returns path from paths when readme field absent", () => {
    const s = makeSummary({ paths: ["dataset_description.json", "README.md", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });

  it("matches case-insensitively from paths", () => {
    const s = makeSummary({ paths: ["readme"] });
    expect(findReadmePathInSummary(s)).toBe("readme");
  });

  it("matches README.txt from paths", () => {
    const s = makeSummary({ paths: ["README.txt", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBe("README.txt");
  });

  it("returns null when no readme anywhere", () => {
    const s = makeSummary({ paths: ["dataset_description.json", "sub-01/x.txt"] });
    expect(findReadmePathInSummary(s)).toBeNull();
  });

  it("returns null for empty summary", () => {
    const s = makeSummary({ paths: [] });
    expect(findReadmePathInSummary(s)).toBeNull();
  });

  it("prefers readme.path over paths list", () => {
    const s = makeSummary({ readme: { path: "docs/README.md" }, paths: ["README.md"] });
    expect(findReadmePathInSummary(s)).toBe("docs/README.md");
  });

  it("falls through to paths when readme.path is absent (empty readme object)", () => {
    const s = makeSummary({ readme: {}, paths: ["README.md"] });
    expect(findReadmePathInSummary(s)).toBe("README.md");
  });
});
