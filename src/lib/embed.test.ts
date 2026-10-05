import { describe, expect, it } from "vitest";
import { buildRecordingList, formatViewSpec, resolveViewParam } from "./eeg-viewer/recording-nav";
import {
  EMBED_IFRAME_HEIGHT,
  datasetPageUrl,
  displayableDatasetId,
  displayableVersion,
  embedRouteDatasetId,
  embedSnippet,
  embedSnippetOrigin,
  embedUrl,
  isEmbedRoute,
  parseEmbedTheme,
} from "./embed";
import { APP_HOST, MARKETING_BASE_URL } from "./host";

describe("embedRouteDatasetId / isEmbedRoute", () => {
  it("matches the embed route with and without a trailing slash", () => {
    expect(embedRouteDatasetId("/dataset/on007753/embed")).toBe("on007753");
    expect(embedRouteDatasetId("/dataset/on007753/embed/")).toBe("on007753");
    expect(embedRouteDatasetId("/dataset/ds007753/embed")).toBe("ds007753");
    expect(isEmbedRoute("/dataset/nm000232/embed")).toBe(true);
  });

  it("matches nothing else, including the dataset page and its other subroutes", () => {
    for (const path of [
      "/",
      "/dataset/on007753",
      "/dataset/on007753/",
      "/dataset/on007753/collaborators",
      "/dataset/on007753.md",
      "/dataset/on007753/embed/extra",
      "/dataset/on007753/embedded",
      "/dataset//embed",
      "/dataset/embed",
      "/datasets/on007753/embed",
      "/x/dataset/on007753/embed",
      "/dataset/on007753/EMBED",
    ]) {
      expect(isEmbedRoute(path), path).toBe(false);
    }
  });

  it("does not decode, so an encoded spelling fails closed", () => {
    // Astro renders the embed page for this path, but the middleware keeps it
    // un-frameable: wrong in the safe direction (see EMBED_ROUTE_RE).
    expect(isEmbedRoute("/dataset/on007753/%65mbed")).toBe(false);
    // An encoded id is still one segment and still the embed route.
    expect(embedRouteDatasetId("/dataset/on%30/embed")).toBe("on%30");
  });
});

describe("parseEmbedTheme", () => {
  it("accepts the two themes, case and whitespace tolerant", () => {
    expect(parseEmbedTheme("light")).toBe("light");
    expect(parseEmbedTheme("dark")).toBe("dark");
    expect(parseEmbedTheme(" Dark ")).toBe("dark");
    expect(parseEmbedTheme("LIGHT")).toBe("light");
  });

  it("returns null, meaning the system preference, for anything else", () => {
    for (const raw of [null, undefined, "", "auto", "system", "darkk", "1"]) {
      expect(parseEmbedTheme(raw), String(raw)).toBeNull();
    }
  });
});

describe("embedSnippetOrigin", () => {
  it("names the serving origin in single-host mode", () => {
    expect(
      embedSnippetOrigin({ origin: "https://test.nemar.org", hostname: "test.nemar.org" }),
    ).toBe("https://test.nemar.org");
    expect(embedSnippetOrigin({ origin: "http://localhost:4321", hostname: "localhost" })).toBe(
      "http://localhost:4321",
    );
  });

  it("names the marketing origin from every production host", () => {
    // A signed-in visitor reads the dataset page on the app host (website#210);
    // a snippet naming it would redirect on every partner page forever.
    for (const host of [APP_HOST, "nemar.org", "www.nemar.org", "ww2.nemar.org"]) {
      expect(embedSnippetOrigin({ origin: `https://${host}`, hostname: host }), host).toBe(
        MARKETING_BASE_URL,
      );
    }
  });
});

describe("embedUrl", () => {
  it("builds the embed URL for a recording", () => {
    expect(embedUrl("https://nemar.org", "on007753", "sub-05_task-BCCWJreading")).toBe(
      "https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading",
    );
  });

  it("pins a version only when asked", () => {
    expect(embedUrl("https://nemar.org", "on007753", "sub-05_task-BCCWJreading", "v1.0.0")).toBe(
      "https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading&v=v1.0.0",
    );
    expect(embedUrl("https://nemar.org", "on007753", "sub-05_task-BCCWJreading", null)).toBe(
      "https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading",
    );
  });

  it("encodes a path-shaped spec from a recording with no BIDS entities", () => {
    // `formatViewSpec` falls back to the raw path; it has to survive the trip.
    const url = embedUrl("http://localhost:4321", "on000001", "raw/session one.edf");
    expect(url).toBe("http://localhost:4321/dataset/on000001/embed?view=raw%2Fsession+one.edf");
    expect(new URL(url).searchParams.get("view")).toBe("raw/session one.edf");
  });

  it("round-trips through the same resolver the dataset page uses", () => {
    // The point of sharing `?view=`: a spec the snippet writes resolves to the
    // recording it was written for. Paths are real on007753 and on004696 Zarr
    // index entries (the latter a sessioned, run-numbered MEF3 directory).
    const recordings = buildRecordingList([
      "sub-01/eeg/sub-01_task-BCCWJreading_eeg.vhdr",
      "sub-05/eeg/sub-05_task-BCCWJreading_eeg.vhdr",
      "sub-06/eeg/sub-06_task-BCCWJreading_eeg.vhdr",
      "sub-01/ses-ieeg01/ieeg/sub-01_ses-ieeg01_task-ccep_run-01_ieeg.mefd",
    ]);
    for (const entry of recordings) {
      const url = new URL(embedUrl("https://nemar.org", "on007753", formatViewSpec(entry)));
      expect(resolveViewParam(recordings, url.searchParams.get("view"))?.path).toBe(entry.path);
    }
  });
});

describe("datasetPageUrl", () => {
  it("links to the dataset page on the given origin", () => {
    expect(datasetPageUrl("https://test.nemar.org", "on007753")).toBe(
      "https://test.nemar.org/dataset/on007753",
    );
  });

  it("carries the version and the recording when given", () => {
    expect(
      datasetPageUrl("https://nemar.org", "on007753", {
        version: "v1.0.0",
        viewSpec: "sub-05_task-BCCWJreading",
      }),
    ).toBe("https://nemar.org/dataset/on007753?v=v1.0.0&view=sub-05_task-BCCWJreading");
    expect(datasetPageUrl("https://nemar.org", "on007753", { viewSpec: "sub-05" })).toBe(
      "https://nemar.org/dataset/on007753?view=sub-05",
    );
  });
});

describe("embedSnippet", () => {
  it("is exactly the snippet #410 specifies", () => {
    expect(
      embedSnippet(
        "https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading",
        "sub-05_task-BCCWJreading_eeg.vhdr",
      ),
    ).toBe(
      '<iframe src="https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading" width="100%" height="560" style="border:0" loading="lazy" referrerpolicy="origin" allowfullscreen title="NEMAR signal viewer: sub-05_task-BCCWJreading_eeg.vhdr"></iframe>',
    );
    expect(EMBED_IFRAME_HEIGHT).toBe(560);
  });

  it("escapes the src, so a pinned version's & is valid HTML", () => {
    const snippet = embedSnippet(
      embedUrl("https://nemar.org", "on007753", "sub-05_task-BCCWJreading", "v1.0.0"),
      "sub-05_task-BCCWJreading_eeg.vhdr",
    );
    expect(snippet).toContain(
      'src="https://nemar.org/dataset/on007753/embed?view=sub-05_task-BCCWJreading&amp;v=v1.0.0"',
    );
  });

  it("escapes a recording name that would otherwise break out of the title", () => {
    const snippet = embedSnippet(
      "https://nemar.org/dataset/on007753/embed?view=sub-05",
      'a"><script>&',
    );
    expect(snippet).toContain('title="NEMAR signal viewer: a&quot;&gt;&lt;script&gt;&amp;"');
    expect(snippet).not.toContain("<script>");
  });
});

describe("displayableDatasetId", () => {
  it("echoes ids shaped like NEMAR's and OpenNeuro's", () => {
    for (const id of ["on007753", "ds007753", "nm000292", "on004696", "xx000001"]) {
      expect(displayableDatasetId(id), id).toBe(id);
    }
  });

  it("refuses arbitrary path text, which a framing site could use to put words on the page", () => {
    for (const id of [
      "Your account is suspended, call 555",
      "<script>",
      "on007753 visit example.com",
      "",
      "a".repeat(41),
      "on007753\n",
    ]) {
      expect(displayableDatasetId(id), JSON.stringify(id)).toBeNull();
    }
  });
});

describe("displayableVersion", () => {
  it("echoes version tokens", () => {
    for (const v of ["v1.0.0", "v1.0.1", "1.0.2", "v2.0.0-rc.1"]) {
      expect(displayableVersion(v), v).toBe(v);
    }
  });

  it("refuses the framing site's own text", () => {
    for (const v of ["Your account is suspended, call 555-0100", "<b>", "", "v".repeat(41), "v1\n"]) {
      expect(displayableVersion(v), JSON.stringify(v)).toBeNull();
    }
  });
});
