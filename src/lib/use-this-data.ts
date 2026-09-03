/**
 * "Use this data" section (nemarOrg/website#284 phase 2, issue #286).
 *
 * ONE MODEL, TWO RENDERERS. {@link buildUseThisData} builds a structured,
 * markup-free model from data `src/pages/dataset/[id].astro` already has in
 * hand after its existing SSR fetch fan-out (id, metadata, catalog row,
 * selected version, data/zarr bases) — no new fetches happen here or in
 * either renderer. `src/components/UseThisData.astro` renders the model as
 * HTML; {@link renderUseThisDataMarkdown} renders the SAME model as the
 * markdown mirror served at `/dataset/<id>.md`. Divergence between the two
 * surfaces ("human-visible and identical for agents") is impossible by
 * construction: neither renderer holds a fact the model doesn't already
 * carry, and both walk the same `sections`/`items` arrays.
 *
 * NULL-SAFETY IS THE POINT of this module, exactly as jsonld.ts documents at
 * its own top. Catalog rows for `ds*` and unsynced `on*` datasets ship null
 * timestamps, null modalities, null author strings, and `license` is
 * optional. Every field here degrades to OMISSION — a section (or the whole
 * model) simply carries fewer items — never to `null`, `"undefined"`, or an
 * empty heading. Astro silently drops content whose render throws, so a
 * builder that throws on a sparse dataset would be a real outage, not a
 * rendering gap.
 */

import { apiBase } from "./api-base";
import { datasetCitation } from "./cite";
import { dirListingUrl } from "./dir-listing";
import { formatBytes, splitModalities } from "./format";
import { ccLicenseUrl, conditionsOfAccess } from "./jsonld";
import type { NeuroschemaDataset } from "./neuroschema";
import type { Dataset } from "./types";
import { zarrIndexUrl } from "./zarr-base";

/**
 * The slice of the api.nemar.org catalog row this builder reads. Same
 * reasoning as `JsonLdCatalogRow` in jsonld.ts: optional, null for `ds*` ids
 * (the catalog detail endpoint 400s there) and whenever the per-id lookup
 * fails — the page already tolerates both.
 */
export type UseThisDataCatalogRow = Pick<
  Dataset,
  | "participants"
  | "file_size"
  | "file_size_formatted"
  | "modalities"
  | "tasks"
  | "hed_version"
  | "zarr_status"
  | "zarr_store_count"
  | "zarr_index_url"
>;

export interface UseThisDataInput {
  id: string;
  metadata: NeuroschemaDataset;
  catalogRow: UseThisDataCatalogRow | null;
  /** Resolved by the page (latest, or the `?v=` override) — usually null
   *  exactly when `unpublished` is true, but the two are computed
   *  independently upstream: `isUnpublished` ORs in an empty-`versions`
   *  check that this field's own `landing.latest ?? landing.versions[0]?.version`
   *  fallback chain does not defend against. So a landing payload with
   *  `latest: null` and a non-empty `versions` array makes this non-null
   *  while `unpublished` is still true. `unpublished` is authoritative —
   *  see `publishedVersion` — this field is only the literal version string
   *  used to build a URL once a section has already decided to render. */
  selectedVersion: string | null;
  /** The page's own `isUnpublished(landing)` (data-api.ts) — the single
   *  source of truth for whether a published version exists. The
   *  bytes-location, download, assess, and Zarr sections are all omitted
   *  when this is true, regardless of what `selectedVersion` holds
   *  (decision 4). Passed in rather than re-derived here so this module
   *  never disagrees with the page about publication state. */
  unpublished: boolean;
  /** data.nemar.org base, env-aware (data-test on staging). Trailing slash optional. */
  dataBase: string;
  /**
   * zarr.nemar.org base, env-aware. Passed explicitly, the same way
   * `dataBase` is, rather than read from `import.meta.env` inside this
   * module — that keeps this file pure and testable against plain fixtures
   * with no environment stubbing.
   */
  zarrBase: string;
}

/**
 * One fact in the model: a label plus its already-formatted display value,
 * optionally linked. `key` is stable and unique within the whole model, so a
 * test (or a future consumer) can address a specific fact without depending
 * on section order. `code` hints that `value` is a literal shell command or
 * file path best shown in a monospace/code treatment — advisory only, both
 * renderers still emit the same text either way.
 */
export interface UseThisDataItem {
  key: string;
  label: string;
  value: string;
  href?: string;
  code?: boolean;
}

export type UseThisDataSectionId =
  | "overview"
  | "license"
  | "location"
  | "download"
  | "assess"
  | "zarr";

export interface UseThisDataSection {
  id: UseThisDataSectionId;
  heading: string;
  /** Optional lead paragraph(s) rendered before the item list, plain text. */
  intro?: string[];
  items: UseThisDataItem[];
}

export interface UseThisData {
  datasetId: string;
  /** Display name for the markdown mirror's title; the HTML page already has
   *  its own `<h1>` and doesn't need this. */
  name: string;
  /** Set directly from `input.unpublished` — see `UseThisDataInput.unpublished`.
   *  Sections that need a published version are simply absent from
   *  `sections` rather than rendered empty. */
  unpublished: boolean;
  sections: UseThisDataSection[];
}

// ---------------------------------------------------------------------------
// Small null-safe readers
// ---------------------------------------------------------------------------

function trimmedOrNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

function normalizedBase(base: string): string {
  return base.replace(/\/$/, "");
}

/**
 * The version to treat as published, treating `input.unpublished` as
 * authoritative over `input.selectedVersion` (see the doc comments on both
 * fields of `UseThisDataInput` for why they can diverge). Every
 * version-gated section builder (location, download, assess, Zarr) reads
 * this instead of `input.selectedVersion` directly, so none of them can
 * independently re-derive "published" and disagree with the page.
 */
function publishedVersion(input: UseThisDataInput): string | null {
  return input.unpublished ? null : input.selectedVersion;
}

/** Bare "10.x/y" from a DOI in any of the shapes NEMAR stores it. Mirrors the
 *  private helper of the same name in jsonld.ts and cite.ts — small enough
 *  that a fourth copy costs less than a shared export across three modules
 *  with slightly different call shapes. */
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

function modalityList(input: UseThisDataInput): string[] {
  const fromMeta = (input.metadata.recording_modality ?? []).map((m) => m.trim()).filter(Boolean);
  if (fromMeta.length > 0) return fromMeta;
  return splitModalities(input.catalogRow?.modalities ?? null);
}

function taskList(input: UseThisDataInput): string[] {
  const fromMeta = (input.metadata.tasks ?? []).map((t) => t.trim()).filter(Boolean);
  if (fromMeta.length > 0) return fromMeta;
  const raw = input.catalogRow?.tasks;
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function participantCount(input: UseThisDataInput): number | null {
  const fromMeta = (input.metadata.demographics as { subjects_count?: number } | null)
    ?.subjects_count;
  if (typeof fromMeta === "number" && fromMeta > 0) return fromMeta;
  const fromCatalog = input.catalogRow?.participants;
  return typeof fromCatalog === "number" && fromCatalog > 0 ? fromCatalog : null;
}

function datasetSize(input: UseThisDataInput): string | null {
  const fromMeta = (input.metadata.data_summary as { size_human?: string } | null)?.size_human;
  const trimmedMeta = trimmedOrNull(fromMeta);
  if (trimmedMeta) return trimmedMeta;
  const bytes = input.catalogRow?.file_size;
  if (typeof bytes === "number" && bytes > 0) return formatBytes(bytes);
  return trimmedOrNull(input.catalogRow?.file_size_formatted ?? null);
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildOverviewSection(input: UseThisDataInput): UseThisDataSection {
  const items: UseThisDataItem[] = [];

  const modalities = modalityList(input);
  if (modalities.length > 0) {
    items.push({ key: "overview-modalities", label: "Modalities", value: modalities.join(", ") });
  }

  const participants = participantCount(input);
  if (participants !== null) {
    items.push({
      key: "overview-participants",
      label: "Participants",
      value: String(participants),
    });
  }

  const size = datasetSize(input);
  if (size) items.push({ key: "overview-size", label: "Size", value: size });

  const bidsVersion = trimmedOrNull(input.metadata.bids_version);
  if (bidsVersion) {
    items.push({ key: "overview-bids-version", label: "BIDS version", value: bidsVersion });
  }

  const tasks = taskList(input);
  if (tasks.length > 0) {
    items.push({ key: "overview-tasks", label: "Tasks", value: tasks.join(", ") });
  }

  const hedVersion = trimmedOrNull(input.catalogRow?.hed_version ?? null);
  if (hedVersion) {
    items.push({ key: "overview-hed-version", label: "HED version", value: hedVersion });
  }

  return { id: "overview", heading: "What it is", items };
}

/**
 * License and terms. Reuses `datasetCitation` (cite.ts), `ccLicenseUrl` and
 * `conditionsOfAccess` (jsonld.ts, exported additively for this module —
 * decision 6) so this section can never disagree with the JSON-LD block
 * about what a dataset's license means. Only `References` related
 * identifiers are surfaced as papers to cite — never `IsReferencedBy`, which
 * records papers that cite the dataset, the opposite direction. See
 * jsonld.ts's `buildCitation` for the same rule stated at more length.
 */
function buildLicenseSection(input: UseThisDataInput): UseThisDataSection {
  const items: UseThisDataItem[] = [];

  const rawLicense =
    trimmedOrNull(input.metadata.license) ??
    trimmedOrNull(input.metadata.rights?.[0]?.rights ?? null);
  if (rawLicense) {
    const url = ccLicenseUrl(rawLicense);
    items.push({
      key: "license-terms",
      label: "License",
      value: rawLicense,
      ...(url ? { href: url } : {}),
    });
    const note = conditionsOfAccess(rawLicense);
    if (note) items.push({ key: "license-note", label: "Note", value: note });
  }

  const authorNames = (input.metadata.authors ?? []).map((a) => a.name).filter(Boolean);
  const doi = input.metadata.external_links.dataset_doi ?? null;
  // datasetCitation is null-safe (no authors / no doi / no date all degrade
  // cleanly — see cite.test.ts), so this item is always present.
  const { apa } = datasetCitation({
    authors: authorNames,
    name: input.metadata.name,
    version: input.selectedVersion,
    date: input.metadata.provenance.publish_date,
    doi,
    id: input.id,
  });
  items.push({ key: "license-citation", label: "Recommended citation", value: apa });

  let refIndex = 0;
  for (const rid of input.metadata.related_identifiers ?? []) {
    if (rid.relation_type !== "References" || rid.identifier_type !== "DOI") continue;
    const url = doiUrl(rid.identifier);
    if (!url) continue;
    refIndex += 1;
    items.push({
      key: `license-reference-${refIndex}`,
      label: refIndex === 1 ? "Reference" : `Reference ${refIndex}`,
      value: url,
      href: url,
    });
  }

  return { id: "license", heading: "License and terms", items };
}

/**
 * Where the BIDS tree lives. Deliberately never `s3://nemar/<id>/` —
 * anonymous ListBucket on that prefix is denied (decision 2). The browsable
 * location is always `data.nemar.org`, at the "latest" alias and at the
 * selected version.
 */
function buildLocationSection(input: UseThisDataInput): UseThisDataSection | null {
  const version = publishedVersion(input);
  if (!version) return null;
  const base = normalizedBase(input.dataBase);
  const id = encodeURIComponent(input.id);
  const latestUrl = `${base}/${id}/latest/`;
  const versionUrl = `${base}/${id}/${encodeURIComponent(version)}/`;
  return {
    id: "location",
    heading: "Where the bytes are",
    items: [
      {
        key: "location-latest",
        label: "Latest version (always current)",
        value: latestUrl,
        href: latestUrl,
      },
      {
        key: "location-selected",
        label: `This version (${version})`,
        value: versionUrl,
        href: versionUrl,
      },
    ],
  };
}

function buildDownloadSection(input: UseThisDataInput): UseThisDataSection | null {
  const publishedVersionValue = publishedVersion(input);
  if (!publishedVersionValue) return null;
  const base = normalizedBase(input.dataBase);
  const id = input.id;
  const version = encodeURIComponent(publishedVersionValue);
  return {
    id: "download",
    heading: "How to download",
    items: [
      {
        key: "download-all",
        label: "Everything",
        value: `nemar dataset download ${id}`,
        code: true,
      },
      {
        key: "download-subset",
        label: "A subset",
        value: `nemar dataset clone ${id} fetches git-annex pointers only, no file content; follow it with nemar dataset get <files> to pull the files you actually need.`,
      },
      {
        key: "download-single-file",
        label: "One small file",
        value: `A direct HTTPS fetch works for any single file, e.g. ${base}/${encodeURIComponent(id)}/${version}/participants.tsv.`,
      },
    ],
  };
}

/** How to decide whether a dataset is worth downloading before doing it. */
function buildAssessSection(input: UseThisDataInput): UseThisDataSection | null {
  const publishedVersionValue = publishedVersion(input);
  if (!publishedVersionValue) return null;
  const base = normalizedBase(input.dataBase);
  const id = encodeURIComponent(input.id);
  const version = encodeURIComponent(publishedVersionValue);
  const participantsUrl = `${base}/${id}/${version}/participants.tsv`;
  const descriptionUrl = `${base}/${id}/${version}/dataset_description.json`;
  const listingUrl = dirListingUrl(input.id, publishedVersionValue, "", input.dataBase);
  const catalogUrl = `${apiBase()}/datasets/${id}`;
  return {
    id: "assess",
    heading: "Assess fit without downloading",
    items: [
      {
        key: "assess-participants",
        label: "Participants table",
        value: participantsUrl,
        href: participantsUrl,
      },
      {
        key: "assess-description",
        label: "Dataset description",
        value: descriptionUrl,
        href: descriptionUrl,
      },
      { key: "assess-listing", label: "Directory listing", value: listingUrl, href: listingUrl },
      { key: "assess-catalog", label: "Catalog record", value: catalogUrl, href: catalogUrl },
    ],
  };
}

/**
 * Zarr recipe, gated on the CATALOG ROW only — never an SSR fetch of
 * index.json (decision 1). `has_zarr` is documented as `zarr_status ===
 * "ready"` AND `(zarr_store_count ?? 0) > 0`; that is the gate here too. The
 * index URL prefers the row's own `zarr_index_url` (derived server-side,
 * non-null only when ready) and falls back to `zarrIndexUrl(id)`.
 */
function buildZarrSection(input: UseThisDataInput): UseThisDataSection | null {
  if (!publishedVersion(input)) return null;
  const row = input.catalogRow;
  const hasZarr = row?.zarr_status === "ready" && (row?.zarr_store_count ?? 0) > 0;
  if (!hasZarr) return null;

  const indexUrl =
    trimmedOrNull(row?.zarr_index_url ?? null) ?? zarrIndexUrl(input.id, input.zarrBase);

  const items: UseThisDataItem[] = [
    {
      key: "zarr-step-1",
      label: "1. Start at the index",
      value: `Fetch ${indexUrl} — the mandatory entry point. Never hardcode a bucket path.`,
      href: indexUrl,
    },
    {
      key: "zarr-step-2",
      label: "2. Read where the bytes are",
      value: "Read this dataset's own data_base / s3_uri from index.json, not a guessed prefix.",
    },
    {
      key: "zarr-step-3",
      label: "3. Open the store, streaming",
      value:
        'Default to streaming: zarr.open(store, mode="r") or xr.open_zarr(fsspec.get_mapper(data_base), consolidated=True).',
      code: true,
    },
    {
      key: "zarr-step-4",
      label: "4. Slice, don't download",
      value:
        "Stream a slice of channels, time, or subjects; download only when touching most of the array.",
    },
    {
      key: "zarr-step-5",
      label: "5. Pick the matching client",
      value: "Use s3fs/fsspec for S3 URIs, and plain HTTPS fsspec for zarr.nemar.org.",
    },
    {
      key: "zarr-step-6",
      label: "6. Check existence with HEAD",
      value:
        "HEAD is never redirected. A plain GET with no allowlisted browser Origin 302s to S3, so follow redirects.",
    },
    {
      key: "zarr-step-7",
      label: "7. Know what's cached",
      value:
        "Only index.json is always proxied and edge-cached; manifest.json and events.parquet redirect like store objects for non-browser clients.",
    },
    {
      key: "zarr-step-8",
      label: "8. Read the attribution before reuse",
      value:
        "Read the store's nemar root attribute (DOI, license, citation, source commit) before reuse.",
    },
    {
      key: "zarr-step-9",
      label: "9. Filter for pipelines",
      value: "Filter on has_zarr_verified, not just has_zarr, for agent pipelines.",
    },
  ];

  return { id: "zarr", heading: "Working with the Zarr copy", items };
}

// ---------------------------------------------------------------------------
// Top-level builder + markdown renderer
// ---------------------------------------------------------------------------

/**
 * Build the "Use this data" model. Pure and total: never throws on
 * sparse/null-heavy input. A section that ends up with zero items (possible
 * for "What it is" on a maximally sparse dataset) is dropped rather than
 * rendered as an empty heading.
 */
export function buildUseThisData(input: UseThisDataInput): UseThisData {
  const sections = [
    buildOverviewSection(input),
    buildLicenseSection(input),
    buildLocationSection(input),
    buildDownloadSection(input),
    buildAssessSection(input),
    buildZarrSection(input),
  ].filter((s): s is UseThisDataSection => s !== null && s.items.length > 0);

  return {
    datasetId: input.id,
    name: input.metadata.name,
    unpublished: input.unpublished,
    sections,
  };
}

/**
 * Render the model as markdown — the `.md` mirror's entire body. Every fact
 * the model carries appears here verbatim (the load-bearing parity
 * guarantee tested in use-this-data.test.ts); the HTML component renders the
 * identical `sections`/`items` structure, so the two surfaces cannot drift.
 */
export function renderUseThisDataMarkdown(model: UseThisData): string {
  const lines: string[] = [`# ${model.name} (${model.datasetId})`, "", "## Use this data", ""];

  if (model.unpublished) {
    lines.push("This dataset has been registered but no published version is available yet.", "");
  }

  for (const section of model.sections) {
    lines.push(`### ${section.heading}`, "");
    for (const paragraph of section.intro ?? []) {
      lines.push(paragraph, "");
    }
    for (const item of section.items) {
      const rendered = item.href
        ? `[${item.value}](${item.href})`
        : item.code
          ? `\`${item.value}\``
          : item.value;
      lines.push(`- **${item.label}:** ${rendered}`);
    }
    lines.push("");
  }

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
