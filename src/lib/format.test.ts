import { describe, expect, it } from "vitest";
import fundingNm000103 from "../../test/fixtures/funding-nm000103.json";
import {
  displayableFunding,
  formatAuthorByline,
  formatBytes,
  formatChannels,
  formatCount,
  formatDate,
  formatRelativeTime,
  safeSnippet,
  splitModalities,
} from "./format";
import type { Funding } from "./neuroschema";

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
    expect(formatAuthorByline("Jonel Morris, Kenneth Cruz, Raydeep Kainth, Daniel Ferris")).toBe(
      "Jonel Morris et al.",
    );
  });
  it("ignores empty entries between commas", () => {
    expect(formatAuthorByline("Daniel G. Wakeman,, Richard N Henson")).toBe(
      "Daniel G. Wakeman et al.",
    );
    expect(formatAuthorByline(",Arnaud Delorme,")).toBe("Arnaud Delorme");
  });
  it("treats a whitespace-only first slot as missing, not as a name", () => {
    expect(formatAuthorByline("  , Richard N Henson")).toBe("Richard N Henson");
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

describe("safeSnippet", () => {
  it("returns empty for nullish input", () => {
    expect(safeSnippet(null)).toBe("");
    expect(safeSnippet(undefined)).toBe("");
    expect(safeSnippet("")).toBe("");
  });

  it("preserves <mark> highlight tags from the backend snippet()", () => {
    const raw = "…We tested their <mark>memory</mark> of these objects…";
    expect(safeSnippet(raw)).toBe("…We tested their <mark>memory</mark> of these objects…");
  });

  it("escapes other HTML so README content can't inject markup", () => {
    const raw = "a <script>alert(1)</script> & <b>bold</b> <mark>hit</mark>";
    const out = safeSnippet(raw);
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("<mark>hit</mark>");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<b>");
  });

  it("does not let a forged mark tag with attributes through", () => {
    const raw = '<mark onmouseover="x">hi</mark>';
    const out = safeSnippet(raw);
    // The attribute-bearing open tag stays escaped; only bare <mark> is restored.
    expect(out).toContain("&lt;mark onmouseover=");
    expect(out).toContain("</mark>");
    expect(out).not.toContain("<mark onmouseover");
  });
});

describe("formatChannels", () => {
  it("appends the electrode system when present", () => {
    expect(formatChannels(30, "10-10")).toBe("30 (10-10)");
  });

  it("returns the bare count when the electrode system is missing", () => {
    expect(formatChannels(64, null)).toBe("64");
    expect(formatChannels(64, undefined)).toBe("64");
    expect(formatChannels(64, "")).toBe("64");
  });

  it("returns null when there is no positive count", () => {
    expect(formatChannels(null, "10-10")).toBeNull();
    expect(formatChannels(undefined, "10-10")).toBeNull();
    expect(formatChannels(0, "10-10")).toBeNull();
    expect(formatChannels(-4, "10-10")).toBeNull();
    expect(formatChannels(Number.NaN, "10-10")).toBeNull();
  });
});

describe("displayableFunding", () => {
  it("returns empty for nullish input", () => {
    expect(displayableFunding(null)).toEqual([]);
    expect(displayableFunding(undefined)).toEqual([]);
    expect(displayableFunding([])).toEqual([]);
  });

  it("resolves funder_name from the real nm000103 funding block (#204)", () => {
    // Captured from data.nemar.org/nm000103/metadata.json. The field is
    // funder_name; the rail used to read `funder` and rendered two blank
    // spans on this exact dataset.
    const funding = fundingNm000103 as Funding[];
    const shown = displayableFunding(funding);
    expect(shown).toHaveLength(2);
    expect(shown.map((f) => f.funderName)).toEqual([
      "See https://childmind.org/science/global-open-science/healthy-brain-network/#donors",
      "NIH",
    ]);
    expect(shown[1].award_number).toBe("R01MH125934");
  });

  it("drops entries with no usable funder name rather than rendering a blank chip", () => {
    const shown = displayableFunding([
      { funder_name: null, award_number: "A-1" },
      { funder_name: "   ", award_number: "A-2" },
      { funder_name: "NSF", award_number: "A-3" },
    ]);
    expect(shown.map((f) => f.funderName)).toEqual(["NSF"]);
  });

  it("trims surrounding whitespace on the resolved name", () => {
    expect(displayableFunding([{ funder_name: "  NIH  " }])[0].funderName).toBe("NIH");
  });

  it("preserves the other fields on each entry", () => {
    const [entry] = displayableFunding([
      { funder_name: "NIH", award_number: "R01", award_title: "T", award_uri: null },
    ]);
    expect(entry.award_title).toBe("T");
    expect(entry.award_uri).toBeNull();
  });
});
