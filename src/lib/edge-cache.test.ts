import { describe, expect, it } from "vitest";
import { CLIENT_ONLY_QUERY_PARAMS, edgeCacheUrl } from "./edge-cache";

describe("edgeCacheUrl", () => {
  it("collapses deep links to one key per page", () => {
    const a = edgeCacheUrl("https://nemar.org/dataset/on000001?view=sub-01_task-rest");
    const b = edgeCacheUrl("https://nemar.org/dataset/on000001?view=sub-99_task-oddball");
    expect(a).toBe("https://nemar.org/dataset/on000001");
    expect(a).toBe(b);
  });

  it("keeps parameters the server renders from", () => {
    // `?v=` picks the version the SSR path fetches; stripping it would serve
    // one version's HTML under another's key.
    expect(edgeCacheUrl("https://nemar.org/dataset/on000001?v=1.0.2&view=sub-01")).toBe(
      "https://nemar.org/dataset/on000001?v=1.0.2",
    );
    expect(edgeCacheUrl("https://nemar.org/discover?modality=eeg&page=3")).toBe(
      "https://nemar.org/discover?modality=eeg&page=3",
    );
  });

  it("returns the input untouched when there is nothing to strip", () => {
    const url = "https://nemar.org/dataset/on000001?v=1.0.2";
    expect(edgeCacheUrl(url)).toBe(url);
  });

  it("preserves the fragment and an empty parameter value", () => {
    expect(edgeCacheUrl("https://nemar.org/dataset/on000001?view=#files")).toBe(
      "https://nemar.org/dataset/on000001#files",
    );
  });

  it("survives a value it cannot parse as a URL", () => {
    expect(edgeCacheUrl("not-a-url")).toBe("not-a-url");
  });

  it("lists only parameters read in the browser", () => {
    expect(CLIENT_ONLY_QUERY_PARAMS).toEqual(["view"]);
  });
});
