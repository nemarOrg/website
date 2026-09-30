import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  // CI runs in UTC, where local time and UTC are the same, so a helper that
  // parsed or formatted in local time would still pass there. Pin the process
  // zone per case instead: Los Angeles lags UTC and Auckland leads it, so the
  // two boundary values below catch a slip in either direction.
  describe.each(["America/Los_Angeles", "Pacific/Auckland"])(
    "reads the zoneless SQLite value as UTC, not as local time, in %s",
    (zone) => {
      const originalZone = process.env.TZ;

      beforeEach(() => {
        process.env.TZ = zone;
      });

      afterEach(() => {
        // Assigning undefined would store the string "undefined", so remove the key.
        if (originalZone === undefined) Reflect.deleteProperty(process.env, "TZ");
        else process.env.TZ = originalZone;
      });

      it("keeps the UTC calendar date just after midnight", () => {
        // 01:00 UTC on the 25th is still the 24th in Los Angeles.
        expect(formatReleaseDate({ latest_version_at: "2026-09-25 01:00:00" })).toBe(
          "Sep 25, 2026",
        );
      });

      it("keeps the UTC calendar date just before midnight", () => {
        // 23:59 UTC on the 24th is already the 25th in Auckland.
        expect(formatReleaseDate({ latest_version_at: "2026-09-24 23:59:59" })).toBe(
          "Sep 24, 2026",
        );
      });
    },
  );

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
