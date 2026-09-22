/**
 * The tag "bible" in code: the single source of truth for classifying the
 * three clickable tag families (modality, license, keyword) and for the
 * /discover links they point at. Colors for each family live as tokens in
 * `src/styles/tokens.css`; the written reference is in
 * `.rules/design-language.md` ("Tag color bible"). `Tag.astro` consumes
 * this module; nothing here renders markup.
 */

import { LICENSE_TIERS, type LicenseTier, MODALITY_CODES, type ModalityCode } from "./types";
import { type ZarrCopyFields, hasZarrCopy } from "./zarr-base";

// --- Modality ---------------------------------------------------------------

/** Color variant for a modality tag. Mirrors the `--modality-*` tokens. */
export type ModalityVariant = "eeg" | "meg" | "ieeg" | "emg" | "nirs" | "motion" | "other";

export function modalityVariant(modality: string): ModalityVariant {
  switch (modality.trim().toUpperCase()) {
    case "EEG":
      return "eeg";
    case "MEG":
      return "meg";
    case "IEEG":
      return "ieeg";
    case "EMG":
      return "emg";
    case "NIRS":
      return "nirs";
    case "MOTION":
      return "motion";
    default:
      return "other";
  }
}

/**
 * Canonical modality code for the `/discover?modality=` param, preserving the
 * `iEEG` casing the filter parser expects. Returns null for a modality the
 * catalog filter can't target (e.g. "MRI"), so callers render a plain,
 * non-clickable tag instead of a dead link.
 */
export function modalityFilterCode(modality: string): ModalityCode | null {
  const upper = modality.trim().toUpperCase();
  const code = upper === "IEEG" ? "iEEG" : upper;
  return (MODALITY_CODES as readonly string[]).includes(code) ? (code as ModalityCode) : null;
}

export function modalityHref(modality: string): string | null {
  const code = modalityFilterCode(modality);
  return code ? `/discover?modality=${encodeURIComponent(code)}` : null;
}

// --- Keyword ----------------------------------------------------------------

/** A keyword tag points at a free-text Discover search for the same term. */
export function keywordHref(term: string): string {
  return `/discover?q=${encodeURIComponent(term.trim())}`;
}

// --- License ----------------------------------------------------------------

export const LICENSE_TIER_LABELS: Record<LicenseTier, string> = {
  public: "Public domain",
  attribution: "Attribution",
  sharealike: "Share-alike",
  noncommercial: "Non-commercial",
  noderiv: "No derivatives",
  unknown: "Unknown / custom",
};

/** One-line plain-language note on what each tier permits. Surfaced in tag
 *  tooltips and the filter legend so "which datasets can I actually use"
 *  reads at a glance. */
export const LICENSE_TIER_BLURB: Record<LicenseTier, string> = {
  public: "No restrictions — public domain dedication.",
  attribution: "Free reuse with credit.",
  sharealike: "Reuse with credit; derivatives keep the same license.",
  noncommercial: "Non-commercial reuse only.",
  noderiv: "No derivative works permitted.",
  unknown: "License not recognized — check the dataset terms.",
};

/**
 * Classify a free-text license string into a permissiveness tier. Tolerant of
 * the spacing / hyphenation / version-suffix drift seen across catalog rows
 * ("CC-BY-NC 4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-4.0", ...). The most
 * restrictive marker is checked first so combined clauses land in the
 * stricter tier: CC-BY-NC-ND → noderiv, CC-BY-NC-SA → noncommercial.
 */
export function licenseTier(license: string | null | undefined): LicenseTier {
  if (!license || !license.trim()) return "unknown";
  // Pass an already-classified tier name straight through, so a caller that
  // hands us a tier (not a raw license string) isn't silently re-bucketed to
  // "unknown".
  const lower = license.trim().toLowerCase();
  if ((LICENSE_TIERS as readonly string[]).includes(lower)) return lower as LicenseTier;
  const s = license.toUpperCase().replace(/[\s_]+/g, "-");
  // Most restrictive marker first, so combined clauses land in the stricter
  // tier (CC-BY-NC-ND -> noderiv, CC-BY-NC-SA -> noncommercial).
  if (/(^|-)ND(-|$)|NO-?DERIV/.test(s)) return "noderiv";
  if (/(^|-)NC(-|$)|NON-?COMMERCIAL/.test(s)) return "noncommercial";
  if (/(^|-)SA(-|$)|SHARE-?ALIKE|ODBL/.test(s)) return "sharealike";
  // `UNLICENSE(?!D)` so "UNLICENSED" (all-rights-reserved) is NOT read as
  // public domain — misclassifying toward *more* permissive is the dangerous
  // direction for a usage-rights signal.
  if (/CC-?0|PDDL|UNLICENSE(?!D)|PUBLIC-?DOMAIN|(^|-)PD(-|$)/.test(s)) return "public";
  // Attribution only via the CC-BY / ODC-BY tokens, never a stray "by" that a
  // free-text custom license sentence might contain.
  if (/CC-BY|ODC-BY|ATTRIBUTION/.test(s)) return "attribution";
  return "unknown";
}

/** Discover link for a license tag — filters to datasets sharing its tier. */
export function licenseHref(license: string | null | undefined): string {
  return `/discover?license=${licenseTier(license)}`;
}

// --- Zarr tag (website#277, #346) --------------------------------------------
// A converted Zarr copy is not a recording modality, but it is how a dataset
// opens in the signal viewer, so it gets a green tag set off from the
// modality tags (and a matching chip in the Discover sidebar). The tag keys on
// the copy EXISTING (`hasZarrCopy`), not on the fidelity sweep's verdict: the
// sweep only reaches datasets with a `github_repo`, so gating on its verdict
// hid the tag from every `on*` mirror. The verdict (nemar-cli#1181 phase 8)
// moves into the tooltip; only a failed check changes the tag itself.

export type ZarrVerifyStatus = "verified" | "failed" | "unverifiable";

const ZARR_VERIFY_STATUSES: ReadonlySet<string> = new Set<ZarrVerifyStatus>([
  "verified",
  "failed",
  "unverifiable",
]);

export function isZarrVerifyStatus(value: unknown): value is ZarrVerifyStatus {
  return typeof value === "string" && ZARR_VERIFY_STATUSES.has(value);
}

/** The catalog-row fields the Zarr tag reads. */
export interface ZarrTagFields extends ZarrCopyFields {
  zarr_verify_status?: string | null;
}

export interface ZarrTagView {
  label: string;
  /** `Tag` kind: `positive` (green) for a served copy, `warning` (amber)
   *  when the sweep ran and found a real mismatch (PR #278 review). */
  kind: "positive" | "warning";
  /** Tooltip: what the copy is, plus the sweep's verdict. */
  title: string;
}

const ZARR_TAG_LEAD =
  "A converted Zarr copy is available, so recordings open in the in-browser signal viewer.";

/** The verdict sentence appended to the tooltip. `null` (never swept) and
 *  "unverifiable" (no check could run) are both "not checked", never a
 *  failure (mirrors `zarr-fidelity-sweep.ts`'s own verdict semantics). */
const ZARR_VERDICT_NOTE: Record<"verified" | "unverifiable" | "unswept", string> = {
  verified:
    "Its channel counts match this dataset's own channels.tsv, checked by the standing fidelity sweep.",
  unverifiable:
    "The fidelity sweep couldn't reach a verdict for it, which does not mean it failed.",
  unswept: "The fidelity sweep hasn't checked it yet.",
};

const ZARR_FAILED_TITLE =
  "A converted Zarr copy is available, but a sampled recording's converted channel count disagreed with this dataset's channels.tsv; the copy is still served until it's rechecked.";

/**
 * The Zarr tag for a catalog row, or null when the row has no Zarr copy.
 * Shared by the Discover card and the dataset page header.
 */
export function zarrTag(row: ZarrTagFields | null | undefined): ZarrTagView | null {
  if (!row || !hasZarrCopy(row)) return null;
  const verdict = isZarrVerifyStatus(row.zarr_verify_status) ? row.zarr_verify_status : null;
  if (verdict === "failed") {
    // "fidelity issue", not "unverified": the sweep RAN and found a mismatch,
    // which must not read as a synonym for "no check could run".
    return { label: "Zarr fidelity issue", kind: "warning", title: ZARR_FAILED_TITLE };
  }
  return {
    label: "Zarr",
    kind: "positive",
    title: `${ZARR_TAG_LEAD} ${ZARR_VERDICT_NOTE[verdict ?? "unswept"]}`,
  };
}
