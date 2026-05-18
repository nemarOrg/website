import { describe, expect, it } from "vitest";
import {
  formatAuthorByline,
  formatBytes,
  formatCount,
  formatDate,
  formatRelativeTime,
  splitModalities,
} from "./format";

describe("formatAuthorByline", () => {
  it("returns empty for nullish or whitespace-only input", () => {
    expect(formatAuthorByline(null)).toBe("");
    expect(formatAuthorByline(undefined)).toBe("");
    expect(formatAuthorByline("")).toBe("");
    expect(formatAuthorByline("   ")).toBe("");
    expect(formatAuthorByline(", ,")).toBe("");
  });
  it("returns a single author verbatim (trimmed)", () => {
    expect(formatAuthorByline("Arnaud Delorme")).toBe("Arnaud Delorme");
    expect(formatAuthorByline("  Daniel G. Wakeman  ")).toBe("Daniel G. Wakeman");
  });
  it("returns first author with et al. when there are 2 or more", () => {
    expect(formatAuthorByline("Daniel G. Wakeman, Richard N Henson")).toBe(
      "Daniel G. Wakeman et al.",
    );
    expect(
      formatAuthorByline("Jonel Morris, Kenneth Cruz, Raydeep Kainth, Daniel Ferris"),
    ).toBe("Jonel Morris et al.");
  });
  it("ignores empty entries between commas", () => {
    expect(formatAuthorByline("Daniel G. Wakeman,, Richard N Henson")).toBe(
      "Daniel G. Wakeman et al.",
    );
    expect(formatAuthorByline(",Arnaud Delorme,")).toBe("Arnaud Delorme");
  });
});

describe("formatBytes", () => {
  it("returns 0 B for zero or negative", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
  it("renders bytes without decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("renders KB and MB with up to 2 decimals when small", () => {
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(2.5 * 1024)).toBe("2.50 KB");
    expect(formatBytes(50 * 1024)).toBe("50.0 KB");
  });
  it("renders GB and TB on big values", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB");
    expect(formatBytes(270 * 1024 ** 3)).toBe("270 GB");
    expect(formatBytes(50 * 1024 ** 4)).toBe("50.0 TB");
  });
});

describe("formatCount", () => {
  it("returns 0 for invalid", () => {
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(-3)).toBe("0");
  });
  it("returns plain integer under 1000", () => {
    expect(formatCount(42)).toBe("42");
    expect(formatCount(999)).toBe("999");
  });
  it("returns K-suffixed in the thousands", () => {
    expect(formatCount(1_500)).toBe("1.5K");
    expect(formatCount(29_344)).toBe("29K");
  });
  it("returns M-suffixed in the millions", () => {
    expect(formatCount(1_500_000)).toBe("1.5M");
    expect(formatCount(60_000_000)).toBe("60M");
  });
});

describe("splitModalities", () => {
  it("handles empty input", () => {
    expect(splitModalities(null)).toEqual([]);
    expect(splitModalities("")).toEqual([]);
    expect(splitModalities("  ,  ")).toEqual([]);
  });
  it("splits and dedupes", () => {
    expect(splitModalities("eeg,EEG,meg")).toEqual(["EEG", "MEG"]);
  });
  it("preserves BIDS casing", () => {
    expect(splitModalities("ieeg,fmri,ecog")).toEqual(["iEEG", "fMRI", "ECoG"]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-15T12:00:00Z");
  it("renders past dates", () => {
    expect(formatRelativeTime("2026-05-14T12:00:00Z", now)).toMatch(/yesterday|1 day ago/);
  });
  it("returns empty for invalid", () => {
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});

describe("formatDate", () => {
  it("renders an ISO timestamp", () => {
    expect(formatDate("2025-10-09T09:04:56Z")).toBe("Oct 9, 2025");
  });
  it("returns empty for invalid", () => {
    expect(formatDate("nope")).toBe("");
  });
});
