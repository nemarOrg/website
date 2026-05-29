/**
 * The tag "bible" in code: the single source of truth for classifying the
 * three clickable tag families (modality, license, keyword) and for the
 * /discover links they point at. Colors for each family live as tokens in
 * `src/styles/tokens.css`; the written reference is in
 * `.rules/design-language.md` ("Tag color bible"). `Tag.astro` consumes
 * this module; nothing here renders markup.
 */

import { type LicenseTier, MODALITY_CODES, type ModalityCode } from "./types";

// --- Modality ---------------------------------------------------------------

/** Color variant for a modality tag. Mirrors the `--modality-*` tokens. */
export type ModalityVariant = "eeg" | "meg" | "ieeg" | "emg" | "other";

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
  const s = license.toUpperCase().replace(/[\s_]+/g, "-");
  if (/(^|-)ND(-|$)|NODERIV|NO-DERIV/.test(s)) return "noderiv";
  if (/(^|-)NC(-|$)|NONCOMMERCIAL|NON-COMMERCIAL/.test(s)) return "noncommercial";
  if (/(^|-)SA(-|$)|SHARE-?ALIKE|ODBL/.test(s)) return "sharealike";
  if (/CC-?0|PDDL|UNLICENSE|PUBLIC-?DOMAIN|(^|-)PD(-|$)/.test(s)) return "public";
  if (/(^|-)BY(-|$)|ODC-BY|ATTRIBUTION/.test(s)) return "attribution";
  return "unknown";
}

/** Discover link for a license tag — filters to datasets sharing its tier. */
export function licenseHref(license: string | null | undefined): string {
  return `/discover?license=${licenseTier(license)}`;
}
