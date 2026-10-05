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

  it("collapses the embed's theme choice too", () => {
    // `?theme=` is applied before first paint in the browser (website#410), so
    // a partner's light embed and another's dark one are the same HTML.
    const light = edgeCacheUrl(
      "https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading&theme=light",
    );
    const dark = edgeCacheUrl(
      "https://nemar.org/dataset/on007753/embed?theme=dark&view=sub-05_task-BCCWJreading",
    );
    expect(light).toBe("https://nemar.org/dataset/on007753/embed");
    expect(dark).toBe(light);
    // `?v=` is still the server's to read on the embed route as on the page.
    expect(edgeCacheUrl("https://nemar.org/dataset/on007753/embed?v=v1.0.0&theme=dark")).toBe(
      "https://nemar.org/dataset/on007753/embed?v=v1.0.0",
    );
  });

  it("lists only parameters read in the browser", () => {
    expect(CLIENT_ONLY_QUERY_PARAMS).toEqual(["view", "theme"]);
  });
});
