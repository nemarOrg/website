import { describe, expect, it } from "vitest";
import {
  keywordHref,
  licenseHref,
  licenseTier,
  modalityFilterCode,
  modalityHref,
  modalityVariant,
} from "./tags";
import { LICENSE_TIERS } from "./types";

describe("modalityVariant", () => {
  it("maps the four known codes case-insensitively", () => {
    expect(modalityVariant("EEG")).toBe("eeg");
    expect(modalityVariant("eeg")).toBe("eeg");
    expect(modalityVariant("MEG")).toBe("meg");
    expect(modalityVariant("iEEG")).toBe("ieeg");
    expect(modalityVariant("IEEG")).toBe("ieeg");
    expect(modalityVariant("EMG")).toBe("emg");
  });

  it("falls back to other for anything else", () => {
    expect(modalityVariant("MRI")).toBe("other");
    expect(modalityVariant("fMRI")).toBe("other");
    expect(modalityVariant("")).toBe("other");
  });
});

describe("modalityFilterCode / modalityHref", () => {
  it("returns the canonical code (preserving iEEG casing)", () => {
    expect(modalityFilterCode("eeg")).toBe("EEG");
    expect(modalityFilterCode("ieeg")).toBe("iEEG");
  });

  it("is null for modalities the catalog filter can't target", () => {
    expect(modalityFilterCode("MRI")).toBeNull();
    expect(modalityHref("MRI")).toBeNull();
  });

  it("builds a /discover link for known modalities", () => {
    expect(modalityHref("EEG")).toBe("/discover?modality=EEG");
    expect(modalityHref("iEEG")).toBe("/discover?modality=iEEG");
  });

  it("covers MEG and EMG (the non-iEEG-special-cased codes)", () => {
    expect(modalityFilterCode("meg")).toBe("MEG");
    expect(modalityFilterCode("EMG")).toBe("EMG");
    expect(modalityHref("MEG")).toBe("/discover?modality=MEG");
    expect(modalityHref("emg")).toBe("/discover?modality=EMG");
  });
});

describe("keywordHref", () => {
  it("encodes the term into a Discover search", () => {
    expect(keywordHref("resting-state")).toBe("/discover?q=resting-state");
    expect(keywordHref("eyes closed")).toBe("/discover?q=eyes%20closed");
    expect(keywordHref("  trimmed ")).toBe("/discover?q=trimmed");
  });

  it("produces a bare q param for an empty term (caller is expected to guard)", () => {
    expect(keywordHref("")).toBe("/discover?q=");
    expect(keywordHref("   ")).toBe("/discover?q=");
  });
});

describe("licenseTier", () => {
  it("treats missing / blank as unknown", () => {
    expect(licenseTier(null)).toBe("unknown");
    expect(licenseTier(undefined)).toBe("unknown");
    expect(licenseTier("")).toBe("unknown");
    expect(licenseTier("   ")).toBe("unknown");
  });

  it("classifies public-domain licenses, including multi-word/spaced forms", () => {
    expect(licenseTier("CC0")).toBe("public");
    expect(licenseTier("CC0-1.0")).toBe("public");
    expect(licenseTier("CC0 1.0 Universal")).toBe("public");
    expect(licenseTier("PDDL")).toBe("public");
    expect(licenseTier("Public Domain")).toBe("public");
    expect(licenseTier("Unlicense")).toBe("public");
    expect(licenseTier("The Unlicense")).toBe("public");
  });

  it("does NOT read all-rights-reserved 'UNLICENSED' as public domain", () => {
    // Misclassifying toward more-permissive is the dangerous direction.
    expect(licenseTier("UNLICENSED")).toBe("unknown");
    expect(licenseTier("Unlicensed")).toBe("unknown");
  });

  it("does not classify a free-text license containing the preposition 'by'", () => {
    expect(licenseTier("Data provided by OpenNeuro under restricted terms")).toBe("unknown");
  });

  it("passes an already-classified tier name straight through", () => {
    for (const tier of LICENSE_TIERS) {
      expect(licenseTier(tier)).toBe(tier);
    }
    expect(licenseTier("PUBLIC")).toBe("public");
  });

  it("classifies plain attribution", () => {
    expect(licenseTier("CC-BY")).toBe("attribution");
    expect(licenseTier("CC-BY-4.0")).toBe("attribution");
    expect(licenseTier("ODC-BY")).toBe("attribution");
  });

  it("classifies share-alike", () => {
    expect(licenseTier("CC-BY-SA-4.0")).toBe("sharealike");
    expect(licenseTier("ODbL")).toBe("sharealike");
  });

  it("classifies non-commercial, tolerating spacing/hyphenation drift", () => {
    expect(licenseTier("CC-BY-NC 4.0")).toBe("noncommercial");
    expect(licenseTier("CC-BY-NC-4.0")).toBe("noncommercial");
    // NC + SA together lands in the stricter NC tier.
    expect(licenseTier("CC-BY-NC-SA-4.0")).toBe("noncommercial");
    expect(licenseTier("CC-BY-NC-SA 4.0")).toBe("noncommercial");
  });

  it("classifies no-derivatives as the most restrictive, even combined", () => {
    expect(licenseTier("CC-BY-ND-4.0")).toBe("noderiv");
    expect(licenseTier("CC-BY-NC-ND-4.0")).toBe("noderiv");
  });

  it("does not false-positive on words containing tier markers", () => {
    // "AND"/"GRAND" contain ND but not as a standalone token.
    expect(licenseTier("Brand New License")).toBe("unknown");
  });
});

describe("licenseHref", () => {
  it("links to the tier filter on Discover", () => {
    expect(licenseHref("CC0")).toBe("/discover?license=public");
    expect(licenseHref("CC-BY-NC-4.0")).toBe("/discover?license=noncommercial");
    expect(licenseHref(null)).toBe("/discover?license=unknown");
  });
});

describe("LICENSE_TIERS ordering (permissiveness thermometer)", () => {
  it("runs most-open to most-restrictive, with unknown as the sentinel last", () => {
    // The sidebar color ramp + "green is most permissive, red most restrictive"
    // tooltip depend on this order. Lock it so a reorder can't pass silently.
    expect(LICENSE_TIERS).toEqual([
      "public",
      "attribution",
      "sharealike",
      "noncommercial",
      "noderiv",
      "unknown",
    ]);
  });
});
