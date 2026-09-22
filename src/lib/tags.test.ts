import { describe, expect, it } from "vitest";
import {
  isZarrVerifyStatus,
  keywordHref,
  licenseHref,
  licenseTier,
  modalityFilterCode,
  modalityHref,
  modalityVariant,
  zarrTag,
} from "./tags";
import { LICENSE_TIERS } from "./types";

describe("modalityVariant", () => {
  it("maps the known codes case-insensitively", () => {
    expect(modalityVariant("EEG")).toBe("eeg");
    expect(modalityVariant("eeg")).toBe("eeg");
    expect(modalityVariant("MEG")).toBe("meg");
    expect(modalityVariant("iEEG")).toBe("ieeg");
    expect(modalityVariant("IEEG")).toBe("ieeg");
    expect(modalityVariant("EMG")).toBe("emg");
    expect(modalityVariant("nirs")).toBe("nirs");
    expect(modalityVariant("NIRS")).toBe("nirs");
    expect(modalityVariant("motion")).toBe("motion");
    expect(modalityVariant("MOTION")).toBe("motion");
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

  it("targets the expanded NIRS and motion modalities", () => {
    expect(modalityFilterCode("nirs")).toBe("NIRS");
    expect(modalityFilterCode("motion")).toBe("MOTION");
    expect(modalityHref("nirs")).toBe("/discover?modality=NIRS");
    expect(modalityHref("MOTION")).toBe("/discover?modality=MOTION");
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

describe("isZarrVerifyStatus (website#277)", () => {
  it("accepts the three sweep verdicts", () => {
    expect(isZarrVerifyStatus("verified")).toBe(true);
    expect(isZarrVerifyStatus("failed")).toBe(true);
    expect(isZarrVerifyStatus("unverifiable")).toBe(true);
  });
  it("rejects null, undefined, and any other string", () => {
    expect(isZarrVerifyStatus(null)).toBe(false);
    expect(isZarrVerifyStatus(undefined)).toBe(false);
    expect(isZarrVerifyStatus("pending")).toBe(false);
    expect(isZarrVerifyStatus("")).toBe(false);
  });
});

describe("zarrTag (website#277, #346)", () => {
  const ready = { zarr_status: "ready", zarr_store_count: 8 };

  it("renders nothing for a row without a Zarr copy", () => {
    expect(zarrTag(null)).toBeNull();
    expect(zarrTag(undefined)).toBeNull();
    expect(zarrTag({ zarr_status: "ready", zarr_store_count: 0 })).toBeNull();
    expect(zarrTag({ zarr_status: null, zarr_store_count: null })).toBeNull();
  });

  it("keys on the copy existing, not on a sweep verdict (the on* mirrors carry none)", () => {
    const tag = zarrTag({ ...ready, zarr_verify_status: null });
    expect(tag).toMatchObject({ label: "Zarr", kind: "positive" });
    expect(tag?.title).toContain("hasn't checked it yet");
  });

  it("stays a green Zarr tag for verified and unverifiable copies, verdict in the tooltip", () => {
    const verified = zarrTag({ ...ready, zarr_verify_status: "verified" });
    expect(verified).toMatchObject({ label: "Zarr", kind: "positive" });
    expect(verified?.title).toContain("channels.tsv");
    // unverifiable means no check could run, which must not read as failure.
    const unverifiable = zarrTag({ ...ready, zarr_verify_status: "unverifiable" });
    expect(unverifiable).toMatchObject({ label: "Zarr", kind: "positive" });
    expect(unverifiable?.title).toContain("does not mean it failed");
  });

  it("flags a failed check as a fidelity issue in amber (PR #278 review)", () => {
    expect(zarrTag({ ...ready, zarr_verify_status: "failed" })).toMatchObject({
      label: "Zarr fidelity issue",
      kind: "warning",
    });
  });

  it("does not tag a failed conversion even when the sweep stamped it failed", () => {
    // Live on 2026-09-22: one nm* row had zarr_status "failed" with stores
    // left behind and a "failed" verdict. has_zarr=1 excludes it, so the tag
    // must too.
    expect(
      zarrTag({ zarr_status: "failed", zarr_store_count: 3, zarr_verify_status: "failed" }),
    ).toBeNull();
  });

  it("treats an unrecognized verdict string as not yet checked", () => {
    expect(zarrTag({ ...ready, zarr_verify_status: "pending" })?.title).toContain(
      "hasn't checked it yet",
    );
  });

  it("writes every tooltip as whole sentences", () => {
    for (const status of [null, "verified", "unverifiable", "failed"]) {
      const title = zarrTag({ ...ready, zarr_verify_status: status })?.title ?? "";
      expect(title.length).toBeGreaterThan(0);
      expect(title.endsWith(".")).toBe(true);
    }
  });
});
