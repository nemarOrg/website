import { describe, expect, it } from "vitest";
import { searchResultToDataset } from "./api";
import { formatReleaseDate } from "./release-date";
import type { Dataset } from "./types";

describe("formatReleaseDate", () => {
  it("renders the latest version's release date", () => {
    expect(formatReleaseDate({ latest_version_at: "2026-09-24 17:53:13" })).toBe("Sep 24, 2026");
  });

  it("shows the release date when the row was touched after it", () => {
    // nm000279 shape: released 2026-09-16, row rewritten by the 2026-09-29
    // enrichment sweep. The sweep's date must not leak into the card.
    const row = {
      created_at: "2026-07-05 20:31:40",
      first_published_at: "2026-09-16 17:22:37",
      updated_at: "2026-09-29 23:29:20",
      latest_version: "v1.0.0",
      latest_version_at: "2026-09-16 17:22:05",
    };
    expect(formatReleaseDate(row)).toBe("Sep 16, 2026");
  });

  it("returns empty, not updated_at, when the row has no version date", () => {
    const row = { updated_at: "2026-09-29 23:29:20", latest_version_at: null };
    expect(formatReleaseDate(row)).toBe("");
  });

  it("returns empty when the API predates the field", () => {
    const row: Partial<Dataset> = { updated_at: "2026-09-29 23:29:20" };
    expect(formatReleaseDate(row)).toBe("");
  });

  it("returns empty for undefined, empty and malformed values", () => {
    expect(formatReleaseDate({ latest_version_at: undefined })).toBe("");
    expect(formatReleaseDate({ latest_version_at: "" })).toBe("");
    expect(formatReleaseDate({ latest_version_at: "yesterday" })).toBe("");
  });

  it("reads the zoneless SQLite value as UTC, not as the runtime's local time", () => {
    // 01:00 UTC on the 25th is still the 24th in San Diego; the date shown
    // must be the UTC calendar date on any machine.
    expect(formatReleaseDate({ latest_version_at: "2026-09-25 01:00:00" })).toBe("Sep 25, 2026");
    expect(formatReleaseDate({ latest_version_at: "2026-09-24 23:59:59" })).toBe("Sep 24, 2026");
  });

  it("accepts an RFC3339 value that already carries a zone", () => {
    expect(formatReleaseDate({ latest_version_at: "2026-09-24T17:53:13Z" })).toBe("Sep 24, 2026");
  });

  it("shows nothing on the search-hit fallback row", () => {
    const row = searchResultToDataset({
      id: "nm000287",
      name: "Muse Sleep-Onset EEG",
      doi: "10.82901/nemar.nm000287",
      modalities: "eeg",
      participants: 203,
      tasks: "sleeponset",
      authors: "Muse Team",
      score: 0.91,
    });
    expect(formatReleaseDate(row)).toBe("");
  });
});
