/**
 * Server-rendered schema.org `Dataset` JSON-LD for the dataset detail page
 * (website#156, implementing the OSCAR NEMAR worked example). Pure mapping
 * from data `src/pages/dataset/[id].astro` already has in hand after its SSR
 * fetch fan-out (catalog row + metadata.json + landing payload) — no network
 * calls here. The page calls {@link datasetJsonLdScript} and drops the
 * result straight into a `<script type="application/ld+json">` tag.
 *
 * NULL-SAFETY IS THE POINT of this module. Catalog rows for `ds*` and
 * unsynced `on*` datasets ship null timestamps, null modalities, null
 * author strings, and `license` is optional pending nemar-cli#653 (see
 * AGENTS.md). Every field here degrades to omission — never `null`,
 * `"undefined"`, or an empty object/array — when the source is missing.
 * Astro silently drops content whose render throws, so a builder that
 * throws on a sparse dataset would be a real outage, not a rendering gap.
 */

import { datasetCitation } from "./cite";
import { formatBytes } from "./format";
import { MARKETING_BASE_URL } from "./host";
import type { NeuroschemaDataset } from "./neuroschema";
import type { Provenance } from "./provenance";
import { licenseTier } from "./tags";
import type { Dataset } from "./types";

/** The slice of the api.nemar.org catalog row the builder reads. Optional —
 *  null for `ds*` ids (400 there, see `isManagedDatasetId`) and whenever the
 *  per-id lookup fails; the page already tolerates both (see
 *  `catalogRow?.n_channels` in DetailRail's props). */
export type JsonLdCatalogRow = Pick<
  Dataset,
  "concept_doi" | "doi" | "authors" | "file_size" | "file_size_formatted"
>;

export interface DatasetJsonLdInput {
  id: string;
  metadata: NeuroschemaDataset;
  catalogRow: JsonLdCatalogRow | null;
  /** Resolved from the landing payload by the page (latest, or the `?v=`
   *  override) — null only for an unpublished dataset, in which case
   *  `version` and `distribution` are omitted below. */
  selectedVersion: string | null;
  provenance: Provenance;
  /** Absolute canonical URL of this dataset's own page — same origin logic
   *  Base.astro uses for `<link rel="canonical">` (app vs. marketing host). */
  pageUrl: string;
  /** data.nemar.org base, env-aware (data-test on staging). No trailing slash required. */
  dataBase: string;
}

// ---------------------------------------------------------------------------
// License: NEMAR license strings are free text ("CC-BY-NC-SA 4.0", "CC BY
// 4.0", "CC0", "CC-BY-NC-SA-3.0", ...). Map the Creative Commons family to a
// canonical URL when recognized; schema.org's `license` accepts a URL or
// Text, so an unrecognized string is passed through as-is rather than
// dropped.
// ---------------------------------------------------------------------------

function ccLicenseUrl(raw: string): string | undefined {
  const s = raw.toUpperCase().replace(/[\s_]+/g, "-");
  if (/(^|-)CC-?0(-|$)/.test(s) || /PUBLIC-?DOMAIN/.test(s)) {
    return "https://creativecommons.org/publicdomain/zero/1.0/";
  }
  const versionMatch = s.match(/(\d+(?:\.\d+)?)/);
  const version = versionMatch ? versionMatch[1] : "4.0";
  if (/CC-?BY-?NC-?ND/.test(s)) return `https://creativecommons.org/licenses/by-nc-nd/${version}/`;
  if (/CC-?BY-?NC-?SA/.test(s)) return `https://creativecommons.org/licenses/by-nc-sa/${version}/`;
  if (/CC-?BY-?ND/.test(s)) return `https://creativecommons.org/licenses/by-nd/${version}/`;
  if (/CC-?BY-?SA/.test(s)) return `https://creativecommons.org/licenses/by-sa/${version}/`;
  if (/CC-?BY-?NC(?!-?[SD])/.test(s))
    return `https://creativecommons.org/licenses/by-nc/${version}/`;
  if (/CC-?BY(?!-)/.test(s)) return `https://creativecommons.org/licenses/by/${version}/`;
  return undefined;
}

/** `conditionsOfAccess` note for restrictive tiers. Generic and factual —
 *  never invents participant-consent language the metadata doesn't carry. */
function conditionsOfAccess(rawLicense: string): string | undefined {
  const tier = licenseTier(rawLicense);
  if (tier === "noncommercial") return `Non-commercial use only (${rawLicense}).`;
  if (tier === "noderiv") return `No derivative works permitted (${rawLicense}).`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Measurement technique: recording_modality codes -> human-readable labels.
// ---------------------------------------------------------------------------

const MODALITY_LABELS: Record<string, string> = {
  EEG: "Electroencephalography (EEG)",
  MEG: "Magnetoencephalography (MEG)",
  IEEG: "Intracranial Electroencephalography (iEEG)",
  ECOG: "Electrocorticography (ECoG)",
  EMG: "Electromyography (EMG)",
  NIRS: "Near-Infrared Spectroscopy (NIRS)",
  MOTION: "Motion capture",
  ANAT: "Magnetic Resonance Imaging (MRI), anatomical",
  FUNC: "Magnetic Resonance Imaging (MRI), functional",
  FMRI: "Functional Magnetic Resonance Imaging (fMRI)",
  DWI: "Diffusion-Weighted Imaging (DWI)",
  BEH: "Behavioral testing",
};

function measurementTechniques(modalities: string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of modalities) {
    const code = raw.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    labels.push(MODALITY_LABELS[code] ?? raw.trim());
  }
  return labels;
}

// ---------------------------------------------------------------------------
// DOI helpers
// ---------------------------------------------------------------------------

/** Bare "10.x/y" from a DOI in any of the shapes NEMAR stores it. */
function bareDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const stripped = doi
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/^doi:/i, "");
  return stripped || null;
}

function doiUrl(doi: string | null | undefined): string | null {
  const bare = bareDoi(doi);
  return bare ? `https://doi.org/${bare}` : null;
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

function buildCreators(input: DatasetJsonLdInput): Array<Record<string, unknown>> {
  const authors = input.metadata.authors ?? [];
  if (authors.length > 0) {
    return authors
      .map((a) => (a.name ?? "").trim())
      .filter((name) => name.length > 0)
      .map((name, i) => {
        const orcid = authors[i]?.orcid;
        const person: Record<string, unknown> = { "@type": "Person", name };
        if (orcid) person.sameAs = `https://orcid.org/${orcid}`;
        return person;
      });
  }
  // Fallback: metadata.json shipped no authors array (sparse ds*/on* rows),
  // but the catalog row may still carry a comma-joined authors string.
  const raw = input.catalogRow?.authors ?? "";
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((name) => ({ "@type": "Person", name }));
}

// ---------------------------------------------------------------------------
// Citation: the dataset's own recommended citation (reusing cite.ts, per
// AGENTS.md — don't duplicate citation formatting) plus any DOIs the
// metadata explicitly marks as "References" (the paper(s) to cite when using
// this data, e.g. a Data Descriptor). Deliberately NOT "IsReferencedBy"
// entries — those record papers that cite the dataset, the opposite
// direction, and telling a reader to cite them would misrepresent the
// relationship (see PR description for a concrete on* example).
// ---------------------------------------------------------------------------

function buildCitation(input: DatasetJsonLdInput): string[] {
  const citations: string[] = [];
  const doi = input.catalogRow?.concept_doi ?? input.metadata.external_links.dataset_doi ?? null;
  const authorNames = (input.metadata.authors ?? []).map((a) => a.name).filter(Boolean);
  // datasetCitation is null-safe for empty authors / no doi / no date (see
  // cite.ts's own "OpenNeuro, no version, no doi, no date" test case), so
  // the self-citation is always included — even a dataset with nothing but
  // a name still gets a usable "(n.d.). <name> [Data set]. NEMAR." string.
  const { apa } = datasetCitation({
    authors: authorNames,
    name: input.metadata.name,
    version: input.selectedVersion,
    date: input.metadata.provenance.publish_date,
    doi,
    id: input.id,
  });
  citations.push(apa);
  for (const rid of input.metadata.related_identifiers ?? []) {
    if (rid.relation_type !== "References" || rid.identifier_type !== "DOI") continue;
    const url = doiUrl(rid.identifier);
    if (url) citations.push(url);
  }
  return citations;
}

// ---------------------------------------------------------------------------
// Distribution (DataDownload)
// ---------------------------------------------------------------------------

function buildDistribution(input: DatasetJsonLdInput): Record<string, unknown> | null {
  if (!input.selectedVersion) return null; // unpublished — nothing to point at
  const base = input.dataBase.replace(/\/$/, "");
  const contentUrl = `${base}/${encodeURIComponent(input.id)}/${encodeURIComponent(input.selectedVersion)}/`;

  const contentSize =
    (input.metadata.data_summary as { size_human?: string } | null)?.size_human ||
    (typeof input.catalogRow?.file_size === "number" && input.catalogRow.file_size > 0
      ? formatBytes(input.catalogRow.file_size)
      : undefined);

  const distribution: Record<string, unknown> = {
    "@type": "DataDownload",
    contentUrl,
    encodingFormat: "https://bids.neuroimaging.io",
    description: `Browsable BIDS tree on data.nemar.org. Download the full dataset with 'nemar dataset download ${input.id}', or fetch selectively with 'nemar dataset clone ${input.id}' then 'nemar dataset get <files>'.`,
  };
  if (contentSize) distribution.contentSize = contentSize;
  return distribution;
}

// ---------------------------------------------------------------------------
// sameAs: mirror identifiers the metadata marks as "IsIdenticalTo" this
// dataset (e.g. a Zenodo DOI for a dataset that also has a NEMAR-minted
// concept DOI as its primary `identifier` — see PR description).
// ---------------------------------------------------------------------------

function buildSameAs(input: DatasetJsonLdInput): string[] {
  const urls: string[] = [];
  for (const rid of input.metadata.related_identifiers ?? []) {
    if (rid.relation_type !== "IsIdenticalTo") continue;
    const url = rid.identifier_type === "DOI" ? doiUrl(rid.identifier) : rid.identifier;
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Build the schema.org `Dataset` JSON-LD object for a dataset detail page.
 * Pure and total: never throws on sparse/null-heavy input.
 */
export function buildDatasetJsonLd(input: DatasetJsonLdInput): Record<string, unknown> {
  const { metadata, catalogRow, provenance } = input;

  const jsonld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: metadata.name,
    alternateName: input.id,
    url: input.pageUrl,
  };

  if (metadata.description) jsonld.description = metadata.description;

  const conceptDoi = catalogRow?.concept_doi ?? metadata.external_links.dataset_doi ?? null;
  const identifier = doiUrl(conceptDoi);
  if (identifier) jsonld.identifier = identifier;

  if (input.selectedVersion) jsonld.version = input.selectedVersion;

  const rawLicense = metadata.license;
  if (rawLicense) {
    jsonld.license = ccLicenseUrl(rawLicense) ?? rawLicense;
    const access = conditionsOfAccess(rawLicense);
    if (access) jsonld.conditionsOfAccess = access;
  }

  const creators = buildCreators(input);
  if (creators.length > 0) jsonld.creator = creators;

  const citations = buildCitation(input);
  if (citations.length > 0) jsonld.citation = citations;

  const techniques = measurementTechniques(metadata.recording_modality ?? []);
  if (techniques.length > 0) {
    jsonld.measurementTechnique = techniques.length === 1 ? techniques[0] : techniques;
  }

  const keywords = (metadata.keywords ?? [])
    .map((k) => (typeof k === "string" ? k : ((k as { term?: string }).term ?? "")))
    .filter((term) => term.length > 0);
  if (keywords.length > 0) jsonld.keywords = keywords;

  jsonld.includedInDataCatalog = {
    "@type": "DataCatalog",
    name: "NEMAR",
    url: MARKETING_BASE_URL,
  };

  if (provenance.kind === "derived" && provenance.originalUrl) {
    jsonld.isBasedOn = provenance.originalUrl;
  }

  const sameAs = buildSameAs(input);
  if (sameAs.length > 0) jsonld.sameAs = sameAs;

  if (metadata.provenance.publish_date) {
    const iso = toIsoDate(metadata.provenance.publish_date);
    if (iso) jsonld.datePublished = iso;
  }

  const distribution = buildDistribution(input);
  if (distribution) jsonld.distribution = [distribution];

  return jsonld;
}

/** Best-effort ISO 8601 date from the free-form date strings metadata.json
 *  ships ("2026-02-23 07:49:00"). Returns null rather than an "Invalid
 *  Date" string when the value doesn't parse. */
function toIsoDate(value: string): string | null {
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------------------
// Safe embedding: JSON.stringify, then escape every byte sequence that could
// let attacker- or metadata-controlled text break out of the <script> tag.
// `<` is the load-bearing one (it's the only way to spell "</script>"), but
// `>` / `&` / U+2028 / U+2029 are escaped too as defense in depth. `\uXXXX`
// is a valid JSON string escape, so this round-trips through JSON.parse
// unchanged — it only changes the literal bytes an HTML parser sees.
// ---------------------------------------------------------------------------

export function escapeJsonLdForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/[\u2028\u2029]/g, (ch) => (ch.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
}

/** Build + serialize + escape in one call — what the page actually uses. */
export function datasetJsonLdScript(input: DatasetJsonLdInput): string {
  return escapeJsonLdForScript(JSON.stringify(buildDatasetJsonLd(input)));
}
