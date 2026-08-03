/**
 * Types for the data.nemar.org responses we consume on the detail page.
 *
 * These mirror the live shapes verified against `nm000103`, `nm000104`,
 * and `on005262`. The canonical server-side definitions live in
 * `nemar-cli/backend/src/services/data-router.ts`; if those drift, the
 * Phase 2 PR description will call it out and we update here.
 */

export interface Affiliation {
  name: string;
  identifier: string | null;
  scheme: string | null;
}

export interface Author {
  name: string;
  name_type: "Personal" | "Organizational" | string;
  orcid: string | null;
  affiliations: Affiliation[];
}

export interface RelatedIdentifier {
  identifier: string;
  identifier_type: "DOI" | "URL" | "PMID" | string;
  relation_type:
    | "References"
    | "IsDescribedBy"
    | "IsIdenticalTo"
    | "IsDerivedFrom"
    | "IsVariantFormOf"
    | "IsSupplementTo"
    | "Cites"
    | string;
}

export interface Rights {
  rights: string;
  rights_uri: string | null;
  rights_identifier: string | null;
  rights_identifier_scheme: string | null;
}

/**
 * One funding entry. The field is `funder_name`, not `funder` — verified
 * against every `funding[]` entry served by data.nemar.org (11 entries
 * across 10 datasets, 2026-08-02; zero carry a `funder` key). It is
 * declared nullable for the same reason the rest of this file is: a
 * catalog row that violates the shape must render an incomplete rail,
 * never throw and drop the whole page.
 */
export interface Funding {
  funder_name: string | null;
  award_number?: string | null;
  award_title?: string | null;
  award_uri?: string | null;
  funder_identifier?: string | null;
  funder_identifier_type?: string | null;
}

export interface ExternalLinks {
  dataset_doi: string | null;
  github_url: string | null;
}

export interface Provenance {
  latest_snapshot: string | null;
  publish_date: string | null;
}

export interface NeuroschemaDataset {
  schema_version: string;
  doc_type: "dataset" | string;
  dataset_id: string;
  name: string;
  description: string | null;
  source: "nemar" | "openneuro" | string;
  recording_modality: string[];
  bids_version: string | null;
  license: string | null;
  authors: Author[];
  keywords: string[];
  related_identifiers: RelatedIdentifier[];
  contributors: Author[];
  dates: Array<{ date: string; date_type: string }>;
  rights: Rights[];
  language: string | null;
  funding: Funding[];
  tasks: string[];
  datatypes: string[];
  sessions: string[];
  sessions_count: number | null;
  demographics: unknown | null;
  data_summary: unknown | null;
  provenance: Provenance;
  external_links: ExternalLinks;
  extensions?: Record<string, unknown>;
}

export interface LandingVersion {
  version: string;
  doi: string | null;
  created_at: string;
  manifest_url: string;
  browse_url: string;
}

/** Latest-only downloadable-archive state (#752). A non-null `skip_reason`
 *  means the zip was intentionally skipped by the size policy (status stays
 *  null) and the UI should show the direct per-file download recipe. Optional
 *  for forward-compat with older API responses that predate the field. */
export interface LandingArchive {
  status: string | null;
  size: number | null;
  skip_reason: string | null;
}

export interface LandingPayload {
  dataset_id: string;
  latest: string | null;
  metadata_url: string;
  versions: LandingVersion[];
  archive?: LandingArchive;
}
